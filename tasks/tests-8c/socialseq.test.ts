import assert from "node:assert/strict";
import { parseSocialSeq, checkSocialSeq, socialFailureLines, mergeSocial, parseSocialReview, SEQ_KEYS } from "../../netlify/functions/lib/socialseq";
import { partsFor, socialTypeFor } from "../../netlify/functions/lib/social";
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + " -> " + String((e as Error).message).split("\n")[0].slice(0, 200)); } };
const inp = { freeAsset1: "a 2-minute recording", freeAsset2: "a number", proofLine: "", namedSources: "" };
const FB = {
  message: "Hi there, Katy Air has 4.8 stars from 210 reviews. When a call comes in after hours and nobody picks up, do those callers just ring the next company?",
  follow_up: "I wrote about missed calls. Want me to send a short recording of it answering for you?",
  last: "Last message from me. Is someone else the right person for new customer calls? A plain no is fine.",
};
t("step keys per channel", () => { assert.deepEqual(SEQ_KEYS.facebook, ["message", "follow_up", "last"]); assert.deepEqual(SEQ_KEYS.linkedin, ["note", "dm", "follow_up", "last"]); });
t("partsFor(sequence) gives every step, older types are unchanged", () => { assert.equal(partsFor("linkedin", "sequence").length, 4); assert.equal(partsFor("facebook", "first").length, 1); assert.equal(partsFor("linkedin", "first").length, 2); });
t("type: a sequence is only for a channel with nothing sent; after a send the older follow-up path", () => { assert.equal(socialTypeFor("sequence", false), "sequence"); assert.equal(socialTypeFor("sequence", true), "follow_up_channel"); assert.equal(socialTypeFor(undefined, false), "first"); });
t("parse: facebook needs first, follow_up, last; linkedin also the connection note", () => {
  assert.ok(parseSocialSeq("facebook", { first: "a", follow_up: "b", last: "c" }));
  assert.equal(parseSocialSeq("facebook", { first: "a", follow_up: "b" }), null);
  assert.equal(parseSocialSeq("linkedin", { first: "a", follow_up: "b", last: "c" }), null);
  assert.deepEqual(Object.keys(parseSocialSeq("linkedin", { connection_note: "n", first: "a", follow_up: "b", last: "c", fact_used: 2 })!.texts), ["note", "dm", "follow_up", "last"]);
});
t("a good Facebook run is all ready", () => { const c = checkSocialSeq("facebook", FB, inp); assert.deepEqual(c.map((x) => x.status), ["ready", "ready", "ready"], JSON.stringify(c.map((x) => x.reasons))); });
t("first message with an offer or an asset is blocked; a call ask is blocked", () => {
  assert.equal(checkSocialSeq("facebook", { ...FB, message: FB.message + " I help plumbers with an AI receptionist." }, inp)[0].status, "blocked");
  assert.equal(checkSocialSeq("facebook", { ...FB, follow_up: FB.follow_up + " Can we book a call?" }, inp)[1].status, "blocked");
});
t("follow-up repeating the rating is BLOCKED (once per lead); last without 'last message' is Check", () => {
  assert.equal(checkSocialSeq("facebook", { ...FB, follow_up: "Katy Air has 4.8 stars. Want me to send a short recording?" }, inp)[1].status, "blocked");
  assert.equal(checkSocialSeq("facebook", { ...FB, last: "Is someone else the right person? A plain no is fine." }, inp)[2].status, "check");
});
t("empty free asset: the follow-up is Check with the Settings reason", () => { const c = checkSocialSeq("facebook", FB, { ...inp, freeAsset1: "" }); assert.equal(c[1].status, "check"); assert.match(c[1].reasons.join(" "), /Settings/); });
t("LinkedIn: a 201-character note is blocked, a pitch in the note is blocked", () => {
  const li = { note: "Saw Katy Air serves the whole Katy area.", dm: "Hi Sam, Katy Air has 4.8 stars. When the phones ring after hours and nobody answers, do those callers move on?", follow_up: FB.follow_up, last: FB.last };
  assert.deepEqual(checkSocialSeq("linkedin", li, inp).map((x) => x.status), ["ready", "ready", "ready", "ready"]);
  assert.equal(checkSocialSeq("linkedin", { ...li, note: "x".repeat(201) }, inp)[0].status, "blocked");
  assert.equal(checkSocialSeq("linkedin", { ...li, note: "I help plumbers with an AI receptionist." }, inp)[0].status, "blocked");
});
t("merge: the worse of code and AI; a missing AI verdict is Check", () => {
  const c = checkSocialSeq("facebook", FB, inp);
  assert.equal(mergeSocial(c[0], parseSocialReview([{ step: "first", verdict: "blocked", reasons: ["invents a fact"] }])).status, "blocked");
  assert.equal(mergeSocial(c[0], []).status, "check");
  assert.equal(mergeSocial(c[0], parseSocialReview([{ step: "message", verdict: "ready", reasons: [] }])).status, "ready");
});
t("failure lines list the exact problems for the one retry", () => { assert.ok(socialFailureLines(checkSocialSeq("facebook", { ...FB, follow_up: "Hi. Can we book a call?" }, inp)).some((x) => /follow_up/.test(x))); });
console.log(`\n${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
