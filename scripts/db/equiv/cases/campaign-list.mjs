// Equivalence case: outreach.campaign.list. The SQL version below is a TEST REFERENCE that rebuilds today's
// answer from the imported tables. It is not the P2 rewrite (chunk 2), which will also leave out merged leads.
//
// Today's answer (command.ts): every campaign record, newest first, with its state record laid over it
// (STATE_KEYS), leads_imported = number of lead records (if any), and counters worked out from its emails.

export const action = "outreach.campaign.list";
export const params = {};

const STATE_KEYS = ["job", "browser_checked_ids", "default_sender_name", "default_sender_company", "default_sender_offer", "default_framework", "default_sequence_total"];

/** Same rule as deriveCampaign in command.ts. */
function derive(c, emails) {
  if (emails.length === 0) return c;
  const sent = emails.filter((e) => e.status && e.status !== "drafted").length;
  const queued = emails.length - sent;
  const out = {
    ...c,
    emails_generated: emails.length,
    emails_sent: sent,
    emails_delivered: emails.filter((e) => ["delivered", "clicked", "replied"].includes(e.status ?? "")).length,
    emails_clicked: emails.filter((e) => e.status === "clicked" || (e.click_count ?? 0) > 0).length,
    emails_replied: emails.filter((e) => e.status === "replied" && !e.own_reply_only).length,
    emails_bounced: emails.filter((e) => ["bounced", "complained", "failed"].includes(e.status ?? "")).length,
  };
  const st = c.status;
  const sendingNow = st === "sending" && Date.now() - Date.parse(c.updated_at ?? "") < 5 * 60_000;
  if (!sendingNow && ["ready", "sending", "completed", "failed"].includes(st) && sent > 0) out.status = queued > 0 ? "ready" : "completed";
  return out;
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

/** The SQL version: four queries, then the same shaping as today. */
export async function sqlVersion(tx) {
  const campaigns = await tx`select * from campaigns order by created_at desc nulls last`;
  const jobs = await tx`select * from campaign_jobs`;
  const leadCounts = new Map((await tx`select campaign_id, count(*)::int as n from leads group by campaign_id`).map((r) => [r.campaign_id, r.n]));
  const emails = await tx`
    select e.campaign_id, e.status, e.click_count,
           (exists (select 1 from replies r where r.original_email_id = e.id and r.campaign_id = e.campaign_id and r.kind = 'test')
            and not exists (select 1 from replies r where r.original_email_id = e.id and r.campaign_id = e.campaign_id and r.kind is distinct from 'test')) as own_reply_only
    from emails e`;
  const emailsBy = Map.groupBy(emails, (e) => e.campaign_id);
  const jobsBy = Map.groupBy(jobs, (j) => j.campaign_id);

  return campaigns.map((c) => {
    const mine = jobsBy.get(c.id) ?? [];
    const leadsJob = mine.find((j) => j.kind === "leads");
    const runJob = mine.find((j) => j.kind !== "leads" && j.kind !== "browser_check");
    const checked = mine.find((j) => j.kind === "browser_check");
    const record = {
      ...c.data,
      id: c.id, name: c.name, description: c.description, query: c.niche, created_by: c.created_by,
      default_sender_name: c.default_sender_name, default_sender_company: c.default_sender_company, default_sender_offer: c.default_sender_offer,
      default_framework: c.default_framework, default_sequence_total: c.default_sequence_total,
      any_trade: c.any_trade, agentmail_inbox_id: c.agentmail_inbox_id, created_at: iso(c.created_at), updated_at: iso(c.updated_at),
      ...(leadsJob?.data ?? {}),
      status: leadsJob?.status ?? null,
    };
    if (runJob) record.job = { ...runJob.data, kind: runJob.kind, status: runJob.status, total: runJob.total, done: runJob.done, made: runJob.made, started_at: iso(runJob.started_at), progress_at: iso(runJob.progress_at), finished_at: iso(runJob.finished_at) };
    if (checked) record.browser_checked_ids = checked.data.browser_checked_ids;
    for (const k of STATE_KEYS) if (!(k in record)) delete record[k];
    const n = leadCounts.get(c.id) ?? 0;
    const stored = typeof record.leads_imported === "number" ? record.leads_imported : 0;
    return derive({ ...record, leads_imported: n > 0 ? n : stored }, (emailsBy.get(c.id) ?? []).map((e) => ({ ...e, click_count: Number(e.click_count) })));
  });
}

/** A deliberately wrong version, to show the harness fails when the SQL path is wrong (lead count off by one). */
export async function brokenSqlVersion(tx) {
  return (await sqlVersion(tx)).map((c, i) => (i === 0 ? { ...c, leads_imported: c.leads_imported + 1 } : c));
}

/**
 * Differences found, each with its reason. Matched narrowly (path AND values), so anything else still fails.
 * FINDING (27 Nov 2026, needs Lakshmi's decision before chunk 2): older campaign records have no `any_trade`.
 * Today's code reads a missing value as TRUE (`any_trade !== false` in campaignSkipCtx), but the P1 import
 * stored FALSE (the column's default). Fix options: a migration setting those campaigns to true, or the rewrite
 * reading them as true. Until decided, the difference is listed here and counted by the test.
 */
export const known = [
  { path: /^\$\[\d+\]\.any_trade$/, when: (d) => d.old === "(absent)" && d.new === false, why: "missing any_trade imported as false; old code reads it as true (needs decision)" },
];
