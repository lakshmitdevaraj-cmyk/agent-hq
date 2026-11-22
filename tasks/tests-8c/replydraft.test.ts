import assert from "node:assert/strict";
import { stateFromAddress, proposeSlots, assembleReply, validTimeZone, STATE_TZ } from "../../netlify/functions/lib/replydraft";
import { scanBanned } from "../../netlify/functions/lib/messagerules";
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + " -> " + String((e as Error).message).split("\n")[0].slice(0, 200)); } };
const hourIn = (iso: string, tz: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));
const dayIn = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(iso));
t("state from address", () => { assert.equal(stateFromAddress("1 Main St, Katy, TX 77494, USA"), "TX"); assert.equal(stateFromAddress("Katy Texas"), null); assert.equal(stateFromAddress(null), null); });
t("every state has a valid zone", () => { for (const [s, z] of Object.entries(STATE_TZ)) assert.ok(validTimeZone(z), s); });
t("time zone check", () => { assert.ok(validTimeZone("America/Chicago")); assert.ok(!validTimeZone("Mars/Base")); });
const now = new Date("2026-11-22T15:00:00Z"); // a Sunday
t("sender in India, prospect in Texas: three weekdays inside the prospect's working day, sender's zone shown too", () => {
  const s = proposeSlots(now, "Asia/Kolkata", "America/Chicago");
  assert.equal(s.length, 3);
  assert.equal(new Set(s.map((x) => x.at.slice(0, 10))).size, 3);
  for (const x of s) {
    const h = hourIn(x.at, "America/Chicago"); assert.ok(h >= 9 && h < 17, x.text);
    assert.ok(!["Sat", "Sun"].includes(dayIn(x.at, "America/Chicago")));
    assert.match(x.text, /CST \(\d{1,2}:\d{2} (AM|PM) IST for me\)$/);
  }
});
t("sender in Houston, prospect in New York: 3 slots, different weekdays, both inside 9-5, both zones shown", () => {
  const s = proposeSlots(now, "America/Chicago", "America/New_York");
  assert.equal(s.length, 3);
  assert.equal(new Set(s.map((x) => x.at.slice(0, 10))).size, 3);
  for (const x of s) { assert.ok(!["Sat", "Sun"].includes(dayIn(x.at, "America/New_York"))); const h = hourIn(x.at, "America/Chicago"); assert.ok(h >= 9 && h <= 16); const p = hourIn(x.at, "America/New_York"); assert.ok(p >= 9 && p <= 16); }
  assert.match(s[0].text, /^Monday, November 23 at \d{1,2}:00 (AM|PM) EST \(\d{1,2}:00 (AM|PM) CST for me\)$/);
});
t("the slots are shown in the prospect's zone, with the sender's zone after it", () => { assert.match(proposeSlots(now, "America/Chicago", "America/Los_Angeles")[0].text, /PST \(.* CST for me\)$/); });
t("assembled reply: slots then the booking link last, sender name at the end", () => {
  const r = assembleReply({ greeting: "Hi Sam,", answer: "Yes, it answers after hours.", whyCall: "On a call you can hear it answer for your own business.", slots: proposeSlots(now, "America/Chicago", "America/Chicago"), bookingLink: "https://cal.example/lakshmi", senderName: "Lakshmi" });
  assert.ok(r.indexOf("30-minute") < r.indexOf("https://cal.example"));
  assert.ok(r.indexOf("If it is easier") > r.lastIndexOf("- "));
  assert.equal(scanBanned("Yes, it answers after hours. On a call you can hear it answer for your own business.").length, 0);
});
console.log(`\n${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
