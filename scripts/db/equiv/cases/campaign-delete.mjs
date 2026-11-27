// R13 case: outreach.campaign.delete on a campaign with leads, drafts and sent emails, then read back (F1):
// get → 404, lead count 0, and exactly `sent_kept` emails left (sent emails stay as history).
import { get, leadsCount, remove } from "../../../../netlify/functions/lib/sql/campaigns.ts";
import { asResponse } from "./shared.mjs";

export const action = "outreach.campaign.delete";

/** The campaign with the most emails that has both drafts and sent emails, and leads. */
export async function pick(tx) {
  const [r] = await tx`
    select e.campaign_id as id from emails e
    where exists (select 1 from leads l where l.campaign_id = e.campaign_id)
    group by e.campaign_id
    having count(*) filter (where e.status = 'drafted') > 0 and count(*) filter (where e.status is distinct from 'drafted') > 0
    order by count(*) desc, e.campaign_id limit 1`;
  return r?.id;
}

export async function sqlVersion(tx, { id }) {
  const deleted = await asResponse(() => remove(tx, id));
  const missingId = await asResponse(() => remove(tx, undefined));
  const after = await asResponse(() => get(tx, id));
  const count = await asResponse(() => leadsCount(tx, id));
  const [{ n }] = await tx`select count(*)::int as n from emails where campaign_id = ${id}`;
  return { deleted, missingId, after, count, emailsLeft: n };
}
