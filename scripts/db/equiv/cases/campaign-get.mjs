// R13 case: outreach.campaign.get for every campaign id, plus a missing id (404) and no id (400).
import { get } from "../../../../netlify/functions/lib/sql/campaigns.ts";
import { asResponse } from "./shared.mjs";
export { oneKnown as known } from "./shared.mjs";

export const action = "outreach.campaign.get";
export const MISSING_ID = "no-such-campaign-equiv";
export const sqlVersion = (tx, p = {}) => asResponse(() => get(tx, p.id));
