// R13 / S0 case: campaign search, filters and sort. The old app has no search, so the reference is the old
// list (real command.ts) filtered and sorted in JS by the written rule below; the SQL answer must give the
// same campaign ids in the same order. `followups_due` has no old-path source (the old app works follow-ups
// out on each read), so its reference ids come from a separate plain query on the follow_ups table.
import { list } from "../../../../netlify/functions/lib/sql/campaigns.ts";

export const action = "outreach.campaign.list";
export const sqlVersion = (tx, p = {}) => list(tx, p);

/** The written rule. `active`: a running job, searching or sending, or unsent drafts. */
export function reference(oldList, { q, filter, sort, limit } = {}, followupsDue = new Set()) {
  let out = oldList.map((c, i) => ({ c, i }));
  const term = String(q ?? "").trim().toLowerCase();
  if (term) out = out.filter(({ c }) => `${c.name ?? ""} ${c.query ?? ""} ${c.structured_query?.location ?? ""}`.toLowerCase().includes(term));
  if (filter === "active") out = out.filter(({ c }) => c.job?.status === "running" || ["searching", "sending"].includes(c.status) || (c.emails_generated ?? 0) - (c.emails_sent ?? 0) > 0);
  if (filter === "has_replies") out = out.filter(({ c }) => (c.emails_replied ?? 0) > 0);
  if (filter === "followups_due") out = out.filter(({ c }) => followupsDue.has(c.id));
  const byId = (a, b) => (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0);
  if (sort === "name") out.sort((a, b) => { const x = (a.c.name ?? "").toLowerCase(), y = (b.c.name ?? "").toLowerCase(); return x < y ? -1 : x > y ? 1 : byId(a, b); });
  if (sort === "replies") out.sort((a, b) => (b.c.emails_replied ?? 0) - (a.c.emails_replied ?? 0) || a.i - b.i);
  if (limit) out = out.slice(0, limit);
  return out.map(({ c }) => c.id);
}

/** Campaigns with a follow-up due today (campaign time zone, Chicago if none), not stopped, lead not merged. */
export async function followupsDueIds(tx) {
  const rows = await tx`
    select distinct f.campaign_id from follow_ups f
    join leads l on l.id = f.lead_id
    join campaigns c on c.id = f.campaign_id
    where f.stopped_reason is null and l.merged_into is null
      and f.due_date <= (now() at time zone coalesce(c.time_zone, 'America/Chicago'))::date`;
  return new Set(rows.map((r) => r.campaign_id));
}

/** Search terms are taken from the data at test time (so none are written here): an area, a word of a niche. */
export function combos(oldList) {
  const area = oldList.map((c) => c.structured_query?.location).find(Boolean)?.split(",")[0].trim().toLowerCase() ?? "x";
  const word = oldList.map((c) => c.query).find(Boolean)?.split(/\s+/).find((w) => w.length >= 4)?.toLowerCase() ?? "xyz";
  return [
    {}, { q: area }, { q: area.slice(0, 2) }, { q: area.slice(0, 1) }, { q: word }, { q: `  ${word.toUpperCase()}  ` },
    { q: "zz-no-such-campaign" }, { q: "100%_" },
    { filter: "active" }, { filter: "has_replies" }, { filter: "followups_due" },
    { sort: "newest" }, { sort: "name" }, { sort: "replies" },
    { q: area, sort: "name", limit: 3 }, { filter: "active", sort: "replies" }, { filter: "has_replies", sort: "name" }, { limit: 1 },
  ];
}
