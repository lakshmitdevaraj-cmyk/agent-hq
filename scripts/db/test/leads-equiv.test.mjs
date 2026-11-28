// R13 for chunk 3: the lead and Prospects actions, old path (real command.ts on the P1 export, network blocked) vs
// their SQL versions in lib/sql/leads.ts and search.ts on Neon dev (transactions rolled back). Skipped without the export.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";

function same(label, oldValue, newValue, opts) {
  const r = compare(oldValue, newValue, opts);
  console.log(`${label}: ${describeDiff(r, 5)}`);
  assert.ok(r.same, `${label}\n${describeDiff(r)}`);
  return r;
}
const byCreated = (a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || String(a.id).localeCompare(String(b.id));

describe("chunk 3 lead actions: old vs new", { skip }, () => {
  let openOld, fresh, cs, merged, campaigns;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    cs = await import("../equiv/cases/leads.mjs");
    merged = await fresh.call(cs.mergedIds);
    campaigns = (await (await openOld(EXPORT)).call("outreach.campaign.list")).body.data.map((c) => c.id);
  });
  after(() => fresh?.close());

  test("leads.list for every campaign (merged leads left out), plus no id", async () => {
    const old = await openOld(EXPORT);
    let hidden = 0, compared = 0;
    const { pmap } = await import("../equiv/new-path.mjs"); // campaigns are independent: six side by side, the same checks
    for (const [campaign_id, o, n] of await pmap(campaigns, 6, async (campaign_id) => [campaign_id, await old.call("outreach.leads.list", { campaign_id }), await fresh.call(cs.list, { campaign_id })])) {
      assert.equal(n.status, o.status);
      const kept = o.body.data.filter((l) => !merged.has(l.id));
      hidden += o.body.data.length - kept.length;
      // Order: newest first on both sides; ties on created_at are put in id order before comparing.
      const ns = n.body.data;
      for (let i = 1; i < ns.length; i++) assert.ok(String(ns[i - 1].created_at) >= String(ns[i].created_at), "newest first");
      same(`leads.list ${campaign_id}`, [...kept].sort(byCreated), [...ns].sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
      assert.ok(ns.every((l) => !merged.has(l.id)), "no merged lead in the SQL list");
      compared += ns.length;
    }
    console.log(`leads.list: ${campaigns.length} campaigns, ${compared} leads compared, ${hidden} merged leads left out (F17)`);
    assert.equal(hidden, merged.size - 0 /* every merged lead belongs to a listed campaign */ - (await fresh.call(async (tx) => (await tx`select count(*)::int n from leads l where merged_into is not null and not exists (select 1 from campaigns c where c.id = l.campaign_id)`)[0].n)));
    same("leads.list no id", await old.call("outreach.leads.list", {}), await fresh.call(cs.list, {}));
  });

  test("prospects.list: the whole answer (merged leads left out)", async () => {
    const o = (await (await openOld(EXPORT)).call("outreach.prospects.list")).body.data;
    const n = await fresh.call(cs.prospects, {});
    assert.equal(n.status, 200);
    const fromMerges = await fresh.call(cs.linksFromMerges);
    const kept = o.filter((r) => !merged.has(r.id));
    assert.equal(o.length - kept.length, merged.size, "exactly the merged leads are left out");
    const at = (path) => n.body.data[Number(path.match(/^\$\[(\d+)\]/)[1])]?.id;
    same("prospects.list", kept, n.body.data, {
      known: [
        ...cs.leadKnown("\\$\\[\\d+\\]"),
        { path: /^\$\[\d+\]\.facts$/, when: (d) => d.old === "(absent)", why: "F18: hand-typed facts are shown" },
        { path: /^\$\[\d+\]\.social\.\w+$/, when: (d) => d.old === "(absent)" && fromMerges.has(`${at(d.path)}/${d.path.split(".").pop()}`), why: "P1 merge: the kept lead has its merged twin's page" },
      ],
    });
  });

  test("lead.screenshot.get: none saved, and no ids", async () => {
    const old = await openOld(EXPORT);
    const { id, campaign_id } = await fresh.call(cs.pickLeadWithDraft);
    same("screenshot none", await old.call("outreach.lead.screenshot.get", { campaign_id, lead_id: id }), await fresh.call(cs.screenshot, { campaign_id, lead_id: id }));
    same("screenshot no ids", await old.call("outreach.lead.screenshot.get", {}), await fresh.call(cs.screenshot, {}));
  });

  test("lead.set_email: refusals, set (drafts follow), clear (drafts removed), each read back (F1)", async () => {
    const { id: lead_id, campaign_id } = await fresh.call(cs.pickLeadWithMail);
    const old = await openOld(EXPORT);
    const call = (p) => old.call("outreach.lead.set_email", p);
    const n = await fresh.callWrite(cs.setEmailRun, { campaign_id, lead_id });
    same("set_email bad", await call({ campaign_id, lead_id, email: "not an address" }), n.bad);
    same("set_email .gov", await call({ campaign_id, lead_id, email: "someone@city.gov" }), n.gov);
    same("set_email no id", await call({ email: cs.NEW_EMAIL }), n.noId);
    same("set_email unknown", await call({ campaign_id, lead_id: "no-such-lead-equiv", email: cs.NEW_EMAIL }), n.unknown);
    same("set_email set", await call({ campaign_id, lead_id, email: ` ${cs.NEW_EMAIL.toUpperCase()} ` }), n.set);
    assert.ok(n.set.body.data.drafts_updated > 0, "the lead's drafts were really updated");
    same("set_email → list", (await old.call("outreach.leads.list", { campaign_id })).body.data.filter((l) => !merged.has(l.id)).sort(byCreated), n.afterSet.body.data.sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
    assert.ok(n.draftsAfterSet.every((d) => d.to_email === cs.NEW_EMAIL && d.original_to_email), "every unsent draft goes to the new address");
    same("set_email clear", await call({ campaign_id, lead_id, email: "" }), n.clear);
    same("set_email clear → list", (await old.call("outreach.leads.list", { campaign_id })).body.data.filter((l) => !merged.has(l.id)).sort(byCreated), n.afterClear.body.data.sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
    assert.equal(n.draftsAfterClear, 0);
  });

  test("leads.update: seven patches, refusals, then read back (F1)", async () => {
    const { id: lead_id, campaign_id } = await fresh.call(cs.pickLeadWithDraft);
    const old = await openOld(EXPORT);
    const n = await fresh.callWrite(cs.updateRun, { campaign_id, lead_id });
    for (const [i, patch] of cs.UPDATE_STEPS.entries()) {
      same(`update ${i + 1} ${Object.keys(patch)}`, await old.call("outreach.leads.update", { campaign_id, lead_id, ...patch }), n.answers[i], { known: cs.leadKnown("\\$\\.body\\.data") });
    }
    assert.ok(n.answers.at(-1).body.data.drafts_deleted > 0, "excluding with delete_drafts removed drafts");
    const refusals = [...cs.UPDATE_REFUSALS.map((p) => ({ campaign_id, lead_id, ...p })), { campaign_id, excluded: true }, { campaign_id, lead_id: "no-such-lead-equiv", excluded: true }];
    for (const [i, p] of refusals.entries()) same(`update refusal ${i + 1}`, await old.call("outreach.leads.update", p), n.refusals[i]);
    same("update → list", (await old.call("outreach.leads.list", { campaign_id })).body.data.filter((l) => !merged.has(l.id)).sort(byCreated), n.readBack.body.data.sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
  });

  test("leads.delete: the lead, its drafts; sent emails stay; read back (F1)", async () => {
    const { id: lead_id, campaign_id } = await fresh.call(cs.pickLeadWithMail);
    const old = await openOld(EXPORT);
    const n = await fresh.callWrite(cs.deleteRun, { campaign_id, lead_id });
    same("delete", await old.call("outreach.leads.delete", { campaign_id, lead_id }), n.deleted);
    same("delete again", await old.call("outreach.leads.delete", { campaign_id, lead_id }), n.again);
    same("delete no id", await old.call("outreach.leads.delete", { campaign_id }), n.noId);
    same("delete → list", (await old.call("outreach.leads.list", { campaign_id })).body.data.filter((l) => !merged.has(l.id)).sort(byCreated), n.readBack.body.data.sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
    assert.equal(n.drafts, 0);
    assert.ok(n.sent > 0, "sent emails stay as history");
  });

  test("lead.fb_checked: set, refusals, clear, each read back (F1)", async () => {
    const { id: lead_id, campaign_id } = await fresh.call(cs.pickLeadWithDraft);
    const old = await openOld(EXPORT);
    const call = (p) => old.call("outreach.lead.fb_checked", p);
    const n = await fresh.callWrite(cs.fbRun, { campaign_id, lead_id });
    same("fb set", await call({ campaign_id, lead_id, result: "gone", note: "  page removed  " }), n.set);
    same("fb set → list", (await old.call("outreach.leads.list", { campaign_id })).body.data.filter((l) => !merged.has(l.id)).sort(byCreated), n.afterSet.body.data.sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
    same("fb bad", await call({ campaign_id, lead_id, result: "maybe" }), n.bad);
    same("fb unknown", await call({ campaign_id, lead_id: "no-such-lead-equiv", result: "real" }), n.unknown);
    same("fb no id", await call({ lead_id }), n.noId);
    same("fb clear", await call({ campaign_id, lead_id, result: null }), n.clear);
    same("fb clear → list", (await old.call("outreach.leads.list", { campaign_id })).body.data.filter((l) => !merged.has(l.id)).sort(byCreated), n.afterClear.body.data.sort(byCreated), { known: cs.leadKnown("\\$\\[\\d+\\]") });
  });
});
