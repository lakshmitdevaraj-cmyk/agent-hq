// R13 for chunk 2: every rewritten campaign action, old path (real command.ts on the P1 export, network blocked)
// vs its SQL version in lib/sql/campaigns.ts on Neon dev (transactions rolled back). Skipped without the export.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
/** One store of a fake-blobs set (stores load on first use). */
const storeMap = (blobs, name) => (blobs.getStore(name), blobs.stores.get(name));
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
const C = "../equiv/cases/";

/** Prints the diff report (emails masked) and fails on anything unexpected. */
function same(label, oldValue, newValue, opts) {
  const r = compare(oldValue, newValue, opts);
  console.log(`${label}: ${describeDiff(r, 5)}`);
  assert.ok(r.same, `${label}\n${describeDiff(r)}`);
  return r;
}

describe("chunk 2 campaign actions: old vs new", { skip }, () => {
  let openOld, fresh, shared, merged, oldList;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    shared = await import(C + "shared.mjs");
    merged = await fresh.call(shared.mergedCounts);
    const res = await (await openOld(EXPORT)).call("outreach.campaign.list");
    assert.equal(res.status, 200);
    oldList = res.body.data;
  });
  after(() => fresh?.close());

  test("campaign.list (no params)", async () => {
    const cs = await import(C + "campaign-list-sql.mjs");
    const r = same("list", oldList, await fresh.call(cs.sqlVersion), { known: cs.known(oldList, merged) });
    const expectF17 = oldList.filter((c) => (merged.get(c.id) ?? 0) > 0).length;
    assert.equal(r.known.filter((d) => d.path.endsWith("leads_imported")).length, expectF17, "each campaign with merged leads shows the F17 difference");
    assert.ok(expectF17 > 0, "the export has merged leads, so F17 is really tested");
  });

  test("campaign.get for every campaign, a missing id and no id", async () => {
    const cs = await import(C + "campaign-get.mjs");
    const old = await openOld(EXPORT);
    const { pmap } = await import("../equiv/new-path.mjs"); // campaigns are independent: six side by side, the same checks
    for (const [id, o, n] of await pmap(oldList, 6, async ({ id }) => [id, await old.call(cs.action, { id }), await fresh.call(cs.sqlVersion, { id })])) same(`get ${id}`, o, n, { known: cs.known(id, merged, "\\$\\.body\\.data") });
    for (const p of [{ id: cs.MISSING_ID }, {}]) same(`get ${JSON.stringify(p)}`, await old.call(cs.action, p), await fresh.call(cs.sqlVersion, p));
  });

  test("leads.count for every campaign (merged leads left out)", async () => {
    const cs = await import(C + "leads-count.mjs");
    const old = await openOld(EXPORT);
    let f17 = 0;
    const { pmap } = await import("../equiv/new-path.mjs");
    for (const [id, o, n] of await pmap(oldList, 6, async ({ id }) => [id, await old.call(cs.action, { campaign_id: id }), await fresh.call(cs.sqlVersion, { campaign_id: id })])) {
      const r = compare(o.body, n.body, { known: cs.known(id, merged) });
      assert.ok(r.same, describeDiff(r));
      assert.equal(n.status, o.status);
      f17 += r.known.length;
    }
    console.log(`leads.count: ${oldList.length} campaigns, ${f17} lower by their merged rows (F17)`);
    assert.equal(f17, [...merged.values()].filter((n) => n > 0).length);
    same("leads.count no id", await old.call(cs.action, {}), await fresh.call(cs.sqlVersion, {}));
  });

  test("S0: search, filters and sort give the same campaigns in the same order as the written rule", async () => {
    const cs = await import(C + "campaign-search.mjs");
    const due = await fresh.call(cs.followupsDueIds);
    const { pmap } = await import("../equiv/new-path.mjs");
    const combos = cs.combos(oldList);
    const results = await pmap(combos, 6, (p) => fresh.call(cs.sqlVersion, p)); // read only and independent: six side by side
    for (const [i, p] of combos.entries()) {
      const got = results[i].map((c) => c.id);
      const want = cs.reference(oldList, p, due);
      assert.deepEqual(got, want, `search ${JSON.stringify(p.filter ?? p.sort ?? "")} q-length ${String(p.q ?? "").length}`);
    }
    console.log(`S0: ${cs.combos(oldList).length} combinations match (${due.size} campaigns with follow-ups due)`);
  });

  test("campaign.create, then read straight back (F1)", async () => {
    const cs = await import(C + "campaign-create.mjs");
    const old = await openOld(EXPORT);
    const made = await old.call(cs.action, cs.input);
    assert.equal(made.status, 200);
    const oldId = made.body.data.id;
    const got = await old.call("outreach.campaign.get", { id: oldId });
    const first = (await old.call("outreach.campaign.list")).body.data[0];
    const act = [...storeMap(old.blobs, "agent-hq-activity").values()].map((v) => JSON.parse(v)).find((a) => a.details?.campaign_id === oldId);
    const n = await fresh.callWrite(cs.sqlVersion, cs.input);
    const opts = { ignoreKeys: cs.ignoreKeys };
    same("create", made, n.made, opts);
    same("create → get", got, n.got, opts);
    same("create → list[0]", first, n.first, opts);
    same("create → activity", { agent_id: act.agent_id, category: act.category, summary: act.summary, details: act.details }, n.activity, opts);
    for (const p of [{ query: "x" }, { name: "x" }, { name: " ", query: "x" }]) {
      same(`create ${Object.keys(p)}`, await old.call(cs.action, p), (await fresh.callWrite(cs.sqlVersion, p)).made);
    }
  });

  test("campaign.update: twelve patches in a row, then read straight back (F1)", async () => {
    const cs = await import(C + "campaign-update.mjs");
    const id = await fresh.call(async (tx) => (await tx`select campaign_id from campaign_jobs where kind = 'social' order by campaign_id limit 1`)[0].campaign_id);
    const old = await openOld(EXPORT);
    const n = await fresh.callWrite(cs.sqlVersion, { id });
    for (const [i, patch] of cs.steps.entries()) {
      same(`update ${i + 1} ${Object.keys(patch)}`, await old.call(cs.action, { id, ...patch }), n.answers[i], { known: shared.oneKnown(id, merged, "\\$\\.body\\.data") });
    }
    same("update no id", await old.call(cs.action, { name: "x" }), n.missingId);
    same("update unknown id", await old.call(cs.action, { id: "no-such-campaign-equiv", name: "x" }), n.unknownId);
    same("update → get", await old.call("outreach.campaign.get", { id }), n.readBack, { known: shared.oneKnown(id, merged, "\\$\\.body\\.data") });
    assert.equal(n.readBack.body.data.any_trade, true);
    assert.equal(n.readBack.body.data.equiv_new_flag, "kept in data");
  });

  test("campaign.delete, then read straight back (F1)", async () => {
    const cs = await import(C + "campaign-delete.mjs");
    const id = await fresh.call(cs.pick);
    assert.ok(id);
    const old = await openOld(EXPORT);
    const n = await fresh.callWrite(cs.sqlVersion, { id });
    same("delete", await old.call(cs.action, { id }), n.deleted);
    assert.ok(n.deleted.body.data.drafts_deleted > 0 && n.deleted.body.data.sent_kept > 0 && n.deleted.body.data.leads_deleted > 0);
    same("delete no id", await old.call(cs.action, {}), n.missingId);
    same("delete → get", await old.call("outreach.campaign.get", { id }), n.after);
    same("delete → leads.count", await old.call("outreach.leads.count", { campaign_id: id }), n.count);
    const oldLeft = [...storeMap(old.blobs, "agent-hq-outreach-emails").keys()].filter((k) => k.startsWith(`${id}/`)).length;
    assert.equal(n.emailsLeft, oldLeft);
    assert.equal(n.emailsLeft, n.deleted.body.data.sent_kept);
  });
});
