// R13 case: outreach.campaign.list with no params, old path vs the chunk 2 rewrite (lib/sql/campaigns.ts `list`).
// Known differences: any_trade absent → true (0011), and leads_imported leaves out merged leads (F17).
import { list } from "../../../../netlify/functions/lib/sql/campaigns.ts";
export { listKnown as known } from "./shared.mjs";

export const action = "outreach.campaign.list";
export const params = {};
export const sqlVersion = (tx, p = {}) => list(tx, p);
