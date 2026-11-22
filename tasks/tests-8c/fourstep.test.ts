import assert from "node:assert/strict";
import { resolveInputs, parseGaps, parseSequence, checkSequence, mergeStatus, parseReview, DEFAULT_ASSET_1, DEFAULT_PROOF, sequenceUserPrompt, SEQUENCE_SYSTEM_PROMPT } from "../../netlify/functions/lib/fourstep";
import { buildFooter, appendFooter } from "../../netlify/functions/lib/outreach";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 220)); } };

const GOOD = {
  subject: "missed calls",
  email_1: "Hi Sam,\n\nKaty Air Pros has 4.8 stars from 210 Google reviews, and callers who hit voicemail often ring the next company. I help AC companies keep those calls. Want me to send a 2-minute recording of an AI receptionist answering for your business?",
  email_2: "Hi Sam,\n\nI wrote to you about missed calls earlier. Another way to see it: a customer rings at dinner time, gets no answer and books someone else. Want me to send a phone number you can ring to try the assistant?",
  email_3: "Hi Sam,\n\nI built an assistant for my agency's website that answers home-service owners' questions about missed calls and books a discussion call. Do you still want the recording?",
  email_4: "Hi Sam,\n\nThis is my last email. Who is the right person for new customer calls? A no is fine.",
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
t("sequence JSON: all four emails are read; emails 2 to 4 carry email 1's subject (no new subject, never a fake Re:)", () => {
  const s = parseSequence(GOOD)!;
  assert.equal(s.steps.length, 4);
  assert.equal(s.steps[1].subject, "missed calls");
  assert.ok(!s.steps.some((x) => /^re:/i.test(x.subject)));
  assert.equal(parseSequence({ ...GOOD, email_4: "" }), null);
  assert.equal(parseSequence(null), null);
});
t("a good sequence: every email is Ready", () => {
  const checks = checkSequence(parseSequence(GOOD)!.steps, resolveInputs({}, "Katy Air Pros"));
  assert.deepEqual(checks.map((c) => c.status), ["ready", "ready", "ready", "ready"], JSON.stringify(checks.map((c) => c.reasons)));
});
t("each email has its own status: a call ask in email 4 blocks only email 4", () => {
  const bad = { ...GOOD, email_4: "Hi Sam,\n\nCan we book a call? Or is someone else the right person?" };
  const checks = checkSequence(parseSequence(bad)!.steps, resolveInputs({}, "X"));
  assert.deepEqual(checks.map((c) => c.status), ["ready", "ready", "ready", "blocked"]);
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
  assert.match(p, /FREE THING 1 \(offer it in email 1/);
  assert.match(p, /PROOF LINE: I built an assistant for my agency's website/);
  assert.match(p, /FREE THING 2/);
  assert.match(SEQUENCE_SYSTEM_PROMPT, /Never ask for a call/);
});
t("proof line: 'my business' / 'my home-services business' is blocked; a proof sentence close to the Settings line is Ready; a drifted one gets Check", () => {
  const inp = resolveInputs({}, "X");
  for (const bad of ["I built this assistant for my own home-services business that answers calls.", "I run my business and built an assistant that answers calls."]) {
    const c = checkSequence(parseSequence({ ...GOOD, email_3: `Hi Sam,\n\n${bad} Want me to send a recording?` })!.steps, inp);
    assert.equal(c[2].status, "blocked", bad);
  }
  assert.equal(checkSequence(parseSequence(GOOD)!.steps, inp)[2].status, "ready");
  const drift = checkSequence(parseSequence({ ...GOOD, email_3: "Hi Sam,\n\nI built a tool that many shops like. Want me to send a recording?" })!.steps, inp);
  assert.notEqual(drift[2].status, "ready");
});
t("proof line must be copied: 'my own website' or a missing 'agency' is Check; the exact line is Ready", () => {
  const inp = resolveInputs({}, "X");
  for (const drift of ["I built an assistant for my own website that answers home-service owners' questions about missed calls and books a discussion call.", "I use an assistant on my own website that answers questions from home-service owners about missed calls and books a discussion.", "I built an assistant for my website that answers home-service owners' questions about missed calls and books a discussion call."]) {
    const c = checkSequence(parseSequence({ ...GOOD, email_3: `Hi Sam,\n\n${drift} Do you still want the recording?` })!.steps, inp);
    assert.equal(c[2].status, "check", drift);
  }
  assert.equal(checkSequence(parseSequence(GOOD)!.steps, inp)[2].status, "ready");
});
t("a greeting line is always followed by one blank line", () => {
  const s = parseSequence({ ...GOOD, email_2: "Hi Sam,\nI wrote earlier about missed calls." })!;
  assert.equal(s.steps[1].body, "Hi Sam,\n\nI wrote earlier about missed calls.");
  assert.equal(s.steps[0].body, GOOD.email_1);
});
t("offer check is code: email 3 without a yes/no offer is Check, with one is Ready; an AI 'no offer' remark is dropped when the code found the offer", () => {
  const inp = resolveInputs({}, "X");
  const noOffer = checkSequence(parseSequence({ ...GOOD, email_3: "Hi Sam,\n\nI built an assistant on my own website that answers owners' questions about missed calls." })!.steps, inp);
  assert.notEqual(noOffer[2].status, "ready");
  const checks = checkSequence(parseSequence(GOOD)!.steps, inp);
  const m = mergeStatus(checks[0], { step: 1, verdict: "check", reasons: ["No yes/no offer of the free asset"] });
  assert.equal(m.status, "ready");
  assert.equal(mergeStatus(checks[0], { step: 1, verdict: "blocked", reasons: ["invented client"] }).status, "blocked");
});
t("a plain mention of their contact form is allowed; criticising it is still blocked", () => {
  const inp = resolveInputs({}, "X");
  const ok = checkSequence(parseSequence({ ...GOOD, email_1: GOOD.email_1.replace("and callers", "and your site has a contact form; callers") })!.steps, inp);
  assert.equal(ok[0].status, "ready", JSON.stringify(ok[0].reasons));
  const bad = checkSequence(parseSequence({ ...GOOD, email_1: GOOD.email_1.replace("and callers", "and your contact form is slow; callers") })!.steps, inp);
  assert.equal(bad[0].status, "blocked");
});
t("email 3 must not repeat a sentence of email 1; the same proof line in email 1 is a Check; asking for a 'discussion call' is blocked (the proof line's own 'books a discussion call' is not an ask)", () => {
  const inp = resolveInputs({}, "X");
  const rep = checkSequence(parseSequence({ ...GOOD, email_3: "Hi Sam,\n\nI built an assistant for my agency's website that answers home-service owners' questions about missed calls and books a discussion call. Want me to send a 2-minute recording of an AI receptionist answering for your business?" })!.steps, inp);
  assert.ok(rep[2].hits.some((h) => h.id === "repeats-earlier"), JSON.stringify(rep[2].reasons));
  assert.notEqual(rep[2].status, "ready");
  const e1proof = checkSequence(parseSequence({ ...GOOD, email_1: GOOD.email_1.replace("I help AC companies keep those calls.", "I built an assistant for my agency's website that answers home-service owners' questions about missed calls and books a discussion call.") })!.steps, inp);
  assert.ok(e1proof[0].hits.some((h) => h.id === "proof-in-email1"));
  const dc = checkSequence(parseSequence({ ...GOOD, email_3: "Hi Sam,\n\nI built the assistant on my own website. Can we have a discussion call? Do you still want the recording?" })!.steps, inp);
  assert.equal(dc[2].status, "blocked");
});
t("a Ready email never lists reasons; a listed reason means Check or Blocked", () => {
  const inp = resolveInputs({}, "X");
  const checks = checkSequence(parseSequence(GOOD)!.steps, inp);
  const m = mergeStatus(checks[0], { step: 1, verdict: "ready", reasons: ["leftover remark"] });
  assert.equal(m.status, "ready"); assert.deepEqual(m.reasons, []);
  const bad = checkSequence(parseSequence({ ...GOOD, email_2: GOOD.email_2 + " ".repeat(5) + "x".repeat(200) })!.steps, inp);
  const mb = mergeStatus(bad[1], { step: 2, verdict: "ready", reasons: [] });
  assert.notEqual(mb.status, "ready"); assert.ok(mb.reasons.length > 0);
});
t("AI reviewer: the worse of code and AI wins; a missing AI answer is Check", () => {
  const checks = checkSequence(parseSequence(GOOD)!.steps, resolveInputs({}, "X"));
  const ai = parseReview([{ step: 1, verdict: "blocked", reasons: ["invented client"] }, { step: 2, verdict: "ready", reasons: [] }]);
  assert.equal(mergeStatus(checks[0], ai.find((a) => a.step === 1)).status, "blocked");
  assert.equal(mergeStatus(checks[1], ai.find((a) => a.step === 2)).status, "ready");
  assert.equal(mergeStatus(checks[2], ai.find((a) => a.step === 3)).status, "check");
  assert.equal(mergeStatus(checks[3], ai.find((a) => a.step === 4)).status, "check");
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
