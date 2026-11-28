// P2 chunk 7: inbound replies on Postgres. The SQL twins of `outreach.replies.list / get / delete`, `outreach.reply.send`
// and `outreach.replies.sync` in command.ts, and of `ingestInboundReply` in lib/inbound.ts (logic copied; the old Blobs
// code is not touched). The pure rules come from the same lib/ files (replies.ts, outreach.ts, messagerules.ts).
//   - One row per AgentMail message id. A reply is matched by its thread to the latest sent email of that thread.
//   - Stop states (F7, F8): a person's reply → the lead's stop_state "replied" (do-not-contact wins); an opt-out → every lead
//     with that address (any campaign) do-not-contact and its unsent drafts deleted; a delivery failure report → a bounce of
//     the matched email's address (as P1 imported them). Lakshmi's own replies are tests and change no state.
//   - R12 / F31: the "new reply" alert, the FYI alert for an opt-out or bounce, and the CRM handoff are outbox rows written in
//     the same transaction (lib/sql/outbox.ts); they are sent after commit.
//   - `outreach.reply.draft` answers 501 until P4 (it needs the AI writer, as generate_one does since chunk 5).
// AgentMail comes in only through `deps.agentmail`; tests pass a stub and the harness refuses every real network call.
import type { Sql, Tx } from "../db/client.ts";
import { CampaignError } from "./campaigns.ts";
import { enqueue } from "./outbox.ts";
import { isOptOutReply, isAutoReply, newPartOfReply, extractEmailAddress, emailKey, appendFooter, textToHtml } from "../outreach.ts";
import {
  buildReplyRecord, replyBodyText, replySubject, isInboundEvent, isSystemReply, isTestReply, isBounceReport, isListedInbound, listedToMessage,
  listMessagesQuery, flagFor, type InboundMessage, type ListedMessage, type ReplyRecord,
} from "../replies.ts";
import { scanBanned } from "../messagerules.ts";

type Q = Sql | Tx;
type Row = Record<string, unknown>;
export type Runner = <T>(fn: (q: Q) => Promise<T>) => Promise<T>;

export type ReplyAction = "outreach.replies.list" | "outreach.replies.get" | "outreach.replies.delete" | "outreach.reply.send" | "outreach.reply.draft" | "outreach.replies.sync";
export const REPLY_ACTIONS: ReplyAction[] = ["outreach.replies.list", "outreach.replies.get", "outreach.replies.delete", "outreach.reply.send", "outreach.reply.draft", "outreach.replies.sync"];

export type AgentMailGet = { ok: true; body: Row } | { ok: false; status: number; text: string };
export type AgentMailApi = {
  inbox?(name: string): Promise<{ inbox_id: string; email?: string }>;
  post(path: string, body: Row): Promise<{ ok: true; message_id?: string; thread_id?: string } | { ok: false; status: number; text: string }>;
  get?(path: string): Promise<AgentMailGet>;
};
export type ReplyDeps = { newId: () => string; ownAddresses: string[]; agentmail: AgentMailApi | null; baseUrl: string; agentId?: string | null; senderFallback?: string };

const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };

// D2: the health-check subject says Alcance now. Mail sent before the rename still has the old one, so both are recognised.
export const HEALTH_CHECK_SUBJECT = "Alcance webhook health check";
export const isHealthCheck = (subject: string | null | undefined) => /(?:Alcance|ShiftForge HQ) webhook health check/i.test(subject ?? "");

// ── The reply record ─────────────────────────────────────────────────────

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
/** The old Blobs reply record, put back together from its columns and `data` (unset columns come back as null, as buildReplyRecord wrote them). */
export function replyRecord(r: Row): Row {
  return {
    ...((r.data as Row | null) ?? {}),
    id: r.id, campaign_id: r.campaign_id ?? null, lead_id: r.lead_id ?? null, original_email_id: r.original_email_id ?? null,
    agentmail_message_id: r.agentmail_message_id ?? null, agentmail_thread_id: r.agentmail_thread_id ?? null,
    from: r.from_address ?? null, subject: r.subject ?? null, text: r.body_text ?? null, html: r.body_html ?? null,
    received_at: iso(r.received_at), handled: r.handled === true, opt_out: r.opt_out === true, flag: r.flag ?? null, source: r.source ?? null,
  };
}

async function settingsOf(q: Q): Promise<Row> {
  const [s] = await q`select data from outreach_settings where key = 'settings'`;
  return (s?.data as Row | undefined) ?? {};
}

// ── Ingest (the SQL twin of ingestInboundReply) ──────────────────────────

export type IngestResult = { stored: boolean; duplicate: boolean; reply?: ReplyRecord; opt_out?: boolean; dnc_marked?: number };

/** Builds the alert note's addressing, or null when alerts are off or it would loop (the rules of lib/inbound.ts sendReplyAlert). */
function alertTarget(settings: Row, fromAddr: string | null, receivingInbox: string | null | undefined, messageInbox: string | null | undefined): { to: string; inbox_id: string } | null {
  const to = String(settings.reply_alert_email ?? "").trim().toLowerCase();
  if (!to) return null;
  const inbox = String(settings.sending_inbox_id || receivingInbox || messageInbox || "").trim();
  if (!inbox) return null;
  if (fromAddr === to || fromAddr === inbox.toLowerCase() || to === inbox.toLowerCase()) return null;
  return { to, inbox_id: inbox };
}

/** The F31 note for an opt-out, a bounce or a complaint. Written to the outbox; nothing to do for Lakshmi. */
export async function queueFyi(q: Q, settings: Row, o: { what: "opted out" | "bounced" | "complained"; business: string; campaignName: string; fromAddr: string | null; inbox?: string | null; lead_id: string | null; campaign_id: string | null; reply_id?: string | null; email_id?: string | null }) {
  const t = alertTarget(settings, o.fromAddr, o.inbox, null);
  if (!t) return;
  const line = o.what === "opted out" ? "asked not to be emailed again. They are marked do-not-contact and their unsent drafts are removed."
    : o.what === "bounced" ? "bounced. Email to this address has stopped; social messages stay open."
    : "marked the email as spam. They are marked do-not-contact.";
  await enqueue(q, "alert.fyi", {
    to: [t.to], inbox_id: t.inbox_id, subject: `[Alcance] FYI: ${o.business} ${o.what}`.replace(/[\r\n]+/g, " ").slice(0, 200),
    text: `FYI, no action needed.\n\n${o.business} (${o.campaignName}) ${line}`,
    what: o.what, lead_id: o.lead_id, campaign_id: o.campaign_id, reply_id: o.reply_id ?? null, email_id: o.email_id ?? null,
  });
}

/** Marks every lead matching the replier (by lead id, or by address in any campaign) do-not-contact and deletes its unsent drafts. */
async function markDoNotContact(q: Q, leadId: string | null, fromKey: string | null, at: string, replyId: string): Promise<number> {
  const rows = await q`update leads set do_not_contact = true, status = 'do_not_contact', do_not_contact_at = ${at}::timestamptz, do_not_contact_reason = 'opt-out reply',
                              stop_state = 'do_not_contact', stop_reason = coalesce(nullif(stop_reason, ''), 'opt-out reply'), stopped_at = coalesce(stopped_at, ${at}::timestamptz),
                              data = data || ${q.json({ do_not_contact_reply_id: replyId })}, updated_at = now()
                       where id = ${leadId ?? ""} or (${fromKey}::text is not null and email_key = ${fromKey}) returning id`;
  const ids = rows.map((r) => String(r.id));
  if (ids.length) await q`delete from emails where lead_id = any(${ids}::text[]) and status = 'drafted'`;
  return ids.length;
}

export async function ingest(q: Q, o: { eventType: string; message: InboundMessage; baseUrl?: string; alert: boolean; source?: "webhook" | "sync" }, deps: ReplyDeps): Promise<IngestResult> {
  const message: InboundMessage = { ...o.message, text: replyBodyText(o.message) };
  if (!isInboundEvent(o.eventType)) return { stored: false, duplicate: false };
  if (message.message_id) {
    const [dup] = await q`select 1 as x from replies where agentmail_message_id = ${message.message_id} limit 1`;
    if (dup) return { stored: false, duplicate: true };
  }
  const [match] = message.thread_id
    ? await q`select e.id, e.campaign_id, e.lead_id, e.to_name, e.to_key, e.agentmail_inbox_id, c.name as campaign_name from emails e left join campaigns c on c.id = e.campaign_id
              where e.agentmail_thread_id = ${message.thread_id} order by (e.sent_at is null), e.sent_at desc, e.step desc limit 1`
    : [];
  const settings = await settingsOf(q);
  const own = [...deps.ownAddresses, settings.reply_alert_email, settings.sending_inbox_id, match?.agentmail_inbox_id]
    .filter((x): x is string => typeof x === "string" && x.includes("@")).map((x) => x.trim().toLowerCase());
  const text = message.text ?? "";
  const optOut = isOptOutReply(message.subject, text);
  const replyId = deps.newId();
  const reply = buildReplyRecord({
    id: replyId, eventType: o.eventType, message, own, optOut, source: o.source ?? "webhook",
    match: match ? { campaign_id: (match.campaign_id as string) ?? null, lead_id: (match.lead_id as string) ?? null, email_id: String(match.id) } : null,
  });
  const kind = isBounceReport(reply.from, reply.subject) ? "bounce_report" : isSystemReply(reply) ? "system" : reply.is_test ? "test" : "person";
  const fromAddr = extractEmailAddress(message.from);
  const fromKey = emailKey(fromAddr);
  await q`insert into replies ${q({
    id: replyId, blob_key: `${reply.campaign_id ?? "unassigned"}/${reply.received_at}-${replyId}`, campaign_id: reply.campaign_id, lead_id: reply.lead_id,
    original_email_id: reply.original_email_id, agentmail_message_id: reply.agentmail_message_id, agentmail_thread_id: reply.agentmail_thread_id,
    from_address: reply.from, from_key: fromKey, subject: reply.subject, body_text: reply.text, body_html: reply.html, received_at: reply.received_at,
    handled: false, opt_out: optOut, flag: reply.flag, is_test: kind === "test", kind, source: reply.source,
    data: q.json({ to: reply.to, labels: reply.labels, authentication_results: reply.authentication_results, is_test: reply.is_test } as never),
  } as never)}`;

  const business = String(match?.to_name || fromAddr || "A lead");
  const campaignName = String(match?.campaign_name ?? "campaign");
  if (match && kind === "person") {
    await q`update emails set status = 'replied', replied_at = ${reply.received_at}::timestamptz, updated_at = now() where id = ${match.id}`;
    await q`update leads set stop_state = 'replied', stop_reason = 'reply', stopped_at = coalesce(stopped_at, ${reply.received_at}::timestamptz), updated_at = now()
            where id = ${match.lead_id} and stop_state in ('none', 'bounced')`;
  }
  if (match && kind === "bounce_report" && match.to_key) {
    await q`update emails set status = 'bounced', bounced_at = coalesce(bounced_at, ${reply.received_at}::timestamptz), updated_at = now() where id = ${match.id} and status not in ('replied', 'complained')`;
    await noteBounce(q, String(match.to_key), reply.received_at, "bounce report");
    await queueFyi(q, settings, { what: "bounced", business, campaignName, fromAddr: null, inbox: match.agentmail_inbox_id as string, lead_id: (match.lead_id as string) ?? null, campaign_id: reply.campaign_id, reply_id: replyId, email_id: String(match.id) });
  }

  let dnc = 0;
  if (optOut) {
    dnc = await markDoNotContact(q, reply.lead_id, fromKey, reply.received_at, replyId);
    await queueFyi(q, settings, { what: "opted out", business, campaignName, fromAddr, inbox: match?.agentmail_inbox_id as string, lead_id: reply.lead_id, campaign_id: reply.campaign_id, reply_id: replyId });
  }

  // The "new reply" alert: same rules as today (match, not an opt-out, not an auto-reply, the loop guards). Own test replies alert too, so the alert can be tested.
  if (o.alert && match && !optOut && kind !== "bounce_report" && kind !== "system" && !isAutoReply(message.subject, text)) {
    const t = alertTarget(settings, fromAddr, match.agentmail_inbox_id as string, message.inbox_id);
    if (t) {
      const body = newPartOfReply(text).replace(/\s+\n/g, "\n").trim();
      const snippet = body.length > 300 ? `${body.slice(0, 300).trimEnd()}...` : body;
      const flagLine = reply.flag ? `This reply was flagged "${reply.flag}" by AgentMail. It is usually still a real person: check before acting.` : "";
      const baseUrl = o.baseUrl ?? deps.baseUrl;
      const alertText = [`${business} replied.`, flagLine, "", snippet || "(no text)", "", baseUrl ? `Open your Inbox: ${baseUrl}/inbox` : ""].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n").trim();
      await enqueue(q, "alert.reply", { to: [t.to], inbox_id: t.inbox_id, subject: replySubject(business, campaignName, reply.flag), text: alertText, reply_id: replyId });
    }
  }
  if (match && kind === "person" && !optOut) {
    await enqueue(q, "crm.reply_received", { reply_id: replyId, lead_id: reply.lead_id, campaign_id: reply.campaign_id, email_id: reply.original_email_id, received_at: reply.received_at, flag: reply.flag });
  }

  await q`insert into activity (id, blob_key, agent_id, category, summary, details, created_at, data) values (
            ${deps.newId()}, null, null, 'email', ${`${reply.flag ? `[${reply.flag}] ` : ""}Reply from ${message.from ?? "unknown"}: ${(message.subject ?? "(no subject)").slice(0, 80)}`},
            ${q.json({ reply_id: replyId, campaign_id: reply.campaign_id, flag: reply.flag } as never)}, ${reply.received_at}::timestamptz, '{}')`;
  return { stored: true, duplicate: false, reply, opt_out: optOut, dnc_marked: dnc };
}

/** A real bounce of `address`: a bounced contact entry, and stop state "bounced" for every lead whose current address it is (F7: email only). */
export async function noteBounce(q: Q, address: string, at: string, why: string) {
  const key = address.trim().toLowerCase();
  await q`insert into contacts (blob_key, kind, email, campaign_id, value) values (${`bounced/${key}`}, 'bounced', ${key}, '', ${at}) on conflict (blob_key) do nothing`;
  await q`update leads set stop_state = 'bounced', stop_reason = ${why}, stopped_at = coalesce(stopped_at, ${at}::timestamptz), updated_at = now()
          where email_key = ${key} and stop_state = 'none'`;
}

// ── Actions ──────────────────────────────────────────────────────────────

export async function runReplyAction(run: Runner, action: ReplyAction, params: Row, deps: ReplyDeps): Promise<unknown> {
  switch (action) {
    case "outreach.replies.list": return run((q) => list(q, params));
    case "outreach.replies.get": return run((q) => get(q, params));
    case "outreach.replies.delete": return run((q) => remove(q, params));
    case "outreach.reply.send": return replySend(run, params, deps);
    case "outreach.reply.draft": return fail(501, "Drafting a reply on the database comes with the P4 runners (it needs the AI writer).");
    case "outreach.replies.sync": return sync(run, params, deps);
    default: return fail(400, `unknown reply action: ${String(action)}`);
  }
}

async function list(q: Q, params: Row) {
  const cid = typeof params.campaign_id === "string" && params.campaign_id ? params.campaign_id : null;
  const limit = typeof params.limit === "number" ? params.limit : 200;
  // A broken record (no sender, no date, no text) is left out, as on the old path. Newest first; rows without a date last;
  // two replies in the same second: the later blob key first (the old sort left such ties to the sort algorithm).
  const rows = await q`select * from replies
                       where (${cid}::text is null or campaign_id = ${cid} or (${cid} = 'unassigned' and campaign_id is null))
                         and not (from_address is null and received_at is null and coalesce(btrim(body_text), '') = '' and coalesce(btrim(body_html), '') = '')
                       order by received_at desc nulls last, blob_key desc nulls last, id limit ${Math.max(0, Math.floor(limit))}`;
  return rows.map((row) => {
    const r0 = replyRecord(row) as Row & { text?: string | null };
    const r = { ...r0, is_test: isTestReply(r0 as never), system: isSystemReply(r0 as never) };
    return r.text && String(r.text).trim() ? r : { ...r, text: replyBodyText(r as never) || r.text || null };
  });
}

async function get(q: Q, params: Row) {
  const id = params.id;
  if (!id || typeof id !== "string") return fail(400, "id required");
  const [row] = await q`select * from replies where id = ${id}`;
  if (!row) return fail(404, "reply not found");
  return replyRecord(row);
}

async function remove(q: Q, params: Row) {
  const id = params.id;
  if (!id || typeof id !== "string") return fail(400, "id required");
  // The lead is not touched: a do-not-contact flag set by this reply stays in force.
  const gone = await q`delete from replies where id = ${id} returning id`;
  if (!gone.length) return fail(404, "reply not found");
  return { id, deleted: true };
}

async function replySend(run: Runner, params: Row, deps: ReplyDeps) {
  const { id, text: rawText, preview, resend } = params as { id?: string; text?: string; preview?: boolean; resend?: boolean };
  if (!id) return fail(400, "id required");
  const body = String(rawText ?? "").replace(/\r/g, "").trim();
  if (!body) return fail(400, "The reply is empty.");
  const plan = await run(async (q) => {
    const [row] = await q`select * from replies where id = ${id}`;
    if (!row) return fail(404, "reply not found");
    const reply = replyRecord(row) as Row & { our_reply?: unknown };
    if (row.opt_out) return fail(400, "This person asked us to stop. Nothing is sent.");
    const to = extractEmailAddress(String(row.from_address ?? ""));
    if (!to) return fail(400, "This reply has no sender address to answer.");
    if (!row.agentmail_message_id) return fail(400, "This reply has no AgentMail message id, so it cannot be answered in its thread. Copy the text and send it by hand.");
    const [lead] = row.lead_id ? await q`select do_not_contact, stop_state from leads where id = ${row.lead_id}` : [];
    if (lead && (lead.do_not_contact || lead.stop_state === "do_not_contact")) return fail(400, "This lead is marked do-not-contact. Nothing is sent.");
    const [original] = row.original_email_id
      ? await q`select id, agentmail_inbox_id, sender_name, subject from emails where id = ${row.original_email_id}`
      : row.lead_id ? await q`select id, agentmail_inbox_id, sender_name, subject from emails where lead_id = ${row.lead_id} and agentmail_inbox_id is not null order by step limit 1` : [];
    const inboxId = String(original?.agentmail_inbox_id ?? "").trim();
    if (!inboxId) return fail(400, "Could not find the inbox the original email was sent from, so the reply cannot be sent in the same thread.");
    if (reply.our_reply && !resend) return fail(400, "You already sent a reply to this message. Send again only if you mean to.");
    const hard = scanBanned(body).filter((h) => h.level === "hard" && h.id !== "dash");
    if (hard.length) return fail(400, `Fix this before sending: ${hard.map((h) => `${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}`).join("; ")}`);
    const settings = await settingsOf(q);
    const [camp] = row.campaign_id ? await q`select default_sender_name from campaigns where id = ${row.campaign_id}` : [];
    const senderName = String(original?.sender_name || camp?.default_sender_name || deps.senderFallback || "Lakshmi Devaraj").trim();
    const postal = String(settings.postal_address ?? "");
    const withFooter = appendFooter(body, textToHtml(body), postal, senderName);
    const subject = /^re:/i.test(String(row.subject ?? "")) ? String(row.subject) : `Re: ${row.subject ?? original?.subject ?? ""}`.trim();
    return { reply, row, view: { to, subject, text: withFooter.text, inbox_id: inboxId, thread_id: (row.agentmail_thread_id as string | null) ?? null, postal_address_set: !!postal.trim() }, html: withFooter.html };
  });
  if (preview) return { preview: true, ...plan.view };
  const am = deps.agentmail;
  if (!am) return fail(400, "AgentMail key not configured");
  const r = await am.post(`/inboxes/${encodeURIComponent(plan.view.inbox_id)}/messages/${encodeURIComponent(String(plan.row.agentmail_message_id))}/reply`, { text: plan.view.text, html: plan.html });
  if (!r.ok) return fail(502, `AgentMail reply ${r.status}: ${r.text.slice(0, 200)}`);
  const sentAt = new Date().toISOString();
  const ourReply = { sent_at: sentAt, message_id: r.message_id ?? null, thread_id: r.thread_id ?? plan.view.thread_id, inbox_id: plan.view.inbox_id, to: plan.view.to, subject: plan.view.subject, text: plan.view.text };
  await run(async (q) => {
    await q`update replies set handled = true, data = data || ${q.json({ our_reply: ourReply } as never)} where id = ${id}`;
    await q`insert into activity (id, agent_id, category, summary, details, created_at, data) values (${deps.newId()}, ${deps.agentId ?? null}, 'email',
              ${`Replied to ${plan.view.to} in the same thread (${plan.view.subject.slice(0, 60)})`},
              ${q.json({ reply_id: id, campaign_id: plan.row.campaign_id ?? null, message_id: r.message_id ?? null } as never)}, now(), '{}')`;
  });
  return { sent: true, message_id: r.message_id ?? null, ...plan.view, thread_id: r.thread_id ?? plan.view.thread_id };
}

type Inbox = { inbox_id: string; email?: string };
async function sync(run: Runner, params: Row, deps: ReplyDeps) {
  const am = deps.agentmail;
  if (!am?.get) return fail(400, "AgentMail key not configured");
  const get = am.get.bind(am);
  const days = Number(params.days) || 14, maxNew = Number(params.max_new) || 40;
  const cutoff = Date.now() - Math.max(1, Math.min(60, days)) * 86_400_000;
  const inboxes: Inbox[] = [];
  let tok: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = await get(`/inboxes?limit=100${tok ? `&page_token=${encodeURIComponent(tok)}` : ""}`);
    if (!r.ok) return fail(502, `AgentMail inbox list failed (${r.status})`);
    inboxes.push(...(((r.body.inboxes as Inbox[] | undefined) ?? [])));
    tok = r.body.next_page_token as string | undefined;
    if (!tok) break;
  }
  const have = new Set((await run((q) => q`select agentmail_message_id from replies where agentmail_message_id is not null`)).map((x) => String(x.agentmail_message_id)));
  const skipped = { already_have: 0, own_sent: 0, bounce_reports: 0, health_checks: 0, too_old: 0 };
  const candidates: Array<{ inbox: Inbox; m: ListedMessage }> = [];
  let scanned = 0;
  for (const inbox of inboxes) {
    let pt: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await get(`/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages?${listMessagesQuery(pt)}`);
      if (!r.ok) return fail(502, `AgentMail message list failed for ${inbox.inbox_id} (${r.status})`);
      for (const m of ((r.body.messages as ListedMessage[] | undefined) ?? [])) {
        scanned++;
        if (!isListedInbound(m)) { skipped.own_sent++; continue; }
        if (Date.parse(m.timestamp ?? "") < cutoff) { skipped.too_old++; continue; }
        if (isHealthCheck(m.subject)) { skipped.health_checks++; continue; }
        if (isBounceReport(m.from, m.subject)) { skipped.bounce_reports++; continue; }
        if (m.message_id && have.has(m.message_id)) { skipped.already_have++; continue; }
        candidates.push({ inbox, m: { ...m, inbox_id: m.inbox_id ?? inbox.inbox_id } });
      }
      pt = r.body.next_page_token as string | undefined;
      if (!pt) break;
    }
  }
  candidates.sort((x, y) => ((x.m.timestamp ?? "") < (y.m.timestamp ?? "") ? -1 : 1));
  const limit = Math.max(1, Math.min(100, maxNew));
  const own = [...deps.ownAddresses, ...inboxes.map((i) => i.email ?? i.inbox_id)];
  const added: Array<{ from: string | null; subject: string | null; flag: string | null; campaign_id: string | null; received_at: string; test: boolean }> = [];
  let flagged = 0;
  for (const { inbox, m } of candidates.slice(0, limit)) {
    let full: ListedMessage = m;
    try {
      const r = await get(`/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(m.message_id ?? "")}`);
      if (r.ok) full = { ...m, ...(r.body as ListedMessage), labels: m.labels };
    } catch { /* the list item (with its preview) is enough */ }
    const msg = listedToMessage(full);
    const flag = flagFor("message.received", msg.labels);
    const res = await run((q) => ingest(q, { eventType: flag ? `message.received.${flag}` : "message.received", message: msg, alert: false, source: "sync" }, { ...deps, ownAddresses: own }));
    if (res.stored && res.reply) {
      if (res.reply.flag) flagged++;
      added.push({ from: res.reply.from, subject: res.reply.subject, flag: res.reply.flag, campaign_id: res.reply.campaign_id, received_at: res.reply.received_at, test: res.reply.is_test });
    }
  }
  return { added: added.length, flagged, scanned, skipped, more: Math.max(0, candidates.length - limit), items: added, inboxes: inboxes.map((i) => i.email ?? i.inbox_id), own_checked: own.filter((x) => x && x.includes("@")).length };
}
