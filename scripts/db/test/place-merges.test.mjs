// The rule for duplicates where neither row has an email: same Google place id only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeMerges } from "../place-merges.mjs";

const lead = (id, place, over = {}) => ({ id, campaign_id: "c", name: id, email_key: null, is_test: false, data: {}, created_at: `2026-11-0${id.at(-1)}T00:00:00Z`, place, ...over });
const run = (leads, more = {}) => placeMerges({ leads, emails: [], social_messages: [], replies: [], touches: [], follow_up_state: [], follow_ups: [], lead_social_links: [], ...more }, (l) => l.place);
const pairs = (r) => r.merges.map((m) => [m.keep, m.merge]);

test("keeps the row with a message, touch, follow-up record or Facebook-checked note, even if newer", () => {
  assert.deepEqual(pairs(run([lead("a1", "P"), lead("a2", "P")], { social_messages: [{ lead_id: "a2" }] })), [["a2", "a1"]]);
  assert.deepEqual(pairs(run([lead("a1", "P"), lead("a2", "P")], { touches: [{ lead_id: "a2" }] })), [["a2", "a1"]]);
  assert.deepEqual(pairs(run([lead("a1", "P"), lead("a2", "P")], { follow_up_state: [{ lead_id: "a2" }] })), [["a2", "a1"]]);
  assert.deepEqual(pairs(run([lead("a1", "P"), lead("a2", "P", { data: { fb_checked: { result: "real" } } })])), [["a2", "a1"]]);
  assert.deepEqual(pairs(run([lead("a1", "P"), lead("a2", "P", { excluded_note: "Facebook checked 21 Nov: gone" })])), [["a2", "a1"]]);
});

test("both rows with records are left for her", () => {
  const r = run([lead("a1", "P"), lead("a2", "P", { data: { fb_checked: {} } })], { emails: [{ lead_id: "a1" }] });
  assert.deepEqual(r.merges, []);
  assert.deepEqual(r.left.map((x) => x.ids), [["a1", "a2"]]);
});

test("with no records, the row holding more is kept, else the older", () => {
  assert.deepEqual(pairs(run([lead("a1", "P"), lead("a2", "P", { site_check: {} })])), [["a2", "a1"]]);
  assert.deepEqual(pairs(run([lead("a2", "P"), lead("a1", "P")])), [["a1", "a2"]]);
});

test("not merged: different or missing place id, other campaign, a row with an email", () => {
  assert.deepEqual(run([lead("a1", "P"), lead("a2", "Q")]).merges, []);
  assert.deepEqual(run([lead("a1", null), lead("a2", null)]).merges, []);
  assert.deepEqual(run([lead("a1", "P"), lead("a2", "P", { campaign_id: "d" })]).merges, []);
  assert.deepEqual(run([lead("a1", "P"), lead("a2", "P", { email_key: "x@example.com" })]).merges, []);
});

test("a merged row that is excluded or do-not-contact when the kept one is not is left for her", () => {
  assert.equal(run([lead("a1", "P", { site_check: {} }), lead("a2", "P", { excluded: true })]).left.length, 1);
});
