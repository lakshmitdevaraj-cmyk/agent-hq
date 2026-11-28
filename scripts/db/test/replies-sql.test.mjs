// Chunk 7 on Neon dev, every transaction rolled back: inbound replies (lib/sql/replies.ts) and the outbox (lib/sql/outbox.ts).
// The SQL twin of lib/inbound.ts ingestInboundReply (one row per AgentMail message id, thread match, own address = test,
// opt-out = do-not-contact across campaigns and drafts removed, email replied), R12 (outbox rows written in the same
// transaction), F31 (short FYI alert for an opt-out), the reply actions (list, get, delete, reply.send, replies.sync, reply.draft 501).
// All data is made up. AgentMail is a stub; a real fetch is refused for the whole file.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const CID = "r7-camp", CID2 = "r7-camp2";
let n, rp, ob, rules;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  rp = await import("../../../netlify/functions/lib/sql/replies.ts");
  ob = await import("../../../netlify/functions/lib/sql/outbox.ts");
  rules = await import("../../../netlify/functions/lib/messagerules.ts");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

let idn = 0;
const OWN = "me@madeup-own.test";
const run = (tx) => (fn) => fn(tx);
function stub() {
  const posts = [], gets = [];
  return {
    posts, gets,
    api: {
      inbox: async () => ({ inbox_id: "inbox-send@madeup-agentmail.test" }),
      post: async (path, body) => { posts.push({ path, body }); return { ok: true, message_id: `out-${posts.length}`, thread_id: "am-thread-1" }; },
      get: async (path) => { gets.push(path); return { ok: false, status: 404, text: "not stubbed" }; },
    },
  };
}
const deps = (o = {}) => ({ newId: () => `r7-id-${++idn}`, ownAddresses: [OWN], agentmail: null, baseUrl: "https://madeup-app.test", ...o });

async function seed(tx) {
  for (const id of [CID, CID2]) await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${id}, ${id}, ${`Made-up Campaign ${id}`}, 'plumber', 'Katy, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), ${tx.json({})})`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", reply_alert_email: "alerts@madeup-own.test", sending_inbox_id: "inbox-send@madeup-agentmail.test", postal_address: "1 Made Up Street, Katy, TX 77449" })})
           on conflict (key) do update set data = excluded.data`;
  await tx`insert into leads (id, campaign_id, blob_key, name, email, email_key, category, created_at, data) values
           ('r7-lead', ${CID}, 'k1', 'Made-up Plumbing R7', 'owner@madeup-r7.test', 'owner@madeup-r7.test', 'Plumber', now(), '{}'),
           ('r7-lead-b', ${CID2}, 'k2', 'Made-up Plumbing R7 (other campaign)', 'owner@madeup-r7.test', 'owner@madeup-r7.test', 'Plumber', now(), '{}')`;
  await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, to_name, subject, body_text, step, sequence_total, framework, status,
                               agentmail_message_id, agentmail_thread_id, agentmail_inbox_id, sent_at, created_at, updated_at, data) values
    ('r7-e1', 'k3', ${CID}, 'r7-lead', 'owner@madeup-r7.test', 'owner@madeup-r7.test', 'Made-up Plumbing R7', 'plumbing', 'Hello', 1, 4, 'four-step', 'delivered', 'am-msg-1', 'am-thread-1', 'inbox-send@madeup-agentmail.test', '2026-11-18T15:00:00Z', now(), now(), '{}'),
    ('r7-e2', 'k4', ${CID}, 'r7-lead', 'owner@madeup-r7.test', 'owner@madeup-r7.test', 'Made-up Plumbing R7', 'Re: plumbing', 'Following up', 2, 4, 'four-step', 'sent', 'am-msg-2', 'am-thread-1', 'inbox-send@madeup-agentmail.test', '2026-11-25T15:00:00Z', now(), now(), '{}'),
    ('r7-d3', 'k5', ${CID}, 'r7-lead', 'owner@madeup-r7.test', 'owner@madeup-r7.test', 'Made-up Plumbing R7', 'Re: plumbing', 'Step 3', 3, 4, 'four-step', 'drafted', null, null, null, null, now(), now(), '{}'),
    ('r7-d4', 'k6', ${CID2}, 'r7-lead-b', 'owner@madeup-r7.test', 'owner@madeup-r7.test', 'Made-up Plumbing R7', 'plumbing', 'Other campaign', 1, 1, 'one-off', 'drafted', null, null, null, null, now(), now(), '{}')`;
}
const msg = (o = {}) => ({ message_id: `am-in-${++idn}`, thread_id: "am-thread-1", inbox_id: "inbox-send@madeup-agentmail.test", from: "Pat Owner <owner@madeup-r7.test>", to: ["inbox-send@madeup-agentmail.test"],
  subject: "Re: plumbing", text: "Sounds interesting, tell me more.", timestamp: "2026-11-26T16:00:00.000Z", ...o });

describe("ingest (the SQL twin of ingestInboundReply)", () => {
  test("a real reply: stored once, matched to the latest sent email of the thread, email replied, lead stop state replied, outbox rows (alert + CRM), History entry; read back (F1)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const m = msg();
      const r = await rp.ingest(tx, { eventType: "message.received", message: m, alert: true, source: "webhook" }, deps());
      assert.equal(r.stored, true);
      assert.equal(r.reply.campaign_id, CID);
      assert.equal(r.reply.lead_id, "r7-lead");
      assert.equal(r.reply.original_email_id, "r7-e2");
      assert.equal(r.reply.is_test, false);
      const again = await rp.ingest(tx, { eventType: "message.received", message: m, alert: true, source: "sync" }, deps());
      assert.deepEqual([again.stored, again.duplicate], [false, true]);
      assert.equal((await tx`select count(*)::int as n from replies where agentmail_message_id = ${m.message_id}`)[0].n, 1);
      assert.equal((await tx`select status from emails where id = 'r7-e2'`)[0].status, "replied");
      assert.equal((await tx`select stop_state from leads where id = 'r7-lead'`)[0].stop_state, "replied");
      const kinds = (await tx`select kind from outbox where payload->>'reply_id' = ${r.reply.id} order by kind`).map((x) => x.kind);
      assert.deepEqual(kinds, ["alert.reply", "crm.reply_received"]);
      const [alert] = await tx`select payload from outbox where kind = 'alert.reply' and payload->>'reply_id' = ${r.reply.id}`;
      assert.equal(alert.payload.subject, "[Alcance] Reply from Made-up Plumbing R7");
      assert.deepEqual(alert.payload.to, ["alerts@madeup-own.test"]);
      assert.equal(alert.payload.inbox_id, "inbox-send@madeup-agentmail.test");
      const [a] = await tx`select summary from activity where details->>'reply_id' = ${r.reply.id}`;
      assert.equal(a.summary, "Reply from Pat Owner <owner@madeup-r7.test>: Re: plumbing");
      const got = await rp.runReplyAction(run(tx), "outreach.replies.get", { id: r.reply.id }, deps());
      assert.equal(got.text, "Sounds interesting, tell me more.");
      assert.equal(got.from, m.from);
    });
  });

  test("own address: a test reply; the email is not replied and no CRM row, but the alert goes (as today, so the alert can be tested)", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = await rp.ingest(tx, { eventType: "message.received", message: msg({ from: `Me <${OWN}>` }), alert: true }, deps());
      assert.equal(r.reply.is_test, true);
      assert.equal((await tx`select status from emails where id = 'r7-e2'`)[0].status, "sent");
      assert.deepEqual((await tx`select kind from outbox where payload->>'reply_id' = ${r.reply.id}`).map((x) => x.kind), ["alert.reply"]);
    });
  });

  test("opt-out: every lead with that address (both campaigns) do-not-contact, their unsent drafts deleted, FYI alert (F31), no reply alert", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = await rp.ingest(tx, { eventType: "message.received", message: msg({ text: "Please remove me from your list." }), alert: true }, deps());
      assert.equal(r.opt_out, true);
      assert.equal(r.dnc_marked, 2);
      const leads = await tx`select id, do_not_contact, stop_state, do_not_contact_reason from leads where id in ('r7-lead', 'r7-lead-b') order by id`;
      for (const l of leads) { assert.equal(l.do_not_contact, true); assert.equal(l.stop_state, "do_not_contact"); assert.equal(l.do_not_contact_reason, "opt-out reply"); }
      assert.equal((await tx`select count(*)::int as n from emails where id in ('r7-d3', 'r7-d4')`)[0].n, 0, "drafts removed");
      assert.equal((await tx`select count(*)::int as n from emails where id in ('r7-e1', 'r7-e2')`)[0].n, 2, "sent emails kept");
      const kinds = (await tx`select kind from outbox where payload->>'reply_id' = ${r.reply.id} order by kind`).map((x) => x.kind);
      assert.deepEqual(kinds, ["alert.fyi"]);
      const [o] = await tx`select payload from outbox where kind = 'alert.fyi' and payload->>'reply_id' = ${r.reply.id}`;
      assert.match(o.payload.subject, /^\[Alcance\] FYI: Made-up Plumbing R7 opted out/);
      assert.match(o.payload.text, /no action needed/i);
    });
  });

  test("a delivery failure report is stored as a bounce report (not a person), no alert; an unknown thread is unassigned", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = await rp.ingest(tx, { eventType: "message.received", message: msg({ from: "Mail Delivery Subsystem <mailer-daemon@madeup-mx.test>", subject: "Undeliverable: plumbing" }), alert: true }, deps());
      assert.equal((await tx`select kind from replies where id = ${r.reply.id}`)[0].kind, "bounce_report");
      assert.equal((await tx`select count(*)::int as n from outbox where kind = 'alert.reply' and payload->>'reply_id' = ${r.reply.id}`)[0].n, 0);
      const u = await rp.ingest(tx, { eventType: "message.received.unauthenticated", message: msg({ thread_id: "am-thread-none" }), alert: true }, deps());
      assert.equal(u.reply.campaign_id, null);
      assert.equal(u.reply.flag, "unauthenticated");
    });
  });
});

describe("outbox drain (R12)", () => {
  test("sends unsent alert rows once through the stub; a failure keeps last_error; at most 3 tries; CRM rows are left for P6", async () => {
    await n.callWrite(async (tx) => {
      await ob.enqueue(tx, "alert.reply", { to: ["alerts@madeup-own.test"], inbox_id: "inbox-a", subject: "[Alcance] Reply from A", text: "A replied." });
      await ob.enqueue(tx, "alert.fyi", { to: ["alerts@madeup-own.test"], inbox_id: "inbox-a", subject: "[Alcance] FYI: B opted out", text: "FYI, no action needed." });
      await ob.enqueue(tx, "crm.reply_received", { reply_id: "x" });
      const s = stub();
      const r1 = await ob.drain(run(tx), { agentmail: s.api }, { onlyNewerThan: "1 minute" });
      assert.deepEqual(r1, { sent: 2, failed: 0 });
      assert.deepEqual(s.posts.map((p) => p.path), ["/inboxes/inbox-a/messages/send", "/inboxes/inbox-a/messages/send"]);
      assert.deepEqual(s.posts[0].body, { to: ["alerts@madeup-own.test"], subject: "[Alcance] Reply from A", text: "A replied." });
      const r2 = await ob.drain(run(tx), { agentmail: s.api }, { onlyNewerThan: "1 minute" });
      assert.deepEqual(r2, { sent: 0, failed: 0 }, "never sent twice");
      assert.equal((await tx`select count(*)::int as n from outbox where kind = 'crm.reply_received' and sent_at is null and created_at > now() - interval '1 minute'`)[0].n, 1);
      await ob.enqueue(tx, "alert.reply", { to: ["alerts@madeup-own.test"], inbox_id: "inbox-b", subject: "s", text: "t" });
      const failing = { post: async () => ({ ok: false, status: 500, text: "made-up error" }) };
      for (let i = 0; i < 4; i++) await ob.drain(run(tx), { agentmail: failing }, { onlyNewerThan: "1 minute" });
      const [row] = await tx`select attempts, last_error, sent_at from outbox where payload->>'inbox_id' = 'inbox-b' and created_at > now() - interval '1 minute'`;
      assert.equal(row.attempts, 3);
      assert.match(row.last_error, /500/);
      assert.equal(row.sent_at, null);
      assert.deepEqual(await ob.drain(run(tx), { agentmail: null }, {}), { sent: 0, failed: 0 }, "no AgentMail key: nothing tried");
    });
  });
});

describe("reply actions", () => {
  test("list (newest first, limit, campaign, broken rows left out, text from HTML), get, delete (404s); the lead's do-not-contact stays", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = (await rp.ingest(tx, { eventType: "message.received", message: msg({ timestamp: "2026-11-26T10:00:00.000Z" }), alert: false }, deps())).reply;
      const b = (await rp.ingest(tx, { eventType: "message.received", message: msg({ timestamp: "2026-11-27T10:00:00.000Z", text: "", html: "<p>From the <b>HTML</b></p>" }), alert: false }, deps())).reply;
      await tx`insert into replies (id, campaign_id, received_at, data) values ('r7-broken', ${CID}, null, '{}')`;
      const list = await rp.runReplyAction(run(tx), "outreach.replies.list", { campaign_id: CID }, deps());
      assert.deepEqual(list.map((r) => r.id), [b.id, a.id]);
      assert.equal(list[0].text, "From the HTML");
      assert.equal(list[0].system, false);
      assert.equal((await rp.runReplyAction(run(tx), "outreach.replies.list", { campaign_id: CID, limit: 1 }, deps())).length, 1);
      await assert.rejects(() => rp.runReplyAction(run(tx), "outreach.replies.get", { id: "nope" }, deps()), (e) => e.status === 404);
      await assert.rejects(() => rp.runReplyAction(run(tx), "outreach.replies.get", {}, deps()), (e) => e.status === 400);
      await tx`update leads set do_not_contact = true where id = 'r7-lead'`;
      assert.deepEqual(await rp.runReplyAction(run(tx), "outreach.replies.delete", { id: a.id }, deps()), { id: a.id, deleted: true });
      await assert.rejects(() => rp.runReplyAction(run(tx), "outreach.replies.get", { id: a.id }, deps()), (e) => e.status === 404);
      await assert.rejects(() => rp.runReplyAction(run(tx), "outreach.replies.delete", { id: a.id }, deps()), (e) => e.status === 404);
      assert.equal((await tx`select do_not_contact from leads where id = 'r7-lead'`)[0].do_not_contact, true);
    });
  });

  test("reply.send: preview sends nothing; refusals (empty, opt-out, do-not-contact, no message id, already answered, banned words); a send goes in the thread from the original inbox and is saved", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = (await rp.ingest(tx, { eventType: "message.received", message: msg(), alert: false }, deps())).reply;
      const s = stub();
      const d = deps({ agentmail: s.api, senderFallback: "Made-up Sender" });
      const act = (p) => rp.runReplyAction(run(tx), "outreach.reply.send", p, d);
      const pv = await act({ id: r.id, text: "Happy to talk. How about a short call?", preview: true });
      assert.equal(pv.preview, true);
      assert.equal(pv.to, "owner@madeup-r7.test");
      assert.equal(pv.subject, "Re: plumbing");
      assert.equal(pv.inbox_id, "inbox-send@madeup-agentmail.test");
      assert.match(pv.text, /1 Made Up Street/);
      assert.equal(s.posts.length, 0);
      await assert.rejects(() => act({ id: r.id, text: "  " }), (e) => e.status === 400);
      await assert.rejects(() => act({ id: "nope", text: "x" }), (e) => e.status === 404);
      const sent = await act({ id: r.id, text: "Happy to talk. How about a short call?" });
      assert.equal(sent.sent, true);
      assert.equal(s.posts[0].path, `/inboxes/inbox-send%40madeup-agentmail.test/messages/${encodeURIComponent(r.agentmail_message_id)}/reply`);
      const [row] = await tx`select handled, data from replies where id = ${r.id}`;
      assert.equal(row.handled, true);
      assert.equal(row.data.our_reply.to, "owner@madeup-r7.test");
      await assert.rejects(() => act({ id: r.id, text: "Again" }), (e) => e.status === 400 && /already/.test(e.message));
      await tx`update leads set do_not_contact = true, stop_state = 'do_not_contact' where id = 'r7-lead'`;
      await assert.rejects(() => act({ id: r.id, text: "Again", resend: true }), (e) => e.status === 400 && /do-not-contact/.test(e.message));
      const o = (await rp.ingest(tx, { eventType: "message.received", message: msg({ text: "unsubscribe" }), alert: false }, deps())).reply;
      await assert.rejects(() => act({ id: o.id, text: "Sorry" }), (e) => e.status === 400 && /stop/.test(e.message));
      await tx`insert into replies (id, campaign_id, lead_id, from_address, subject, body_text, received_at, data) values ('r7-nomsg', ${CID}, 'r7-lead', 'x@madeup-r7.test', 's', 't', now(), '{}')`;
      await assert.rejects(() => act({ id: "r7-nomsg", text: "Hi" }), (e) => e.status === 400 && /message id/.test(e.message));
      assert.equal(s.posts.length, 1, "only the one real send");
    });
  });

  test("reply.draft answers 501 on the SQL path until P4", async () => {
    await assert.rejects(() => rp.runReplyAction(async () => {}, "outreach.reply.draft", { id: "x" }, deps()), (e) => e.status === 501);
  });

  test("replies.sync with a stubbed AgentMail: stores new inbound mail with the webhook's rules, skips own sent, old, health checks, bounce reports and ones already held; no alert", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      const held = (await rp.ingest(tx, { eventType: "message.received", message: msg({ message_id: "am-held" }), alert: false }, deps())).reply;
      const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const listed = [
        { message_id: "am-held", labels: ["received"], timestamp: now, from: "Pat <owner@madeup-r7.test>", thread_id: "am-thread-1" },
        { message_id: "am-new", labels: ["received"], timestamp: now, from: "Pat <owner@madeup-r7.test>", subject: "Re: plumbing", thread_id: "am-thread-1", preview: "Yes please" },
        { message_id: "am-spam", labels: ["received", "spam"], timestamp: now, from: "Sam <sam@madeup-elsewhere.test>", subject: "hello", thread_id: "t-x" },
        { message_id: "am-sent", labels: ["sent"], timestamp: now, from: "inbox-send@madeup-agentmail.test" },
        { message_id: "am-old", labels: ["received"], timestamp: old, from: "x@madeup.test" },
        { message_id: "am-hc", labels: ["received"], timestamp: now, from: "hc@madeup-agentmail.test", subject: "Alcance webhook health check" },
        { message_id: "am-hc-old", labels: ["received"], timestamp: now, from: "hc@madeup-agentmail.test", subject: "ShiftForge HQ webhook health check" },
        { message_id: "am-bounce", labels: ["received"], timestamp: now, from: "mailer-daemon@madeup-mx.test", subject: "Undeliverable: x" },
      ];
      const s = stub();
      s.api.get = async (path) => {
        s.gets.push(path);
        if (path.startsWith("/inboxes?")) return { ok: true, body: { inboxes: [{ inbox_id: "inbox-send@madeup-agentmail.test", email: "inbox-send@madeup-agentmail.test" }] } };
        if (/\/messages\?/.test(path)) return { ok: true, body: { messages: listed } };
        if (/\/messages\/am-new$/.test(path)) return { ok: true, body: { message_id: "am-new", text: "Yes please, call me." } };
        return { ok: false, status: 404, text: "" };
      };
      const r = await rp.runReplyAction(run(tx), "outreach.replies.sync", { days: 14 }, deps({ agentmail: s.api }));
      assert.equal(r.added, 2);
      assert.equal(r.flagged, 1);
      assert.deepEqual(r.skipped, { already_have: 1, own_sent: 1, bounce_reports: 1, health_checks: 2, too_old: 1 });
      assert.equal(s.posts.length, 0, "the sync never sends");
      const [nw] = await tx`select body_text, source, lead_id from replies where agentmail_message_id = 'am-new'`;
      assert.deepEqual([nw.body_text, nw.source, nw.lead_id], ["Yes please, call me.", "sync", "r7-lead"]);
      assert.equal((await tx`select count(*)::int as n from outbox where kind like 'alert.%' and payload->>'reply_id' in (select id from replies where source = 'sync' and agentmail_message_id like 'am-%')`)[0].n, 0, "no alert from the sync");
      assert.ok(held);
      await assert.rejects(() => rp.runReplyAction(run(tx), "outreach.replies.sync", {}, deps({ agentmail: null })), (e) => e.status === 400);
    });
  });
});

test("health check subject (D2): both the new and the old subject are recognised", () => {
  assert.equal(rp.HEALTH_CHECK_SUBJECT, "Alcance webhook health check");
  assert.equal(rp.isHealthCheck("Alcance webhook health check"), true);
  assert.equal(rp.isHealthCheck("ShiftForge HQ webhook health check"), true);
  assert.equal(rp.isHealthCheck("Re: plumbing"), false);
  assert.ok(rules.RULES_VERSION >= 5);
});
