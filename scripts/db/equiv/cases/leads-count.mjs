// R13 case: outreach.leads.count for every campaign id. Known: lower by that campaign's merged rows (F17).
import { leadsCount } from "../../../../netlify/functions/lib/sql/campaigns.ts";
import { asResponse } from "./shared.mjs";

export const action = "outreach.leads.count";
export const sqlVersion = (tx, p = {}) => asResponse(() => leadsCount(tx, p.campaign_id));
export const known = (id, merged) => [{
  path: /^\$\.data\.count$/,
  when: (d) => (merged.get(id) ?? 0) > 0 && d.new === d.old - merged.get(id),
  why: "F17: merged leads are not counted",
}];
