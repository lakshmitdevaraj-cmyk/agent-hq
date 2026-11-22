import assert from "node:assert/strict";
import {
  isInboundEvent, flagFor, isOwnAddress, isHealthCheckMessage, isBounceReport, replySubject, buildReplyRecord,
  ownReplyEmailIds, repliedEmailCount, listedToMessage, isListedInbound, webhookEventsToSend, dryRunWebhookPatch, REQUIRED_WEBHOOK_EVENTS,
} from "../../netlify/functions/lib/replies";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  " + name); };

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
  assert.equal(m.text, "Got it");
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

console.log(`\n${n} tests passed`);
