// R13 cases for chunk 3 (Leads and Prospects). The SQL side is the real rewrite in netlify/functions/lib/sql/leads.ts
// and search.ts; the old side is the real command.ts on the P1 export. Every write runs in a rolled-back transaction
// and reads its change straight back (F1).
import * as leads from "../../../../netlify/functions/lib/sql/leads.ts";
import * as search from "../../../../netlify/functions/lib/sql/search.ts";
import { asResponse } from "./shared.mjs";

/** Merged lead ids per campaign on dev (P1 merges, F17), and every merged id. */
export async function mergedIds(tx) {
  const rows = await tx`select id, campaign_id from leads where merged_into is not null`;
  return new Set(rows.map((r) => r.id));
}

/** Leads whose social links the P1 import gave from a merged twin (kept lead, link kind it did not have). */
export async function linksFromMerges(tx) {
  const rows = await tx`
    select k.lead_id, k.kind from lead_social_links k join leads l on l.id = k.lead_id
    where coalesce(l.data->'social'->>k.kind, '') = '' and exists (select 1 from leads m where m.merged_into = k.lead_id)`;
  return new Set(rows.map((r) => `${r.lead_id}/${r.kind}`));
}

/** Known, intended differences on one lead record at `prefix` (a path regex source). */
export const leadKnown = (prefix) => [
  { path: new RegExp(`^${prefix}\\.stop_state$`), when: (d) => d.old === "(absent)", why: "F8: the lead's stop state is shown (new column)" },
  { path: new RegExp(`^${prefix}\\.fit_flags(\\[\\d+\\](\\.\\w+)?)?$`), when: (d) => d.old === "(absent)", why: "F32/F33: flags to check before drafting are shown" },
  { path: new RegExp(`^${prefix}\\.(is_test|excluded|not_fit_kept|do_not_contact)$`), when: (d) => d.old === "(absent)" && d.new === false, why: "a missing flag is stored as false (P1 import; the code only checks === true)" },
  { path: new RegExp(`^${prefix}\\.email_source$`), when: (d) => d.old === "(absent)" && ["google_maps", "site_check", "browser", "manual"].includes(d.new), why: "P1 import worked out where an address came from" },
];

// ── reads ──
export const list = (tx, p = {}) => asResponse(() => leads.list(tx, p));
export const prospects = (tx, p = {}) => asResponse(() => search.prospects(tx, p));
export const screenshot = (tx, p = {}) => asResponse(() => leads.screenshot(tx, p));

// ── picking real rows on dev (the same ids exist in the export) ──
/** A real lead (not merged, not a test) with at least one unsent draft and one sent email. */
export async function pickLeadWithMail(tx) {
  const [r] = await tx`
    select l.id, l.campaign_id from leads l
    where l.merged_into is null and not l.is_test and l.email is not null
      and exists (select 1 from emails e where e.lead_id = l.id and e.status = 'drafted' and e.campaign_id = l.campaign_id)
      and exists (select 1 from emails e where e.lead_id = l.id and e.status <> 'drafted')
    order by l.id limit 1`;
  return r;
}
/** A real lead with an unsent draft and no sent email. */
export async function pickLeadWithDraft(tx) {
  const [r] = await tx`
    select l.id, l.campaign_id from leads l
    where l.merged_into is null and not l.is_test and l.email is not null
      and exists (select 1 from emails e where e.lead_id = l.id and e.status = 'drafted' and e.campaign_id = l.campaign_id)
    order by l.id desc limit 1`;
  return r;
}

// ── writes, each followed by a read-back ──
export const NEW_EMAIL = "equiv.newaddress@alcance-test.invalid";

export async function setEmailRun(tx, { campaign_id, lead_id }) {
  const ids = { campaign_id, lead_id };
  const out = {};
  out.bad = await asResponse(() => leads.setEmail(tx, { ...ids, email: "not an address" }));
  out.gov = await asResponse(() => leads.setEmail(tx, { ...ids, email: "someone@city.gov" }));
  out.noId = await asResponse(() => leads.setEmail(tx, { email: NEW_EMAIL }));
  out.unknown = await asResponse(() => leads.setEmail(tx, { campaign_id, lead_id: "no-such-lead-equiv", email: NEW_EMAIL }));
  out.set = await asResponse(() => leads.setEmail(tx, { ...ids, email: ` ${NEW_EMAIL.toUpperCase()} ` }));
  out.afterSet = await list(tx, { campaign_id });
  out.draftsAfterSet = await tx`select id, to_email, data->>'original_to_email' as original_to_email from emails where lead_id = ${lead_id} and status = 'drafted' order by id`;
  out.clear = await asResponse(() => leads.setEmail(tx, { ...ids, email: "" }));
  out.afterClear = await list(tx, { campaign_id });
  out.draftsAfterClear = (await tx`select count(*)::int as n from emails where lead_id = ${lead_id} and status = 'drafted'`)[0].n;
  return out;
}

export const UPDATE_STEPS = [
  { excluded: true, excluded_reason: "chain", excluded_note: "  part of   a chain  " },
  { owner_name: "  Pat   Tester " },
  { trade_override: true },
  { not_fit_kept: true },
  { owner_name: "" },
  { excluded: false },
  { excluded: true, delete_drafts: true },
];
export const UPDATE_REFUSALS = [
  {},
  { excluded: "yes" },
  { excluded_reason: "bad" },
  { owner_name: 5 },
];

export async function updateRun(tx, { campaign_id, lead_id }) {
  const answers = [];
  for (const patch of UPDATE_STEPS) answers.push(await asResponse(() => leads.update(tx, { campaign_id, lead_id, ...patch })));
  const refusals = [];
  for (const patch of UPDATE_REFUSALS) refusals.push(await asResponse(() => leads.update(tx, { campaign_id, lead_id, ...patch })));
  refusals.push(await asResponse(() => leads.update(tx, { campaign_id, excluded: true })));
  refusals.push(await asResponse(() => leads.update(tx, { campaign_id, lead_id: "no-such-lead-equiv", excluded: true })));
  const readBack = await list(tx, { campaign_id });
  return { answers, refusals, readBack };
}

export async function deleteRun(tx, { campaign_id, lead_id }) {
  const deleted = await asResponse(() => leads.remove(tx, { campaign_id, lead_id }));
  const again = await asResponse(() => leads.remove(tx, { campaign_id, lead_id }));
  const noId = await asResponse(() => leads.remove(tx, { campaign_id }));
  const readBack = await list(tx, { campaign_id });
  const [{ drafts, sent }] = await tx`select count(*) filter (where status = 'drafted')::int as drafts, count(*) filter (where status <> 'drafted')::int as sent from emails where lead_id = ${lead_id}`;
  return { deleted, again, noId, readBack, drafts, sent };
}

export async function fbRun(tx, { campaign_id, lead_id }) {
  const ids = { campaign_id, lead_id };
  const set = await asResponse(() => leads.fbChecked(tx, { ...ids, result: "gone", note: "  page removed  " }));
  const afterSet = await list(tx, { campaign_id });
  const bad = await asResponse(() => leads.fbChecked(tx, { ...ids, result: "maybe" }));
  const unknown = await asResponse(() => leads.fbChecked(tx, { campaign_id, lead_id: "no-such-lead-equiv", result: "real" }));
  const noId = await asResponse(() => leads.fbChecked(tx, { lead_id }));
  const clear = await asResponse(() => leads.fbChecked(tx, { ...ids, result: null }));
  const afterClear = await list(tx, { campaign_id });
  return { set, afterSet, bad, unknown, noId, clear, afterClear };
}
