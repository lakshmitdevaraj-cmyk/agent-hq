import assert from "node:assert/strict";
import { countSentToday, limitOrDefault, dayIn } from "../../netlify/functions/lib/sendcount";
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
t("limit: default 30, whole numbers only", () => { assert.equal(limitOrDefault(undefined), 30); assert.equal(limitOrDefault("x"), 30); assert.equal(limitOrDefault(0), 30); assert.equal(limitOrDefault(12), 12); assert.equal(dayIn("2026-11-22T04:30:00Z", "America/Chicago"), "2026-11-21"); });
console.log(`\n${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
