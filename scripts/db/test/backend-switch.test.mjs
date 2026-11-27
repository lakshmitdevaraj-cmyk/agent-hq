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
    for (const [i, w] of was.answers.entries()) {
      const r = compare(w, now.answers[i]);
      assert.ok(r.same, `${w.action} (call ${i + 1})\n${describeDiff(r)}`);
    }
    for (const name of Object.keys(was.stores)) {
      const r = compare(was.stores[name], now.stores[name]);
      assert.ok(r.same, `${name}\n${describeDiff(r)}`);
    }
    // Real data and real writes, not two empty answers.
    assert.ok(was.answers[0].body.data.length > 0 && was.answers[1].body.data.length > 100);
    assert.ok(was.answers[3].body.data.drafts_updated > 0);
    assert.equal(was.answers[8].body.data.deleted, true);
    for (const a of was.answers.filter((x) => CHUNK3_NEW.includes(x.action))) assert.deepEqual(a.body, { ok: false, error: `Unknown action: ${a.action}` });
    console.log(`switch unset (chunk 3): ${was.answers.length} calls and ${Object.keys(was.stores).length} stores are the same before and after chunk 3`);
  });

  test("sql: the chunk 3 actions go to the SQL module (a database socket is reached for)", async () => {
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    for (const action of ["outreach.leads.list", "outreach.prospects.list", "outreach.lead.set_email", "outreach.leads.update", "outreach.leads.delete", "outreach.lead.fb_checked", "outreach.lead.screenshot.get", ...CHUNK3_NEW]) {
      const old = await openOld(EXPORT);
      process.env.DATA_BACKEND = "sql";
      process.env.DATABASE_URL = "postgres://switch-test:not-a-password@db.invalid:5432/none";
      const before = blockedCalls.length;
      let outcome;
      try { const r = await old.call(action, { ...ids, email: "x@alcance-test.invalid", excluded: true, result: "real", q: "switch", fact: "x" }); outcome = `${r.status} ${r.body.error}`; } catch (e) { outcome = `${e.code} ${e.message}`; }
      assert.match(outcome, /network access is blocked/, `${action}: ${outcome}`);
      assert.ok(blockedCalls.slice(before).some((c) => c.what === "connect"), `${action}: a database socket was refused`);
    }
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
