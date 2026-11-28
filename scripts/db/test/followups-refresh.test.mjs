// Run E (chunk 8 open point), on Neon dev, every transaction rolled back: `follow_ups` is refreshed for the lead after
// each send, reply, bounce report, bounce or complaint event, without opening the follow-ups list. All data is made up.
// AgentMail is a stub; a real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

const CID = "fr-camp";
const HOOK = "fr-hook";
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
let n, send, rp, wh, realFetch;
let seq = 0;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  send = await import("../../../netlify/functions/lib/sql/send.ts");
  rp = await import("../../../netlify/functions/lib/sql/replies.ts");
  wh = await import("../../../netlify/functions/lib/sql/webhooks.ts");
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const run = (tx) => (fn) => fn(tx);
const newId = () => `fr-id-${++seq}`;
function sign(body) {
  const id = `msg_${randomBytes(6).toString("hex")}`, ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from(SECRET.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}`, "content-type": "application/json" };
}
const stub = () => ({
  inbox: async () => ({ inbox_id: "inbox-fr", email: "inbox@madeup-own.test", display_name: "Made-up Sender" }),
  setDisplayName: async () => {},
  post: async () => ({ ok: true, message_id: `am-fr-${++seq}`, thread_id: `am-fr-thread-${seq}` }),
});

async function seed(tx) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign FR', 'plumber', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), '{}')`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", follow_up_gaps_email: [3, 8, 15], postal_address: "1 Made Up Street", daily_send_limit: 30 })})
           on conflict (key) do update set data = excluded.data`;
  await tx`insert into webhooks (id, blob_key, name, service, event_count, created_at, data)
           values (${HOOK}, ${HOOK}, 'Made-up AgentMail hook', 'agentmail', 0, now(), ${tx.json({ description: "", signing_secret: SECRET })})`;
  for (const id of ["fr-send", "fr-reply", "fr-bounce", "fr-complain"]) {
    const sent = id !== "fr-send";
    await tx`insert into leads (id, campaign_id, blob_key, name, email, email_key, category, address, created_at, data)
             values (${id}, ${CID}, ${id}, ${`Made-up Plumbing ${id}`}, ${`owner@${id}.test`}, ${`owner@${id}.test`}, 'Plumber', '1 Made Up St, Madeupville, TX 77001', now(), '{}')`;
    for (const step of [1, 2]) {
      await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, to_name, subject, body_text, body_html, sender_name, step, sequence_total, framework, status, review_status, reviewed_by,
                                   agentmail_message_id, agentmail_thread_id, agentmail_inbox_id, sent_at, created_at, updated_at, data)
               values (${`${id}-e${step}`}, ${`${CID}/${id}-e${step}`}, ${CID}, ${id}, ${`owner@${id}.test`}, ${`owner@${id}.test`}, 'Made-up Plumbing', 'plumbing',
                       'Hello Made-up Plumbing team. Would you like a short recording of an assistant answering a call?', null, 'Made-up Sender', ${step}, 4, 'four-step',
                       ${step === 1 && sent ? "sent" : "drafted"}, 'ready', 'lakshmi',
                       ${step === 1 && sent ? `am-${id}-1` : null}, ${step === 1 && sent ? `am-${id}-thread` : null}, ${step === 1 && sent ? "inbox-fr" : null},
                       ${step === 1 && sent ? "2026-11-20T15:00:00Z" : null}, ${new Date(Date.UTC(2026, 1, 1, 0, 0, ++seq))}, now(), '{}')`;
    }
  }
  // follow_ups starts empty for these leads (nobody opened the list)
}
const withFx = (fn) => n.callWrite(async (tx) => { await seed(tx); return fn(tx); });
const rows = (tx, lead) => tx`select channel, position, due_date, stopped_reason, email_id from follow_ups where lead_id = ${lead} order by channel, position`;

describe("follow_ups is refreshed after each send and reply (no list open needed)", () => {
  test("after a send: the lead's email follow-up row appears with a due date", () => withFx(async (tx) => {
    assert.equal((await rows(tx, "fr-send")).length, 0);
    const r = await send.runSendAction(run(tx), "outreach.emails.send", { campaign_id: CID, email_ids: ["fr-send-e1"] }, { agentmail: stub(), baseUrl: "https://made-up.test", ownAddresses: ["me@madeup-own.test"], newId });
    assert.equal(r.sent, 1, JSON.stringify(r).slice(0, 200));
    const fu = (await rows(tx, "fr-send")).filter((x) => x.channel === "email");
    assert.ok(fu.length > 0, "an email follow-up row");
    assert.ok(fu.some((x) => x.due_date && !x.stopped_reason), JSON.stringify(fu));
  }));

  test("after a person's reply: the lead's follow-ups are stopped", () => withFx(async (tx) => {
    const m = { message_id: "fr-in-1", thread_id: "am-fr-reply-thread", from: "Owner <owner@fr-reply.test>", to: ["inbox@madeup-own.test"], subject: "Re: plumbing", text: "Yes, tell me more about this.", timestamp: "2026-11-24T16:00:00Z", inbox_id: "inbox-fr" };
    await rp.ingest(tx, { eventType: "message.received", message: m, alert: false, source: "webhook" }, { newId, ownAddresses: ["me@madeup-own.test"], agentmail: null, baseUrl: "" });
    assert.equal((await tx`select stop_state from leads where id = 'fr-reply'`)[0].stop_state, "replied");
    const fu = await rows(tx, "fr-reply");
    assert.ok(fu.length > 0 && fu.every((x) => x.stopped_reason), JSON.stringify(fu));
  }));

  test("after a bounce event: the lead's email follow-ups are stopped (bounced)", () => withFx(async (tx) => {
    const body = JSON.stringify({ event_type: "message.bounced", event_id: `evt-fr-${++seq}`, bounce: { message_id: "am-fr-bounce-1", inbox_id: "inbox-fr", timestamp: "2026-11-21T15:00:00Z" } });
    const r = await wh.receive(run(tx), { webhookId: HOOK, headers: sign(body), rawBody: body }, { newId, ownAddresses: ["me@madeup-own.test"], agentmail: null, baseUrl: "" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal((await tx`select stop_state from leads where id = 'fr-bounce'`)[0].stop_state, "bounced");
    const fu = (await rows(tx, "fr-bounce")).filter((x) => x.channel === "email");
    assert.ok(fu.length > 0 && fu.every((x) => x.stopped_reason), JSON.stringify(fu));
  }));

  test("after a complaint event: every follow-up of the lead is stopped", () => withFx(async (tx) => {
    const body = JSON.stringify({ event_type: "message.complained", event_id: `evt-fr-${++seq}`, complaint: { message_id: "am-fr-complain-1", inbox_id: "inbox-fr", timestamp: "2026-11-21T15:00:00Z" } });
    const r = await wh.receive(run(tx), { webhookId: HOOK, headers: sign(body), rawBody: body }, { newId, ownAddresses: ["me@madeup-own.test"], agentmail: null, baseUrl: "" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const fu = await rows(tx, "fr-complain");
    assert.ok(fu.length > 0 && fu.every((x) => x.stopped_reason), JSON.stringify(fu));
  }));

  test("another lead's rows are not touched by a refresh", () => withFx(async (tx) => {
    await tx`insert into follow_ups (lead_id, channel, campaign_id, step_key, position, due_date, computed_at) values ('fr-complain', 'email', ${CID}, 'x', 9, '2026-12-01', now())`;
    const m = { message_id: "fr-in-2", thread_id: "am-fr-reply-thread", from: "Owner <owner@fr-reply.test>", to: ["inbox@madeup-own.test"], subject: "Re: plumbing", text: "Sounds good.", timestamp: "2026-11-24T16:00:00Z", inbox_id: "inbox-fr" };
    await rp.ingest(tx, { eventType: "message.received", message: m, alert: false, source: "webhook" }, { newId, ownAddresses: ["me@madeup-own.test"], agentmail: null, baseUrl: "" });
    assert.equal((await tx`select count(*)::int as n from follow_ups where lead_id = 'fr-complain' and position = 9`)[0].n, 1);
  }));
});
