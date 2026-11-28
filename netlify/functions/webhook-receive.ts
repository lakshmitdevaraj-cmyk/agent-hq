import type { Handler } from "@netlify/functions";
import { connectLambda } from "@netlify/blobs";
import { nanoid } from "nanoid";
import { store, readJson, writeJson, listJson } from "./lib/blobs";
import { isInboundEvent } from "./lib/replies";
import { ingestInboundReply, findOutreachEmailByAgentMailIds } from "./lib/inbound";
import { noteBounced } from "./lib/contacts";

const WEBHOOKS = "agent-hq-webhooks";
const WEBHOOK_EVENTS = "agent-hq-webhook-events";
const ACTIVITY = "agent-hq-activity";
const OUTREACH_EMAILS = "agent-hq-outreach-emails";

type WebhookRecord = {
  name: string;
  event_count: number;
  service?: string; // "agentmail" triggers the specialised processor below
};

// Each message.* event nests the message-identification object under a
// different top-level key — message.sent → send, message.delivered →
// delivery, message.bounced → bounce, message.complained → complaint,
// message.rejected → rejection, message.received → message.
// We probe all of them so the handler doesn't silently drop events when
// AgentMail introduces a new shape or we guess wrong.
type AgentMailIdCarrier = {
  message_id?: string;
  thread_id?: string;
  inbox_id?: string;
  recipients?: string[];
  timestamp?: string;
};

type AgentMailEvent = {
  type?: string;
  event_type?: string;
  event_id?: string;
  send?: AgentMailIdCarrier;
  delivery?: AgentMailIdCarrier;
  bounce?: AgentMailIdCarrier & { type?: string; sub_type?: string };
  complaint?: AgentMailIdCarrier;
  rejection?: AgentMailIdCarrier;
  message?: {
    message_id?: string;
    thread_id?: string;
    inbox_id?: string;
    subject?: string;
    from?: string;
    to?: string[];
    text?: string;
    extracted_text?: string;
    preview?: string;
    html?: string;
    timestamp?: string;
  };
  thread?: { thread_id?: string };
};

function extractIds(event: AgentMailEvent): { messageId?: string; threadId?: string } {
  const carriers = [event.send, event.delivery, event.bounce, event.complaint, event.rejection];
  for (const c of carriers) {
    if (c?.message_id || c?.thread_id) {
      return { messageId: c.message_id, threadId: c.thread_id };
    }
  }
  return {};
}

// Status rank controls forward-only progression so out-of-order webhooks
// (e.g. delivered arriving before sent finishes writing) don't regress a
// replied email back to sent. Negative terminal states (bounced/complained/
// failed) always win regardless of prior state.
function statusRank(s: string | undefined): number {
  return (
    ({
      drafted: 0,
      sent: 1,
      delivered: 2,
      clicked: 3,
      replied: 4,
    } as Record<string, number>)[s ?? ""] ?? 0
  );
}

function shouldAdvanceStatus(current: string | undefined, next: string): boolean {
  if (["bounced", "complained", "failed"].includes(next)) return true;
  return statusRank(next) >= statusRank(current);
}

/**
 * AgentMail event handler. Updates per-email status + per-campaign counters
 * and — for inbound replies — stores the full reply content so the /inbox
 * page can render it. Keep this resilient to unknown event_types: if we
 * don't recognise the event, we still log it to the generic audit trail.
 */
async function processAgentMailEvent(event: AgentMailEvent, baseUrl = ""): Promise<void> {
  const eventType = event.event_type ?? "";
  const message = event.message;

  // Outbound send-lifecycle events — each one nests identifiers under a
  // different key (send/delivery/bounce/complaint/rejection). We probe
  // all carriers rather than assuming one shape.
  const OUTBOUND = ["message.sent", "message.delivered", "message.bounced", "message.complained", "message.rejected"];
  if (OUTBOUND.includes(eventType)) {
    const { messageId, threadId } = extractIds(event);
    if (!messageId && !threadId) return;
    const match = await findOutreachEmailByAgentMailIds(messageId, threadId);
    if (!match) return;
    const newStatus =
      eventType === "message.delivered" ? "delivered" :
      eventType === "message.bounced" ? "bounced" :
      eventType === "message.complained" ? "complained" :
      eventType === "message.rejected" ? "failed" :
      "sent";
    const currentStatus = match.record.status as string | undefined;
    if (!shouldAdvanceStatus(currentStatus, newStatus)) return; // ignore out-of-order events

    // Re-read right before writing so only the status fields change (never write a stale record back).
    const latestEmail = (await readJson<Record<string, unknown>>(store(OUTREACH_EMAILS), match.storeKey)) ?? match.record;
    const updatedEmail = {
      ...latestEmail,
      status: newStatus,
      [`${newStatus}_at`]: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await writeJson(store(OUTREACH_EMAILS), match.storeKey, updatedEmail);

    // A bounce, complaint or rejection means this address must never be emailed again (any campaign).
    if (newStatus === "bounced" || newStatus === "complained" || newStatus === "failed") {
      try { await noteBounced(match.record.to_email as string | undefined); } catch { /* best effort */ }
    }

    // Campaign counters and status are derived from the emails when campaigns are listed.
    // Bumping a counter here meant rewriting the whole campaign record, which overwrote
    // newer changes made by sends and drafting jobs.
    return;
  }

  // Inbound reply: message.received and every message.received.* variant (spam, blocked, unauthenticated, ...).
  // AgentMail files mail from domains without DKIM/SPF/DMARC under .unauthenticated: those are usually real people.
  if (isInboundEvent(eventType) && message) {
    const res = await ingestInboundReply({ eventType, message, baseUrl, alert: true, source: "webhook" });
    if (res.duplicate) console.log(`[webhook-receive] duplicate ${eventType} ignored`);
    else if (res.reply) console.log(`[webhook-receive] stored ${eventType} reply ${res.reply.id} flag=${res.reply.flag ?? "none"} test=${res.reply.is_test}`);
  }
}

export const handler: Handler = async (event) => {
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
  if (process.env.DATA_BACKEND === "sql") return sqlReceive(event); // P2 chunk 7: the SQL path (R4 signature, F47), below
  const webhookId = (event.path.split("/").pop() ?? "").trim();
  if (!webhookId) return { statusCode: 400, body: "Missing webhook id" };

  const s = store(WEBHOOKS);
  const existing = await readJson<WebhookRecord>(s, webhookId);
  if (!existing) return { statusCode: 404, body: "Webhook not found" };

  let body: unknown = null;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    body = event.body;
  }

  const id = nanoid(12);
  const received_at = new Date().toISOString();
  await writeJson(store(WEBHOOK_EVENTS), `${webhookId}/${received_at}-${id}`, {
    id,
    webhook_id: webhookId,
    headers: event.headers,
    body,
    received_at,
  });

  await writeJson(s, webhookId, {
    ...existing,
    event_count: (existing.event_count ?? 0) + 1,
  });

  // Specialised processor for AgentMail-tagged webhooks. We still log the
  // raw event above (for the generic Webhooks page audit trail) — this
  // just adds the outreach-domain side effects on top.
  try {
    const tagged = existing.service === "agentmail";
    const looksLikeAgentMail = typeof body === "object" && body !== null && (body as AgentMailEvent).event_type?.startsWith("message.");
    if (tagged || looksLikeAgentMail) {
      await processAgentMailEvent(body as AgentMailEvent, event.headers?.host ? `https://${event.headers.host}` : "");
    }
  } catch (err) {
    console.error("[webhook-receive] AgentMail processor error:", err);
    // Fall through — we still 200'd the raw event capture above.
  }

  const activityId = nanoid(12);
  await writeJson(store(ACTIVITY), `${received_at}-${activityId}`, {
    id: activityId,
    agent_id: null,
    category: "system",
    summary: `Webhook "${existing.name}" received an event`,
    details: { event_id: id, service: existing.service ?? "generic" },
    created_at: received_at,
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, event_id: id }),
  };
};

// Small helper — compiled out at runtime, kept here to prove intent.
export const __listJson = listJson;

// P2 chunk 7: the receive path on Postgres (only when DATA_BACKEND=sql): lib/sql/webhooks.ts checks the AgentMail signature
// on the exact raw body, stores and applies the event in one transaction, then sends the alerts it queued (outbox).
// The AgentMail key (for the alerts) is still read from the service-config store until chunk 9 moves the keys.
async function sqlReceive(event: Parameters<Handler>[0]) {
  const [{ withTx }, webhooks, { OWN_ADDRESSES }] = await Promise.all([import("./lib/db/client.ts"), import("./lib/sql/webhooks.ts"), import("./lib/replies.ts")]);
  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  const key = (await readJson<{ key?: string }>(store("agent-hq-service-config"), "agentmail"))?.key ?? null;
  const agentmail = key ? {
    post: async (path: string, body: Record<string, unknown>) => {
      const r = await fetch(`https://api.agentmail.to/v0${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      return r.ok ? { ok: true as const } : { ok: false as const, status: r.status, text: await r.text() };
    },
  } : null;
  const r = await webhooks.receive((fn) => withTx(fn), { webhookId: (event.path.split("/").pop() ?? "").trim(), headers: (event.headers ?? {}) as Record<string, unknown>, rawBody, host: event.headers?.host },
    { newId: () => nanoid(12), ownAddresses: [...OWN_ADDRESSES], agentmail, baseUrl: event.headers?.host ? `https://${event.headers.host}` : "" });
  return { statusCode: r.statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.body) };
}
