// P2 chunk 6: sending and the send plan, on Postgres. The SQL twins of `outreach.emails.send` and `outreach.send.today`
// in command.ts (logic copied, so the old Blobs code is not touched), plus `outreach.send.plan` (C1 planSend, SQL only).
//   - send.today and send.plan are one database call each (C2): the functions send_today / plan_send (migration 0013).
//   - emails.send never double-sends (F45): one UPDATE claims the drafts as "sending" and commits BEFORE any AgentMail
//     call; each row then becomes "sent" (ids, sent_at) only from "sending". A second call finds nothing to claim.
//   - A failed send keeps its reason (R2): AgentMail answered with an error -> "failed" and emails.error. It is never a
//     bounce and never touches the lead's stop_state. No answer at all (network error, timeout) -> the row stays
//     "sending" with the reason, because it may have gone out: it is never sent again on its own (send.today counts it).
//   - A country that requires a postal address refuses the send while Settings has none (R9).
//   - Stop states (F7, F8): a lead whose stop_state is do_not_contact, replied or bounced gets no email (social is not
//     touched here). Bounced = a real bounce or complaint of that address; a failed send is not a bounce.
// AgentMail only comes in through `deps.agentmail` (command.ts wraps its own helpers); tests pass a stub, and the
// test harness refuses every real network call.
import type { Sql, Tx } from "../db/client.ts";
import { CampaignError } from "./campaigns.ts";
import { codeCheckDraft, readSettings } from "./emailchecks.ts";
import { appendFooter, textToHtml } from "../outreach.ts";
import { RULES_VERSION } from "../messagerules.ts";

type Q = Sql | Tx;
type Row = Record<string, unknown>;

export type SendAction = "outreach.emails.send" | "outreach.send.today" | "outreach.send.plan";

/** Runs `fn` as one short transaction and commits it (command.ts: withTx; tests: their own rolled-back transaction). */
export type Runner = <T>(fn: (q: Q) => Promise<T>) => Promise<T>;

export type AgentMailInbox = { inbox_id: string; email?: string; display_name?: string };
/** What AgentMail answered. `ok: false` is a real answer (an HTTP error); a missing answer is a thrown error. */
export type AgentMailResult = { ok: true; message_id?: string; thread_id?: string } | { ok: false; status: number; text: string };
export type AgentMail = {
  inbox(campaignName: string): Promise<AgentMailInbox>;
  setDisplayName(inboxId: string, name: string, current?: string): Promise<void>;
  post(path: string, body: Row): Promise<AgentMailResult>;
};
export type SendDeps = {
  /** null when no AgentMail key is set up. */
  agentmail: AgentMail | null;
  baseUrl: string;
  ownAddresses: string[];
  newId: () => string;
  createdBy?: string | null;
};

const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : {}); };
const NO_ANSWER = "No answer from AgentMail, so it may have gone out. Check the inbox before sending it again.";

export async function runSendAction(run: Runner, action: SendAction, params: Row, deps: SendDeps): Promise<unknown> {
  switch (action) {
    case "outreach.send.today": return run((q) => sendToday(q, deps));
    case "outreach.send.plan": return run((q) => sendPlan(q, params, deps));
    case "outreach.emails.send": return send(run, params, deps);
    default: return fail(400, `unknown send action: ${String(action)}`);
  }
}

async function sendToday(q: Q, deps: SendDeps) {
  const [r] = await q`select send_today(${deps.ownAddresses}::text[]) as t`;
  const t = r.t as Row;
  return { sent_today: Number(t.sent_today), limit: Number(t.limit), sending_unknown: Number(t.sending_unknown), day: t.day, time_zone: t.time_zone };
}

async function sendPlan(q: Q, params: Row, deps: SendDeps) {
  const day = params.day;
  if (day !== undefined && (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`)))) fail(400, "day must be a date like 2026-12-01");
  const cid = params.campaign_id;
  if (cid !== undefined && (typeof cid !== "string" || !cid)) fail(400, "campaign_id must be text");
  // One call: the day defaults to today in the Settings time zone, inside the function's own statement.
  const camp = (cid as string | undefined) ?? null;
  const dayText = (day as string | undefined) ?? null;
  const [r] = dayText
    ? await q`select plan_send(${dayText}::date, ${deps.ownAddresses}::text[], ${camp}) as p`
    : await q`select plan_send((now() at time zone settings_time_zone())::date, ${deps.ownAddresses}::text[], ${camp}) as p`;
  return r.p;
}

// ── emails.send ─────────────────────────────────────────────────────────

type NotSent = { email_id: string; to_email?: string; step?: number; reason: string; code: string };
type Draft = Row & { id: string; lead_id: string; to_email: string; step: number; status: string; review_status: string | null; created_at: unknown };

/** copy of rewriteLinksForTracking in command.ts */
export function rewriteLinksForTracking(html: string, baseUrl: string, campaignId: string, leadId: string, emailId: string): string {
  return html.replace(/href="([^"]+)"/gi, (full, rawUrl) => {
    if (!rawUrl || typeof rawUrl !== "string") return full;
    if (/^(#|mailto:|tel:|sms:)/i.test(rawUrl)) return full;
    if (rawUrl.startsWith(`${baseUrl}/t/`)) return full;
    const token = Buffer.from(JSON.stringify({ c: campaignId, l: leadId, e: emailId, u: rawUrl })).toString("base64url");
    return `href="${baseUrl}/t/${token}"`;
  });
}

const STOP_REASON: Record<string, string> = {
  do_not_contact: "Do not contact: this lead or address asked not to be emailed",
  replied: "This lead already replied, so no more emails are sent",
  bounced: "This lead's address bounced, so email stops (social messages stay open)",
};

/** The old campaign record's `status` is the lead-search job's status on Postgres. */
async function setCampaignStatus(q: Q, cid: string, status: string): Promise<void> {
  await q`insert into campaign_jobs (campaign_id, kind, status) values (${cid}, 'leads', ${status})
          on conflict (campaign_id, kind) do update set status = excluded.status`;
}

async function send(run: Runner, params: Row, deps: SendDeps) {
  const { campaign_id, email_ids, sequence_position, limit, allow_check } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  if (!deps.agentmail) fail(400, "AgentMail key not configured");
  const am = deps.agentmail!;
  const cid = campaign_id as string;
  const selectedIds = Array.isArray(email_ids) ? new Set((email_ids as unknown[]).map(String)) : null;
  const targetStep = typeof sequence_position === "number" && sequence_position >= 1 ? Math.floor(sequence_position) : null;
  const batchLimit = typeof limit === "number" && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : null;

  // ── 1. Decide and claim, in one committed transaction ──
  const decided = await run(async (q) => {
    const [campaign] = await q`select c.id, c.name, c.default_sender_name, known_country(c.country) as country, p.postal_address_required
                               from campaigns c left join country_profiles p on p.code = known_country(c.country) where c.id = ${cid}`;
    if (!campaign) fail(404, "campaign not found");
    const settings = await readSettings(q);
    const postal = String(settings.postal_address ?? "").trim();
    // A failed row goes again only when she names it.
    const drafts = (await q`
      select e.*, l.do_not_contact, l.excluded, l.is_test, l.stop_state, l.merged_into,
             exists (select 1 from contacts k where k.kind = 'do_not_contact' and k.email <> '' and k.email = e.to_key) as dnc_address,
             (exists (select 1 from emails o where o.to_key = e.to_key and o.id <> e.id and o.status in ('bounced', 'complained'))
              or exists (select 1 from contacts k where k.kind = 'bounced' and k.email <> '' and k.email = e.to_key)) as bounced_address,
             (exists (select 1 from emails o where o.to_key = e.to_key and o.campaign_id <> e.campaign_id and not o.is_duplicate
                        and o.status not in ('drafted', 'failed'))
              or exists (select 1 from contacts k where k.kind = 'sent' and k.email <> '' and k.email = e.to_key and k.campaign_id <> e.campaign_id)) as other_campaign
      from emails e left join leads l on l.id = e.lead_id
      where e.campaign_id = ${cid} and not e.is_duplicate
      order by e.created_at, e.id`) as Draft[];
    const reviewOf = (e: Draft) => (e.review_status === "ready" || e.review_status === "blocked" ? e.review_status : "check");
    const passesReview = (e: Draft) => {
      const st = reviewOf(e);
      return st === "ready" || (st === "check" && !!selectedIds && selectedIds.has(e.id) && allow_check === true);
    };
    const sendable = (e: Draft) => e.status === "drafted" || (e.status === "failed" && !!selectedIds && selectedIds.has(e.id));
    const isDnc = (e: Draft) => e.do_not_contact === true || e.dnc_address === true || e.stop_state === "do_not_contact";
    const contactBlocked = (e: Draft): string | null => (e.bounced_address ? "bounced earlier" : !e.is_test && e.other_campaign ? "already contacted in another campaign" : null);
    const whyNot = (e: Draft): { code: string; reason: string } | null => {
      if (!sendable(e)) return { code: "not_draft", reason: `Not a draft any more (status: ${e.status})` };
      if (e.merged_into) return { code: "lead_skipped", reason: "This lead was merged into another one" };
      if (isDnc(e)) return { code: "do_not_contact", reason: STOP_REASON.do_not_contact };
      if (e.excluded) return { code: "lead_skipped", reason: "This lead was skipped (not a fit)" };
      if (e.stop_state === "bounced") return { code: "bounced", reason: STOP_REASON.bounced };
      const cb = contactBlocked(e);
      if (cb) return { code: "contacted", reason: cb };
      if (!passesReview(e)) return reviewOf(e) === "blocked"
        ? { code: "blocked", reason: `Blocked: ${(Array.isArray(e.review_reasons) ? (e.review_reasons as string[]) : []).join(" | ") || "fix it first"}` }
        : { code: "not_ready", reason: "Check this: mark it ready or tick it and confirm" };
      if (e.stop_state === "replied") return { code: "replied", reason: STOP_REASON.replied };
      return null;
    };
    const inScope = (e: Draft) => (selectedIds ? selectedIds.has(e.id) : targetStep !== null ? e.step === targetStep : true);
    const notSent: NotSent[] = [];
    const candidates = drafts.filter((e) => inScope(e) && sendable(e));
    if (selectedIds) for (const id of selectedIds) if (!drafts.some((e) => e.id === id)) notSent.push({ email_id: id, reason: "No draft with this id in this campaign", code: "not_found" });
    if (selectedIds) for (const e of drafts.filter((x) => selectedIds.has(x.id) && !sendable(x))) notSent.push({ email_id: e.id, to_email: e.to_email, step: e.step, ...whyNot(e)! });
    const eligible = candidates.filter((e) => {
      const w = whyNot(e);
      if (w) { if (selectedIds || w.code === "replied" || w.code === "blocked" || w.code === "bounced") notSent.push({ email_id: e.id, to_email: e.to_email, step: e.step, ...w }); return false; }
      return true;
    });
    // R9: refused before anything is claimed or sent.
    if (eligible.length && campaign.postal_address_required && !postal) {
      fail(409, `A postal address is required for emails to ${campaign.country} leads. Add yours in Settings, then send again. Nothing was sent.`, "postal_address_required");
    }
    // Send-time gate: the free code checks run again on each draft (an old Ready draft can break newer rules).
    const toSend: Draft[] = [];
    let gateBlocked = 0;
    for (const e of eligible) {
      if (batchLimit && toSend.length >= batchLimit) break;
      const ck = await codeCheckDraft(q, e, settings);
      if (ck.hard.length) {
        gateBlocked++;
        await q`update emails set review_status = 'blocked', review_reasons = ${q.json(ck.reasons as never)}, reviewed_by = 'code checks', reviewed_at = now(), rules_version = ${RULES_VERSION}
                where id = ${e.id} and status = 'drafted'`;
        notSent.push({ email_id: e.id, to_email: e.to_email, step: e.step, code: "blocked", reason: `Blocked by the free checks: ${ck.hard.join(" | ")}` });
        continue;
      }
      toSend.push(e);
    }
    const overLimit = batchLimit ? eligible.length - gateBlocked - toSend.length : 0;
    const okForQueue = (e: Draft) => e.status === "drafted" && !isDnc(e) && !e.excluded && !e.merged_into && !contactBlocked(e) && e.stop_state !== "bounced" && reviewOf(e) === "ready";
    const queuedBefore = drafts.filter(okForQueue).length;
    const inScopeDrafted = drafts.filter((e) => e.status === "drafted" && inScope(e) && !isDnc(e) && !contactBlocked(e));
    const skipInfo = {
      skipped_excluded: inScopeDrafted.filter((e) => e.excluded).length,
      skipped_blocked: inScopeDrafted.filter((e) => !e.excluded && reviewOf(e) === "blocked").length + gateBlocked,
      skipped_not_ready: inScopeDrafted.filter((e) => !e.excluded && reviewOf(e) === "check" && !passesReview(e)).length,
      skipped_over_limit: overLimit,
      not_sent: notSent,
    };
    const skippedContacted = drafts.filter((e) => e.status === "drafted" && !isDnc(e) && contactBlocked(e) && (!selectedIds || selectedIds.has(e.id)))
      .map((e) => ({ email_id: e.id, to_email: e.to_email, reason: contactBlocked(e)!.replace(/^./, (c) => c.toUpperCase()) }));
    if (toSend.length === 0) {
      const first = notSent.slice(0, 3).map((x) => `${x.to_email ?? x.email_id}${x.step ? ` (email ${x.step})` : ""}: ${x.reason}`).join("; ");
      const reason = notSent.length ? `Nothing was sent. ${first.replace(/\.$/, "")}${notSent.length > 3 ? `; and ${notSent.length - 3} more` : ""}.`
        : candidates.length === 0 ? (selectedIds ? "Nothing was sent: none of the chosen emails is a draft." : targetStep !== null ? `Nothing was sent: there are no drafts for email ${targetStep}.` : "Nothing was sent: there are no drafts in this campaign.")
        : "Nothing was sent: no draft is ready.";
      return { done: { sent: 0, total: 0, queued: queuedBefore, errors: [], ...skipInfo, reason, skipped_do_not_contact: drafts.filter((e) => e.status === "drafted" && isDnc(e)).length, skipped_contacted: skippedContacted } };
    }
    // F45: claim before any AgentMail call. Only rows still drafted (or the named failed ones) are taken.
    const ids = toSend.map((e) => e.id);
    const claimed = await q`update emails set status = 'sending', error = null, updated_at = now()
                            where id = any(${ids}::text[]) and (status = 'drafted' or (status = 'failed' and id = any(${selectedIds ? [...selectedIds] : []}::text[])))
                            returning id`;
    const got = new Set(claimed.map((r) => String(r.id)));
    for (const e of toSend) if (!got.has(e.id)) notSent.push({ email_id: e.id, to_email: e.to_email, step: e.step, code: "not_draft", reason: "Another send took this draft first" });
    // The campaign's status is its lead-search job's status (campaign_jobs, kind 'leads'), as lib/sql/campaigns.ts reads it.
    await setCampaignStatus(q, cid, "sending");
    // Email 1 of each lead with a later step, for the thread.
    const leadIds = [...new Set(toSend.filter((e) => e.framework === "four-step" && e.step > 1).map((e) => e.lead_id))];
    const firsts = leadIds.length
      ? await q`select distinct on (lead_id) lead_id, agentmail_message_id, agentmail_inbox_id from emails
                where lead_id = any(${leadIds}::text[]) and step = 1 and agentmail_message_id is not null and status not in ('drafted', 'failed', 'sending')
                order by lead_id, sent_at desc nulls last`
      : [];
    return {
      campaign, postal, skipInfo, skippedContacted, queuedBefore,
      toSend: toSend.filter((e) => got.has(e.id)), notSent,
      firstOf: new Map(firsts.map((f) => [String(f.lead_id), { message_id: String(f.agentmail_message_id), inbox_id: (f.agentmail_inbox_id as string | null) ?? null }])),
    };
  });
  if ("done" in decided) return decided.done;

  // ── 2. One AgentMail call per claimed row; each result is written on its own ──
  const { campaign, postal, toSend, firstOf } = decided;
  let sent = 0;
  const errors: Array<{ email_id: string; error: string }> = [];
  const sentLeadIds = new Set<string>();
  let inbox: AgentMailInbox | null = null;
  try {
    try {
      inbox = await am.inbox(String(campaign.name ?? ""));
    } catch (e) {
      // Nothing went out: the claimed rows go back to drafted with the reason.
      const msg = `Could not get the sending inbox: ${(e as Error).message}`.slice(0, 500);
      await run((q) => q`update emails set status = 'drafted', error = ${msg}, updated_at = now() where id = any(${toSend.map((x) => x.id)}::text[]) and status = 'sending'`);
      return fail(502, msg);
    }
    const senderName = String(campaign.default_sender_name ?? "");
    if (senderName) { try { await am.setDisplayName(inbox.inbox_id, senderName, inbox.display_name); } catch { /* non-fatal, as today */ } }
    for (const em of toSend) {
      const tracked = rewriteLinksForTracking(String(em.body_html || textToHtml(String(em.body_text || ""))), deps.baseUrl, cid, em.lead_id, em.id);
      const withFooter = appendFooter(String(em.body_text || ""), tracked, postal, String(em.sender_name || senderName));
      let path = `/inboxes/${inbox.inbox_id}/messages/send`;
      let usedInbox = inbox.inbox_id; // F47: the inbox the email really goes out from is the one stored
      let body: Row = { to: [em.to_email], subject: em.subject, text: withFooter.text, html: withFooter.html };
      if (em.framework === "four-step" && em.step > 1) {
        const first = firstOf.get(em.lead_id);
        if (!first) {
          const msg = "Send email 1 first: this one goes as a reply in the same thread.";
          errors.push({ email_id: em.id, error: msg });
          await run((q) => q`update emails set status = 'drafted', error = ${msg}, updated_at = now() where id = ${em.id} and status = 'sending'`);
          continue;
        }
        usedInbox = first.inbox_id || inbox.inbox_id;
        path = `/inboxes/${encodeURIComponent(usedInbox)}/messages/${encodeURIComponent(first.message_id)}/reply`;
        body = { text: withFooter.text, html: withFooter.html };
      }
      let res: AgentMailResult;
      try {
        res = await am.post(path, body);
      } catch (e) {
        const msg = `${NO_ANSWER} (${String((e as Error)?.message ?? e).slice(0, 200)})`;
        errors.push({ email_id: em.id, error: msg });
        await run((q) => q`update emails set error = ${msg}, updated_at = now() where id = ${em.id} and status = 'sending'`);
        continue;
      }
      if (!res.ok) {
        const msg = `AgentMail send ${res.status}: ${res.text.slice(0, 200)}`;
        errors.push({ email_id: em.id, error: msg });
        await run((q) => q`update emails set status = 'failed', error = ${msg}, updated_at = now() where id = ${em.id} and status = 'sending'`);
        continue;
      }
      const at = new Date().toISOString();
      const ok = res;
      await run((q) => q`update emails set status = 'sent', error = null, agentmail_message_id = ${ok.message_id ?? null}, agentmail_thread_id = ${ok.thread_id ?? null},
                                  agentmail_inbox_id = ${usedInbox}, sent_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
                         where id = ${em.id} and status = 'sending'`);
      sent++;
      sentLeadIds.add(em.lead_id);
    }
  } finally {
    // The campaign never stays "sending", whatever happened above.
    await run(async (q) => {
      if (sentLeadIds.size) await q`update leads set contacted_at = coalesce(contacted_at, now()) where id = any(${[...sentLeadIds]}::text[])`;
      const [{ n }] = await q`select count(*)::int as n from emails e join leads l on l.id = e.lead_id
                              where e.campaign_id = ${cid} and e.status = 'drafted' and not e.is_duplicate and e.review_status = 'ready'
                                and not l.excluded and not l.do_not_contact and l.stop_state = 'none' and l.merged_into is null`;
      const status = sent > 0 ? (n > 0 ? "ready" : "completed") : "failed";
      // last_send_at lives in the campaign's data (no column), as the old record kept it.
      await setCampaignStatus(q, cid, status);
      await q`update campaigns set updated_at = now(),
                                   data = case when ${inbox !== null} then data || jsonb_build_object('last_send_at', now()) else data end,
                                   agentmail_inbox_id = coalesce(${inbox?.inbox_id ?? null}, agentmail_inbox_id) where id = ${cid}`;
    });
  }
  const queued = await run(async (q) => {
    const [{ n }] = await q`select count(*)::int as n from emails e join leads l on l.id = e.lead_id
                            where e.campaign_id = ${cid} and e.status = 'drafted' and not e.is_duplicate and e.review_status = 'ready'
                              and not l.excluded and not l.do_not_contact and l.stop_state = 'none' and l.merged_into is null`;
    const id = deps.newId(), now = new Date();
    await q`insert into activity (id, blob_key, agent_id, category, summary, details, created_at)
            values (${id}, ${`${now.toISOString()}-${id}`}, ${deps.createdBy ?? null}, 'email', ${`Sent ${sent} of ${toSend.length} emails for "${String(campaign.name ?? "")}" (${n} still queued)`},
                    ${q.json({ campaign_id: cid, sent, queued: n, errors: errors.length, inbox: inbox?.inbox_id ?? null } as never)}, ${now})`;
    return n as number;
  });
  return {
    sent, total: toSend.length, queued, errors, inbox,
    skipped_contacted: decided.skippedContacted, ...decided.skipInfo, not_sent: decided.notSent,
  };
}
