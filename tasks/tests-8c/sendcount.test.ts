import assert from "node:assert/strict";
import { countSentToday, limitOrDefault, dayIn, DEFAULT_COUNT_TZ } from "../../netlify/functions/lib/sendcount";
import { isOwnAddress } from "../../netlify/functions/lib/replies";
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + " -> " + String((e as Error).message).split("\n")[0].slice(0, 200)); } };
const now = new Date("2026-11-22T04:30:00Z"); // 22:30 on 21 Nov in Chicago, 04:30 on 22 Nov in UTC
t("today is the day in the Settings time zone", () => {
  const rows = [{ status: "sent", sent_at: "2026-11-22T03:00:00Z" }, { status: "sent", sent_at: "2026-11-21T20:00:00Z" }, { status: "sent", sent_at: "2026-11-20T20:00:00Z" }];
  assert.equal(countSentToday(rows, "America/Chicago", now), 2);
  assert.equal(countSentToday(rows, "UTC", now), 1);
});
t("drafted and failed rows do not count; bounced and replied were sent", () => {
  const at = "2026-11-21T20:00:00Z";
  assert.equal(countSentToday([{ status: "drafted", sent_at: at }, { status: "failed", sent_at: at }, { status: "bounced", sent_at: at }, { status: "replied", sent_at: at }, { status: "sent" }], "America/Chicago", now), 2);
});
t("real sends only: mock ids, test leads and own addresses are not counted", () => {
  const at = "2026-11-22T02:00:00Z";
  const rows = [
    { status: "sent", sent_at: at, agentmail_message_id: "msg_real_1", lead_id: "L1", to_email: "owner@acme-plumbing.com" },
    { status: "delivered", sent_at: at, agentmail_message_id: "msg_real_2", lead_id: "L2", to_email: "office@katyrooter.com" },
    { status: "sent", sent_at: at, agentmail_message_id: "mock-out-1795361032074", lead_id: "L3", to_email: "x@real.com" },
    { status: "sent", sent_at: at, agentmail_message_id: "msg_real_3", lead_id: "T1", to_email: "t@real.com" },
    { status: "sent", sent_at: at, agentmail_message_id: "msg_real_4", lead_id: "L4", to_email: "shiftforge.ai+ebm@gmail.com" },
  ];
  const skip = { testLeadIds: new Set(["T1"]), isOwn: (a: string) => isOwnAddress(a) };
  assert.equal(countSentToday(rows, "UTC", now, skip), 2);
  assert.equal(countSentToday(rows, "UTC", now), 5);
});
t("the default day is India (IST)", () => {
  assert.equal(DEFAULT_COUNT_TZ, "Asia/Kolkata");
  const n2 = new Date("2026-11-21T20:00:00Z"); // 01:30 on 22 Nov in India
  const rows = [{ status: "sent", sent_at: "2026-11-21T19:00:00Z" }, { status: "sent", sent_at: "2026-11-21T17:00:00Z" }];
  assert.equal(countSentToday(rows, DEFAULT_COUNT_TZ, n2), 1); // 00:30 IST on 22 Nov counts, 22:30 IST on 21 Nov does not
});
t("limit: default 30, whole numbers only", () => { assert.equal(limitOrDefault(undefined), 30); assert.equal(limitOrDefault("x"), 30); assert.equal(limitOrDefault(0), 30); assert.equal(limitOrDefault(12), 12); assert.equal(dayIn("2026-11-22T04:30:00Z", "America/Chicago"), "2026-11-21"); });
console.log(`\n${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
