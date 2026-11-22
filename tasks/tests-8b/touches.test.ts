import assert from "node:assert/strict";
import { deriveTouches, summarizeTouches, touchFromSent, parseSentOn, filterMatches, touchCsvColumns } from "../../netlify/functions/lib/touches";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 160)); } };

const emails = [
  { id: "e1", lead_id: "L1", status: "delivered", sent_at: "2026-11-18T10:00:00Z", sequence_position: 1, subject: "Hello", body_text: "Step 1 text" },
  { id: "e2", lead_id: "L1", status: "sent", sent_at: "2026-11-21T10:00:00Z", sequence_position: 2, subject: "Re: Hello", body_text: "Step 2 text" },
  { id: "e3", lead_id: "L1", status: "drafted", created_at: "2026-11-22T10:00:00Z", sequence_position: 3, subject: "x", body_text: "unsent" },
  { id: "e9", lead_id: "OTHER", status: "sent", sent_at: "2026-11-01T10:00:00Z", sequence_position: 1, subject: "o", body_text: "o" },
];
const legacySocial = { campaign_id: "C1", lead_id: "L1", channel: "facebook", status: "sent", sent_at: "2026-11-22T08:00:00Z", parts: [{ key: "message", label: "Message", text: "Hi Mike, hello from FB" }], type: undefined };

t("existing data carries over: sent emails and the 22 Nov Facebook mark are derived, drafts are not", () => {
  const ts = deriveTouches({ lead_id: "L1", campaign_id: "C1", emails, socials: [legacySocial], stored: [] });
  assert.equal(ts.length, 3);
  assert.deepEqual(ts.map((x) => x.channel), ["email", "email", "facebook"]);
  assert.deepEqual(ts.map((x) => x.kind), ["first", "follow_up", "first"]);
  assert.equal(ts[2].sent_at, "2026-11-22T08:00:00Z");
  assert.equal(ts[2].text, "Hi Mike, hello from FB");
  assert.ok(ts.every((x) => x.lead_id === "L1"));
});

t("two Facebook messages plus two emails are all kept, oldest first", () => {
  const stored = [
    { id: "t1", lead_id: "L1", campaign_id: "C1", channel: "facebook", kind: "first", sent_at: "2026-11-22T08:00:00Z", text: "first fb", source: "hq", ref: "social-C1-L1-facebook" },
    { id: "t2", lead_id: "L1", campaign_id: "C1", channel: "facebook", kind: "follow_up", sent_at: "2026-11-25T08:00:00Z", text: "second fb", source: "manual" },
  ] as never;
  const ts = deriveTouches({ lead_id: "L1", campaign_id: "C1", emails, socials: [legacySocial], stored });
  assert.equal(ts.length, 4, "the legacy sent record is not counted twice when its touch exists");
  assert.deepEqual(ts.map((x) => x.sent_at.slice(0, 10)), ["2026-11-18", "2026-11-21", "2026-11-22", "2026-11-25"]);
  const s = summarizeTouches(ts, false);
  assert.deepEqual(s.counts, { email: 2, facebook: 2, instagram: 0, linkedin: 0 });
  assert.equal(s.last_at, "2026-11-25T08:00:00Z");
  assert.equal(s.replied, false);
  assert.equal(s.total, 4);
});

t("the Replied tag", () => {
  assert.equal(summarizeTouches([], true).replied, true);
  assert.equal(summarizeTouches([], false).total, 0);
});

t("mark as sent: today by default, an earlier date allowed, a future date refused", () => {
  const now = new Date("2026-11-22T10:00:00Z");
  assert.equal(parseSentOn(undefined, now), "2026-11-22T10:00:00.000Z");
  assert.equal(parseSentOn("2026-11-20", now), "2026-11-20T12:00:00.000Z");
  assert.equal(parseSentOn("2026-11-22", now), "2026-11-22T10:00:00.000Z".replace("10:00:00", "10:00:00"), "today keeps the real time");
  assert.equal(parseSentOn("2026-11-30", now), null);
  assert.equal(parseSentOn("not a date", now), null);
});

t("a touch records channel, type, date, text and source", () => {
  const x = touchFromSent({ id: "z1", lead_id: "L1", campaign_id: "C1", channel: "instagram", kind: "follow_up", sent_at: "2026-11-23T00:00:00Z", text: "hi", source: "manual" });
  assert.deepEqual([x.channel, x.kind, x.source, x.text], ["instagram", "follow_up", "manual", "hi"]);
});

const sample = (counts: Partial<Record<string, number>>, last: string | null, replied = false) => ({ counts: { email: 0, facebook: 0, instagram: 0, linkedin: 0, ...counts }, last_at: last, replied, total: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) }) as never;
t("filters: not yet contacted on a channel; emailed, no reply, no social; last touch older than N days", () => {
  const now = new Date("2026-11-22T00:00:00Z");
  const a = sample({ email: 1 }, "2026-11-10T00:00:00Z");
  const b = sample({ email: 1, facebook: 1 }, "2026-11-21T00:00:00Z");
  const c = sample({ email: 1 }, "2026-11-20T00:00:00Z", true);
  const none = sample({}, null);
  assert.equal(filterMatches("not_on_facebook", a, now), true);
  assert.equal(filterMatches("not_on_facebook", b, now), false);
  assert.equal(filterMatches("not_on_facebook", none, now), true);
  assert.equal(filterMatches("emailed_no_reply_no_social", a, now), true);
  assert.equal(filterMatches("emailed_no_reply_no_social", b, now), false, "has a social message");
  assert.equal(filterMatches("emailed_no_reply_no_social", c, now), false, "replied");
  assert.equal(filterMatches("older_than:7", a, now), true);
  assert.equal(filterMatches("older_than:7", b, now), false);
  assert.equal(filterMatches("older_than:7", none, now), false, "never touched is not 'last touch older'");
});

t("CSV columns: touches per channel and the last-touch date", () => {
  const cols = touchCsvColumns(sample({ email: 2, facebook: 1 }, "2026-11-22T08:00:00Z"));
  assert.deepEqual(cols, [2, 1, 0, 0, "2026-11-22"]);
});

t("kind from date order: a legacy 22 Nov Facebook touch is a follow-up when an 8 Nov Facebook touch exists; hand-picked kinds are kept", () => {
  const stored = [{ id: "m1", lead_id: "L1", campaign_id: "C1", channel: "facebook", kind: "first", sent_at: "2026-11-08T12:00:00Z", text: "old", source: "manual" }] as never;
  const ts = deriveTouches({ lead_id: "L1", campaign_id: "C1", emails: [], socials: [legacySocial], stored });
  const fb = ts.filter((x) => x.channel === "facebook");
  assert.deepEqual(fb.map((x) => x.sent_at.slice(0, 10)), ["2026-11-08", "2026-11-22"]);
  assert.deepEqual(fb.map((x) => x.kind), ["first", "follow_up"], "22 Nov derived touch must be a follow-up");
  // Alone, the legacy touch is still the first message.
  assert.equal(deriveTouches({ lead_id: "L1", campaign_id: "C1", emails: [], socials: [legacySocial], stored: [] })[0].kind, "first");
  // A hand-recorded entry keeps the kind the user picked, even when an earlier touch exists.
  const picked = [{ id: "m1", lead_id: "L1", campaign_id: "C1", channel: "instagram", kind: "first", sent_at: "2026-11-08T12:00:00Z", text: "a", source: "manual" }, { id: "m2", lead_id: "L1", campaign_id: "C1", channel: "instagram", kind: "first", sent_at: "2026-11-20T12:00:00Z", text: "b", source: "manual" }] as never;
  assert.deepEqual(deriveTouches({ lead_id: "L1", campaign_id: "C1", emails: [], socials: [], stored: picked }).map((x) => x.kind), ["first", "first"]);
  // Different channels do not affect each other.
  const mixed = deriveTouches({ lead_id: "L1", campaign_id: "C1", emails: [], socials: [legacySocial], stored: [{ id: "i1", lead_id: "L1", campaign_id: "C1", channel: "instagram", kind: "first", sent_at: "2026-11-08T12:00:00Z", text: "i", source: "manual" }] as never });
  assert.equal(mixed.find((x) => x.channel === "facebook")!.kind, "first");
});

t("summary carries the latest reply date and the last message sent on any channel", () => {
  const ts = deriveTouches({ lead_id: "L1", campaign_id: "C1", emails, socials: [legacySocial], stored: [] });
  const s = summarizeTouches(ts, true, { at: "2026-11-21T09:00:00Z", via: "email" });
  assert.equal(s.last_at, "2026-11-22T08:00:00Z");
  assert.equal(s.replied_at, "2026-11-21T09:00:00Z");
  assert.equal(s.replied_via, "email");
  assert.equal(summarizeTouches(ts, false, { at: "2026-11-21T09:00:00Z" }).replied_at, null);
});

t("a written run's sent steps count as touches, so Prospects and Follow-ups agree (and a stored entry is not counted twice)", () => {
  const seq = { campaign_id: "C", lead_id: "L9", channel: "linkedin", status: "drafted", type: "sequence", sent_at: null, parts: [
    { key: "note", text: "Note text", sent_at: "2026-10-28T11:00:00Z" },
    { key: "dm", text: "DM text", sent_at: "2026-11-02T11:00:00Z", touch_id: "T-stored" },
    { key: "follow_up", text: "Follow up", sent_at: null },
  ] };
  const stored = [touchFromSent({ id: "T-stored", lead_id: "L9", campaign_id: "C", channel: "linkedin", kind: "follow_up", sent_at: "2026-11-02T11:00:00Z", text: "DM text", source: "hq" })];
  const tl = deriveTouches({ lead_id: "L9", campaign_id: "C", emails: [], socials: [seq], stored });
  assert.equal(tl.length, 2);
  assert.equal(summarizeTouches(tl, false).counts.linkedin, 2);
  assert.equal(summarizeTouches(tl, false).total, 2);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
