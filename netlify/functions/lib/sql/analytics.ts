// P2 chunk 11: analytics on Postgres (outreach.analytics.summary; used when DATA_BACKEND=sql, the Blobs code in command.ts
// stays the default until P5). Same answer as today ({totals, campaigns: newest 50}) from grouped queries (F4: no query
// per campaign). Counting rules are the old deriveCampaign rules, as in lib/sql/campaigns.ts:
//   sent = not drafted; delivered = delivered/clicked/replied; clicked = clicked or click_count > 0; replied = replied
//   unless every reply to it is a test; bounced = bounced/complained/failed.
// Leads: live leads (merged_into is null), else the count stored in the campaign's leads job (old withLeadCount rule).
// Totals add up ALL campaigns, the list shows the newest 50. Intended differences are listed in
// scripts/db/test/chunk11-equiv.test.mjs.
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export const ANALYTICS_ACTIONS = ["outreach.analytics.summary"];

const iso = (v: unknown): string | null => (typeof v === "string" ? new Date(v).toISOString() : v instanceof Date ? v.toISOString() : null);

export async function analyticsSummary(q: Q): Promise<Row> {
  const rows = (await q`
    with em as (
      select e.campaign_id,
        count(*) filter (where coalesce(e.status, '') not in ('', 'drafted'))::int as sent,
        count(*) filter (where e.status in ('delivered', 'clicked', 'replied'))::int as delivered,
        count(*) filter (where e.status = 'clicked' or coalesce(e.click_count, 0) > 0)::int as clicked,
        count(*) filter (where e.status = 'replied' and not (
          exists (select 1 from replies r where r.original_email_id = e.id and r.campaign_id = e.campaign_id and r.kind = 'test')
          and not exists (select 1 from replies r where r.original_email_id = e.id and r.campaign_id = e.campaign_id and r.kind is distinct from 'test')
        ))::int as replied,
        count(*) filter (where e.status in ('bounced', 'complained', 'failed'))::int as bounced
      from emails e group by e.campaign_id
    ),
    ld as (select campaign_id, count(*)::int as n from leads where merged_into is null group by campaign_id)
    select c.id, c.name, c.created_at,
      case when coalesce(ld.n, 0) > 0 then ld.n
           when lj.data->>'leads_imported' ~ '^[0-9]+$' then (lj.data->>'leads_imported')::int
           else 0 end as leads_imported,
      coalesce(em.sent, 0) as sent, coalesce(em.delivered, 0) as delivered, coalesce(em.bounced, 0) as bounced,
      coalesce(em.clicked, 0) as clicked, coalesce(em.replied, 0) as replied
    from campaigns c
    left join em on em.campaign_id = c.id
    left join ld on ld.campaign_id = c.id
    left join campaign_jobs lj on lj.campaign_id = c.id and lj.kind = 'leads'
    order by c.created_at desc nulls last, c.id`) as unknown as Row[];
  const totals = { campaigns: rows.length, leads: 0, sent: 0, delivered: 0, bounced: 0, clicked: 0, replied: 0 };
  for (const r of rows) {
    totals.leads += r.leads_imported as number;
    totals.sent += r.sent as number;
    totals.delivered += r.delivered as number;
    totals.bounced += r.bounced as number;
    totals.clicked += r.clicked as number;
    totals.replied += r.replied as number;
  }
  const campaigns = rows.slice(0, 50).map((r) => ({
    id: r.id, name: r.name, created_at: iso(r.created_at), leads_imported: r.leads_imported,
    emails_sent: r.sent, emails_delivered: r.delivered, emails_bounced: r.bounced, emails_clicked: r.clicked, emails_replied: r.replied,
  }));
  return { totals, campaigns };
}

export async function runAnalyticsAction(q: Q, action: string, _p: Record<string, unknown> = {}): Promise<unknown> {
  if (action === "outreach.analytics.summary") return analyticsSummary(q);
  throw new CampaignError(400, `unknown analytics action ${action}`);
}
