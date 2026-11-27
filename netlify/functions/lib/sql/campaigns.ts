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
  /** An error code the old answer carried (failCode), e.g. "job_running". */
  code?: string;
  /** Keep what was written before the refusal (the old code saved a failed state, then answered 500). */
  keep: boolean;
  constructor(status: number, message: string, opts: { code?: string; keep?: boolean } = {}) {
    super(message);
    this.name = "CampaignError";
    this.status = status;
    this.code = opts.code;
    this.keep = opts.keep === true;
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
export async function storedRecord(sql: Q, id: string): Promise<Row | null> {
  const [row] = await listStatement(sql, { id });
  return row ? baseRecord(row) : null;
}

/** outreach.leads.count: leads in the campaign, merged leads left out (F17). */
export async function leadsCount(sql: Q, campaignId: unknown): Promise<{ count: number }> {
  if (!campaignId || typeof campaignId !== "string") throw new CampaignError(400, "campaign_id required");
  const [{ n }] = await sql`select count(*)::int as n from leads where campaign_id = ${campaignId} and merged_into is null`;
  return { count: n as number };
}

// ── Writes ─────────────────────────────────────────────────────────────────
// Callers run these inside one transaction (command.ts uses withTx), so a write is all or nothing.

export type WriteCtx = { newId: () => string; createdBy?: string | null };

const ZERO_COUNTERS = { emails_generated: 0, emails_sent: 0, emails_delivered: 0, emails_bounced: 0, emails_clicked: 0, emails_replied: 0 };

const locationOf = (sq: unknown): string | null => {
  const loc = sq && typeof sq === "object" ? (sq as Row).location : null;
  return typeof loc === "string" ? loc : null;
};

/** outreach.campaign.create: the campaign, its lead-search job (status draft) and the activity entry. */
export async function create(sql: Q, input: Row, ctx: WriteCtx): Promise<Row> {
  const { name, query, structured_query, description } = input ?? {};
  if (typeof name !== "string" || !name.trim()) throw new CampaignError(400, "name required");
  if (typeof query !== "string" || !query.trim()) throw new CampaignError(400, "query required");
  const id = ctx.newId();
  const now = new Date();
  const area = locationOf(structured_query);
  const { country, time_zone } = areaCountry(area);
  const createdBy = ctx.createdBy ?? null;
  await sql`
    insert into campaigns (id, blob_key, name, description, niche, area, country, time_zone, created_by, any_trade, created_at, updated_at, data)
    values (${id}, ${id}, ${name.trim()}, ${typeof description === "string" ? description : ""}, ${query.trim()}, ${area}, ${country}, ${time_zone},
            ${createdBy}, true, ${now}, ${now}, ${sql.json({ structured_query: (structured_query ?? null) as never, ...ZERO_COUNTERS })})`;
  await sql`
    insert into campaign_jobs (campaign_id, kind, status, total, done, data)
    values (${id}, 'leads', 'draft', 0, 0, ${sql.json({ total_leads_found: 0, leads_imported: 0 })})`;
  const activityId = ctx.newId();
  await sql`
    insert into activity (id, blob_key, agent_id, category, summary, details, created_at)
    values (${activityId}, ${`${now.toISOString()}-${activityId}`}, ${createdBy}, 'content', ${`Outreach campaign created: "${name.trim()}"`},
            ${sql.json({ campaign_id: id, query: query.trim() })}, ${now})`;
  return (await storedRecord(sql, id))!;
}

/** Setting keys with their own column, and what each may hold. */
const COLUMNS: Record<string, { col: string; ok: (v: unknown) => boolean; what: string }> = {};
const text = (v: unknown) => v === null || typeof v === "string";
for (const k of ["name", "description", "agentmail_inbox_id", "created_by", "default_sender_name", "default_sender_company", "default_sender_offer", "default_framework"]) COLUMNS[k] = { col: k, ok: text, what: "text or null" };
COLUMNS.query = { col: "niche", ok: text, what: "text or null" };
COLUMNS.any_trade = { col: "any_trade", ok: (v) => typeof v === "boolean", what: "true or false" };
COLUMNS.default_sequence_total = { col: "default_sequence_total", ok: (v) => v === null || Number.isInteger(v), what: "a whole number or null" };
COLUMNS.created_at = { col: "created_at", ok: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)), what: "a date-time" };

/** Fields of the lead search run (old code kept them in the campaign record; here they live in its 'leads' job). */
const LEADS_JOB_KEYS = new Set(["status", "total_leads_found", "leads_imported", "last_run_at", "apify_run_id", "apify_dataset_id", "apify_status", "error_message", "last_status_refresh_at", "leads_skipped_duplicate", "leads_skipped_by", "import_started_at"]);

/**
 * outreach.campaign.update (F2). Never a whole-record write: each key goes to its own place and only the given
 * columns are set. Settings → `campaigns` columns (or `data`, merged with ||); `job` → that job's row;
 * `browser_checked_ids` → its row; lead-search fields → the 'leads' job. Answers with the stored record, as before.
 */
export async function update(sql: Q, input: Row): Promise<Row> {
  const { id, ...patch } = input ?? {};
  if (!id || typeof id !== "string") throw new CampaignError(400, "id required");
  const cols: Row = {};
  const data: Row = {};
  const leadsJob: Row = {};
  let job: unknown = undefined;
  let checked: unknown = undefined;
  let settings = false; // a key the old code wrote to the campaign record (it then bumped updated_at)
  for (const [k, v] of Object.entries(patch)) {
    if (k === "job") job = v;
    else if (k === "browser_checked_ids") checked = v;
    else if (k in COLUMNS) {
      if (!COLUMNS[k].ok(v)) throw new CampaignError(400, `bad value for ${k}: must be ${COLUMNS[k].what}`);
      cols[COLUMNS[k].col] = v;
      if (!STATE_KEYS.includes(k)) settings = true;
    } else if (k === "structured_query") {
      if (v !== null && typeof v !== "object") throw new CampaignError(400, "bad value for structured_query: must be an object or null");
      data.structured_query = v;
      const area = locationOf(v);
      Object.assign(cols, { area, ...areaCountry(area) });
      settings = true;
    } else if (LEADS_JOB_KEYS.has(k)) { leadsJob[k] = v; settings = true; }
    else if (k === "updated_at") settings = true; // the old code replaced it with the server clock
    else { data[k] = v; settings = true; }
  }
  if (job !== undefined) checkJob(job);
  const [found] = await sql`select 1 from campaigns where id = ${id}`;
  if (!found) throw new CampaignError(404, "campaign not found");
  const now = new Date();
  if (settings) cols.updated_at = now;
  if (Object.keys(cols).length) {
    await sql`update campaigns set ${sql(cols)}${Object.keys(data).length ? sql`, data = data || ${sql.json(data as never)}` : sql``} where id = ${id}`;
  }
  if (Object.keys(leadsJob).length) await writeLeadsJob(sql, id, leadsJob);
  if (job !== undefined) await setJob(sql, id, job as Row | null, now);
  if (checked !== undefined) {
    await sql`
      insert into campaign_jobs (campaign_id, kind, data) values (${id}, 'browser_check', ${sql.json({ browser_checked_ids: checked as never })})
      on conflict (campaign_id, kind) do update set data = excluded.data`;
  }
  return (await storedRecord(sql, id))!;
}

const JOB_INTS = ["total", "done", "made"];
const JOB_TIMES = ["started_at", "progress_at", "finished_at"];
const isTime = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

function checkJob(job: unknown): void {
  if (job === null) return;
  if (typeof job !== "object" || Array.isArray(job)) throw new CampaignError(400, "bad value for job: must be an object or null");
  const j = job as Row;
  if (typeof j.kind !== "string" || !j.kind || NOT_THE_JOB.includes(j.kind)) throw new CampaignError(400, "job.kind required (not leads or browser_check)");
  if (j.status != null && typeof j.status !== "string") throw new CampaignError(400, "bad value for job.status");
  for (const k of JOB_INTS) if (j[k] != null && !Number.isInteger(j[k])) throw new CampaignError(400, `bad value for job.${k}: must be a whole number`);
  for (const k of JOB_TIMES) if (j[k] != null && !isTime(j[k])) throw new CampaignError(400, `bad value for job.${k}: must be a date-time`);
}

/**
 * The page sets the whole job (start, progress, finish), replacing that job's row, as the old state record did.
 * A job that starts running gets the server clock; a resume, or a finishing update, keeps the current job's start
 * (command.ts rule, batch 7). null clears the job.
 */
async function setJob(sql: Q, id: string, job: Row | null, now: Date): Promise<void> {
  if (job === null) {
    await sql`delete from campaign_jobs where campaign_id = ${id} and kind not in ('leads', 'browser_check')`;
    return;
  }
  const { kind, status, total, done, made, started_at, progress_at, finished_at, ...rest } = job;
  const running = status === "running";
  const resume = job.resume === true;
  await sql`
    insert into campaign_jobs (campaign_id, kind, status, total, done, made, started_at, progress_at, finished_at, data)
    select ${id}, ${kind as string}, ${(status ?? null) as string | null}::text, ${(total ?? null) as number | null}::int,
      ${(done ?? null) as number | null}::int, ${(made ?? null) as number | null}::int,
      case
        when ${running}::boolean and ${resume}::boolean and cur.started_at is not null then cur.started_at
        when ${running}::boolean then ${now}::timestamptz
        when cur.started_at is not null then cur.started_at
        else ${(started_at ?? null) as string | null}::timestamptz
      end,
      ${(progress_at ?? null) as string | null}::timestamptz, ${(finished_at ?? null) as string | null}::timestamptz,
      ${sql.json({ ...rest, written_at: now.toISOString() } as never)}
    from (select (
      select j.started_at from campaign_jobs j
      where j.campaign_id = ${id} and j.kind not in ('leads', 'browser_check')
      order by j.data->>'written_at' desc nulls last, coalesce(j.progress_at, j.started_at) desc nulls last, j.kind
      limit 1) as started_at) cur
    on conflict (campaign_id, kind) do update set status = excluded.status, total = excluded.total, done = excluded.done,
      made = excluded.made, started_at = excluded.started_at, progress_at = excluded.progress_at,
      finished_at = excluded.finished_at, data = excluded.data`;
}

/**
 * For background jobs (draft, review, social; chunks 4, 5, 8): merges progress into the job's row. Only the
 * given columns change, `data` is merged with ||, and the campaigns row is never read or written (F2).
 */
export async function writeJob(sql: Q, campaignId: string, kind: string, patch: Row): Promise<void> {
  if (!kind || NOT_THE_JOB.includes(kind)) throw new CampaignError(400, "writeJob is for draft, review and social jobs");
  checkJob({ ...patch, kind });
  const now = new Date();
  const cols: Row = {};
  const data: Row = { written_at: now.toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "kind") continue;
    if (k === "status" || JOB_INTS.includes(k) || JOB_TIMES.includes(k)) cols[k] = v ?? null;
    else data[k] = v;
  }
  cols.progress_at = now;
  const json = sql.json(data as never);
  await sql`
    insert into campaign_jobs ${sql({ campaign_id: campaignId, kind, ...cols, data: json })}
    on conflict (campaign_id, kind) do update set ${sql(cols)}, data = campaign_jobs.data || ${json}`;
}

/**
 * For the lead search (campaign.run / campaign.sync, chunk 4): the fields the old code wrote into the campaign
 * record (status, apify_*, counts, ...) go to the 'leads' job instead, merged, so a sync can never undo a setting (F2).
 */
export async function writeLeadsJob(sql: Q, campaignId: string, patch: Row): Promise<void> {
  const cols: Row = {};
  const data: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "status") { if (v != null && typeof v !== "string") throw new CampaignError(400, "bad value for status"); cols.status = v ?? null; continue; }
    data[k] = v;
    if (k === "total_leads_found") cols.total = Number.isInteger(v) ? v : null;
    if (k === "leads_imported") cols.done = Number.isInteger(v) ? v : null;
    if (k === "last_run_at") cols.started_at = isTime(v) ? new Date(v as string) : null;
  }
  const json = sql.json(data as never);
  const row = sql({ campaign_id: campaignId, kind: "leads", ...cols, data: json });
  await (Object.keys(cols).length
    ? sql`insert into campaign_jobs ${row} on conflict (campaign_id, kind) do update set ${sql(cols)}, data = campaign_jobs.data || ${json}`
    : sql`insert into campaign_jobs ${row} on conflict (campaign_id, kind) do update set data = campaign_jobs.data || ${json}`);
}

/**
 * outreach.campaign.delete, as today: the campaign, its leads (merged rows too), its unsent drafts, jobs, screenshots,
 * social drafts and worked-out follow-ups go; sent emails stay as history. The leads' touches, follow-up settings,
 * facts and social links stay too (as in Blobs today; to be settled with the orphans, R10). One statement.
 */
export async function remove(sql: Q, id: unknown): Promise<Row> {
  if (!id || typeof id !== "string") throw new CampaignError(400, "id required");
  const [r] = await sql`
    with l as (delete from leads where campaign_id = ${id} returning 1),
      d as (delete from emails where campaign_id = ${id} and status = 'drafted' returning 1),
      s as (delete from lead_screenshots where campaign_id = ${id} returning 1),
      m as (delete from social_messages where campaign_id = ${id} returning 1),
      f as (delete from follow_ups where campaign_id = ${id} returning 1),
      j as (delete from campaign_jobs where campaign_id = ${id} returning 1),
      c as (delete from campaigns where id = ${id} returning 1)
    select (select count(*) from l)::int as leads_deleted, (select count(*) from d)::int as drafts_deleted,
      (select count(*) from emails where campaign_id = ${id} and status is distinct from 'drafted')::int as sent_kept,
      (select count(*) from s) + (select count(*) from m) + (select count(*) from f) + (select count(*) from j) + (select count(*) from c) as others`;
  return { id, deleted: true, leads_deleted: r.leads_deleted, drafts_deleted: r.drafts_deleted, sent_kept: r.sent_kept };
}

// ── The six actions, for command.ts ────────────────────────────────────────

export const CAMPAIGN_ACTIONS = ["outreach.campaign.create", "outreach.campaign.list", "outreach.campaign.get", "outreach.campaign.update", "outreach.campaign.delete", "outreach.leads.count"] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

/** Runs one action. Refusals are thrown as CampaignError (status + message), as the Blobs code answers them. */
export function runCampaignAction(sql: Q, action: CampaignAction, params: Row, ctx: WriteCtx): Promise<unknown> {
  switch (action) {
    case "outreach.campaign.create": return create(sql, params, ctx);
    case "outreach.campaign.list": return list(sql, params);
    case "outreach.campaign.get": return get(sql, params.id);
    case "outreach.campaign.update": return update(sql, params);
    case "outreach.campaign.delete": return remove(sql, params.id);
    case "outreach.leads.count": return leadsCount(sql, params.campaign_id);
  }
}
