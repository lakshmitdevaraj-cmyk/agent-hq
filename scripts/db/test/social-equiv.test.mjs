// R13 for chunk 8: follow-ups, social messages and touches, old path (real command.ts on the P1 export, network blocked)
// vs the SQL versions (lib/sql/followups.ts, lib/sql/social.ts) on Neon dev in rolled-back transactions. Intended
// differences are listed with a reason, counted and printed, never hidden. Skipped without the export.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
const tally = (m, why) => { m[why] = (m[why] ?? 0) + 1; };
const show = (m) => Object.entries(m).map(([k, v]) => `${v} × ${k}`).join("; ") || "none";
const sameInstant = (d) => typeof d.old === "string" && typeof d.new === "string" && Date.parse(d.old) === Date.parse(d.new);

describe("chunk 8 follow-ups, social and touches: old vs new", { skip }, () => {
  let old, fresh, so, fu, pmap;
  before(async () => {
    const { openOld } = await import("../equiv/old-path.mjs");
    old = await openOld(EXPORT);
    ({ pmap } = await import("../equiv/new-path.mjs"));
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    so = await import("../../../netlify/functions/lib/sql/social.ts");
    fu = await import("../../../netlify/functions/lib/sql/followups.ts");
  });
  after(() => fresh?.close());
  const wrap = (fn) => fresh.call(async (tx) => {
    try { return { status: 200, body: { ok: true, data: await fn(tx) } }; }
    catch (e) { if (e.status) return { status: e.status, body: { ok: false, error: e.message } }; throw e; }
  });
  const sqlSocial = (action, params) => wrap((tx) => so.runSocialAction(tx, action, params, { newId: () => "eq8" }));
  // followups.list also rewrites follow_ups, so it runs in a write transaction that is rolled back.
  const sqlFollow = (action, params) => fresh.callWrite(async (tx) => ({ status: 200, body: { ok: true, data: await fu.runFollowupAction(tx, action, params, {}) } }));

  test("followups.list: the same rows; due dates differ only by the F10 roll to a working day; stops differ only where the lead's stop_state says so", async () => {
    const a = (await old.call("followups.list")).body.data, b = (await sqlFollow("followups.list", {})).body.data;
    assert.equal(b.today, a.today);
    const leads = new Map((await fresh.call((tx) => tx`select id, stop_state, merged_into, data->'fb_checked'->>'result' as fb from leads`)).map((l) => [l.id, l]));
    const key = (r) => `${r.lead_id}/${r.channel}`;
    const newBy = new Map(b.rows.map((r) => [key(r), r]));
    const dues = [...new Set(a.rows.map((r) => r.due_date).filter(Boolean))];
    const rolled = new Map((await fresh.call((tx) => tx`select d::text as d, next_working_day(d, 'US')::text as w from unnest(${dues}::date[]) as d`)).map((x) => [x.d, x.w]));
    const why = {}, bad = [];
    for (const o of a.rows) {
      const n = newBy.get(key(o));
      const lead = leads.get(o.lead_id);
      if (!n) {
        if (!lead || lead.merged_into) tally(why, "F17: merged lead hidden");
        else if (o.channel === "facebook" && lead.fb === "gone") tally(why, "F11: Facebook page gone");
        else bad.push(`${key(o)} missing on SQL`);
        continue;
      }
      newBy.delete(key(o));
      const stopNew = n.bucket === "stopped", stopOld = o.bucket === "stopped";
      if (stopNew !== stopOld || n.stopped_reason !== o.stopped_reason) {
        if (stopNew && lead.stop_state !== "none") { tally(why, `F8: stop from stop_state (${lead.stop_state})`); continue; }
        if (!stopNew && lead.stop_state === "none") { tally(why, "F8: stop_state none (P1 decision, e.g. own test reply)"); continue; }
        bad.push(`${key(o)} stop ${o.stopped_reason}→${n.stopped_reason}`);
        continue;
      }
      if (n.due_date !== o.due_date) {
        if (!o.moved && rolled.get(o.due_date) === n.due_date) tally(why, "F10: due date rolled to the next working day");
        else bad.push(`${key(o)} due ${o.due_date}→${n.due_date}`);
        continue;
      }
      const r = compare(o, n, { known: [
        { path: /^\$\.(review_status|text)$/, why: "no re-check on read (F44 → P4)" },
        { path: /^\$\.last_sent_at$/, when: sameInstant, why: "same instant, as Postgres gives it back" },
      ] });
      for (const h of r.known) tally(why, h.why);
      if (!r.same) bad.push(`${key(o)}: ${describeDiff(r)}`);
    }
    for (const k of newBy.keys()) {
      const lead = leads.get(k.split("/")[0]);
      if (lead?.stop_state !== "none") tally(why, "F8: a stopped row the old rules did not see"); else bad.push(`${k} only on SQL`);
    }
    console.log(`followups.list: ${a.rows.length} old rows, ${b.rows.length} new; intended: ${show(why)}`);
    assert.deepEqual(bad, [], bad.slice(0, 10).join("\n"));
  });

  test("social.list for every campaign: the same records", async () => {
    const campaigns = (await old.call("outreach.campaign.list")).body.data.map((c) => c.id);
    const why = {}, bad = [];
    let records = 0;
    for (const [cid, a, b] of await pmap(campaigns, 6, async (cid) => [cid, await old.call("outreach.social.list", { campaign_id: cid }), await sqlSocial("outreach.social.list", { campaign_id: cid })])) {
      records += a.body.data.length;
      const r = compare(a, b, { unordered: ["body.data"], known: [
        { path: /\.(rules_version)$/, why: "no re-stamp on read (F44 → P4)" },
        { path: /\.(review_status|review_reasons(\[\d+\])?|review_reasons\.length)$/, why: "no re-check on read (F44 → P4)" },
        { path: /\.(created_at|updated_at|sent_at|reviewed_at)$/, when: sameInstant, why: "same instant, as Postgres gives it back" },
        { path: /\.(sent_at|skipped|touch_id|review_reasons|review_status)$/, when: (d) => d.old === "(absent)" && (d.new === null || d.new === false), why: "a part field the old record never had" },
        { path: /\.parts\[\d+\]\.skipped$/, when: (d) => d.old === "(absent)" && d.new === true, why: "F30: a do-not-contact lead's open step is skipped (migration 0015)" },
        { path: /\.skipped_reason$/, when: (d) => d.old === "(absent)" && d.new === "do_not_contact", why: "F30: why the steps were skipped" },
      ] });
      for (const h of r.known) tally(why, h.why);
      if (!r.same) bad.push(`${cid}: ${describeDiff(r)}`);
    }
    console.log(`social.list: ${campaigns.length} campaigns, ${records} records; intended: ${show(why)}`);
    assert.deepEqual(bad, [], bad.slice(0, 5).join("\n"));
  });

  test("lead.touches for every lead with a touch, a sent email or a sent social step", async () => {
    const pairs = await fresh.call((tx) => tx`
      select distinct l.campaign_id, l.id from leads l where l.merged_into is null and (
        exists (select 1 from touches t where t.lead_id = l.id) or exists (select 1 from emails e where e.lead_id = l.id and e.status not in ('drafted', 'failed'))
        or exists (select 1 from social_messages s where s.lead_id = l.id and s.sent_at is not null))`);
    const stepFixed = new Set((await fresh.call((tx) => tx`select distinct lead_id from emails where is_duplicate`)).map((r) => r.lead_id));
    const why = {}, bad = [];
    for (const [p, a, b] of await pmap(pairs, 6, async (p) => [p, await old.call("outreach.lead.touches", { campaign_id: p.campaign_id, lead_id: p.id }), await sqlSocial("outreach.lead.touches", { campaign_id: p.campaign_id, lead_id: p.id })])) {
      const r = compare(a, b, { known: [
        { path: /\.(sent_at|last_at|replied_at)$/, when: sameInstant, why: "same instant, as Postgres gives it back" },
        { path: /\.replied(_at|_via)?$/, why: "F8: replied from the lead's stop_state and real replies (P1 decisions)" },
        { path: /\.(campaign_id)$/, why: "P1 merges: the touch points at the lead that was kept" },
      ] });
      for (const h of r.known) tally(why, h.why);
      if (!r.same && stepFixed.has(p.id) && r.unexpected.every((d) => /\.(touches|summary)/.test(d.path))) { tally(why, "P1 first-send step fix: the bounced try is is_duplicate, so not a touch"); continue; }
      if (!r.same) bad.push(`${p.id}: ${describeDiff(r)}`);
    }
    console.log(`lead.touches: ${pairs.length} leads; intended: ${show(why)}`);
    assert.deepEqual(bad, [], bad.slice(0, 5).join("\n"));
  });
});
