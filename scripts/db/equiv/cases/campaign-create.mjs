// R13 case: outreach.campaign.create, then read straight back (F1) with get and list. Old side: fresh copy of the
// export in memory. New side: one transaction on dev that is rolled back. Ids and times differ and are ignored.
import { create, get, list } from "../../../../netlify/functions/lib/sql/campaigns.ts";
import { asResponse } from "./shared.mjs";

export const action = "outreach.campaign.create";
export const input = {
  name: "Equivalence test campaign",
  query: "test plumbers",
  description: "made by the chunk 2 equivalence test",
  structured_query: { location: "Katy, TX", searchTerms: ["test plumber"], maxResults: 10 },
};
export const ignoreKeys = ["id", "campaign_id"];

/** create → get → list[0] → the activity entry, all in the caller's (rolled-back) transaction. */
export async function sqlVersion(tx, p = input) {
  const made = await asResponse(() => create(tx, p, { newId: () => "equiv-new-" + Math.random().toString(36).slice(2, 8), createdBy: null }));
  if (!made.body.ok) return { made };
  const id = made.body.data.id;
  const got = await asResponse(() => get(tx, id));
  const first = (await list(tx, {}))[0];
  const [act] = await tx`select agent_id, category, summary, details from activity where details->>'campaign_id' = ${id}`;
  return { made, got, first, activity: act ?? null, id };
}
