import assert from "node:assert/strict";
import { nextFollowUp, countDue, bucketOf, addDays, gapsOrDefault, type FollowInput } from "../../netlify/functions/lib/followups";
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + " -> " + String((e as Error).message).split("\n")[0].slice(0, 220)); } };
const base = { lead_id: "l1", campaign_id: "c1", name: "Acme", gaps: [3, 8, 15], today: "2026-11-20" };
const em = (s1: string | null, s2: string | null = null, s3: string | null = null): FollowInput["steps"] => [
  { key: "1", label: "Email 1", text: "a", sent_at: s1, id: "e1", status: "ready" }, { key: "2", label: "Email 2", text: "b", sent_at: s2, id: "e2", status: "ready" }, { key: "3", label: "Email 3", text: "c", sent_at: s3, id: "e3", status: "check" },
];
t("dates: 3 days after email 1 is email 2's due date; 8 days is email 3's", () => {
  assert.equal(nextFollowUp({ ...base, channel: "email", steps: em("2026-11-17T10:00:00Z") })!.due_date, "2026-11-20");
  assert.equal(nextFollowUp({ ...base, channel: "email", steps: em("2026-11-12T10:00:00Z", "2026-11-15T10:00:00Z") })!.due_date, "2026-11-20");
});
t("buckets: overdue, today, this week, later", () => {
  assert.equal(bucketOf("2026-11-19", "2026-11-20"), "overdue"); assert.equal(bucketOf("2026-11-20", "2026-11-20"), "today");
  assert.equal(bucketOf("2026-11-27", "2026-11-20"), "week"); assert.equal(bucketOf("2026-11-28", "2026-11-20"), "later");
});
t("days late is counted from the due date", () => { assert.equal(nextFollowUp({ ...base, channel: "email", steps: em("2026-11-12T10:00:00Z") })!.days_late, 5); });
t("nothing is due when email 1 is not sent, or when every step is sent", () => {
  assert.equal(nextFollowUp({ ...base, channel: "email", steps: em(null) }), null);
  assert.equal(nextFollowUp({ ...base, channel: "email", steps: em("2026-11-01T00:00:00Z", "2026-11-04T00:00:00Z", "2026-11-09T00:00:00Z") }), null);
});
t("a skipped step is passed over and the next one is due on its own gap", () => {
  const r = nextFollowUp({ ...base, channel: "email", steps: em("2026-11-12T10:00:00Z"), state: { lead_id: "l1", channel: "email", steps: { "2": { skipped: true } } } })!;
  assert.equal(r.step_key, "3"); assert.equal(r.due_date, "2026-11-20");
});
t("a moved date replaces the computed one and is flagged", () => {
  const r = nextFollowUp({ ...base, channel: "email", steps: em("2026-11-12T10:00:00Z"), state: { lead_id: "l1", channel: "email", steps: { "2": { moved_to: "2026-12-01" } } } })!;
  assert.equal(r.due_date, "2026-12-01"); assert.equal(r.moved, true); assert.equal(r.bucket, "later");
});
t("a reply, opt-out or do-not-contact stops the lead: one stopped row, never counted as due", () => {
  for (const why of ["replied", "opt_out", "do_not_contact"] as const) {
    const r = nextFollowUp({ ...base, channel: "email", steps: em("2026-11-01T00:00:00Z"), stopped: why })!;
    assert.equal(r.bucket, "stopped"); assert.equal(r.stopped_reason, why); assert.equal(r.can_mark, false);
    assert.equal(countDue([r]).total, 0);
  }
});
t("Facebook: follow-up 3 days after the first message, last 8 days after it", () => {
  const steps = [{ key: "message", label: "First message", text: "a", sent_at: "2026-11-17T00:00:00Z" }, { key: "follow_up", label: "Follow-up", text: "b", sent_at: null }, { key: "last", label: "Last message", text: "c", sent_at: null }];
  assert.equal(nextFollowUp({ ...base, channel: "facebook", steps })!.due_date, "2026-11-20");
  steps[1].sent_at = "2026-11-20T00:00:00Z";
  assert.equal(nextFollowUp({ ...base, channel: "facebook", steps })!.due_date, "2026-11-25");
});
const li = (note: string | null, dm: string | null, fu: string | null = null) => [{ key: "note", label: "Connection note", text: "n", sent_at: note }, { key: "dm", label: "First message", text: "d", sent_at: dm }, { key: "follow_up", label: "Follow-up", text: "f", sent_at: fu }, { key: "last", label: "Last message", text: "l", sent_at: null }];
t("LinkedIn: waiting for them to accept; after 21 days it asks to withdraw", () => {
  let r = nextFollowUp({ ...base, channel: "linkedin", steps: li("2026-11-15T00:00:00Z", null) })!;
  assert.equal(r.bucket, "waiting"); assert.equal(r.withdraw_prompt, false);
  r = nextFollowUp({ ...base, channel: "linkedin", steps: li("2026-10-25T00:00:00Z", null) })!;
  assert.equal(r.withdraw_prompt, true); assert.match(r.waiting_text!, /Withdraw the invitation\?/);
});
t("LinkedIn: accepted means the first message is due the next day; withdrawn means nothing more", () => {
  const acc = { lead_id: "l1", channel: "linkedin", accepted_at: "2026-11-19T10:00:00Z" };
  const r = nextFollowUp({ ...base, channel: "linkedin", steps: li("2026-11-10T00:00:00Z", null), state: acc })!;
  assert.equal(r.step_key, "dm"); assert.equal(r.due_date, "2026-11-20"); assert.equal(r.bucket, "today");
  assert.equal(nextFollowUp({ ...base, channel: "linkedin", steps: li("2026-10-01T00:00:00Z", null), state: { lead_id: "l1", channel: "linkedin", withdrawn_at: "2026-11-01T00:00:00Z" } }), null);
});
t("LinkedIn: after the first message the follow-up counts from it", () => {
  const r = nextFollowUp({ ...base, channel: "linkedin", steps: li("2026-11-10T00:00:00Z", "2026-11-17T00:00:00Z"), state: { lead_id: "l1", channel: "linkedin", accepted_at: "2026-11-16T00:00:00Z" } })!;
  assert.equal(r.step_key, "follow_up"); assert.equal(r.due_date, "2026-11-20");
});
t("counts: due today and overdue only, split by email and social", () => {
  const a = nextFollowUp({ ...base, channel: "email", steps: em("2026-11-12T10:00:00Z") })!;
  const b = nextFollowUp({ ...base, channel: "facebook", steps: [{ key: "message", label: "F", text: "", sent_at: "2026-11-17T00:00:00Z" }, { key: "follow_up", label: "F", text: "", sent_at: null }] })!;
  const c = nextFollowUp({ ...base, channel: "email", steps: em("2026-11-19T10:00:00Z") })!;
  assert.deepEqual(countDue([a, b, c]), { email: 1, social: 1, total: 2, week: 1 });
});
t("gaps parse from text and fall back to 3, 8, 15", () => { assert.deepEqual(gapsOrDefault("2, 6, 12"), [2, 6, 12]); assert.deepEqual(gapsOrDefault("x"), [3, 8, 15]); assert.deepEqual(gapsOrDefault([5, 9]), [5, 9]); assert.equal(addDays("2026-11-30", 1), "2026-12-01"); });
console.log(`\n${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
