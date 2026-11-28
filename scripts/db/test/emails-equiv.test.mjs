// R13 for chunk 5: the email actions, old path (real command.ts on the P1 export, network blocked) vs their SQL versions
// in lib/sql/emails.ts on Neon dev (transactions rolled back). Skipped without the export.
// Intended differences are listed in scripts/db/equiv/cases/emails.mjs (P1 merges, step fixes, column defaults) and
// below (duplicate rows and merged leads are left out of the list; the footer gains a postal-address warning).
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

describe("chunk 5 email actions: old vs new", { skip }, () => {
  let openOld, fresh, cs, campaigns, merged, dups, moved;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    cs = await import("../equiv/cases/emails.mjs");
    merged = await fresh.call(cs.mergedInto);
    dups = await fresh.call(cs.duplicateIds);
    moved = await fresh.call(cs.movedIds);
    campaigns = (await (await openOld(EXPORT)).call("outreach.campaign.list")).body.data.map((c) => c.id);
  });
  after(() => fresh?.close());

  test("emails.list for every campaign: the same rows and annotations (duplicate rows left out; P1 merges and step fixes known)", async () => {
    const old = await openOld(EXPORT);
    let compared = 0, hiddenDups = 0, annotated = 0, rechecked = 0;
    // Campaigns are independent, so six run side by side (each its own rolled-back transaction); the checks are unchanged.
    const { pmap } = await import("../equiv/new-path.mjs");
    const pairs = await pmap(campaigns, 6, async (campaign_id) => [campaign_id, await old.call("outreach.emails.list", { campaign_id, limit: 100000 }),
      // A write transaction (rolled back): since RULES_VERSION 5 the list re-checks dev's version-4 drafts and saves the stamp, as the old path does.
      await fresh.callWrite(cs.list, { campaign_id, limit: 100000 })]);
    for (const [campaign_id, o, n] of pairs) {
      assert.equal(n.status, o.status);
      const kept = o.body.data.filter((e) => !dups.has(e.id));
      hiddenDups += o.body.data.length - kept.length;
      const ns = n.body.data;
      for (let i = 1; i < ns.length; i++) assert.ok(String(ns[i - 1].created_at) >= String(ns[i].created_at), "newest first");
      assert.ok(ns.every((e) => !dups.has(e.id)), "no duplicate row in the SQL list");
      const sortedOld = [...kept].sort(byCreated);
      same(`emails.list ${campaign_id}`, sortedOld, [...ns].sort(byCreated), { known: cs.emailKnown("\\$\\[\\d+\\]", { ids: (p) => sortedOld[Number(p.match(/^\$\[(\d+)\]/)[1])]?.id, moved, merged }) });
      compared += ns.length;
      annotated += ns.filter((e) => e.blocked_lead_skipped || e.blocked_do_not_contact || e.blocked_contact).length;
      rechecked += ns.filter((e) => e.reviewed_by === "code checks").length;
    }
    console.log(`emails.list: ${campaigns.length} campaigns, ${compared} emails compared, ${hiddenDups} duplicate rows left out, ${annotated} annotated, ${rechecked} blocked by code checks`);
    assert.ok(compared > 0 && annotated > 0, "the export has emails, and some are annotated");
  });

  test("emails.list: a campaign that does not exist, and no campaign_id", async () => {
    const old = await openOld(EXPORT);
    same("list unknown", await old.call("outreach.emails.list", { campaign_id: "no-such-campaign" }), await fresh.call(cs.list, { campaign_id: "no-such-campaign" }));
    same("list no id", await old.call("outreach.emails.list", {}), await fresh.call(cs.list, {}));
  });

  test("footer.preview: the same footer text for a draft of several campaigns; the postal-address warning is the intended addition", async () => {
    const old = await openOld(EXPORT);
    const picks = await fresh.call(cs.pickDraftsAcrossCampaigns, 8);
    assert.ok(picks.length >= 3);
    let warned = 0;
    for (const p of picks) {
      const o = await old.call("outreach.footer.preview", { campaign_id: p.campaign_id, email_id: p.id });
      const nn = await fresh.call(cs.footer, { campaign_id: p.campaign_id, email_id: p.id });
      if (nn.body.data?.postal_address_missing) warned++;
      same(`footer ${p.id}`, o, nn, { known: [
        { path: /^\$\.body\.data\.postal_address_missing$/, when: (d) => d.old === "(absent)" && d.new === true, why: "R9: the US needs a postal address; none is saved" },
        { path: /^\$\.body\.data\.warning$/, when: (d) => d.old === "(absent)", why: "R9: the warning that goes with it" },
      ] });
    }
    console.log(`footer.preview: ${picks.length} compared, ${warned} with the postal-address warning`);
    same("footer unknown", await old.call("outreach.footer.preview", { campaign_id: picks[0].campaign_id, email_id: "no-such-email" }), await fresh.call(cs.footer, { campaign_id: picks[0].campaign_id, email_id: "no-such-email" }));
    same("footer no ids", await old.call("outreach.footer.preview", {}), await fresh.call(cs.footer, {}));
  });

  test("emails.update: edit, mark ready, refusals (answers compared), then the row read back from the list (F1)", async () => {
    const old = await openOld(EXPORT);
    const { id: email_id, campaign_id } = await fresh.call(cs.pickDraft, 0);
    const sent = await fresh.call(cs.pickSent);
    const steps = [
      ["bad review_status", { review_status: "blocked" }],
      ["bad address", { to_email: "not an address" }],
      ["empty subject", { subject: "  " }],
      ["unknown", { email_id: "no-such-email", subject: "x" }],
      ["no ids", { email_id: undefined, campaign_id: undefined, subject: "x" }],
      ["edit", { subject: " plumbing ", body_text: "Hello. I noticed your plumbing crew works around Katy. Would you like me to send a short recording of an assistant answering a call?" }],
      ["address", { to_email: " New.Address@Equiv-Test.invalid " }],
      ["hard hit", { body_text: "Quick question about your crew. Would you like me to send a short recording?" }],
      ["ready while hard", { review_status: "ready" }],
      ["fix", { body_text: "Hello. I noticed your plumbing crew works around Katy. Would you like me to send a short recording of an assistant answering a call?" }],
      ["ready", { review_status: "ready" }],
    ];
    const n = await fresh.callWrite(async (tx) => {
      const out = [];
      for (const [, p] of steps) out.push(await cs.update(tx, { campaign_id, email_id, ...p }));
      out.push(await cs.update(tx, { campaign_id: sent.campaign_id, email_id: sent.id, subject: "x" }));
      out.push(await cs.list(tx, { campaign_id, limit: 100000 }));
      return out;
    });
    for (const [i, [label, p]] of steps.entries()) {
      // Intended: after an edit the SQL path stamps the rules version its check just used; the old path keeps the older number
      // (and re-checks the draft again later). Hidden until RULES_VERSION 5, because the export and the code were both at 4.
      // Intended (5b, SQL path only): an address on another domain than the website adds the F35 "Check this" reason, from that step on (the address stays).
      const f35 = { path: /\.body\.data\.review_reasons(\.length|\[\d+\])$/, why: "5b F35: the new address is not on the website's domain (Check this)" };
      const stamp = { path: /\.body\.data\.rules_version$/, when: (d) => d.old === 4 && d.new === 5, why: "SQL stamps the rules version an edit was checked with" };
      same(`update ${label}`, await old.call("outreach.emails.update", { campaign_id, email_id, ...p }), n[i], { known: [...cs.emailKnown("\\$\\.body\\.data", { moved, merged }), stamp, ...(i >= steps.findIndex(([l]) => l === "address") ? [f35] : [])] });
    }
    same("update a sent email", await old.call("outreach.emails.update", { campaign_id: sent.campaign_id, email_id: sent.id, subject: "x" }), n[steps.length]);
    const oldRow = (await old.call("outreach.emails.list", { campaign_id, limit: 100000 })).body.data.find((e) => e.id === email_id);
    const newRow = n[steps.length + 1].body.data.find((e) => e.id === email_id);
    same("update → list row", oldRow, newRow, { known: cs.emailKnown("\\$", { moved, merged }) });
    assert.equal(newRow.review_status, "ready");
  });

  test("emails.delete: a draft goes, a sent email stays, refusals; the list read back (F1)", async () => {
    const old = await openOld(EXPORT);
    const { id: email_id, campaign_id } = await fresh.call(cs.pickDraft, 3);
    const sent = await fresh.call(cs.pickSent);
    const n = await fresh.callWrite(async (tx) => ({
      del: await cs.remove(tx, { campaign_id, email_id }), again: await cs.remove(tx, { campaign_id, email_id }),
      sent: await cs.remove(tx, { campaign_id: sent.campaign_id, email_id: sent.id }), noId: await cs.remove(tx, { campaign_id }),
      list: await cs.list(tx, { campaign_id, limit: 100000 }),
    }));
    same("delete", await old.call("outreach.emails.delete", { campaign_id, email_id }), n.del);
    same("delete again", await old.call("outreach.emails.delete", { campaign_id, email_id }), n.again);
    same("delete sent", await old.call("outreach.emails.delete", { campaign_id: sent.campaign_id, email_id: sent.id }), n.sent);
    same("delete no id", await old.call("outreach.emails.delete", { campaign_id }), n.noId);
    assert.ok(!n.list.body.data.some((e) => e.id === email_id));
    assert.ok(!(await old.call("outreach.emails.list", { campaign_id, limit: 100000 })).body.data.some((e) => e.id === email_id));
  });
});
