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
    const viaSql = await old.call("outreach.campaign.list");
    assert.equal(viaSql.status, 500);
    assert.match(viaSql.body.error, /network access is blocked/, viaSql.body.error);
    delete process.env.DATA_BACKEND;
    const viaBlobs = await old.call("outreach.campaign.list");
    assert.equal(viaBlobs.status, 200);
    assert.ok(viaBlobs.body.data.length > 0);
  });

  test("any other value of DATA_BACKEND keeps Blobs", async () => {
    const old = await openOld(EXPORT);
    for (const v of ["blobs", "SQL", "", "postgres"]) {
      process.env.DATA_BACKEND = v;
      assert.equal((await old.call("outreach.leads.count", { campaign_id: ids[0] })).status, 200, v);
    }
  });
});
