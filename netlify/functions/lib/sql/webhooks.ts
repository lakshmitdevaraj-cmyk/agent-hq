// P2 chunk 7: webhooks on Postgres. The SQL twins of `webhook.create / create_typed / list / events / delete` and
// `outreach.webhook.test` in command.ts, a new `webhook.set_secret`, and `receive`, the SQL path of webhook-receive.ts.
//   - R4: AgentMail signs its webhooks the Svix way (headers svix-id, svix-timestamp, svix-signature "v1,<base64>"; the
//     signed text is "<id>.<timestamp>.<raw body>", HMAC-SHA256 with the secret after "whsec_", base64). An AgentMail
//     webhook with no secret saved refuses every event (fail closed). A refused event is not stored and changes nothing;
//     the refusal is counted on the webhook (V8). A generic webhook with no secret logs the raw event as today, but an
//     AgentMail-looking body on it is no longer applied. Raw events are kept 30 days (each receive deletes older ones).
//   - F47: an outbound event matches an email by its AgentMail message id. The thread id is a fallback only when exactly
//     one email of that thread has no message id saved. A webhook never changes sent_at; the status only moves forward; the
//     event's inbox id is saved as the inbox actually used.
//   - F7/F8: a bounce stops email to that address (stop state "bounced"); a complaint makes the lead do-not-contact; a
//     rejection is a failed send with its reason, never a bounce (26 Nov rule). F31: an FYI alert for a bounce or complaint.
//   - V8: webhook.list gives each webhook's status: signed, last event, events in the last 30 days, refusals.
//   - The secret is stored on the webhook row and is never returned by any read.
import { refreshForLeads } from "./followups.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sql, Tx } from "../db/client.ts";
import { CampaignError } from "./campaigns.ts";
import { drain, type AlertPost } from "./outbox.ts";
import { ingest, noteBounce, queueFyi, HEALTH_CHECK_SUBJECT, type ReplyDeps, type AgentMailApi } from "./replies.ts";
import { isInboundEvent, type InboundMessage } from "../replies.ts";

type Q = Sql | Tx;
type Row = Record<string, unknown>;
export type Runner = <T>(fn: (q: Q) => Promise<T>) => Promise<T>;

export type WebhookAction = "webhook.create" | "webhook.create_typed" | "webhook.list" | "webhook.events" | "webhook.delete" | "webhook.set_secret" | "outreach.webhook.test";
export const WEBHOOK_ACTIONS: WebhookAction[] = ["webhook.create", "webhook.create_typed", "webhook.list", "webhook.events", "webhook.delete", "webhook.set_secret", "outreach.webhook.test"];
export type WebhookDeps = ReplyDeps & { sleep?: (ms: number) => Promise<void> };

const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };
/** Keys of `webhooks.data` that are kept for the status or the signature and are not fields of the old record. */
const INTERNAL = new Set(["signing_secret", "refused_count", "last_refused_at", "last_refused_reason", "last_event_at"]);
const TOLERANCE_S = 5 * 60;
const SECRET_RE = /^whsec_[A-Za-z0-9+/]+=*$/;

// ── R4: the signature ────────────────────────────────────────────────────

const header = (h: Record<string, unknown>, name: string): string => {
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === name) return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  return "";
};

/** Checks a Svix-style signature. `nowS` is the current time in seconds. */
export function verifySignature(secret: string | null | undefined, headers: Record<string, unknown>, rawBody: string, nowS = Math.floor(Date.now() / 1000)): { ok: true } | { ok: false; reason: string } {
  if (!secret || !SECRET_RE.test(secret)) return { ok: false, reason: "no signing secret saved for this webhook" };
  const id = header(headers, "svix-id"), ts = header(headers, "svix-timestamp"), sigs = header(headers, "svix-signature");
  if (!id || !ts || !sigs) return { ok: false, reason: "unsigned event (no svix-id, svix-timestamp or svix-signature)" };
  const t = Number(ts);
  if (!Number.isInteger(t) || Math.abs(nowS - t) > TOLERANCE_S) return { ok: false, reason: "timestamp too old or in the future" };
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const part of sigs.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const got = Buffer.from(value, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature does not match" };
}

// ── Records ──────────────────────────────────────────────────────────────

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
function webhookRecord(r: Row): Row {
  const data = Object.fromEntries(Object.entries((r.data as Row | null) ?? {}).filter(([k]) => !INTERNAL.has(k)));
  return { ...data, id: r.id, name: r.name, ...(r.service ? { service: r.service } : {}), event_count: Number(r.event_count ?? 0), created_at: iso(r.created_at) };
}
function statusOf(r: Row): Row {
  const d = (r.data as Row | null) ?? {};
  return {
    signed: typeof d.signing_secret === "string" && SECRET_RE.test(d.signing_secret),
    last_event_at: iso(r.last_event_at ?? d.last_event_at ?? null),
    events_30d: Number(r.events_30d ?? 0),
    refused_count: Number(d.refused_count ?? 0),
    last_refused_at: d.last_refused_at ?? null,
    last_refused_reason: d.last_refused_reason ?? null,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────

export async function runWebhookAction(q: Q, action: WebhookAction, params: Row, deps: WebhookDeps): Promise<unknown> {
  const p = params as Record<string, string | undefined>;
  switch (action) {
    case "webhook.create":
    case "webhook.create_typed": {
      if (!p.name) return fail(400, "name required");
      const id = deps.newId();
      const created_at = new Date().toISOString();
      const service = action === "webhook.create_typed" ? (p.service ?? "generic") : null;
      await q`insert into webhooks (id, blob_key, name, service, event_count, created_at, data) values (${id}, ${id}, ${p.name}, ${service}, 0, ${created_at}::timestamptz, ${q.json({ description: p.description ?? "" })})`;
      return { id, name: p.name, description: p.description ?? "", ...(service ? { service } : {}), event_count: 0, created_at };
    }
    case "webhook.list": {
      const rows = await q`select w.*, (select max(received_at) from webhook_events e where e.webhook_id = w.id) as last_event_at,
                                  (select count(*)::int from webhook_events e where e.webhook_id = w.id and e.received_at > now() - interval '30 days') as events_30d
                           from webhooks w order by w.created_at, w.id`;
      return rows.map((r) => ({ ...webhookRecord(r), status: statusOf(r) }));
    }
    case "webhook.events": {
      if (!p.id) return fail(400, "id required");
      const rows = await q`select * from webhook_events where webhook_id = ${p.id} order by received_at, id`;
      return rows.map((r) => ({ ...((r.data as Row | null) ?? {}), id: r.id, webhook_id: r.webhook_id, headers: r.headers, body: r.body, received_at: iso(r.received_at) }));
    }
    case "webhook.delete": {
      if (!p.id) return fail(400, "id required");
      // Its raw events go too (the Webhooks page can no longer show them, and they would never reach the 30-day purge).
      await q`delete from webhook_events where webhook_id = ${p.id}`;
      await q`delete from webhooks where id = ${p.id}`;
      return { id: p.id, deleted: true };
    }
    case "webhook.set_secret": {
      if (!p.id) return fail(400, "id required");
      const secret = String(p.secret ?? "").trim();
      if (!SECRET_RE.test(secret) || Buffer.from(secret.slice(6), "base64").length < 16) return fail(400, "secret must be the webhook's signing secret from AgentMail (it starts with whsec_)");
      const done = await q`update webhooks set data = data || ${q.json({ signing_secret: secret })} where id = ${p.id} returning id`;
      if (!done.length) return fail(404, "webhook not found");
      return { id: p.id, signed: true };
    }
    case "outreach.webhook.test": return healthTest(q, params, deps);
    default: return fail(400, `unknown webhook action: ${String(action)}`);
  }
}

/** The "Run test" button (D2: the subject says Alcance). Same flow as today; the event count comes from SQL. */
async function healthTest(q: Q, params: Row, deps: WebhookDeps) {
  const { webhook_id, check_only, before_count, wait_s } = params as { webhook_id?: string; check_only?: boolean; before_count?: number; wait_s?: number };
  if (!webhook_id) return fail(400, "webhook_id required");
  const waitMs = Math.max(2, Math.min(12, Number(wait_s) || 8)) * 1000;
  const count = async () => Number((await q`select count(*)::int as n from webhook_events where webhook_id = ${webhook_id}`)[0].n);
  let beforeCount = typeof before_count === "number" ? before_count : 0;
  let testMessageId: string | null = null, address: string | null = null;
  if (!check_only) {
    const am = deps.agentmail;
    if (!am?.inbox) return fail(400, "AgentMail key not configured");
    const inbox = await am.inbox("Alcance Health Check");
    address = inbox.email ?? null;
    if (!address) return fail(500, "AgentMail returned an inbox without an email field. Check your AgentMail account setup.");
    beforeCount = await count();
    const r = await am.post(`/inboxes/${inbox.inbox_id}/messages/send`, {
      to: [address], subject: HEALTH_CHECK_SUBJECT,
      text: "This is an automated test from your Alcance dashboard. If you see event counters tick on the Webhooks page, your integration is wired correctly.",
      html: "<p>This is an automated test from your Alcance dashboard.</p><p>If you see event counters tick on the Webhooks page, your integration is wired correctly.</p>",
    });
    if (!r.ok) return fail(500, `Test send failed (${r.status}): ${r.text.slice(0, 200)}`);
    testMessageId = r.message_id ?? null;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const deadline = Date.now() + waitMs;
  let newEvents = 0;
  for (let i = 0; i < 8 && Date.now() < deadline; i++) {
    await sleep(1500);
    newEvents = Math.max(0, (await count()) - beforeCount);
    if (newEvents > 0) break;
  }
  return {
    ok: newEvents > 0, waiting: newEvents === 0, before_count: beforeCount, test_message_id: testMessageId, test_address: address, new_events: newEvents,
    hint: newEvents > 0
      ? `Received ${newEvents} webhook event(s) — your integration is live.`
      : "No events yet. Events can take up to a minute to arrive. If none come: (a) the webhook URL is pasted into AgentMail → Webhooks, (b) every event type is ticked (use Fix webhook events), (c) your AgentMail key has webhook permissions, (d) the webhook's signing secret is saved in Alcance.",
  };
}

// ── Receive ──────────────────────────────────────────────────────────────

type Carrier = { message_id?: string; thread_id?: string; inbox_id?: string; type?: string; sub_type?: string; reason?: string };
type AgentMailEvent = { event_type?: string; event_id?: string; send?: Carrier; delivery?: Carrier; bounce?: Carrier; complaint?: Carrier; rejection?: Carrier; message?: InboundMessage };
const OUTBOUND: Record<string, string> = { "message.sent": "sent", "message.delivered": "delivered", "message.bounced": "bounced", "message.complained": "complained", "message.rejected": "failed" };
const RANK: Record<string, number> = { drafted: 0, sent: 1, delivered: 2, clicked: 3, replied: 4 };
const advances = (current: string, next: string) => ["bounced", "complained", "failed"].includes(next) || (RANK[next] ?? 0) >= (RANK[current] ?? 0);

/** Applies one outbound AgentMail event (F47). Returns how it matched, for the stored event. */
async function applyOutbound(q: Q, ev: AgentMailEvent, type: string): Promise<string> {
  const c = [ev.send, ev.delivery, ev.bounce, ev.complaint, ev.rejection].find((x) => x?.message_id || x?.thread_id) ?? {};
  if (!c.message_id && !c.thread_id) return "no ids";
  let [email] = c.message_id ? await q`select * from emails where agentmail_message_id = ${c.message_id} limit 1` : [];
  let how = "message id";
  if (!email && c.thread_id) {
    const cands = await q`select * from emails where agentmail_thread_id = ${c.thread_id} and agentmail_message_id is null limit 2`;
    if (cands.length !== 1) return cands.length ? "no match (thread fallback ambiguous)" : "no match";
    email = cands[0];
    how = "thread fallback";
  }
  if (!email) return "no match";
  const next = OUTBOUND[type];
  if (!advances(String(email.status), next)) return `${how}; out of order, ignored`;
  // sent_at is never changed here: only a real send sets it (send.ts), so the day count counts real sends.
  const inbox = how === "message id" && c.inbox_id ? c.inbox_id : null;
  const reason = next === "failed" ? `AgentMail rejected the message${c.reason || c.type ? `: ${[c.type, c.sub_type, c.reason].filter(Boolean).join(" / ")}` : ""}`.slice(0, 500) : null;
  await q`update emails set status = ${next},
                            delivered_at = case when ${next} = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
                            bounced_at = case when ${next} = 'bounced' then coalesce(bounced_at, now()) else bounced_at end,
                            error = coalesce(${reason}, error),
                            agentmail_inbox_id = coalesce(${inbox}, agentmail_inbox_id), updated_at = now()
          where id = ${email.id}`;
  if (next === "bounced" || next === "complained") {
    const at = new Date().toISOString();
    const address = String(email.to_key ?? email.to_email ?? "").toLowerCase();
    if (address && next === "bounced") await noteBounce(q, address, at, "bounce event");
    if (address && next === "complained") {
      await q`update leads set do_not_contact = true, status = 'do_not_contact', do_not_contact_at = coalesce(do_not_contact_at, ${at}::timestamptz), do_not_contact_reason = coalesce(do_not_contact_reason, 'spam complaint'),
                               stop_state = 'do_not_contact', stop_reason = 'spam complaint', stopped_at = coalesce(stopped_at, ${at}::timestamptz), updated_at = now()
              where email_key = ${address} or id = ${email.lead_id}`;
    }
    const [s] = await q`select data from outreach_settings where key = 'settings'`;
    const [camp] = await q`select name from campaigns where id = ${email.campaign_id}`;
    await refreshForLeads(q, { leadIds: [email.lead_id as string | undefined], emailKeys: [address] }); // run E: follow_ups current after a bounce or complaint
    await queueFyi(q, (s?.data as Row) ?? {}, { what: next === "bounced" ? "bounced" : "complained", business: String(email.to_name || address || "A lead"), campaignName: String(camp?.name ?? "campaign"), fromAddr: null, inbox: email.agentmail_inbox_id as string, lead_id: (email.lead_id as string) ?? null, campaign_id: (email.campaign_id as string) ?? null, email_id: String(email.id) });
  }
  return how;
}

export type ReceiveRequest = { webhookId: string; headers: Record<string, unknown>; rawBody: string; host?: string };
export type ReceiveResult = { statusCode: number; body: Row };

/** The SQL path of webhook-receive.ts: one transaction for the event and everything it changes, then the outbox is drained. */
export async function receive(run: Runner, req: ReceiveRequest, deps: WebhookDeps): Promise<ReceiveResult> {
  const webhookId = String(req.webhookId ?? "").trim();
  if (!webhookId) return { statusCode: 400, body: { ok: false, error: "Missing webhook id" } };
  const out = await run(async (q): Promise<ReceiveResult> => {
    const [hook] = await q`select * from webhooks where id = ${webhookId} for update`;
    if (!hook) return { statusCode: 404, body: { ok: false, error: "Webhook not found" } };
    const data = (hook.data as Row | null) ?? {};
    const secret = typeof data.signing_secret === "string" ? data.signing_secret : null;
    const isAgentMail = hook.service === "agentmail";
    let signed = false;
    if (isAgentMail || secret) {
      const v = verifySignature(secret, req.headers, req.rawBody);
      if (!v.ok) {
        await q`update webhooks set data = data || jsonb_build_object('refused_count', coalesce((data->>'refused_count')::int, 0) + 1, 'last_refused_at', now(), 'last_refused_reason', ${v.reason}::text) where id = ${webhookId}`;
        return { statusCode: 401, body: { ok: false, error: `Refused: ${v.reason}` } };
      }
      signed = true;
    }
    let body: unknown = null;
    try { body = req.rawBody ? JSON.parse(req.rawBody) : null; } catch { body = req.rawBody; }
    const ev = (typeof body === "object" && body !== null ? body : {}) as AgentMailEvent;
    const type = String(ev.event_type ?? "");
    const id = deps.newId();
    const receivedAt = new Date().toISOString();
    let match: string | null = null;
    // Only a signed AgentMail event changes outreach data; anything else is logged, as on the Webhooks page today.
    if (signed && (isAgentMail || type.startsWith("message."))) {
      try {
        match = await (q as Tx).savepoint(async (sp) => {
          if (OUTBOUND[type]) return applyOutbound(sp as unknown as Q, ev, type);
          if (isInboundEvent(type) && ev.message) {
            const r = await ingest(sp as unknown as Q, { eventType: type, message: ev.message, alert: true, source: "webhook", baseUrl: req.host ? `https://${req.host}` : deps.baseUrl }, deps);
            return r.duplicate ? "duplicate reply" : r.stored ? "reply stored" : "not stored";
          }
          return "not an email event";
        });
      } catch (e) {
        console.error("[webhook-receive sql] AgentMail processor error:", e);
        match = `error: ${String((e as Error)?.message ?? e).slice(0, 200)}`; // the raw event is still kept, as today
      }
    } else if (type.startsWith("message.")) match = "not applied: unsigned event on a generic webhook";
    await q`insert into webhook_events (id, blob_key, webhook_id, headers, body, received_at, data)
            values (${id}, ${`${webhookId}/${receivedAt}-${id}`}, ${webhookId}, ${q.json(req.headers as never)}, ${q.json(body as never)}, ${receivedAt}::timestamptz, ${q.json({ signed, match } as never)})`;
    await q`delete from webhook_events where webhook_id = ${webhookId} and received_at < now() - interval '30 days'`;
    await q`update webhooks set event_count = coalesce(event_count, 0) + 1 where id = ${webhookId}`;
    await q`insert into activity (id, agent_id, category, summary, details, created_at, data)
            values (${deps.newId()}, null, 'system', ${`Webhook "${hook.name}" received an event`}, ${q.json({ event_id: id, service: hook.service ?? "generic" } as never)}, ${receivedAt}::timestamptz, '{}')`;
    return { statusCode: 200, body: { ok: true, event_id: id } };
  });
  if (out.statusCode === 200 && deps.agentmail) {
    try { await drain(run, { agentmail: deps.agentmail as AlertPost }); } catch (e) { console.warn("[webhook-receive sql] outbox drain failed (rows stay unsent):", (e as Error)?.message ?? e); }
  }
  return out;
}
export type { AgentMailApi };
