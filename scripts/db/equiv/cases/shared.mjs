// Helpers shared by the chunk 2 campaign cases (R13). The SQL side is the real rewrite in
// netlify/functions/lib/sql/campaigns.ts; the old side is the real command.ts on the P1 export.
import { CampaignError } from "../../../../netlify/functions/lib/sql/campaigns.ts";

/** Runs a SQL action and answers the way the handler does: { status, body: { ok, data | error } }. */
export async function asResponse(fn) {
  try {
    return { status: 200, body: { ok: true, data: await fn() } };
  } catch (e) {
    if (e instanceof CampaignError) return { status: e.status, body: { ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) } };
    throw e;
  }
}

/** Merged lead rows per campaign on dev (P1 merges, F17). */
export async function mergedCounts(tx) {
  const rows = await tx`select campaign_id, count(*)::int as n from leads where merged_into is not null group by campaign_id`;
  return new Map(rows.map((r) => [r.campaign_id, r.n]));
}

const ANY_TRADE = { when: (d) => d.old === "(absent)" && d.new === true, why: "absent means true in the old code; stored as true since 0011" };
const f17 = (merged, idAt) => ({
  when: (d) => { const m = merged.get(idAt(d.path)) ?? 0; return m > 0 && typeof d.old === "number" && d.new === d.old - m; },
  why: "F17: merged leads are not counted (lower by exactly that campaign's merged rows)",
});

/** Intended differences for a list answer: `$[i].any_trade` and `$[i].leads_imported`, matched by the campaign at i. */
export function listKnown(oldList, merged) {
  const idAt = (path) => oldList[Number(path.match(/^\$\[(\d+)\]/)[1])]?.id;
  return [
    { path: /^\$\[\d+\]\.any_trade$/, ...ANY_TRADE },
    { path: /^\$\[\d+\]\.leads_imported$/, ...f17(merged, idAt) },
  ];
}

/** The same for one campaign (`get`), or a body path prefix such as `$.data`. */
export function oneKnown(id, merged, prefix = "\\$") {
  return [
    { path: new RegExp(`^${prefix}\\.any_trade$`), ...ANY_TRADE },
    { path: new RegExp(`^${prefix}\\.leads_imported$`), ...f17(merged, () => id) },
  ];
}
