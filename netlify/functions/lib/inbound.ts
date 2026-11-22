/**
 * Storing one inbound reply (batch 8b). Used by the AgentMail webhook AND by the "Check AgentMail for missed replies"
 * sync, so both follow the same rules: thread matching, one record per message id, opt-out detection, flagged replies,
 * reply alert. Writes only the fields it changes (the email is re-read right before it is updated).
 */
import { nanoid } from "nanoid";
import { store, readJson, writeJson, listJson } from "./blobs";
import { isOptOutReply, isAutoReply, newPartOfReply, extractEmailAddress, emailKey } from "./outreach";
import { buildReplyRecord, replySubject, flagFor, isInboundEvent, type InboundMessage, type ReplyRecord } from "./replies";

export const OUTREACH_CAMPAIGNS = "agent-hq-outreach-campaigns";
export const OUTREACH_EMAILS = "agent-hq-outreach-emails";
export const OUTREACH_REPLIES = "agent-hq-outreach-replies";
export const OUTREACH_LEADS = "agent-hq-outreach-leads";
export const OUTREACH_SETTINGS = "agent-hq-outreach-settings";
export const SERVICE_CONFIG = "agent-hq-service-config";
const ACTIVITY = "agent-hq-activity";

export function stripTags(html: string | null | undefined): string {
  return (html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ");
}

/**
 * Find the outreach email record that corresponds to an AgentMail message or thread identifier. We match on
 * agentmail_message_id first, then fall back to agentmail_thread_id (for replies that come in on the same thread).
 */
export async function findOutreachEmailByAgentMailIds(
  messageId: string | undefined,
  threadId: string | undefined,
): Promise<{ storeKey: string; record: Record<string, unknown> } | null> {
  if (!messageId && !threadId) return null;
  const es = store(OUTREACH_EMAILS);
  const { blobs } = await es.list();
  for (const b of blobs) {
    const row = await readJson<Record<string, unknown>>(es, b.key);
    if (!row) continue;
    if (messageId && row.agentmail_message_id === messageId) return { storeKey: b.key, record: row };
    if (threadId && row.agentmail_thread_id === threadId) return { storeKey: b.key, record: row };
  }
  return null;
}

/**
 * Flags every lead that matches the replier (by lead id, or by email address as a fallback / across campaigns) as
 * do_not_contact and deletes its queued drafts so nothing more goes out. Returns how many leads were flagged.
 */
export async function markDoNotContact(leadId: string | null, fromEmail: string | null, at: string, replyId: string): Promise<number> {
  const leadsStore = store(OUTREACH_LEADS);
  const emailsStore = store(OUTREACH_EMAILS);
  const { blobs } = await leadsStore.list();
  let flagged = 0;
  for (const b of blobs) {
    const lead = await readJson<Record<string, unknown>>(leadsStore, b.key);
    if (!lead) continue;
    const byId = !!leadId && lead.id === leadId;
    const byEmail = !!fromEmail && emailKey(lead.email as string | null) === fromEmail;
    if (!byId && !byEmail) continue;
    // Re-read so only the do-not-contact fields change.
    const latest = (await readJson<Record<string, unknown>>(leadsStore, b.key)) ?? lead;
    await writeJson(leadsStore, b.key, {
      ...latest,
      do_not_contact: true,
      status: "do_not_contact",
      do_not_contact_at: at,
      do_not_contact_reason: "opt-out reply",
      do_not_contact_reply_id: replyId,
      updated_at: new Date().toISOString(),
    });
    flagged++;
    const cid = (lead.campaign_id as string | undefined) ?? b.key.split("/")[0];
    const { blobs: eblobs } = await emailsStore.list({ prefix: `${cid}/` });
    for (const eb of eblobs) {
      const em = await readJson<{ lead_id?: string; status?: string }>(emailsStore, eb.key);
      if (em && em.lead_id === lead.id && em.status === "drafted") await emailsStore.delete(eb.key);
    }
  }
  return flagged;
}

/** Addresses that are Lakshmi's own: the built-in ones plus the alert address and her sending inboxes from Settings. */
export async function ownAddressList(extra: Array<string | null | undefined> = []): Promise<string[]> {
  const s = await readJson<{ reply_alert_email?: string; sending_inbox_id?: string }>(store(OUTREACH_SETTINGS), "settings");
  return [s?.reply_alert_email, s?.sending_inbox_id, ...extra].filter((x): x is string => typeof x === "string" && x.includes("@")).map((x) => x.trim().toLowerCase());
}

/**
 * One short "new reply" note to the address saved in Settings (blank = off), sent from the sending inbox. Never for
 * opt-outs, auto-replies or the alert address itself. Any failure is swallowed: an alert must not break reply handling.
 * On a local dev server the alert is only logged (ALERTS_LIVE=1 sends it for real).
 */
async function sendReplyAlert(opts: { message: InboundMessage; business: string; campaignName: string; baseUrl: string; receivingInbox: string | undefined; flag: ReplyRecord["flag"] }): Promise<string | null> {
  try {
    const settings = await readJson<{ reply_alert_email?: string; sending_inbox_id?: string }>(store(OUTREACH_SETTINGS), "settings");
    const alertTo = (settings?.reply_alert_email ?? "").trim().toLowerCase();
    if (!alertTo) return null;
    const m = opts.message;
    const fromAddr = extractEmailAddress(m.from);
    const inboxId = (settings?.sending_inbox_id || opts.receivingInbox || m.inbox_id || "").trim();
    if (!inboxId) return null;
    // Loop guards: ignore mail from the alert address or from our own inbox.
    if (fromAddr === alertTo || fromAddr === inboxId.toLowerCase() || alertTo === inboxId.toLowerCase()) return null;
    const subject = replySubject(opts.business, opts.campaignName, opts.flag);
    if (process.env.NETLIFY_DEV === "true" && process.env.ALERTS_LIVE !== "1") {
      console.log(`[reply-alert] (local, not sent) subject: ${subject}`);
      return subject;
    }
    const key = (await readJson<{ key?: string }>(store(SERVICE_CONFIG), "agentmail"))?.key;
    if (!key) return null;
    const body = newPartOfReply(m.text ?? stripTags(m.html)).replace(/\s+\n/g, "\n").trim();
    const snippet = body.length > 300 ? `${body.slice(0, 300).trimEnd()}...` : body;
    const flagLine = opts.flag ? `This reply was flagged "${opts.flag}" by AgentMail. It is usually still a real person: check before acting.` : "";
    const text = [`${opts.business} replied.`, flagLine, "", snippet || "(no text)", "", opts.baseUrl ? `Open your Inbox: ${opts.baseUrl}/inbox` : ""].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n").trim();
    await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: [alertTo], subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    return subject;
  } catch (err) {
    console.warn("[inbound] reply alert failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export type IngestResult = { stored: boolean; duplicate: boolean; reply?: ReplyRecord; alert_subject?: string | null; opt_out?: boolean; dnc_marked?: number };

/**
 * Stores one inbound message as a reply. `alert` is false for the missed-reply sync (it would re-alert on old mail).
 * Duplicates (same AgentMail message id, from either path) are stored once.
 */
export async function ingestInboundReply(o: { eventType: string; message: InboundMessage; baseUrl?: string; alert: boolean; source?: "webhook" | "sync" }): Promise<IngestResult> {
  const message = o.message;
  if (!isInboundEvent(o.eventType)) return { stored: false, duplicate: false };
  const rs = store(OUTREACH_REPLIES);
  // AgentMail can deliver the same event twice, and the sync can meet a message the webhook already stored.
  if (message.message_id) {
    const all = await listJson<{ agentmail_message_id?: string | null }>(rs);
    if (all.some((r) => r.agentmail_message_id === message.message_id)) return { stored: false, duplicate: true };
  }
  const match = await findOutreachEmailByAgentMailIds(undefined, message.thread_id);
  const campaignId = (match?.record.campaign_id as string) ?? null;
  const replyId = nanoid(12);
  const own = await ownAddressList([match?.record.agentmail_inbox_id as string | undefined]);
  const text = message.text ?? stripTags(message.html);
  const optOut = isOptOutReply(message.subject, text);
  const reply = buildReplyRecord({
    id: replyId, eventType: o.eventType, message, own, optOut, source: o.source ?? "webhook",
    match: match ? { campaign_id: campaignId, lead_id: (match.record.lead_id as string | undefined) ?? null, email_id: (match.record.id as string | undefined) ?? null } : null,
  });
  const prefix = campaignId ?? "unassigned";
  await writeJson(rs, `${prefix}/${reply.received_at}-${replyId}`, reply);

  // The email counts as replied only for a real reply: Lakshmi's own test replies never move the counter.
  if (match && !reply.is_test) {
    const es = store(OUTREACH_EMAILS);
    const latest = (await readJson<Record<string, unknown>>(es, match.storeKey)) ?? match.record;
    await writeJson(es, match.storeKey, { ...latest, status: "replied", replied_at: reply.received_at, updated_at: new Date().toISOString() });
  }

  let dnc = 0;
  if (optOut) {
    dnc = await markDoNotContact((match?.record.lead_id as string | undefined) ?? null, extractEmailAddress(message.from), reply.received_at, replyId);
    console.log(`[inbound] opt-out reply ${replyId}: marked ${dnc} lead(s) do_not_contact`);
  }

  let alertSubject: string | null = null;
  if (o.alert && match && !optOut && !isAutoReply(message.subject, text)) {
    const camp = campaignId ? await readJson<{ name?: string }>(store(OUTREACH_CAMPAIGNS), campaignId) : null;
    alertSubject = await sendReplyAlert({
      message,
      business: (match.record.to_name as string | undefined) || extractEmailAddress(message.from) || "A lead",
      campaignName: camp?.name ?? "campaign",
      baseUrl: o.baseUrl ?? "",
      receivingInbox: (match.record.agentmail_inbox_id as string | undefined) ?? undefined,
      flag: reply.flag,
    });
  }

  const activityId = nanoid(12);
  await writeJson(store(ACTIVITY), `${reply.received_at}-${activityId}`, {
    id: activityId, agent_id: null, category: "email",
    summary: `${reply.flag ? `[${reply.flag}] ` : ""}Reply from ${message.from ?? "unknown"}: ${(message.subject ?? "(no subject)").slice(0, 80)}`,
    details: { reply_id: replyId, campaign_id: campaignId, flag: reply.flag },
    created_at: reply.received_at,
  });
  return { stored: true, duplicate: false, reply, alert_subject: alertSubject, opt_out: optOut, dnc_marked: dnc };
}

export { flagFor };
