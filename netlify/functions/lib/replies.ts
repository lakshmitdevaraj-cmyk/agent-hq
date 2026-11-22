/**
 * Inbound replies (batch 8b). Pure helpers, no I/O, so the webhook, the missed-reply sync and the tests share one set of rules.
 * AgentMail files an inbound message under message.received, or message.received.spam / .blocked / .unauthenticated
 * (and any future message.received.*). Every one of them is a reply from a person until proven otherwise.
 */
import { extractEmailAddress } from "./outreach";

export type ReplyFlag = "unauthenticated" | "spam" | "blocked" | null;

/** Lakshmi's own addresses: replies from these are test replies (shown in the Inbox, never counted). */
export const OWN_ADDRESSES = ["shiftforge.ai@gmail.com", "lakshmi_devaraj@yahoo.com"];

/** Every event type HQ handles. The AgentMail webhook must be subscribed to all of them. */
export const REQUIRED_WEBHOOK_EVENTS = [
  "domain.verified",
  "message.bounced",
  "message.complained",
  "message.delivered",
  "message.received",
  "message.received.blocked",
  "message.received.spam",
  "message.received.unauthenticated",
  "message.rejected",
  "message.sent",
];

export function isInboundEvent(type: string | null | undefined): boolean {
  return typeof type === "string" && (type === "message.received" || type.startsWith("message.received."));
}

/** null = normal reply. The event type decides first, the message labels second. */
export function flagFor(type: string | null | undefined, labels: string[] | null | undefined): ReplyFlag {
  const t = (type ?? "").toLowerCase();
  const l = new Set((labels ?? []).map((x) => String(x).toLowerCase()));
  if (t.endsWith(".blocked") || l.has("blocked")) return "blocked";
  if (t.endsWith(".spam") || l.has("spam")) return "spam";
  if (t.endsWith(".unauthenticated") || l.has("unauthenticated")) return "unauthenticated";
  return null;
}

export function isOwnAddress(from: string | null | undefined, extra: string[] = []): boolean {
  const a = extractEmailAddress(from ?? "");
  if (!a) return false;
  // name+tag@gmail.com is the same mailbox as name@gmail.com (Lakshmi's test leads use plus-addresses).
  const base = (x: string) => x.trim().toLowerCase().replace(/^([^@+]+)\+[^@]*@(gmail\.com|googlemail\.com|yahoo\.com)$/, "$1@$2");
  return [...OWN_ADDRESSES, ...extra].some((x) => base(x) === base(a));
}

export const HEALTH_CHECK_SUBJECT = "ShiftForge HQ webhook health check";
export const isHealthCheckMessage = (subject: string | null | undefined) => /ShiftForge HQ webhook health check/i.test(subject ?? "");

/** Delivery failure reports keep their existing bounce handling; they are not replies. */
export function isBounceReport(from: string | null | undefined, subject: string | null | undefined): boolean {
  return /mailer-daemon|postmaster@/i.test(from ?? "") || /^\s*(?:delivery status notification|undeliverable|mail delivery (?:failed|subsystem))/i.test(subject ?? "");
}

const FLAG_LABEL: Record<Exclude<ReplyFlag, null>, string> = { unauthenticated: "Unauthenticated", spam: "Spam", blocked: "Blocked" };
export const flagLabel = (f: ReplyFlag) => (f ? FLAG_LABEL[f] : null);
export const FLAG_TIP: Record<Exclude<ReplyFlag, null>, string> = {
  unauthenticated: "The sender's domain has no email authentication. Usually a real person; check before acting.",
  spam: "AgentMail's filter marked this as spam. Often a real reply; check before acting.",
  blocked: "AgentMail blocked this sender. Check before acting.",
};

/** The reply-alert subject: the flag leads when there is one. */
export function replySubject(business: string, campaignName: string, flag: ReplyFlag): string {
  const s = flag ? `[${FLAG_LABEL[flag]}] Reply from ${business}` : `New reply: ${business} (${campaignName})`;
  return s.replace(/[\r\n]+/g, " ").slice(0, 200);
}

export type InboundMessage = {
  message_id?: string; thread_id?: string; inbox_id?: string; subject?: string; from?: string; to?: string[];
  text?: string; extracted_text?: string; preview?: string; html?: string; timestamp?: string; labels?: string[]; authentication_results?: Record<string, unknown> | null;
};

export type ReplyRecord = {
  id: string; campaign_id: string | null; lead_id: string | null; original_email_id: string | null;
  agentmail_message_id: string | null; agentmail_thread_id: string | null; from: string | null; to: string[] | null;
  subject: string | null; text: string | null; html: string | null; received_at: string; handled: boolean; opt_out: boolean;
  flag: ReplyFlag; labels: string[]; authentication_results: Record<string, unknown> | null; is_test: boolean; source: "webhook" | "sync";
};

export function buildReplyRecord(o: {
  id: string; eventType: string; message: InboundMessage;
  match: { campaign_id?: string | null; lead_id?: string | null; email_id?: string | null } | null;
  own: string[]; optOut: boolean; source?: "webhook" | "sync"; now?: string;
}): ReplyRecord {
  const m = o.message;
  const labels = Array.isArray(m.labels) ? m.labels.map(String) : [];
  return {
    id: o.id,
    campaign_id: o.match?.campaign_id ?? null,
    lead_id: o.match?.lead_id ?? null,
    original_email_id: o.match?.email_id ?? null,
    agentmail_message_id: m.message_id ?? null,
    agentmail_thread_id: m.thread_id ?? null,
    from: m.from ?? null,
    to: m.to ?? null,
    subject: m.subject ?? null,
    text: replyBodyText(m) || null,
    html: m.html ?? null,
    received_at: m.timestamp ?? o.now ?? new Date().toISOString(),
    handled: false,
    opt_out: o.optOut,
    flag: flagFor(o.eventType, labels),
    labels,
    authentication_results: m.authentication_results && typeof m.authentication_results === "object" ? m.authentication_results : null,
    is_test: isOwnAddress(m.from, o.own),
    source: o.source ?? "webhook",
  };
}

/** Emails whose every stored reply came from Lakshmi herself: they do not count as replied. */
export function ownReplyEmailIds(replies: Array<{ original_email_id?: string | null; is_test?: boolean }>): Set<string> {
  const hasReal = new Set<string>();
  const hasOwn = new Set<string>();
  for (const r of replies) {
    if (!r.original_email_id) continue;
    (r.is_test ? hasOwn : hasReal).add(r.original_email_id);
  }
  return new Set([...hasOwn].filter((id) => !hasReal.has(id)));
}

/** Replied emails, leaving out those that only have a test reply. */
export function repliedEmailCount(emails: Array<{ id?: string; status?: string }>, ownOnly: Set<string>): number {
  return emails.filter((e) => e.status === "replied" && !(e.id && ownOnly.has(e.id))).length;
}

// ── Missed-reply sync (AgentMail list items) ─────────────────────────
export type ListedMessage = {
  message_id?: string; thread_id?: string; inbox_id?: string; labels?: string[]; from?: string; to?: string[];
  subject?: string; timestamp?: string; preview?: string; text?: string; extracted_text?: string; html?: string; authentication_results?: Record<string, unknown> | null;
};

/** An inbound message in a list: labelled "received" and never one of our own sent messages. */
export function isListedInbound(m: ListedMessage): boolean {
  const l = (m.labels ?? []).map((x) => String(x).toLowerCase());
  return l.includes("received") && !l.includes("sent");
}

export function listedToMessage(m: ListedMessage): InboundMessage {
  return {
    message_id: m.message_id, thread_id: m.thread_id, inbox_id: m.inbox_id, subject: m.subject, from: m.from, to: m.to,
    text: m.text, extracted_text: m.extracted_text, preview: m.preview, html: m.html, timestamp: m.timestamp, labels: m.labels ?? [], authentication_results: m.authentication_results ?? null,
  };
}

// ── Webhook subscription ─────────────────────────────────────────────
/** The full list to send: what is subscribed now plus anything HQ handles that is missing. Never removes an event. */
export function webhookEventsToSend(current: string[]): string[] {
  return [...new Set([...current, ...REQUIRED_WEBHOOK_EVENTS])].sort();
}

/** What would change, without changing anything (local testing is read-only). */
export function dryRunWebhookPatch(w: { webhook_id: string; event_types: string[] }): { webhook_id: string; before: string[]; after: string[]; added: string[]; needs_change: boolean; body: { event_types: string[] } } {
  const after = webhookEventsToSend(w.event_types);
  const added = after.filter((e) => !w.event_types.includes(e));
  return { webhook_id: w.webhook_id, before: w.event_types, after, added, needs_change: added.length > 0, body: { event_types: after } };
}

/**
 * Query string for AgentMail's List Messages. AgentMail HIDES spam, blocked and unauthenticated messages from this list unless they are
 * asked for, and those are exactly the replies the webhook may have missed, so every list call must carry all three flags.
 */
export function listMessagesQuery(pageToken?: string | null, limit = 100): string {
  const q = new URLSearchParams({ limit: String(limit), include_unauthenticated: "true", include_spam: "true", include_blocked: "true" });
  if (pageToken) q.set("page_token", pageToken);
  return q.toString();
}

// ── Reply body text ──────────────────────────────────────────────────
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026" };

/** HTML to plain text: drops style/script/head, turns block ends into line breaks, decodes common entities. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return String(html)
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The reply's words: text, else AgentMail's extracted_text, else the HTML as plain text, else the list preview. */
export function replyBodyText(m: { text?: string | null; extracted_text?: string | null; html?: string | null; preview?: string | null }): string {
  for (const t of [m.text, m.extracted_text]) if (t && t.trim()) return t;
  return htmlToText(m.html) || (m.preview ?? "").trim();
}
