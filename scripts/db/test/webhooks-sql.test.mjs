// Chunk 7 on Neon dev, every transaction rolled back: the webhook receive path (lib/sql/webhooks.ts) and the webhook actions.
// R4 (AgentMail signs the Svix way: svix-id, svix-timestamp, svix-signature "v1,<base64 HMAC-SHA256>"; a bad, missing or
// old signature is refused and nothing is stored; raw events kept 30 days), V8 (webhook status), F47 (match by message id,
// thread id only when it is unambiguous, a webhook never changes sent_at, the day count counts real sends, the inbox used is
// stored), F7/F8 (bounce, complaint; a rejection is a failed send, never a bounce), F1 (read straight back).
// All data is made up. AgentMail is a stub; a real fetch is refused for the whole file.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

const HOOK = "w7-hook";
const GENERIC = "w7-generic";
const CID = "w7-camp";
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
let n, wh, send;
let realFetch;

before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  wh = await import("../../../netlify/functions/lib/sql/webhooks.ts");
  send = await import("../../../netlify/functions/lib/sql/send.ts");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

// ── helpers ──────────────────────────────────────────────────────────────
/** Signs like Svix (written here on its own, not taken from webhooks.ts). */
function sign(body, { secret = SECRET, id = `msg_${randomBytes(6).toString("hex")}`, ts = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}`, "content-type": "application/json" };
}
let idn = 0;
const deps = (o = {}) => ({ newId: () => `w7-id-${++idn}`, ownAddresses: ["me@madeup-own.test"], agentmail: null, baseUrl: "https://madeup-app.test", ...o });
const run = (tx) => (fn) => fn(tx);
const receive = (tx, webhookId, body, headers, d = deps()) => wh.receive(run(tx), { webhookId, headers, rawBody: body }, d);

async function seed(tx, { secret = SECRET } = {}) {
  await tx`insert into webhooks (id, blob_key, name, service, event_count, created_at, data)
           values (${HOOK}, ${HOOK}, 'Made-up AgentMail hook', 'agentmail', 0, now(), ${tx.json(secret ? { description: "", signing_secret: secret } : { description: "" })}),
                  (${GENERIC}, ${GENERIC}, 'Made-up generic hook', null, 0, now(), ${tx.json({ description: "" })})`;
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign w7', 'plumber', 'Katy, TX', 'US', 'America/Chicago', true, now(), now(), ${tx.json({})})`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", daily_send_limit: 30, reply_alert_email: "alerts@madeup-own.test", sending_inbox_id: "inbox-send@madeup-agentmail.test" })})
           on conflict (key) do update set data = excluded.data`;
  await tx`insert into leads (id, campaign_id, blob_key, name, email, email_key, category, created_at, data) values
           ('w7-lead', ${CID}, ${`${CID}/w7-lead`}, 'Made-up Plumbing W7', 'owner@madeup-w7.test', 'owner@madeup-w7.test', 'Plumber', now(), ${tx.json({})})`;
  // A four-step lead: email 1 sent 18 Nov, email 2 sent 25 Nov in the same thread (the F47 case, made up).
  await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, to_name, subject, body_text, step, sequence_total, framework, status,
                               agentmail_message_id, agentmail_thread_id, agentmail_inbox_id, sent_at, delivered_at, created_at, updated_at, data) values
    ('w7-e1', ${`${CID}/w7-e1`}, ${CID}, 'w7-lead', 'owner@madeup-w7.test', 'owner@madeup-w7.test', 'Made-up Plumbing W7', 'plumbing', 'Hello', 1, 4, 'four-step', 'delivered',
     'am-msg-1', 'am-thread-1', 'inbox-send@madeup-agentmail.test', '2026-11-18T15:00:00Z', '2026-11-18T15:00:05Z', now(), now(), ${tx.json({})}),
    ('w7-e2', ${`${CID}/w7-e2`}, ${CID}, 'w7-lead', 'owner@madeup-w7.test', 'owner@madeup-w7.test', 'Made-up Plumbing W7', 'Re: plumbing', 'Following up', 2, 4, 'four-step', 'sent',
     'am-msg-2', 'am-thread-1', 'inbox-campaign@madeup-agentmail.test', '2026-11-25T15:00:00Z', null, now(), now(), ${tx.json({})})`;
}
const ev = (type, carrier, o = {}) => JSON.stringify({ event_type: type, event_id: `evt-${++idn}`, [carrier]: { message_id: o.message_id, thread_id: o.thread_id, inbox_id: o.inbox_id, timestamp: "2026-11-25T15:00:07Z" }, ...(o.extra ?? {}) });
const email = async (tx, id) => (await tx`select status, sent_at, delivered_at, bounced_at, error, agentmail_inbox_id from emails where id = ${id}`)[0];
const eventCount = async (tx, id) => Number((await tx`select count(*)::int as n from webhook_events where webhook_id = ${id}`)[0].n);

// ── R4: the signature ────────────────────────────────────────────────────
describe("R4: AgentMail signature", () => {
  test("verifySignature: good accepted; wrong secret, changed body, old timestamp, no headers, garbage refused", () => {
    const body = ev("message.delivered", "delivery", { message_id: "x" });
    const now = Math.floor(Date.now() / 1000);
    assert.equal(wh.verifySignature(SECRET, sign(body), body, now).ok, true);
    const multi = sign(body);
    multi["svix-signature"] = `v1,AAAA ${multi["svix-signature"]}`; // rotated secrets: any listed signature may match
    assert.equal(wh.verifySignature(SECRET, multi, body, now).ok, true);
    const bad = [
      ["wrong secret", sign(body, { secret: `whsec_${randomBytes(24).toString("base64")}` }), body],
      ["changed body", sign(body), body.replace("delivered", "bounced")],
      ["old timestamp", sign(body, { ts: now - 6 * 60 }), body],
      ["future timestamp", sign(body, { ts: now + 6 * 60 }), body],
      ["no headers", {}, body],
      ["garbage signature", { ...sign(body), "svix-signature": "v1,not-base64!!" }, body],
    ];
    for (const [why, h, b] of bad) assert.equal(wh.verifySignature(SECRET, h, b, now).ok, false, why);
    assert.equal(wh.verifySignature("", sign(body), body, now).ok, false, "no secret saved");
  });

  test("an unsigned or wrongly signed event to the AgentMail hook is refused: 401, nothing stored, no email changed, the refusal counted (V8)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const body = ev("message.bounced", "bounce", { message_id: "am-msg-1" });
      for (const headers of [{}, sign(body, { secret: `whsec_${randomBytes(24).toString("base64")}` }), sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 })]) {
        const r = await receive(tx, HOOK, body, headers);
        assert.equal(r.statusCode, 401);
      }
      assert.equal(await eventCount(tx, HOOK), 0, "nothing stored");
      assert.equal((await email(tx, "w7-e1")).status, "delivered", "the bounce was not applied");
      const [h] = await tx`select event_count, data from webhooks where id = ${HOOK}`;
      assert.equal(h.event_count, 0);
      assert.equal(h.data.refused_count, 3);
      assert.ok(h.data.last_refused_at);
    });
  });

  test("an AgentMail hook with no secret saved refuses every event (fail closed)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx, { secret: null });
      const body = ev("message.delivered", "delivery", { message_id: "am-msg-2" });
      const r = await receive(tx, HOOK, body, sign(body));
      assert.equal(r.statusCode, 401);
      assert.match(JSON.stringify(r.body), /secret/i);
      assert.equal(await eventCount(tx, HOOK), 0);
    });
  });

  test("a signed event is stored and applied; count, History entry and status read straight back (F1)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const body = ev("message.delivered", "delivery", { message_id: "am-msg-2", thread_id: "am-thread-1" });
      const r = await receive(tx, HOOK, body, sign(body));
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.ok, true);
      assert.equal(await eventCount(tx, HOOK), 1);
      assert.equal((await email(tx, "w7-e2")).status, "delivered");
      const [h] = await tx`select event_count from webhooks where id = ${HOOK}`;
      assert.equal(h.event_count, 1);
      const [a] = await tx`select summary, category, details from activity where details->>'event_id' = ${r.body.event_id}`;
      assert.equal(a.category, "system");
      assert.equal(a.summary, 'Webhook "Made-up AgentMail hook" received an event');
      const list = await wh.runWebhookAction(tx, "webhook.list", {}, deps());
      const mine = list.find((w) => w.id === HOOK);
      assert.equal(mine.event_count, 1);
      assert.equal(mine.status.signed, true);
      assert.ok(mine.status.last_event_at);
      assert.equal(JSON.stringify(list).includes(SECRET), false, "the secret is never returned");
      assert.equal("signing_secret" in mine, false);
    });
  });

  test("a generic hook with no secret logs the raw event as today, but an AgentMail-looking body on it is not applied", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const body = ev("message.bounced", "bounce", { message_id: "am-msg-1" });
      const r = await receive(tx, GENERIC, body, {});
      assert.equal(r.statusCode, 200);
      assert.equal(await eventCount(tx, GENERIC), 1);
      assert.equal((await email(tx, "w7-e1")).status, "delivered", "a forged bounce changes nothing");
      assert.equal((await receive(tx, "w7-missing", body, {})).statusCode, 404);
    });
  });

  test("raw events older than 30 days are deleted on the next receive; newer ones stay", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      await tx`insert into webhook_events (id, webhook_id, headers, body, received_at, data) values
               ('w7-old', ${HOOK}, '{}', '{}', now() - interval '31 days', '{}'), ('w7-new', ${HOOK}, '{}', '{}', now() - interval '29 days', '{}'),
               ('w7-other', ${GENERIC}, '{}', '{}', now() - interval '31 days', '{}')`;
      const body = ev("message.sent", "send", { message_id: "am-msg-unknown" });
      assert.equal((await receive(tx, HOOK, body, sign(body))).statusCode, 200);
      const ids = (await tx`select id from webhook_events where webhook_id = ${HOOK} order by id`).map((x) => x.id);
      assert.ok(!ids.includes("w7-old"));
      assert.ok(ids.includes("w7-new"));
      assert.equal(ids.length, 2);
    });
  });
});

// ── F47: matching and bookkeeping ────────────────────────────────────────
describe("F47: webhook events match the right email", () => {
  test("email 2's delivered event leaves email 1 untouched; sent_at never changes; the day count counts real sends; the inbox used is stored", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const before1 = await email(tx, "w7-e1");
      const today0 = await tx`select send_today(${["me@madeup-own.test"]}::text[]) as t`;
      for (const [type, carrier] of [["message.sent", "send"], ["message.delivered", "delivery"]]) {
        const body = ev(type, carrier, { message_id: "am-msg-2", thread_id: "am-thread-1", inbox_id: "inbox-send@madeup-agentmail.test" });
        assert.equal((await receive(tx, HOOK, body, sign(body))).statusCode, 200);
      }
      const e1 = await email(tx, "w7-e1"), e2 = await email(tx, "w7-e2");
      assert.deepEqual(e1, before1, "email 1 untouched");
      assert.equal(e2.sent_at.toISOString(), "2026-11-25T15:00:00.000Z", "a webhook never changes sent_at");
      assert.equal(e2.status, "delivered");
      assert.ok(e2.delivered_at);
      assert.equal(e2.agentmail_inbox_id, "inbox-send@madeup-agentmail.test", "the inbox actually used");
      const today1 = await tx`select send_today(${["me@madeup-own.test"]}::text[]) as t`;
      assert.equal(today1[0].t.sent_today, today0[0].t.sent_today, "the day count is unchanged by notices");
    });
  });

  test("thread id is only a fallback when one email of the thread has no message id; two candidates: no match", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      // A thread-only event for thread 1: both emails there have message ids, so it is ambiguous and nothing changes.
      let body = ev("message.delivered", "delivery", { thread_id: "am-thread-1" });
      assert.equal((await receive(tx, HOOK, body, sign(body))).statusCode, 200);
      assert.equal((await email(tx, "w7-e2")).status, "sent");
      const [stored] = await tx`select data from webhook_events where webhook_id = ${HOOK} order by received_at desc limit 1`;
      assert.match(String(stored.data.match ?? ""), /no match|ambiguous/);
      // One email in thread 2 with no message id saved: the fallback applies.
      await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, subject, body_text, step, status, agentmail_thread_id, sent_at, created_at, updated_at, data)
               values ('w7-e3', 'x', ${CID}, 'w7-lead', 'owner@madeup-w7.test', 'owner@madeup-w7.test', 's', 'b', 3, 'sent', 'am-thread-2', '2026-11-20T10:00:00Z', now(), now(), '{}')`;
      body = ev("message.delivered", "delivery", { thread_id: "am-thread-2" });
      await receive(tx, HOOK, body, sign(body));
      assert.equal((await email(tx, "w7-e3")).status, "delivered");
    });
  });

  test("status only moves forward: a late 'sent' after 'delivered' changes nothing", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const body = ev("message.sent", "send", { message_id: "am-msg-1" });
      await receive(tx, HOOK, body, sign(body));
      assert.equal((await email(tx, "w7-e1")).status, "delivered");
    });
  });

  test("bounce: email bounced, a bounced contact entry, the lead's stop state bounced; FYI alert queued (F31)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const body = ev("message.bounced", "bounce", { message_id: "am-msg-2" });
      await receive(tx, HOOK, body, sign(body));
      const e2 = await email(tx, "w7-e2");
      assert.equal(e2.status, "bounced");
      assert.ok(e2.bounced_at);
      const [l] = await tx`select stop_state from leads where id = 'w7-lead'`;
      assert.equal(l.stop_state, "bounced");
      assert.equal((await tx`select count(*)::int as n from contacts where kind = 'bounced' and email = 'owner@madeup-w7.test'`)[0].n, 1);
      const [o] = await tx`select kind, payload from outbox where payload->>'lead_id' = 'w7-lead' and kind = 'alert.fyi'`;
      assert.ok(o, "an FYI alert row");
      assert.match(o.payload.subject, /^\[Alcance\] FYI/);
      assert.match(o.payload.text, /no action needed/i);
    });
  });

  test("complaint: do-not-contact; rejection: failed with its reason, never a bounce (26 Nov rule)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      let body = ev("message.rejected", "rejection", { message_id: "am-msg-2" }, {});
      await receive(tx, HOOK, body, sign(body));
      const e2 = await email(tx, "w7-e2");
      assert.equal(e2.status, "failed");
      assert.match(String(e2.error), /rejected/i);
      assert.equal(e2.bounced_at, null);
      assert.equal((await tx`select stop_state from leads where id = 'w7-lead'`)[0].stop_state, "none");
      assert.equal((await tx`select count(*)::int as n from contacts where kind = 'bounced' and email = 'owner@madeup-w7.test'`)[0].n, 0);
      body = ev("message.complained", "complaint", { message_id: "am-msg-1" });
      await receive(tx, HOOK, body, sign(body));
      const [l] = await tx`select stop_state, do_not_contact from leads where id = 'w7-lead'`;
      assert.equal(l.stop_state, "do_not_contact");
      assert.equal(l.do_not_contact, true);
    });
  });
});

// ── Actions ──────────────────────────────────────────────────────────────
describe("webhook actions", () => {
  test("create, create_typed, set_secret, events, delete; each read straight back (F1)", async () => {
    await n.callWrite(async (tx) => {
      const a = await wh.runWebhookAction(tx, "webhook.create", { name: "Made-up A" }, deps());
      const b = await wh.runWebhookAction(tx, "webhook.create_typed", { name: "Made-up B", service: "agentmail" }, deps());
      assert.equal(a.event_count, 0);
      assert.equal(b.service, "agentmail");
      await assert.rejects(() => wh.runWebhookAction(tx, "webhook.create", {}, deps()), (e) => e.status === 400);
      const set = await wh.runWebhookAction(tx, "webhook.set_secret", { id: b.id, secret: SECRET }, deps());
      assert.deepEqual(set, { id: b.id, signed: true });
      await assert.rejects(() => wh.runWebhookAction(tx, "webhook.set_secret", { id: b.id, secret: "plain" }, deps()), (e) => e.status === 400);
      const body = ev("message.sent", "send", { message_id: "none" });
      assert.equal((await wh.receive(run(tx), { webhookId: b.id, headers: sign(body), rawBody: body }, deps())).statusCode, 200);
      const events = await wh.runWebhookAction(tx, "webhook.events", { id: b.id }, deps());
      assert.equal(events.length, 1);
      assert.equal(events[0].webhook_id, b.id);
      assert.equal(events[0].body.event_type, "message.sent");
      assert.deepEqual(await wh.runWebhookAction(tx, "webhook.delete", { id: a.id }, deps()), { id: a.id, deleted: true });
      const ids = (await wh.runWebhookAction(tx, "webhook.list", {}, deps())).map((w) => w.id);
      assert.ok(!ids.includes(a.id) && ids.includes(b.id));
    });
  });

  test("webhook.test (D2): the health check goes out with the Alcance subject through the stub and counts SQL events", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const posts = [];
      const agentmail = { inbox: async () => ({ inbox_id: "inbox-hc", email: "hc@madeup-agentmail.test" }), post: async (path, body) => { posts.push({ path, body }); return { ok: true, message_id: "hc-1" }; }, get: async () => ({ ok: false, status: 404, text: "" }) };
      const r = await wh.runWebhookAction(tx, "outreach.webhook.test", { webhook_id: HOOK, wait_s: 2 }, deps({ agentmail, sleep: async () => {} }));
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.subject, "Alcance webhook health check");
      assert.equal(r.test_message_id, "hc-1");
      assert.equal(r.before_count, 0);
      assert.equal(r.ok, false);
      await assert.rejects(() => wh.runWebhookAction(tx, "outreach.webhook.test", {}, deps({ agentmail })), (e) => e.status === 400);
      await assert.rejects(() => wh.runWebhookAction(tx, "outreach.webhook.test", { webhook_id: HOOK }, deps({ agentmail: null })), (e) => e.status === 400);
    });
  });
});

// ── F47 in send.ts: the inbox actually used ─────────────────────────────
test("send.ts: a follow-up step goes out from email 1's inbox and stores that inbox (F47)", async () => {
  await n.callWrite(async (tx) => {
    await seed(tx);
    await tx`update outreach_settings set data = data || ${tx.json({ postal_address: "1 Made Up Street, Katy, TX 77449" })} where key = 'settings'`;
    const body = "Hello Made-up Plumbing team. I noticed your plumbing crew works around Katy. Would you like me to send a short recording of an assistant answering a call?";
    await tx`update emails set subject = 'plumbing calls', body_text = ${body}, body_html = ${`<p>${body}</p>`}, status = 'drafted', sent_at = null, agentmail_message_id = null, agentmail_inbox_id = null, review_status = 'ready', reviewed_by = 'lakshmi',
                               rules_version = ${(await import("../../../netlify/functions/lib/messagerules.ts")).RULES_VERSION} where id = 'w7-e2'`;
    const posts = [];
    const am = { inbox: async () => ({ inbox_id: "inbox-campaign@madeup-agentmail.test" }), setDisplayName: async () => {}, post: async (path, body) => { posts.push(path); return { ok: true, message_id: "am-msg-2b", thread_id: "am-thread-1" }; } };
    const r = await send.runSendAction(run(tx), "outreach.emails.send", { campaign_id: CID, email_ids: ["w7-e2"] }, { agentmail: am, baseUrl: "", ownAddresses: [], newId: () => `w7-s-${++idn}` });
    assert.equal(r.sent, 1, JSON.stringify(r));
    assert.match(posts[0], /^\/inboxes\/inbox-send%40madeup-agentmail\.test\/messages\/am-msg-1\/reply$/);
    assert.equal((await email(tx, "w7-e2")).agentmail_inbox_id, "inbox-send@madeup-agentmail.test");
  });
});
