// R13 cases for chunk 5 (the email actions). The SQL side is the real rewrite in netlify/functions/lib/sql/emails.ts;
// the old side is the real command.ts on the P1 export. Reads run in a read-only transaction; writes in one that is
// rolled back. Intended differences are listed here, each with its reason; anything else fails the test.
import * as emails from "../../../../netlify/functions/lib/sql/emails.ts";
import { asResponse } from "./shared.mjs";

const ctx = { newId: () => `eq-${Math.random().toString(36).slice(2, 10)}`, isAgent: false, createdBy: null };
/** No AI is reachable in these cases: every dependency fails if it is used. */
const deps = new Proxy({}, { get: (_, p) => { throw new Error(`equivalence case used deps.${String(p)}`); } });
const act = (action, tx, p) => asResponse(() => emails.runEmailAction(tx, `outreach.${action}`, p, deps, ctx));

export const list = (tx, p = {}) => act("emails.list", tx, p);
export const footer = (tx, p = {}) => act("footer.preview", tx, p);
export const update = (tx, p = {}) => act("emails.update", tx, p);
export const remove = (tx, p = {}) => act("emails.delete", tx, p);

/** Merged lead id -> the lead it was merged into (P1 merges, F17). */
export async function mergedInto(tx) {
  return new Map((await tx`select id, merged_into from leads where merged_into is not null`).map((r) => [r.id, r.merged_into]));
}
/** Emails the P1 import marked as a second draft for the same lead and step (kept as history, left out of the list). */
export async function duplicateIds(tx) {
  return new Set((await tx`select id from emails where is_duplicate`).map((r) => r.id));
}
/** Email ids the P1 import moved to another step (decisions.email_steps). */
export async function movedIds(tx) {
  return new Set((await tx`select id from emails where data ? 'original_step'`).map((r) => r.id));
}

/** A drafted email that is not a duplicate, whose lead is live: for update, delete and footer. */
export async function pickDraft(tx, offset = 0) {
  const [r] = await tx`
    select e.id, e.campaign_id from emails e join leads l on l.id = e.lead_id
    where e.status = 'drafted' and not e.is_duplicate and l.merged_into is null and e.to_email is not null and e.body_text is not null
    order by e.id offset ${offset} limit 1`;
  return r;
}
export async function pickSent(tx) {
  const [r] = await tx`select id, campaign_id from emails where status <> 'drafted' and not is_duplicate order by id limit 1`;
  return r;
}
/** Up to `count` drafted emails from different campaigns. */
export async function pickDraftsAcrossCampaigns(tx, count = 6) {
  return tx`
    select distinct on (e.campaign_id) e.id, e.campaign_id from emails e join leads l on l.id = e.lead_id
    where e.status = 'drafted' and not e.is_duplicate and l.merged_into is null order by e.campaign_id, e.id limit ${count}`;
}

/**
 * Known, intended differences on one email record at `prefix` (a path regex source).
 * `ids(path)` gives the email id at that path (from the old list), `moved` and `merged` come from the cases above.
 */
export function emailKnown(prefix, { ids = () => null, moved = new Set(), merged = new Map() } = {}) {
  const at = (re) => new RegExp(`^${prefix}\\.${re}$`);
  return [
    { path: at("edited"), when: (d) => d.old === "(absent)" && d.new === false, why: "a missing 'edited' is stored as false (column default)" },
    { path: at("click_count"), when: (d) => d.old === "(absent)" && d.new === 0, why: "a missing click count is stored as 0 (column default)" },
    { path: at("(original_step|original_sequence_total)"), when: (d) => d.old === "(absent)", why: "P1 step fix: the step the app had is kept in data" },
    { path: at("(sequence_position|sequence_total)"), when: (d) => moved.has(ids(d.path)), why: "P1 step fix (decisions.email_steps): the email is at its corrected step" },
    { path: at("original_lead_id"), when: (d) => d.old === "(absent)", why: "P1 merge: the email moved to the kept lead; the merged lead's id is kept in data" },
    { path: at("lead_id"), when: (d) => merged.has(d.old) && merged.get(d.old) === d.new, why: "P1 merge: the email now belongs to the lead it was merged into" },
  ];
}
