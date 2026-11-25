// Campaign page: one query. Production: command.ts:4023, deriveCampaign command.ts:1780.
import { ownReplyEmailIds } from "../../../netlify/functions/lib/replies";
import type { Sql } from "./db";

type Rec = Record<string, any>;
const STATE_KEYS = ["job", "browser_checked_ids", "default_sender_name", "default_sender_company", "default_sender_offer", "default_framework", "default_sequence_total"]; // command.ts:2107

export async function campaignGet(sql: Sql, ds: string, id: string): Promise<Rec | null> {
  const [r] = await sql`
    select c.data,
      (select data from spike.s75_settings where ds = ${ds} and name = ${`state-${id}`}) as state,
      (select count(*)::int from spike.s75_leads where ds = ${ds} and campaign_id = ${id}) as leads,
      (select json_build_object(
          'generated', count(*), 'sent', count(*) filter (where status <> 'drafted'),
          'delivered', count(*) filter (where status in ('delivered', 'clicked', 'replied')),
          'clicked', count(*) filter (where status = 'clicked' or coalesce((data->>'click_count')::int, 0) > 0),
          'replied_ids', coalesce(json_agg(id) filter (where status = 'replied'), '[]'),
          'bounced', count(*) filter (where status in ('bounced', 'complained', 'failed')))
        from spike.s75_emails where ds = ${ds} and campaign_id = ${id}) as e,
      (select coalesce(json_agg(json_build_object('original_email_id', data->'original_email_id', 'is_test', data->'is_test', 'from', data->'from')), '[]')
        from spike.s75_replies where ds = ${ds} and campaign_id = ${id}) as replies
    from spike.s75_campaigns c where c.ds = ${ds} and c.id = ${id}`;
  if (!r) return null;
  const c: Rec = { ...r.data };
  for (const k of STATE_KEYS) if (r.state && k in r.state) c[k] = r.state[k];
  c.leads_imported = r.leads > 0 ? r.leads : typeof c.leads_imported === "number" ? c.leads_imported : 0;
  const e = r.e;
  if (e.generated === 0) return c;
  const own = ownReplyEmailIds(r.replies.map((x: Rec) => ({ ...x, is_test: x.is_test ?? undefined })));
  const queued = e.generated - e.sent;
  const out: Rec = {
    ...c, emails_generated: e.generated, emails_sent: e.sent, emails_delivered: e.delivered, emails_clicked: e.clicked,
    emails_replied: e.replied_ids.filter((x: string) => !own.has(x)).length, emails_bounced: e.bounced,
  };
  const st = c.status;
  const sendingNow = st === "sending" && Date.now() - Date.parse(c.updated_at ?? "") < 5 * 60_000;
  if (!sendingNow && (st === "ready" || st === "sending" || st === "completed" || st === "failed") && e.sent > 0) out.status = queued > 0 ? "ready" : "completed";
  return out;
}
