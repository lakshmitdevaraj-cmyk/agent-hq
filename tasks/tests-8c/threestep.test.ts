import assert from "node:assert/strict";
import { resolveInputs, parseGaps, parseSequence, checkSequence, mergeStatus, parseReview, DEFAULT_ASSET_1, DEFAULT_PROOF, sequenceUserPrompt, SEQUENCE_SYSTEM_PROMPT } from "../../netlify/functions/lib/threestep";
import { buildFooter, appendFooter } from "../../netlify/functions/lib/outreach";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 220)); } };

const GOOD = {
  subject: "missed calls",
  email_1: "Hi Sam,\n\nKaty Air Pros has 4.8 stars from 210 Google reviews, and callers who hit voicemail often ring the next company. I help AC companies keep those calls. Want me to send a 2-minute recording of an AI receptionist answering for your business?",
  email_2: "Hi Sam,\n\nI wrote about missed calls earlier. Another way to hear it: want me to send a number you can ring to try the assistant?",
  email_3: "Hi Sam,\n\nIs someone else the right person for this? A no is fine.",
};

t("Settings defaults: the three asset/proof defaults are used when nothing is saved; [business name] is filled in", () => {
  const r = resolveInputs({}, "Katy Air Pros");
  assert.match(r.freeAsset1, /answering a call for Katy Air Pros/);
  assert.match(r.freeAsset2, /phone number you can call/);
  assert.equal(r.proofLine, DEFAULT_PROOF);
  assert.ok(!/\.(?:com|ai)\b/.test(r.proofLine), "proof line has no domain");
  assert.equal(DEFAULT_ASSET_1.includes("[business name]"), true);
});
t("a cleared field stays empty (so the writer refuses instead of inventing)", () => {
  const r = resolveInputs({ free_asset_1: "", free_asset_2: "  " }, "X");
  assert.equal(r.freeAsset1, "");
  assert.equal(r.freeAsset2, "");
});
t("follow-up gaps: default 3, 8, 15; text or numbers accepted; nonsense falls back", () => {
  assert.deepEqual(parseGaps(undefined), [3, 8, 15]);
  assert.deepEqual(parseGaps("2, 6, 12"), [2, 6, 12]);
  assert.deepEqual(parseGaps([4, 9]), [4, 9]);
  assert.deepEqual(parseGaps("a,b"), [3, 8, 15]);
  assert.deepEqual(parseGaps("0,5"), [3, 8, 15]);
});
t("sequence JSON: all three emails are read; emails 2 and 3 carry email 1's subject (no new subject, never a fake Re:)", () => {
  const s = parseSequence(GOOD)!;
  assert.equal(s.steps.length, 3);
  assert.equal(s.steps[1].subject, "missed calls");
  assert.ok(!s.steps.some((x) => /^re:/i.test(x.subject)));
  assert.equal(parseSequence({ ...GOOD, email_3: "" }), null);
  assert.equal(parseSequence(null), null);
});
t("a good sequence: every email is Ready", () => {
  const checks = checkSequence(parseSequence(GOOD)!.steps, resolveInputs({}, "Katy Air Pros"));
  assert.deepEqual(checks.map((c) => c.status), ["ready", "ready", "ready"], JSON.stringify(checks.map((c) => c.reasons)));
});
t("each email has its own status: a call ask in email 3 blocks only email 3", () => {
  const bad = { ...GOOD, email_3: "Hi Sam,\n\nCan we book a call? Or is someone else the right person?" };
  const checks = checkSequence(parseSequence(bad)!.steps, resolveInputs({}, "X"));
  assert.deepEqual(checks.map((c) => c.status), ["ready", "ready", "blocked"]);
});
t("email 2 longer than email 1 gets Check; the rating stated in email 2 as well gets Check", () => {
  const long2 = { ...GOOD, email_2: GOOD.email_1.replace("Want me to send a 2-minute recording", "Want me to send a phone number").replace("Katy Air Pros has", "You have") + " It matters." };
  const c = checkSequence(parseSequence(long2)!.steps, resolveInputs({}, "X"));
  assert.notEqual(c[1].status, "ready");
});
t("empty Settings: a cleared free asset makes email 1 and 2 'Check this: add a free asset in Settings' (nothing invented)", () => {
  const c = checkSequence(parseSequence(GOOD)!.steps, resolveInputs({ free_asset_1: "", free_asset_2: "" }, "X"));
  assert.equal(c[0].status, "check");
  assert.match(c[0].reasons.join(" "), /add a free asset in Settings/);
  assert.equal(c[1].status, "check");
});
t("the writer prompt carries the empty marker, the proof line and both free things; no web address is asked for", () => {
  const p = sequenceUserPrompt({ name: "Katy Air", greeting: "Hi there", city: "Katy", trade: "HVAC", details: ["4.8 stars from 210 reviews"], facts: [] }, resolveInputs({ free_asset_1: "" }, "Katy Air"), "answers calls");
  assert.match(p, /FREE THING 1 \(offer it in email 1\): \(empty\)/);
  assert.match(p, /PROOF LINE: I built the assistant/);
  assert.match(p, /FREE THING 2/);
  assert.match(SEQUENCE_SYSTEM_PROMPT, /Never ask for a call/);
});
t("AI reviewer: the worse of code and AI wins; a missing AI answer is Check", () => {
  const checks = checkSequence(parseSequence(GOOD)!.steps, resolveInputs({}, "X"));
  const ai = parseReview([{ step: 1, verdict: "blocked", reasons: ["invented client"] }, { step: 2, verdict: "ready", reasons: [] }]);
  assert.equal(mergeStatus(checks[0], ai.find((a) => a.step === 1)).status, "blocked");
  assert.equal(mergeStatus(checks[1], ai.find((a) => a.step === 2)).status, "ready");
  assert.equal(mergeStatus(checks[2], ai.find((a) => a.step === 3)).status, "check");
  assert.deepEqual(parseReview("garbage"), []);
});

// ── footer ────────────────────────────────────────────────────────────
t("footer: no website link in text or html; keeps signature line, opt-out line and the postal address when set", () => {
  const f = buildFooter("1 Main St, Austin TX", "Lakshmi Devaraj");
  assert.ok(!/https?:\/\/|shiftforge\.ai|<a /i.test(f.text + f.html), f.text);
  assert.match(f.text, /Lakshmi Devaraj, ShiftForge AI/);
  assert.match(f.text, /just reply "no thanks"/);
  assert.match(f.text, /1 Main St/);
  assert.ok(!/1 Main/.test(buildFooter("", "Lakshmi Devaraj").text));
  const full = appendFooter("Hi Sam,\n\nbody", "<p>body</p>", "", "Lakshmi Devaraj");
  assert.ok(!/https?:\/\//.test(full.text + full.html));
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
