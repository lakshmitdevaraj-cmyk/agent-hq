import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isInboundEvent, flagFor, isOwnAddress, isHealthCheckMessage, isBounceReport, replySubject, buildReplyRecord,
  ownReplyEmailIds, repliedEmailCount, listedToMessage, isListedInbound, webhookEventsToSend, dryRunWebhookPatch, REQUIRED_WEBHOOK_EVENTS, listMessagesQuery, replyBodyText,
} from "../../netlify/functions/lib/replies";
import { isOptOutReply, isAutoReply } from "../../netlify/functions/lib/outreach";
import type { ListedMessage } from "../../netlify/functions/lib/replies";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 160)); } };

t("every message.received* type is inbound, outbound types are not", () => {
  for (const ty of ["message.received", "message.received.spam", "message.received.blocked", "message.received.unauthenticated", "message.received.future_thing"]) assert.equal(isInboundEvent(ty), true, ty);
  for (const ty of ["message.sent", "message.delivered", "message.bounced", "message.receivedx", "", undefined, "domain.verified"]) assert.equal(isInboundEvent(ty as string), false, String(ty));
});

t("flag: event type first, then labels; normal reply is null", () => {
  assert.equal(flagFor("message.received", ["received", "unread"]), null);
  assert.equal(flagFor("message.received.unauthenticated", ["received"]), "unauthenticated");
  assert.equal(flagFor("message.received.spam", []), "spam");
  assert.equal(flagFor("message.received.blocked", []), "blocked");
  assert.equal(flagFor("message.received", ["received", "unauthenticated"]), "unauthenticated");
  assert.equal(flagFor("message.received", ["spam", "unauthenticated"]), "spam");
  assert.equal(flagFor("message.received.unknown_new", []), null);
});

t("own addresses (Lakshmi's) are recognised, prospects are not", () => {
  const own = ["lakshmi@team.shiftforge.ai"];
  assert.equal(isOwnAddress("Lakshmi <shiftforge.ai@gmail.com>", own), true);
  assert.equal(isOwnAddress("lakshmi_devaraj@yahoo.com", own), true);
  assert.equal(isOwnAddress("LAKSHMI@team.shiftforge.ai", own), true);
  assert.equal(isOwnAddress("shiftforge.ai+santhana@gmail.com", own), true, "plus-address of her gmail");
  assert.equal(isOwnAddress("someone+x@gmail.com", own), false);
  assert.equal(isOwnAddress("santhana@regalelectrolysis.com", own), false);
  assert.equal(isOwnAddress(null, own), false);
});

t("health-check and bounce reports are recognised", () => {
  assert.equal(isHealthCheckMessage("ShiftForge HQ webhook health check"), true);
  assert.equal(isHealthCheckMessage("Re: Quick question"), false);
  assert.equal(isBounceReport("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)"), true);
  assert.equal(isBounceReport("postmaster@x.com", "x"), true);
  assert.equal(isBounceReport("santhana@regalelectrolysis.com", "Got it"), false);
});

t("alert subject carries the flag", () => {
  assert.equal(replySubject("Regal Electrolysis", "Webster", "unauthenticated"), "[Unauthenticated] Reply from Regal Electrolysis");
  assert.equal(replySubject("Regal Electrolysis", "Webster", "spam"), "[Spam] Reply from Regal Electrolysis");
  assert.equal(replySubject("Regal Electrolysis", "Webster", null), "New reply: Regal Electrolysis (Webster)");
});

const msg = { message_id: "m1", thread_id: "t1", inbox_id: "lakshmi@team.shiftforge.ai", from: "Santhana <santhana@regalelectrolysis.com>", to: ["lakshmi@team.shiftforge.ai"], subject: "Re: hello", text: "Got it", html: null, timestamp: "2026-11-22T02:27:00Z", labels: ["received", "unread", "unauthenticated"], authentication_results: { dkim: "none", dmarc: "none", spf: "none" } };

t("reply record stores flag, labels and authentication results", () => {
  const r = buildReplyRecord({ id: "r1", eventType: "message.received.unauthenticated", message: msg, match: { campaign_id: "c1", lead_id: "l1", email_id: "e1" }, own: [], optOut: false });
  assert.equal(r.flag, "unauthenticated");
  assert.equal(r.campaign_id, "c1");
  assert.equal(r.lead_id, "l1");
  assert.deepEqual(r.authentication_results, { dkim: "none", dmarc: "none", spf: "none" });
  assert.equal(r.is_test, false);
  assert.equal(r.agentmail_message_id, "m1");
  assert.equal(r.opt_out, false);
});

t("a reply from Lakshmi's own address is stored as a test", () => {
  const r = buildReplyRecord({ id: "r2", eventType: "message.received", message: { ...msg, from: "lakshmi_devaraj@yahoo.com", labels: ["received"] }, match: { campaign_id: "c1", lead_id: "l1", email_id: "e1" }, own: [], optOut: false });
  assert.equal(r.is_test, true);
  assert.equal(r.flag, null);
});

t("own-address replies do not count: only those emails are excluded", () => {
  const replies = [
    { original_email_id: "e1", is_test: true },
    { original_email_id: "e2", is_test: false },
    { original_email_id: "e3", is_test: true },
    { original_email_id: "e3", is_test: false },
  ];
  const own = ownReplyEmailIds(replies);
  assert.deepEqual([...own].sort(), ["e1"]);
  const emails = [{ id: "e1", status: "replied" }, { id: "e2", status: "replied" }, { id: "e3", status: "replied" }, { id: "e4", status: "replied" }, { id: "e5", status: "sent" }];
  assert.equal(repliedEmailCount(emails, own), 3); // e1 excluded; e4 has no stored reply (deleted from Inbox) and still counts
});

t("a campaign with only Lakshmi's test reply shows 0 replies", () => {
  const own = ownReplyEmailIds([{ original_email_id: "e1", is_test: true }]);
  assert.equal(repliedEmailCount([{ id: "e1", status: "replied" }], own), 0);
});

t("AgentMail list items map to messages; inbound only", () => {
  const listed = { message_id: "m9", thread_id: "t9", inbox_id: "i", labels: ["received", "unauthenticated"], from: "a@b.com", to: ["i"], subject: "s", timestamp: "2026-11-22T02:27:00Z", preview: "Got it" };
  assert.equal(isListedInbound(listed), true);
  assert.equal(isListedInbound({ ...listed, labels: ["sent"] }), false);
  assert.equal(isListedInbound({ ...listed, labels: [] }), false);
  const m = listedToMessage(listed);
  assert.equal(m.message_id, "m9");
  assert.equal(replyBodyText(m), "Got it", "preview is the last fallback");
  assert.deepEqual(m.labels, ["received", "unauthenticated"]);
});

t("webhook: required event list includes the unauthenticated type; dry run shows before/after, no change if already complete", () => {
  assert.ok(REQUIRED_WEBHOOK_EVENTS.includes("message.received.unauthenticated"));
  assert.ok(REQUIRED_WEBHOOK_EVENTS.includes("message.received.spam"));
  assert.ok(REQUIRED_WEBHOOK_EVENTS.includes("message.received.blocked"));
  const before = ["domain.verified", "message.bounced", "message.complained", "message.delivered", "message.received", "message.received.blocked", "message.received.spam", "message.rejected", "message.sent"];
  const send = webhookEventsToSend(before);
  assert.ok(send.includes("message.received.unauthenticated"));
  assert.ok(before.every((e) => send.includes(e)), "existing events are kept");
  const d = dryRunWebhookPatch({ webhook_id: "w1", event_types: before });
  assert.deepEqual(d.before, before);
  assert.equal(d.needs_change, true);
  assert.deepEqual(d.added, ["message.received.unauthenticated"]);
  assert.equal(dryRunWebhookPatch({ webhook_id: "w1", event_types: send }).needs_change, false);
});

t("List Messages asks for spam, blocked and unauthenticated messages, on every page", () => {
  for (const tok of [undefined, "page2"]) {
    const q = new URLSearchParams(listMessagesQuery(tok));
    for (const k of ["include_unauthenticated", "include_spam", "include_blocked"]) assert.equal(q.get(k), "true", k);
    assert.equal(q.get("page_token"), tok ?? null);
  }
  const src = fs.readFileSync("netlify/functions/command.ts", "utf8");
  assert.ok(!/\/messages\?limit=/.test(src), "no AgentMail message list may be built without the include_* flags");
  assert.match(src, /\/messages\?\$\{listMessagesQuery\(/);
});

const IPHONE = (words: string) => `<html><head><style>p{margin:0}</style></head><body dir="auto"><div>${words}</div><div dir="ltr"><br><blockquote type="cite"><div dir="ltr">On Nov 21, 2026, at 5:02 PM, Lakshmi Devaraj &lt;lakshmi@team.shiftforge.ai&gt; wrote:<br><br></div><div>Hi Santhana, quick question.</div></blockquote></div></body></html>`;
t("reply text: HTML-only reply shows its words (text empty, no extracted_text)", () => {
  assert.equal(replyBodyText({ text: "", html: IPHONE("Got it") }).split("\n")[0], "Got it");
  assert.equal(replyBodyText({ html: "<p>Thanks&nbsp;a lot &amp; talk soon</p>" }), "Thanks a lot & talk soon");
  assert.equal(replyBodyText({ text: "plain wins", html: "<p>html</p>" }), "plain wins");
  assert.equal(replyBodyText({ text: "", extracted_text: "extracted wins over html", html: "<p>html</p>" }), "extracted wins over html");
  assert.equal(replyBodyText({ text: "", html: "" }), "");
});

t("reply text: an HTML-only stop reply is an opt-out, an HTML-only 'Got it' is not; auto-replies are seen", () => {
  assert.equal(isOptOutReply("Re: Calls", replyBodyText({ text: "", html: IPHONE("Stop. No thanks, please do not email me again.") })), true);
  assert.equal(isOptOutReply("Re: Calls", replyBodyText({ text: "", html: IPHONE("Got it") })), false);
  assert.equal(isAutoReply("Automatic reply: Calls", replyBodyText({ text: "", html: "<p>I am out of the office until Monday.</p>" })), true);
});

t("reply text: webhook and sync both pass through ingestInboundReply, which fills the text before anything else reads it", () => {
  const ing = fs.readFileSync("netlify/functions/lib/inbound.ts", "utf8");
  assert.match(ing, /const message: InboundMessage = \{ \.\.\.o\.message, text: replyBodyText\(o\.message\) \}/);
  assert.match(ing, /newPartOfReply\(replyBodyText\(m\)\)/, "the alert body");
  assert.ok(!/message\.text \?\? stripTags/.test(ing), "no old nullish fallback (empty string is not nullish)");
  assert.ok(/ingestInboundReply\(\{ eventType, message, baseUrl, alert: true, source: "webhook" \}\)/.test(fs.readFileSync("netlify/functions/webhook-receive.ts", "utf8")));
  assert.ok(/source: "sync"/.test(fs.readFileSync("netlify/functions/command.ts", "utf8")));
  const listed = listedToMessage({ message_id: "m", text: "", html: IPHONE("Got it"), extracted_text: "" } as ListedMessage);
  assert.equal(replyBodyText(listed).split("\n")[0], "Got it");
  const rec = buildReplyRecord({ id: "r", eventType: "message.received.unauthenticated", message: { ...listed, text: replyBodyText(listed) }, match: null, own: [], optOut: false });
  assert.equal(rec.text!.split("\n")[0], "Got it");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
