// The DATA_BACKEND switch (chunk 2). With it unset, the app must behave exactly as before this chunk: the same six
// campaign actions are run on command.ts as it was at BASE (before chunk 2) and as it is now, each on a fresh copy
// of the P1 export in memory, and the answers and every store they write must be the same. With DATA_BACKEND=sql,
// the call goes to the SQL module instead (proved by it reaching for a database socket, which the harness blocks).
import { afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const BASE = "4f9338c"; // the last commit before chunk 2 touched command.ts
const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
/** One store of a fake-blobs set (stores load on first use). */
const storeMap = (blobs, name) => (blobs.getStore(name), blobs.stores.get(name));
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
/**
 * Intended differences on the OLD path since run B (27 Nov, approved by Lakshmi): F38 ("5 Star" names are not a rating) and
 * F39 (sameness ignores the offer's sentence; "busy service schedules") changed lib/messagerules.ts and lib/angle.ts, and
 * RULES_VERSION went 4 → 5, so the old path re-checks each unsent draft once when it lists drafts. Listed, never hidden:
 * the version stamp, and any review result the new rules give. Every hit is counted and printed.
 */
const RULES5_KNOWN = [
  { path: /\.rules_version$/, when: (d) => d.old === 4 && d.new === 5, why: "RULES_VERSION 4 → 5: old drafts re-checked once (F38/F39)" },
  { path: /\.(review_status|reviewed_by|review_reasons(\.length|\[\d+\])?)$/, why: "a draft's code-check result under the F38/F39 rules" },
];
const knownSummary = (hits) => Object.entries(hits.reduce((m, h) => ((m[h.why] = (m[h.why] ?? 0) + 1), m), {})).map(([why, k]) => `${k} × ${why}`).join("; ");
const STORES = ["agent-hq-outreach-campaigns", "agent-hq-outreach-campaign-state", "agent-hq-outreach-leads", "agent-hq-outreach-emails", "agent-hq-outreach-social", "agent-hq-lead-screenshots"];

/** The same calls, in the same order, on one old path. Returns the answers and the stores afterwards. */
async function run(old, ids) {
  const [a, b] = ids;
  const calls = [
    ["outreach.campaign.list", {}],
    ["outreach.campaign.get", { id: a }],
    ["outreach.leads.count", { campaign_id: a }],
    ["outreach.campaign.update", { id: a, name: "Switch test rename" }],
    ["outreach.campaign.update", { id: a, job: { kind: "generate", status: "running", total: 2, done: 0 } }],
    ["outreach.campaign.update", { id: a, any_trade: false, default_sender_name: "Switch Test" }],
    ["outreach.campaign.create", { name: "Switch test campaign", query: "switch test", structured_query: { location: "Katy, TX" } }],
    ["outreach.campaign.delete", { id: b }],
    ["outreach.campaign.get", { id: b }],
    ["outreach.campaign.get", { id: "no-such-campaign" }],
    ["outreach.campaign.update", { name: "no id" }],
    ["outreach.leads.count", {}],
    ["outreach.campaign.list", {}],
  ];
  const answers = [];
  let made = null;
  for (const [action, params] of calls) {
    const r = await old.call(action, params);
    if (action === "outreach.campaign.create") made = r.body.data?.id;
    answers.push({ action, ...r });
  }
  const swap = (text) => (made ? text.split(made).join("<new id>") : text);
  const stores = Object.fromEntries(STORES.map((name) => [name, Object.fromEntries([...(storeMap(old.blobs, name))].map(([k, v]) => [swap(k), JSON.parse(swap(v))]))]));
  const activity = [...storeMap(old.blobs, "agent-hq-activity").values()].map((v) => JSON.parse(swap(v))).map(({ id, ...rest }) => rest);
  return { answers: JSON.parse(swap(JSON.stringify(answers))), stores, activity };
}

describe("DATA_BACKEND switch", { skip }, () => {
  let openOld, ids;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    const list = (await (await openOld(EXPORT)).call("outreach.campaign.list")).body.data;
    const emails = storeMap((await openOld(EXPORT)).blobs, "agent-hq-outreach-emails");
    const withMail = list.map((c) => c.id).filter((id) => [...emails.keys()].some((k) => k.startsWith(`${id}/`)));
    ids = [withMail[0], withMail[1]];
  });
  afterEach(() => { delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL; });

  test("unset: every campaign action answers and writes exactly as command.ts did before chunk 2", async () => {
    delete process.env.DATA_BACKEND;
    const was = await run(await openOld(EXPORT, { commit: BASE }), ids);
    const now = await run(await openOld(EXPORT), ids);
    for (const [i, w] of was.answers.entries()) {
      const r = compare(w, now.answers[i]);
      assert.ok(r.same, `${w.action} (call ${i + 1})\n${describeDiff(r)}`);
    }
    for (const name of STORES) {
      const r = compare(was.stores[name], now.stores[name]);
      assert.ok(r.same, `${name}\n${describeDiff(r)}`);
    }
    assert.ok(compare(was.activity, now.activity, { unordered: ["$"] }).same, "activity entries");
    assert.ok(was.answers.every((a) => a.status !== 500), "nothing failed on the old path");
    // Not a comparison of two empty things: real campaigns, a real write, a real create and a real delete.
    assert.ok(was.answers[0].body.data.length > 10);
    assert.equal(was.stores["agent-hq-outreach-campaigns"][ids[0]].name, "Switch test rename");
    assert.ok(was.stores["agent-hq-outreach-campaigns"]["<new id>"]);
    assert.ok(was.answers[7].body.data.leads_deleted > 0);
    assert.equal(was.answers[8].status, 404);
    console.log(`switch unset: ${was.answers.length} calls, ${STORES.length} stores and the activity log are the same before and after chunk 2`);
  });

  test("sql: the same call goes to the SQL module (it reaches for a database socket, which the harness refuses)", async () => {
    const old = await openOld(EXPORT);
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = "postgres://switch-test:not-a-password@db.invalid:5432/none";
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    const before = blockedCalls.length;
    // postgres.js opens its socket outside the handler's await chain, so the refusal can surface either as the
    // handler's 500 answer or as the thrown NetworkBlocked error; both mean the call took the SQL route.
    let outcome;
    try { const r = await old.call("outreach.campaign.list"); outcome = `${r.status} ${r.body.error}`; } catch (e) { outcome = `${e.code} ${e.message}`; }
    assert.match(outcome, /network access is blocked/, outcome);
    assert.ok(blockedCalls.slice(before).some((c) => c.what === "connect"), "a database socket was refused");
    delete process.env.DATA_BACKEND;
    const viaBlobs = await old.call("outreach.campaign.list");
    assert.equal(viaBlobs.status, 200);
    assert.ok(viaBlobs.body.data.length > 0);
  });

  test("sql, end to end on dev: the real handler answers through withTx and maps refusals (reads and refusals only, nothing written)", async () => {
    const { localVar } = await import("../env.mjs");
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    const before = blockedCalls.length;
    const old = await openOld(EXPORT, { allowDb: true }); // net/tls for postgres only; fetch and http(s) stay blocked
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    const list = await old.call("outreach.campaign.list", { sort: "name", limit: 3 });
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
    assert.equal(list.body.data.length, 3);
    const names = list.body.data.map((c) => c.name.toLowerCase());
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(await old.call("outreach.campaign.get", { id: "no-such-campaign" }), { status: 404, body: { ok: false, error: "campaign not found" } });
    assert.deepEqual(await old.call("outreach.campaign.update", { name: "x" }), { status: 400, body: { ok: false, error: "id required" } });
    assert.deepEqual(await old.call("outreach.campaign.update", { id: "no-such-campaign", name: "x" }), { status: 404, body: { ok: false, error: "campaign not found" } });
    assert.deepEqual(await old.call("outreach.leads.count", {}), { status: 400, body: { ok: false, error: "campaign_id required" } });
    assert.equal((await old.call("outreach.campaign.list", { filter: "nope" })).status, 400);
    const count = await old.call("outreach.leads.count", { campaign_id: ids[0] });
    assert.equal(count.status, 200);
    assert.equal(typeof count.body.data.count, "number");
    assert.equal(blockedCalls.length, before, "nothing else reached for the network");
  });

  test("any other value of DATA_BACKEND keeps Blobs", async () => {
    const old = await openOld(EXPORT);
    for (const v of ["blobs", "SQL", "", "postgres"]) {
      process.env.DATA_BACKEND = v;
      assert.equal((await old.call("outreach.leads.count", { campaign_id: ids[0] })).status, 200, v);
    }
  });
});

// ── Chunk 3: the lead and Prospects actions, and the four new ones ──
const BASE3 = "4e2eecb"; // the last commit before chunk 3 touched command.ts
const CHUNK3_NEW = ["outreach.lead.facts.list", "outreach.lead.facts.add", "outreach.lead.facts.delete", "outreach.search"];

async function runLeads(old, campaign_id, lead_id, other_id) {
  const calls = [
    ["outreach.leads.list", { campaign_id }],
    ["outreach.prospects.list", {}],
    ["outreach.lead.screenshot.get", { campaign_id, lead_id }],
    ["outreach.lead.set_email", { campaign_id, lead_id, email: "switch.test@alcance-test.invalid" }],
    ["outreach.leads.update", { campaign_id, lead_id, excluded: true, excluded_reason: "other", owner_name: "Switch Owner" }],
    ["outreach.leads.update", { campaign_id, lead_id, email: "only.email@alcance-test.invalid" }],
    ["outreach.lead.fb_checked", { campaign_id, lead_id, result: "real", note: "switch" }],
    ["outreach.lead.set_email", { campaign_id, lead_id, email: "" }],
    ["outreach.leads.delete", { campaign_id, lead_id: other_id }],
    ["outreach.leads.delete", { campaign_id, lead_id: "no-such-lead" }],
    ...CHUNK3_NEW.map((a) => [a, { lead_id, q: "switch", fact: "x" }]),
    ["outreach.leads.list", { campaign_id }],
  ];
  const answers = [];
  for (const [action, params] of calls) answers.push({ action, ...(await old.call(action, params)) });
  const stores = Object.fromEntries([...STORES, "agent-hq-outreach-contacts"].map((name) => [name, Object.fromEntries([...(storeMap(old.blobs, name))].map(([k, v]) => [k, (() => { try { return JSON.parse(v); } catch { return v; } })()]))]));
  return { answers, stores };
}

describe("DATA_BACKEND switch, chunk 3 actions", { skip }, () => {
  let openOld, ids;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    const n = (await import("../equiv/new-path.mjs")).openNew("dev");
    const { pickLeadWithMail, pickLeadWithDraft } = await import("../equiv/cases/leads.mjs");
    const a = await n.call(pickLeadWithMail), b = await n.call(pickLeadWithDraft);
    const [o] = await n.call(async (tx) => tx`select id from leads where campaign_id = ${a.campaign_id} and id <> ${a.id} and merged_into is null order by id limit 1`);
    ids = { campaign_id: a.campaign_id, lead_id: a.id, other_id: o?.id ?? b.id };
    await n.close();
  });
  afterEach(() => { delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL; });

  test("unset: every chunk 3 action (and the four new ones) answers and writes exactly as command.ts did before chunk 3", async () => {
    delete process.env.DATA_BACKEND;
    const was = await runLeads(await openOld(EXPORT, { commit: BASE3 }), ids.campaign_id, ids.lead_id, ids.other_id);
    const now = await runLeads(await openOld(EXPORT), ids.campaign_id, ids.lead_id, ids.other_id);
    const known3 = [];
    for (const [i, w] of was.answers.entries()) {
      const r = compare(w, now.answers[i], { known: RULES5_KNOWN });
      assert.ok(r.same, `${w.action} (call ${i + 1})\n${describeDiff(r)}`);
      known3.push(...r.known);
    }
    for (const name of Object.keys(was.stores)) {
      const r = compare(was.stores[name], now.stores[name], { known: RULES5_KNOWN });
      assert.ok(r.same, `${name}\n${describeDiff(r)}`);
      known3.push(...r.known);
    }
    console.log(`switch unset (chunk 3), intended differences: ${knownSummary(known3) || "none"}`);
    // Real data and real writes, not two empty answers.
    assert.ok(was.answers[0].body.data.length > 0 && was.answers[1].body.data.length > 100);
    assert.ok(was.answers[3].body.data.drafts_updated > 0);
    assert.equal(was.answers[8].body.data.deleted, true);
    for (const a of was.answers.filter((x) => CHUNK3_NEW.includes(x.action))) assert.deepEqual(a.body, { ok: false, error: `Unknown action: ${a.action}` });
    console.log(`switch unset (chunk 3): ${was.answers.length} calls and ${Object.keys(was.stores).length} stores are the same before and after chunk 3`);
  });

  test("sql: the chunk 3 actions go to the SQL module (a database socket is reached for)", async () => {
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    let sockets = 0;
    for (const action of ["outreach.leads.list", "outreach.prospects.list", "outreach.lead.set_email", "outreach.leads.update", "outreach.leads.delete", "outreach.lead.fb_checked", "outreach.lead.screenshot.get", ...CHUNK3_NEW]) {
      const old = await openOld(EXPORT);
      process.env.DATA_BACKEND = "sql";
      process.env.DATABASE_URL = "postgres://switch-test:not-a-password@db.invalid:5432/none";
      const before = blockedCalls.length;
      let outcome;
      try { const r = await old.call(action, { ...ids, email: "x@alcance-test.invalid", excluded: true, result: "real", q: "switch", fact: "x" }); outcome = `${r.status} ${r.body.error}`; } catch (e) { outcome = `${e.code} ${e.message}`; }
      // The Blobs path never touches the network, so this answer alone means the call took the SQL route.
      assert.match(outcome, /network access is blocked/, `${action}: ${outcome}`);
      if (blockedCalls.slice(before).some((c) => c.what === "connect")) sockets++;
    }
    // The bundled client is shared between calls, so a later call can fail on the socket an earlier one was refused.
    assert.ok(sockets > 0, "a database socket was refused");
  });

  test("sql, end to end on dev: reads and refusals through the real handler (nothing written)", async () => {
    const { localVar } = await import("../env.mjs");
    const old = await openOld(EXPORT, { allowDb: true });
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    const page = await old.call("outreach.prospects.list", { limit: 5 });
    assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 200));
    assert.equal(page.body.data.rows.length, 5);
    assert.equal((await old.call("outreach.leads.list", { campaign_id: ids.campaign_id })).status, 200);
    assert.deepEqual(await old.call("outreach.leads.list", {}), { status: 400, body: { ok: false, error: "campaign_id required" } });
    assert.deepEqual(await old.call("outreach.leads.update", { campaign_id: ids.campaign_id, lead_id: "no-such-lead", excluded: true }), { status: 404, body: { ok: false, error: "lead not found" } });
    assert.equal((await old.call("outreach.search", { q: "a" })).status, 400);
    assert.equal((await old.call("outreach.search", { q: "plumb" })).status, 200);
    assert.equal((await old.call("outreach.lead.facts.list", { lead_id: ids.lead_id })).status, 200);
  });
});

// ── Chunk 4: lead finding, and outreach.leads.add (new, SQL only) ──
const BASE4 = "ee91060"; // the last commit before chunk 4 touched command.ts
const CHUNK4 = ["outreach.browsercheck.plan", "outreach.browsercheck.start", "outreach.campaign.run", "outreach.campaign.sync", "outreach.leads.add_test", "outreach.leads.enrich_one", "outreach.leads.check_site"];

describe("DATA_BACKEND switch, chunk 4 actions", { skip }, () => {
  let openOld, p;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    const n = (await import("../equiv/new-path.mjs")).openNew("dev");
    p = await n.call(async (tx) => (await tx`select l.id as lead_id, l.campaign_id from leads l join campaigns c on c.id = l.campaign_id where l.website is null and l.merged_into is null and not l.is_test order by l.id limit 1`)[0]);
    await n.close();
  });
  afterEach(() => { delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL; });

  const calls = () => [
    ["outreach.browsercheck.plan", { campaign_id: p.campaign_id }],
    ["outreach.browsercheck.start", { campaign_id: p.campaign_id }],
    ["outreach.campaign.run", { id: p.campaign_id }],
    ["outreach.campaign.sync", { id: p.campaign_id }],
    ["outreach.leads.add_test", { campaign_id: p.campaign_id, email: "switch.four@alcance-test.invalid" }],
    ["outreach.leads.enrich_one", { campaign_id: p.campaign_id, lead_id: p.lead_id }],
    ["outreach.leads.check_site", { campaign_id: p.campaign_id, lead_id: p.lead_id }],
    ["outreach.leads.add", { campaign_id: p.campaign_id, format: "single", lead: { name: "x", phone: "5550100000" } }],
    ["outreach.leads.list", { campaign_id: p.campaign_id }],
  ];

  test("unset: every chunk 4 action (and outreach.leads.add) answers and writes exactly as command.ts did before chunk 4", async () => {
    const run = async (old) => {
      const answers = [];
      for (const [action, params] of calls()) answers.push({ action, ...(await old.call(action, params)) });
      const stores = Object.fromEntries([...STORES, "agent-hq-activity"].map((name) => [name, Object.fromEntries([...(storeMap(old.blobs, name))].map(([k, v]) => [k, JSON.parse(v)]))]));
      return { answers, stores };
    };
    const was = await run(await openOld(EXPORT, { commit: BASE4 }));
    const now = await run(await openOld(EXPORT));
    // add_test makes a new id each time; compare with ids and times ignored.
    for (const [i, w] of was.answers.entries()) {
      const r = compare(w, now.answers[i], { ignoreKeys: ["id", "lead_id"] });
      assert.ok(r.same, `${w.action} (call ${i + 1})\n${describeDiff(r)}`);
    }
    const strip = (s) => Object.values(s).map((v) => (v && typeof v === "object" ? { ...v, id: undefined, details: v.details ? { ...v.details, lead_id: undefined } : undefined } : v));
    for (const name of Object.keys(was.stores)) {
      const r = compare(strip(was.stores[name]), strip(now.stores[name]), { unordered: ["$"] });
      assert.ok(r.same, `${name}\n${describeDiff(r)}`);
    }
    assert.equal(was.answers[4].status, 200, "add_test really wrote a lead");
    assert.deepEqual(was.answers[7].body, { ok: false, error: "Unknown action: outreach.leads.add" });
    console.log(`switch unset (chunk 4): ${was.answers.length} calls and ${Object.keys(was.stores).length} stores are the same before and after chunk 4`);
  });

  test("sql: the chunk 4 actions go to the SQL module (the Blobs path never touches the network)", async () => {
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    let sockets = 0;
    for (const [action, params] of calls().slice(0, 8)) {
      const old = await openOld(EXPORT);
      process.env.DATA_BACKEND = "sql";
      process.env.DATABASE_URL = "postgres://switch-test:not-a-password@db.invalid:5432/none";
      const before = blockedCalls.length;
      let outcome;
      try { const r = await old.call(action, params); outcome = `${r.status} ${r.body.error}`; } catch (e) { outcome = `${e.code} ${e.message}`; }
      assert.match(outcome, /network access is blocked/, `${action}: ${outcome}`);
      if (blockedCalls.slice(before).some((c) => c.what === "connect")) sockets++;
    }
    assert.ok(sockets > 0, "a database socket was refused");
  });

  test("sql, end to end on dev: reads and refusals through the real handler and its deps (nothing written)", async () => {
    const { localVar } = await import("../env.mjs");
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    const before = blockedCalls.length;
    const old = await openOld(EXPORT, { allowDb: true });
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    const plan = await old.call("outreach.browsercheck.plan", { campaign_id: p.campaign_id });
    assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 200));
    assert.equal(typeof plan.body.data.cap, "number");
    assert.deepEqual(await old.call("outreach.campaign.run", { id: "no-such-campaign" }), { status: 404, body: { ok: false, error: "campaign not found" } });
    assert.deepEqual(await old.call("outreach.browsercheck.start", { campaign_id: p.campaign_id }), { status: 400, body: { ok: false, error: "Apify key not configured. Add it in Settings to use the browser check." } });
    assert.deepEqual(await old.call("outreach.leads.add", { format: "single" }), { status: 400, body: { ok: false, error: "campaign_id required" } });
    const sync = await old.call("outreach.campaign.sync", { id: p.campaign_id });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.data.changed, false);
    assert.equal(blockedCalls.length, before, "nothing else reached for the network");
  });
});

const BASE5 = "bc04e1e"; // the last commit before chunk 5 touched command.ts

describe("DATA_BACKEND switch, chunk 5 actions", { skip }, () => {
  let openOld, p;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    const n = (await import("../equiv/new-path.mjs")).openNew("dev");
    // A campaign with a drafted email and a sent one (the export and dev share ids).
    p = await n.call(async (tx) => (await tx`select e.campaign_id, e.id as email_id, e.lead_id from emails e join leads l on l.id = e.lead_id where e.status = 'drafted' and not e.is_duplicate and l.merged_into is null order by e.id limit 1`)[0]);
    await n.close();
  });
  afterEach(() => { delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL; });

  const calls = () => [
    ["outreach.emails.list", { campaign_id: p.campaign_id }],
    ["outreach.footer.preview", { campaign_id: p.campaign_id, email_id: p.email_id }],
    ["outreach.emails.update", { campaign_id: p.campaign_id, email_id: p.email_id, subject: "Switch test subject" }],
    ["outreach.emails.create", { campaign_id: p.campaign_id, lead_id: p.lead_id, subject: "Switch test", body_text: "Switch test body.", sequence_position: 3 }],
    ["outreach.emails.delete", { campaign_id: p.campaign_id, email_id: p.email_id }],
    ["outreach.emails.review.start", { campaign_id: p.campaign_id }],
    ["outreach.draft.start", { campaign_id: p.campaign_id }],
    ["outreach.emails.generate_one", { campaign_id: p.campaign_id, lead_id: p.lead_id }],
    ["outreach.emails.generate", { campaign_id: p.campaign_id }],
    ["outreach.emails.list", { campaign_id: p.campaign_id }],
  ];

  test("unset: every chunk 5 action answers and writes exactly as command.ts did before chunk 5", async () => {
    const run = async (old) => {
      const answers = [];
      for (const [action, params] of calls()) answers.push({ action, ...(await old.call(action, params)) });
      const stores = Object.fromEntries([...STORES, "agent-hq-activity"].map((name) => [name, Object.fromEntries([...(storeMap(old.blobs, name))].map(([k, v]) => [k, JSON.parse(v)]))]));
      return { answers, stores };
    };
    const was = await run(await openOld(EXPORT, { commit: BASE5 }));
    const now = await run(await openOld(EXPORT));
    // create and update stamp new ids and times; compare with those ignored.
    const ignoreKeys = ["id", "created_at", "updated_at", "reviewed_at", "at"];
    const known5 = [];
    for (const [i, w] of was.answers.entries()) {
      const r = compare(w, now.answers[i], { ignoreKeys, known: RULES5_KNOWN });
      assert.ok(r.same, `${w.action} (call ${i + 1})\n${describeDiff(r)}`);
      known5.push(...r.known);
    }
    // Stores keep their keys, so each draft is compared with itself.
    const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (ignoreKeys.includes(k) ? undefined : v)));
    for (const name of Object.keys(was.stores)) {
      const r = compare(strip(was.stores[name]), strip(now.stores[name]), { known: RULES5_KNOWN });
      assert.ok(r.same, `${name}\n${describeDiff(r)}`);
      known5.push(...r.known);
    }
    const statusChanges = known5.filter((h) => /review_status$/.test(h.path)).map((h) => `${h.old} → ${h.new}`);
    console.log(`switch unset (chunk 5), intended differences: ${knownSummary(known5) || "none"}; review status changes: ${statusChanges.length ? statusChanges.join(", ") : "none"}`);
    assert.equal(was.answers[2].status, 200, "update really wrote");
    assert.equal(was.answers[3].status, 200, "create really wrote");
    console.log(`switch unset (chunk 5): ${was.answers.length} calls and ${Object.keys(was.stores).length} stores are the same before and after chunk 5`);
  });

  test("sql: the chunk 5 actions go to the SQL module; generate_one / generate answer 501 before any database call", async () => {
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    let sockets = 0;
    for (const [action, params] of calls().slice(0, 7)) {
      const old = await openOld(EXPORT);
      process.env.DATA_BACKEND = "sql";
      process.env.DATABASE_URL = "postgres://switch-test:not-a-password@db.invalid:5432/none";
      const before = blockedCalls.length;
      let outcome;
      try { const r = await old.call(action, params); outcome = `${r.status} ${r.body.error}`; } catch (e) { outcome = `${e.code} ${e.message}`; }
      assert.match(outcome, /network access is blocked/, `${action}: ${outcome}`);
      if (blockedCalls.slice(before).some((c) => c.what === "connect")) sockets++;
    }
    assert.ok(sockets > 0, "a database socket was refused");
    for (const [action, params] of calls().slice(7, 9)) {
      const old = await openOld(EXPORT);
      process.env.DATA_BACKEND = "sql";
      process.env.DATABASE_URL = "postgres://switch-test:not-a-password@db.invalid:5432/none";
      const before = blockedCalls.length;
      const r = await old.call(action, params);
      assert.equal(r.status, 501, action);
      assert.equal(blockedCalls.length, before, `${action} reached for nothing`);
    }
  });

  test("sql, end to end on dev: reads and refusals through the real handler (nothing written)", async () => {
    const { localVar } = await import("../env.mjs");
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    const before = blockedCalls.length;
    const old = await openOld(EXPORT, { allowDb: true });
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    const list = await old.call("outreach.emails.list", { campaign_id: p.campaign_id });
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
    assert.ok(list.body.data.some((e) => e.id === p.email_id));
    const foot = await old.call("outreach.footer.preview", { campaign_id: p.campaign_id, email_id: p.email_id });
    assert.equal(foot.status, 200);
    assert.equal(typeof foot.body.data.footer_text, "string");
    assert.deepEqual(await old.call("outreach.emails.create", { campaign_id: p.campaign_id, lead_id: p.lead_id }), { status: 400, body: { ok: false, error: "subject required" } });
    assert.deepEqual(await old.call("outreach.emails.update", { campaign_id: p.campaign_id, email_id: "no-such-email" }), { status: 404, body: { ok: false, error: "email not found" } });
    assert.deepEqual(await old.call("outreach.emails.delete", { campaign_id: p.campaign_id }), { status: 400, body: { ok: false, error: "campaign_id and email_id required" } });
    assert.equal(blockedCalls.length, before, "nothing else reached for the network");
  });
});
