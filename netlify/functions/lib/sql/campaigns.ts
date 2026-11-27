// P2 chunk 2: the campaign actions on Postgres (used when DATA_BACKEND=sql; the Blobs code in command.ts stays the
// default until P5). Every function takes `sql`, a client or a transaction, so callers and tests choose the
// transaction. Answers have the same shape as the old Blobs actions; the differences are intended and listed in
// the equivalence cases (scripts/db/equiv/cases/):
//   - F17: merged leads (`merged_into` set) are never counted.
//   - any_trade is always stored (true when the old record had no value, migration 0011).
//
// F2: settings live in `campaigns`, job progress in `campaign_jobs`. `update` only sets the columns it is given (no
// whole-record write), and the job writers (`writeJob`, `writeLeadsJob`) never read or write the campaigns row, so a
// running job can never undo a setting.
import type { Sql, Tx } from "../db/client.ts";
import { areaCountry } from "./area.ts";

export type Q = Sql | Tx;
type Row = Record<string, unknown>;

/** A refusal with the HTTP status the handler should answer with. */
export class CampaignError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CampaignError";
    this.status = status;
  }
}

/** The old campaign-state keys (command.ts STATE_KEYS). */
const STATE_KEYS = ["job", "browser_checked_ids", "default_sender_name", "default_sender_company", "default_sender_offer", "default_framework", "default_sequence_total"];

/** Job kinds that are not "the job" shown on the campaign (the lead search, the browser-checked ids); written out in SQL below. */
const NOT_THE_JOB = ["leads", "browser_check"];

const iso = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toISOString() : v ?? null);

// ── Reads ──────────────────────────────────────────────────────────────────

export const FILTERS = ["active", "has_replies", "followups_due"] as const;
export const SORTS = ["newest", "name", "replies"] as const;
export type ListOptions = { q?: unknown; filter?: unknown; sort?: unknown; limit?: unknown; id?: string };

function checkedOptions(o: ListOptions) {
  const q = typeof o.q === "string" ? o.q.trim() : o.q == null ? "" : String(o.q).trim();
  if (q.length > 200) throw new CampaignError(400, "q is too long (200 characters at most)");
  const filter = o.filter ?? null;
  if (filter !== null && !(FILTERS as readonly unknown[]).includes(filter)) throw new CampaignError(400, `filter must be one of ${FILTERS.join(", ")}`);
  const sort = o.sort ?? "newest";
  if (!(SORTS as readonly unknown[]).includes(sort)) throw new CampaignError(400, `sort must be one of ${SORTS.join(", ")}`);
  const limit = o.limit ?? null;
  if (limit !== null && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 200)) throw new CampaignError(400, "limit must be a whole number from 1 to 200");
  return { q, filter: filter as string | null, sort: sort as string, limit: limit as number | null };
}

/**
 * The list query: one statement. Counters come from the campaign's emails by the same rules as deriveCampaign in
 * command.ts; the lead count leaves out merged leads (F17). S0: search on the indexed `search` column (name, niche,
 * area; trigram index from 3 characters), filters and sort, all in the database. Exported so a test can `explain` it.
 */
export function listStatement(sql: Q, opts: ListOptions = {}) {
  const { q, filter, sort, limit } = checkedOptions(opts);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const order =
    sort === "name" ? sql`order by lower(x.name) collate "C", x.id`
    : sort === "replies" ? sql`order by x.replied desc, x.created_at desc nulls last, x.id`
    : sql`order by x.created_at desc nulls last, x.id`;
  const where =
    filter === "active" ? sql`where x.job_running or x.derived_status in ('searching', 'sending') or x.drafts > 0`
    : filter === "has_replies" ? sql`where x.replied > 0`
    : filter === "followups_due" ? sql`where x.followups_due`
    : sql``;
  return sql`
    with c as (
      select * from campaigns
      where true ${opts.id !== undefined ? sql`and id = ${opts.id}` : sql``} ${pattern ? sql`and search ilike ${pattern}` : sql``}
    ),
    em as (
      select e.campaign_id,
        count(*)::int as generated,
        count(*) filter (where coalesce(e.status, '') not in ('', 'drafted'))::int as sent,
        count(*) filter (where e.status = 'drafted')::int as drafts,
        count(*) filter (where e.status in ('delivered', 'clicked', 'replied'))::int as delivered,
        count(*) filter (where e.status = 'clicked' or coalesce(e.click_count, 0) > 0)::int as clicked,
        -- A reply that only came from Lakshmi's own address (a test) does not count.
        count(*) filter (where e.status = 'replied' and not (
          exists (select 1 from replies r where r.original_email_id = e.id and r.campaign_id = e.campaign_id and r.kind = 'test')
          and not exists (select 1 from replies r where r.original_email_id = e.id and r.campaign_id = e.campaign_id and r.kind is distinct from 'test')
        ))::int as replied,
        count(*) filter (where e.status in ('bounced', 'complained', 'failed'))::int as bounced
      from emails e
      where e.campaign_id in (select id from c)
      group by e.campaign_id
    ),
    ld as (
      select campaign_id, count(*)::int as n from leads
      where merged_into is null and campaign_id in (select id from c)
      group by campaign_id
    ),
    x as (
      select c.id, c.name, c.description, c.niche, c.created_by, c.default_sender_name, c.default_sender_company,
        c.default_sender_offer, c.default_framework, c.default_sequence_total, c.any_trade, c.agentmail_inbox_id,
        c.created_at, c.updated_at, c.data,
        lj.status as leads_status, lj.data as leads_data,
        coalesce(em.generated, 0) as generated, coalesce(em.sent, 0) as sent, coalesce(em.drafts, 0) as drafts,
        coalesce(em.delivered, 0) as delivered, coalesce(em.clicked, 0) as clicked, coalesce(em.replied, 0) as replied,
        coalesce(em.bounced, 0) as bounced, coalesce(ld.n, 0) as live_leads,
        (select to_jsonb(j) from campaign_jobs j
          where j.campaign_id = c.id and j.kind not in ('leads', 'browser_check')
          order by j.data->>'written_at' desc nulls last, coalesce(j.progress_at, j.started_at) desc nulls last, j.kind
          limit 1) as job,
        (select b.data from campaign_jobs b where b.campaign_id = c.id and b.kind = 'browser_check') as checked,
        exists (select 1 from campaign_jobs j where j.campaign_id = c.id and j.kind not in ('leads', 'browser_check') and j.status = 'running') as job_running,
        exists (
          select 1 from follow_ups f join leads l on l.id = f.lead_id
          where f.campaign_id = c.id and f.stopped_reason is null and l.merged_into is null
            and f.due_date <= (now() at time zone coalesce(c.time_zone, 'America/Chicago'))::date
        ) as followups_due
      from c
      left join campaign_jobs lj on lj.campaign_id = c.id and lj.kind = 'leads'
      left join em on em.campaign_id = c.id
      left join ld on ld.campaign_id = c.id
    ),
    y as (
      select x.*,
        -- deriveCampaign: once something is sent, ready while drafts remain, else completed; a send in the last
        -- 5 minutes keeps "sending".
        case
          when x.generated = 0 then x.leads_status
          when not coalesce(x.leads_status = 'sending' and x.updated_at > now() - interval '5 minutes', false)
            and x.leads_status in ('ready', 'sending', 'completed', 'failed') and x.sent > 0
            then case when x.generated - x.sent > 0 then 'ready' else 'completed' end
          else x.leads_status
        end as derived_status
      from x
    )
    select * from y x
    ${where}
    ${order}
    ${limit !== null ? sql`limit ${limit}` : sql``}`;
}

/** The stored campaign as the old app kept it: the record with its state laid over it (no counters worked out). */
function baseRecord(r: Row): Row {
  const record: Row = {
    ...(r.data as Row),
    id: r.id, name: r.name, description: r.description, query: r.niche, created_by: r.created_by,
    default_sender_name: r.default_sender_name, default_sender_company: r.default_sender_company,
    default_sender_offer: r.default_sender_offer, default_framework: r.default_framework,
    default_sequence_total: r.default_sequence_total, any_trade: r.any_trade, agentmail_inbox_id: r.agentmail_inbox_id,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
    ...((r.leads_data as Row | null) ?? {}),
    status: r.leads_status ?? null,
  };
  const job = r.job as Row | null;
  if (job) {
    const { written_at: _stamp, ...rest } = (job.data as Row) ?? {};
    record.job = {
      ...rest, kind: job.kind, status: job.status, total: job.total, done: job.done, made: job.made,
      started_at: iso(job.started_at), progress_at: iso(job.progress_at), finished_at: iso(job.finished_at),
    };
  }
  if (r.checked) record.browser_checked_ids = (r.checked as Row).browser_checked_ids;
  return record;
}

/** The campaign as list and get show it: counters from its emails, lead count without merged leads (F17). */
function shaped(r: Row): Row {
  const record = baseRecord(r);
  const stored = typeof record.leads_imported === "number" ? record.leads_imported : 0;
  record.leads_imported = (r.live_leads as number) > 0 ? r.live_leads : stored;
  if ((r.generated as number) > 0) {
    Object.assign(record, {
      emails_generated: r.generated, emails_sent: r.sent, emails_delivered: r.delivered, emails_clicked: r.clicked,
      emails_replied: r.replied, emails_bounced: r.bounced, status: r.derived_status,
    });
  }
  return record;
}

/** outreach.campaign.list, with S0 search, filter and sort (all optional; none = every campaign, newest first). */
export async function list(sql: Q, opts: ListOptions = {}): Promise<Row[]> {
  const { id: _ignored, ...rest } = opts;
  return (await listStatement(sql, rest)).map(shaped);
}

/** outreach.campaign.get */
export async function get(sql: Q, id: unknown): Promise<Row> {
  if (!id || typeof id !== "string") throw new CampaignError(400, "id required");
  const [row] = await listStatement(sql, { id });
  if (!row) throw new CampaignError(404, "campaign not found");
  return shaped(row);
}

/** The stored record (what old `update` answered with): no counters worked out, no lead count. */
async function storedRecord(sql: Q, id: string): Promise<Row | null> {
  const [row] = await listStatement(sql, { id });
  return row ? baseRecord(row) : null;
}

/** outreach.leads.count: leads in the campaign, merged leads left out (F17). */
export async function leadsCount(sql: Q, campaignId: unknown): Promise<{ count: number }> {
  if (!campaignId || typeof campaignId !== "string") throw new CampaignError(400, "campaign_id required");
  const [{ n }] = await sql`select count(*)::int as n from leads where campaign_id = ${campaignId} and merged_into is null`;
  return { count: n as number };
}
