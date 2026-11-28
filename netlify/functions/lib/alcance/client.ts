// P2 chunk 11 (C1): the Alcance client. One documented module for agents (and the P4 runners) to work the outreach on
// the database. Every function is a thin call into the lib/sql module that already holds its rules (chunks 2–10), so
// there is one copy of each rule. Nothing here reads a key or calls the network itself: AgentMail comes in as a dep.
//
//   const c = alcance((fn) => withTx(fn), { agentmail, baseUrl, ownAddresses, newId, agentId });
//   const plan = await c.planSend("2026-12-01");     // what would go today
//   await c.send(plan, approvalId);                  // only with Lakshmi's send_plan approval for these emails
//
// Say-so: send() and markReady() need an approval made by Lakshmi's master key (approval.create, kind send_plan or
// mark_ready) that is unused, not expired and covers every email. See lib/alcance/approvals.ts.
import { CampaignError } from "../sql/campaigns.ts";
import type { Q } from "../sql/leads.ts";
import { useApproval } from "./approvals.ts";
import { runSendAction, type AgentMail, type Runner } from "../sql/send.ts";
import { create as createEmail, update as updateEmail } from "../sql/emails.ts";
import { replyRecord } from "../sql/replies.ts";
import { runFollowupAction, refreshForLeads } from "../sql/followups.ts";
import { runSocialAction } from "../sql/social.ts";
import { addLeads } from "../sql/addlead.ts";
import { searchAll } from "../sql/search.ts";

type Row = Record<string, unknown>;
export type ClientDeps = { agentmail: AgentMail | null; baseUrl: string; ownAddresses: string[]; newId: () => string; agentId?: string | null; now?: () => Date };
export type Plan = { day?: string; items: Array<{ email_id: string; campaign_id: string } & Row> } & Row;

const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : {}); };
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

export function alcance(run: Runner, deps: ClientDeps) {
  const sendDeps = { agentmail: deps.agentmail, baseUrl: deps.baseUrl, ownAddresses: deps.ownAddresses, newId: deps.newId, createdBy: deps.agentId ?? null };
  const tx = <T>(fn: (q: Q) => Promise<T>) => run(fn);

  return {
    /** Sends counted today (Settings time zone), the daily limit and any send still unknown. */
    today: () => runSendAction(run, "outreach.send.today", {}, sendDeps) as Promise<Row>,

    /** The send plan for `day` (default today): new email 1s first, then due follow-ups, up to the room left. Stopped, not ready, weekends, holidays and blackout dates are left out. */
    planSend: (day?: string, campaignId?: string) => runSendAction(run, "outreach.send.plan", { ...(day ? { day } : {}), ...(campaignId ? { campaign_id: campaignId } : {}) }, sendDeps) as Promise<Plan>,

    /** Sends exactly the plan's emails, only with Lakshmi's send_plan approval covering all of them (used once). */
    async send(plan: Plan, approvalId: unknown): Promise<Row> {
      const items = Array.isArray(plan?.items) ? plan.items : [];
      const ids = items.map((i) => i.email_id);
      if (!ids.length) return fail(400, "The plan has nothing to send", "nothing");
      // Checked against what is stored, not what the plan says: the campaign of each email comes from the database.
      const rows = await tx((q) => q`select id, campaign_id from emails where id = any(${ids})`);
      if (rows.length !== new Set(ids).size) return fail(404, "Some emails in the plan do not exist", "unknown_email");
      await tx((q) => useApproval(q, "send_plan", ids, approvalId, deps.agentId ?? null));
      const byCampaign = new Map<string, string[]>();
      for (const r of rows) byCampaign.set(String(r.campaign_id), [...(byCampaign.get(String(r.campaign_id)) ?? []), String(r.id)]);
      let sent = 0, total = 0;
      const errors: unknown[] = [], not_sent: unknown[] = [];
      for (const [campaign_id, email_ids] of byCampaign) {
        const r = (await runSendAction(run, "outreach.emails.send", { campaign_id, email_ids, limit: email_ids.length }, sendDeps)) as Row;
        sent += Number(r.sent ?? 0); total += Number(r.total ?? 0);
        errors.push(...((r.errors as unknown[]) ?? [])); not_sent.push(...((r.not_sent as unknown[]) ?? []));
      }
      return { sent, total, errors, not_sent, campaigns: byCampaign.size };
    },

    /** Replies from people received after `since` (ISO time), newest first. */
    repliesSince: (since: string, limit = 100) => tx(async (q) => {
      if (Number.isNaN(Date.parse(since))) fail(400, "since must be a date and time");
      const rows = await q`select * from replies where received_at > ${since}::timestamptz and kind = 'person' order by received_at desc, id limit ${Math.min(Math.max(limit, 1), 500)}`;
      return rows.map((r) => replyRecord(r));
    }),

    /** Emails that went out (newest first), by campaign and time. */
    sentList: (f: { campaign_id?: string; since?: string; until?: string; limit?: number } = {}) => tx(async (q) => {
      const rows = await q`select id, campaign_id, lead_id, to_email, subject, step, status, sent_at from emails
                           where sent_at is not null and status not in ('drafted', 'sending')
                             and (${f.campaign_id ?? null}::text is null or campaign_id = ${f.campaign_id ?? null}::text)
                             and (${f.since ?? null}::timestamptz is null or sent_at >= ${f.since ?? null}::timestamptz)
                             and (${f.until ?? null}::timestamptz is null or sent_at < ${f.until ?? null}::timestamptz)
                           order by sent_at desc, id limit ${Math.min(Math.max(f.limit ?? 200, 1), 1000)}`;
      return rows.map((r) => ({ ...r, sent_at: iso(r.sent_at) }));
    }),

    /** Follow-ups due or late on one channel (email, facebook, instagram, linkedin). */
    dueFollowUps: (channel: string) => tx(async (q) => {
      const r = (await runFollowupAction(q, "followups.list", {}, { now: deps.now })) as { rows: Row[] };
      return r.rows.filter((x) => x.channel === channel && x.bucket !== "stopped" && x.bucket !== "waiting");
    }),

    /** Records a social message she sent by hand (date and text), as Settings → hand-sent does. */
    recordSocialSent: (p: { campaign_id: string; lead_id: string; channel: string; text?: string; sent_at?: string; part?: string }) =>
      tx((q) => runSocialAction(q, "outreach.social.record_hand", { campaign_id: p.campaign_id, lead_id: p.lead_id, channel: p.channel, text: p.text, sent_on: p.sent_at, ...(p.part ? { part: p.part } : {}) }, { newId: deps.newId, now: deps.now })),

    /** Marks a lead as having replied by hand (stops it); `undo` puts the old stop back. */
    recordReply: (leadId: string, o: { undo?: boolean } = {}) => tx((q) => runFollowupAction(q, "followups.replied", { lead_id: leadId, ...(o.undo ? { undo: true } : {}) }, { now: deps.now })),

    /** A hand-written draft (one per lead and step). Never calls an AI. */
    createDraft: (p: Row) => tx((q) => createEmail(q, p, { newId: deps.newId, isAgent: true, createdBy: deps.agentId ?? null })),

    /** Marks drafts ready, only with Lakshmi's mark_ready approval covering all of them (used once). A Blocked draft stays Blocked. */
    markReady: (ids: string[], approvalId: unknown) => tx(async (q) => {
      const rows = await q`select id, campaign_id from emails where id = any(${ids})`;
      if (!ids.length || rows.length !== new Set(ids).size) fail(404, "Some of these emails do not exist", "unknown_email");
      await useApproval(q, "mark_ready", ids, approvalId, deps.agentId ?? null);
      for (const r of rows) await updateEmail(q, { campaign_id: r.campaign_id, email_id: r.id, review_status: "ready" });
      return { ready: rows.map((r) => String(r.id)) };
    }),

    /** Adds one lead (duplicate check across campaigns). */
    addLead: (campaignId: string, lead: Row) => tx((q) => addLeads(q, { campaign_id: campaignId, format: "single", lead }, { newId: deps.newId })),

    /** Adds leads from CSV text or pasted lines (duplicate check across campaigns). */
    importLeads: (campaignId: string, src: { csv?: string; text?: string }) =>
      tx((q) => addLeads(q, src.csv !== undefined ? { campaign_id: campaignId, format: "csv", text: src.csv } : { campaign_id: campaignId, format: "paste", text: src.text ?? "" }, { newId: deps.newId })),

    /** Searches campaigns and leads (name, owner, email, phone, website, town). */
    searchLeads: (text: string, limit = 10) => tx((q) => searchAll(q, { q: text, limit })),

    /** Stops a lead for good: do-not-contact with the reason. Its open social steps are skipped (F30) and its follow-ups stop. */
    stopLead: (leadId: string, reason: string) => tx(async (q) => {
      const why = String(reason ?? "").trim();
      if (!why) fail(400, "A reason is needed to stop a lead");
      const [l] = await q`update leads set do_not_contact = true, status = 'do_not_contact', do_not_contact_at = coalesce(do_not_contact_at, now()), do_not_contact_reason = ${why.slice(0, 300)},
                                 stop_state = 'do_not_contact', stop_reason = ${why.slice(0, 300)}, stopped_at = coalesce(stopped_at, now()), updated_at = now()
                          where id = ${leadId} and merged_into is null returning id`;
      if (!l) fail(404, "Lead not found");
      await refreshForLeads(q, { leadIds: [leadId] });
      return { stopped: true, lead_id: leadId, reason: why };
    }),

    /** Moves a lead to social messages: its unsent email drafts become Blocked (never sent), social steps stay open. */
    switchToSocial: (leadId: string) => tx(async (q) => {
      const [l] = await q`update leads set data = data || '{"channel": "social"}'::jsonb, updated_at = now() where id = ${leadId} and merged_into is null returning id`;
      if (!l) fail(404, "Lead not found");
      const blocked = await q`update emails set review_status = 'blocked', review_reasons = ${q.json(["Switched to social messages: no more emails to this lead"] as never)},
                                                reviewed_by = 'alcance client', reviewed_at = now(), updated_at = now()
                              where lead_id = ${leadId} and status = 'drafted' returning id`;
      await refreshForLeads(q, { leadIds: [leadId] });
      return { lead_id: leadId, blocked: blocked.map((r) => String(r.id)).sort() };
    }),

    /** The last 7 days (to now): sends, deliveries, bounces, replies from people, opt-outs, clicks, form posts, follow-ups due. */
    weeklyReport: () => tx(async (q) => {
      const to = deps.now?.() ?? new Date();
      const from = new Date(to.getTime() - 7 * 86_400_000);
      const [r] = await q`select
          (select count(*)::int from emails where sent_at >= ${from} and sent_at < ${to}) as sent,
          (select count(*)::int from emails where delivered_at >= ${from} and delivered_at < ${to}) as delivered,
          (select count(*)::int from emails where bounced_at >= ${from} and bounced_at < ${to}) as bounced,
          (select count(*)::int from replies where received_at >= ${from} and received_at < ${to} and kind = 'person') as replies,
          (select count(*)::int from replies where received_at >= ${from} and received_at < ${to} and opt_out) as opt_outs,
          (select count(*)::int from clicks where clicked_at >= ${from} and clicked_at < ${to}) as clicks,
          (select count(*)::int from form_submissions where received_at >= ${from} and received_at < ${to} and not spam) as form_posts,
          (select count(*)::int from follow_ups where stopped_reason is null and due_date <= (${to}::timestamptz at time zone settings_time_zone())::date) as follow_ups_due`;
      return { from: from.toISOString(), to: to.toISOString(), ...r };
    }),

    /** Is everything working: the database answers, the last migration, unsent outbox rows, emails stuck in "sending", the last webhook event and the last send. */
    health: () => tx(async (q) => {
      const [r] = await q`select
          (select name from schema_migrations order by name desc limit 1) as last_migration,
          (select count(*)::int from outbox where sent_at is null) as outbox_unsent,
          (select count(*)::int from emails where status = 'sending' and updated_at < now() - interval '10 minutes') as stuck_sending,
          (select max(received_at) from webhook_events) as last_webhook_event_at,
          (select max(sent_at) from emails) as last_send_at`;
      return { database: "ok", last_migration: r.last_migration, outbox_unsent: r.outbox_unsent, stuck_sending: r.stuck_sending, last_webhook_event_at: iso(r.last_webhook_event_at), last_send_at: iso(r.last_send_at) };
    }),

    /** P4: website checks move to the runners. */
    checkWebsite: async (_leadId: string): Promise<never> => fail(501, "Website checks move to the P4 runners.", "moves_to_p4"),
    /** P6: the CRM handoff. Until then, CRM events wait in the outbox. */
    sendToCrm: async (_leadId: string): Promise<never> => fail(501, "The CRM handoff comes in P6; events wait in the outbox until then.", "moves_to_p6"),
  };
}
export type AlcanceClient = ReturnType<typeof alcance>;
