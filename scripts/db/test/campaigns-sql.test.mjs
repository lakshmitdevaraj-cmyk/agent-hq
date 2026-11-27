// Chunk 2: the campaign SQL module on Neon dev. Every write runs in a transaction that is rolled back.
// Covers F1 (change, then read straight back), F17 (merged leads never counted), S0 (search uses the index),
// the job start-time rule, partial updates and the delete rules.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { areaCountry } from "../normalise.mjs";

const ROLLBACK = Symbol("rollback");
let m, area, STATE_TZ, sql, closeDb;

/** Runs fn(tx) in a transaction that is always rolled back. */
async function inTx(fn) {
  let out;
  try { await sql.begin(async (tx) => { out = await fn(tx); throw ROLLBACK; }); } catch (e) { if (e !== ROLLBACK) throw e; }
  return out;
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof m.CampaignError && e.status === status && re.test(e.message));
const ctx = { newId: () => "sqltest-" + Math.random().toString(36).slice(2, 8), createdBy: null };
const input = { name: "SQL test campaign", query: "test roofers", description: "", structured_query: { location: "Pearland, Texas, USA" } };

before(async () => {
  const { localVar } = await import("../env.mjs");
  process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
  const client = await import("../../../netlify/functions/lib/db/client.ts");
  sql = client.db();
  closeDb = client.closeDb;
  m = await import("../../../netlify/functions/lib/sql/campaigns.ts");
  area = await import("../../../netlify/functions/lib/sql/area.ts");
  ({ STATE_TZ } = await import("../../../netlify/functions/lib/replydraft.ts"));
});
after(() => closeDb?.());

describe("area.ts", () => {
  test("gives the same country and time zone as the import's rule, on every campaign area and some odd ones", async () => {
    const areas = (await sql`select area from campaigns`).map((r) => r.area);
    for (const a of [...areas, "Leeds, UK", "Austin, texas", "Denver, CO, US", "", null, "Texas", "Miami, Florida, United States"]) {
      const want = areaCountry(a, STATE_TZ);
      assert.deepEqual(area.areaCountry(a), { country: want.country, time_zone: want.state ? STATE_TZ[want.state] : null }, String(a));
    }
  });
});

describe("create, then read straight back (F1)", () => {
  test("the new campaign is in get and list at once, with its leads job and its activity entry", () => inTx(async (tx) => {
    const c = await m.create(tx, input, ctx);
    assert.equal(c.status, "draft");
    assert.equal(c.any_trade, true);
    assert.equal(c.leads_imported, 0);
    const got = await m.get(tx, c.id);
    assert.equal(got.name, input.name);
    assert.equal(got.query, input.query);
    assert.deepEqual(got.structured_query, input.structured_query);
    assert.equal((await m.list(tx, {}))[0].id, c.id, "newest first");
    const [row] = await tx`select niche, area, country, time_zone from campaigns where id = ${c.id}`;
    assert.deepEqual({ ...row }, { niche: "test roofers", area: "Pearland, Texas, USA", country: "US", time_zone: "America/Chicago" });
    const [job] = await tx`select status, total, done from campaign_jobs where campaign_id = ${c.id} and kind = 'leads'`;
    assert.deepEqual({ ...job }, { status: "draft", total: 0, done: 0 });
    assert.equal((await tx`select 1 from activity where details->>'campaign_id' = ${c.id}`).length, 1);
    assert.deepEqual(await m.leadsCount(tx, c.id), { count: 0 });
  }));

  test("name and query are required", async () => {
    await rejects(inTx((tx) => m.create(tx, { query: "x" }, ctx)), 400, /^name required$/);
    await rejects(inTx((tx) => m.create(tx, { name: "x", query: "  " }, ctx)), 400, /^query required$/);
  });
});

describe("update", () => {
  let id;
  before(async () => { id = (await sql`select id from campaigns order by created_at limit 1`)[0].id; });

  test("changes only the fields it is given, and the change reads back at once (F1)", () => inTx(async (tx) => {
    const [before] = await tx`select * from campaigns where id = ${id}`;
    await m.update(tx, { id, any_trade: !before.any_trade });
    const [after] = await tx`select * from campaigns where id = ${id}`;
    for (const k of Object.keys(before)) if (!["any_trade", "updated_at"].includes(k)) assert.deepEqual(after[k], before[k], k);
    assert.equal((await m.get(tx, id)).any_trade, !before.any_trade);
  }));

  test("unknown keys are merged into data, never replacing it", () => inTx(async (tx) => {
    const [before] = await tx`select data from campaigns where id = ${id}`;
    await m.update(tx, { id, test_flag: 1 });
    const [after] = await tx`select data from campaigns where id = ${id}`;
    assert.deepEqual(after.data, { ...before.data, test_flag: 1 });
  }));

  test("a job that starts gets the server clock; resume and finish keep the first start time", () => inTx(async (tx) => {
    const t0 = Date.now();
    const a = await m.update(tx, { id, job: { kind: "generate", status: "running", total: 3, done: 0, started_at: "2001-01-01T00:00:00Z" } });
    const start = Date.parse(a.job.started_at);
    assert.ok(Math.abs(start - t0) < 120_000, "server clock, not the caller's");
    const b = await m.update(tx, { id, job: { kind: "generate", status: "running", total: 3, done: 1, resume: true } });
    assert.equal(Date.parse(b.job.started_at), start);
    const c = await m.update(tx, { id, job: { kind: "generate", status: "done", total: 3, done: 3 } });
    assert.equal(Date.parse(c.job.started_at), start);
    assert.equal(c.job.status, "done");
    assert.equal(c.job.done, 3);
    assert.equal(c.job.written_at, undefined, "the ordering stamp stays inside");
    const d = await m.update(tx, { id, job: null });
    assert.equal(d.job, undefined);
  }));

  test("refuses: no id 400, unknown id 404, a bad value 400, a job without a kind 400", async () => {
    await rejects(inTx((tx) => m.update(tx, { name: "x" })), 400, /^id required$/);
    await rejects(inTx((tx) => m.update(tx, { id: "no-such-campaign", name: "x" })), 404, /^campaign not found$/);
    await rejects(inTx((tx) => m.update(tx, { id, any_trade: "yes" })), 400, /any_trade/);
    await rejects(inTx((tx) => m.update(tx, { id, default_sequence_total: 2.5 })), 400, /default_sequence_total/);
    await rejects(inTx((tx) => m.update(tx, { id, job: { status: "running" } })), 400, /job\.kind/);
  });
});

describe("delete", () => {
  test("removes leads, drafts, jobs, screenshots, social drafts and worked-out follow-ups; keeps sent emails and the contact log", () => inTx(async (tx) => {
    const [{ id }] = await tx`select campaign_id as id from follow_ups group by campaign_id order by count(*) desc limit 1`;
    const [{ sent }] = await tx`select count(*)::int as sent from emails where campaign_id = ${id} and status is distinct from 'drafted'`;
    const touchesBefore = (await tx`select count(*)::int as n from touches t join leads l on l.id = t.lead_id where l.campaign_id = ${id}`)[0].n;
    const leadIds = (await tx`select id from leads where campaign_id = ${id}`).map((r) => r.id);
    const r = await m.remove(tx, id);
    assert.equal(r.deleted, true);
    assert.equal(r.leads_deleted, leadIds.length, "merged rows are deleted too, and counted, as today");
    assert.equal(r.sent_kept, sent);
    for (const t of ["leads", "campaign_jobs", "lead_screenshots", "social_messages", "follow_ups", "campaigns"]) {
      const col = t === "campaigns" ? "id" : "campaign_id";
      assert.equal((await tx`select count(*)::int as n from ${tx(t)} where ${tx(col)} = ${id}`)[0].n, 0, t);
    }
    assert.equal((await tx`select count(*)::int as n from emails where campaign_id = ${id}`)[0].n, sent);
    assert.equal((await tx`select count(*)::int as n from touches where lead_id in ${tx(leadIds)}`)[0].n, touchesBefore, "touches stay (decision 2, R10)");
    await rejects(m.get(tx, id), 404, /^campaign not found$/);
  }));
});

describe("F17: merged leads are never counted or listed", () => {
  test("leadsCount and list leave out merged rows", () => inTx(async (tx) => {
    const [{ campaign_id: id, live, all }] = await tx`select campaign_id, count(*) filter (where merged_into is null)::int as live, count(*)::int as all from leads group by campaign_id having count(*) filter (where merged_into is not null) > 0 order by 1 limit 1`;
    assert.ok(all > live);
    assert.deepEqual(await m.leadsCount(tx, id), { count: live });
    assert.equal((await m.get(tx, id)).leads_imported, live);
    assert.equal((await m.list(tx, {})).find((c) => c.id === id).leads_imported, live);
  }));
});

describe("S0 search", () => {
  test("bad filter, sort or limit are refused", async () => {
    await rejects(inTx((tx) => m.list(tx, { filter: "nope" })), 400, /filter/);
    await rejects(inTx((tx) => m.list(tx, { sort: "nope" })), 400, /sort/);
    await rejects(inTx((tx) => m.list(tx, { limit: 0 })), 400, /limit/);
    await rejects(inTx((tx) => m.list(tx, { limit: 201 })), 400, /limit/);
  });

  test("% and _ in the search are plain characters", () => inTx(async (tx) => {
    assert.equal((await m.list(tx, { q: "%" })).length, 0);
    assert.equal((await m.list(tx, { q: "_" })).length, 0);
  }));

  test("a search of 3+ characters uses the campaigns_search index (planner told not to scan, as 25 rows always scan)", () => inTx(async (tx) => {
    await tx`set local enable_seqscan = off`;
    const plan = (await tx`explain ${m.listStatement(tx, { q: "hou" })}`).map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(plan, /Bitmap Index Scan on campaigns_search/, plan);
  }));

  test("list is one database call; timing on dev", async () => {
    const t = performance.now();
    await inTx((tx) => m.list(tx, { filter: "active", sort: "replies" }));
    console.log(`list (filter active, sort replies), inside a transaction, from this machine: ${Math.round(performance.now() - t)} ms`);
  });
});
