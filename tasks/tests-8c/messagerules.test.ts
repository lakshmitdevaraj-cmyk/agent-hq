import assert from "node:assert/strict";
import { scanBanned, checkStep, checkSubject, statusOf, BANNED, tidySubject } from "../../netlify/functions/lib/messagerules";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 220)); } };
const ids = (s: string) => scanBanned(s).map((h) => h.id);
const has = (s: string, id: string) => assert.ok(ids(s).includes(id), `"${s}" should hit ${id}, got ${ids(s)}`);
const not = (s: string, id: string) => assert.ok(!ids(s).includes(id), `"${s}" should NOT hit ${id}`);

// ── every banned pattern: a hit and a near miss ────────────────────────
t("cliche opener: hit", () => { for (const s of ["That caught my eye.", "I came across your page", "Hope you're well.", "Hope this finds you well", "I stumbled upon your site"]) has(s, "cliche-opener"); });
t("cliche opener: near miss", () => { for (const s of ["You have 4.8 stars from 210 reviews.", "Your crews are across town.", "I hope the weather holds."]) not(s, "cliche-opener"); });
t("quick question / chat / call: hit and miss", () => { has("Quick question for you", "quick-ask"); has("a quick chat?", "quick-ask"); has("quick call", "quick-ask"); not("Questions come in quickly.", "quick-ask"); });
t("meeting named after its format: hit and miss", () => { has("a discovery call", "meeting-name"); has("Let's connect", "meeting-name"); not("I will connect the phone line.", "meeting-name"); });
t("nudges: hit and miss", () => { for (const s of ["just following up", "Checking in on this", "circling back", "touching base", "Following up on my note"]) has(s, "nudge"); not("The line is followed up by a tech.", "nudge"); });
t("asking when they are free: hit and miss", () => { has("When are you free?", "availability"); has("let me know a time", "availability"); not("Free to answer in one word?", "availability"); });
t("apology: hit and miss", () => { has("Sorry to bother you", "apology"); not("Sorry, wrong number? No, right one.", "apology"); });
t("design compliment: hit and miss", () => { has("I love your logo", "design-compliment"); has("Love the website design", "design-compliment"); not("Your website lists a phone number.", "design-compliment"); });
t("hype: hit and miss", () => { for (const s of ["cutting-edge", "a game-changer", "skyrocket your calls", "guaranteed results"]) has(s, "hype"); not("It answers the phone at night.", "hype"); });
t("flattery and exclamation marks: hit and miss", () => { has("Your reviews are amazing", "flattery"); has("Great news!", "exclamation"); not("Your rating is 4.8.", "flattery"); not("Calls go to voicemail.", "exclamation"); });
t("dashes as punctuation: hit and miss (a hyphen inside a word is fine)", () => { has("Calls — missed", "dash"); has("Calls – missed", "dash"); has("a - b", "dash"); not("a 30-minute window and follow-up", "dash"); });
t("placeholders: hit and miss", () => { for (const s of ["Hi {{first_name}}", "Hi [First Name]", "Hi {name}", "Hi %name%", "Hi <<name>>"]) has(s, "merge-field"); not("Hi Sam,", "merge-field"); });
t("HTML: hit and miss", () => { has("Hi<br>there", "html"); has("a&nbsp;b", "html"); not("5 < 6 and 7 > 3", "html"); });
t("negated pitch and hedging: hit and miss", () => { has("I'm not pitching anything", "negated-pitch"); has("no pitch, promise", "negated-pitch"); has("hope this isn't weird", "hedge"); not("I send recordings.", "negated-pitch"); });
t("template filler and emoji are SOFT", () => { assert.equal(scanBanned("in today's fast-paced world")[0].level, "soft"); assert.equal(scanBanned("hi 🙂")[0].level, "soft"); });
t("claiming they said something is SOFT (warn only)", () => { const h = scanBanned("As you mentioned, calls are slow"); assert.equal(h[0].id, "claimed-memory"); assert.equal(h[0].level, "soft"); });
t("every banned rule has a label and a reason", () => { for (const r of BANNED) { assert.ok(r.label && r.because && r.id); } });

// ── structure ──────────────────────────────────────────────────────────
const ASSET = "a 2-minute recording";
const E1 = "You have 4.8 stars from 210 Google reviews in Katy, and callers who reach voicemail tend to ring the next plumber. I help plumbers keep those calls. Want me to send a short recording of it answering a call for your business?";
t("email 1: a good one is ready", () => { const r = statusOf(checkStep("email1", E1, { freeAsset: ASSET })); assert.equal(r.status, "ready", JSON.stringify(r)); });
t("email 1: a link, an address or a phone number before a reply is BLOCKED", () => {
  for (const x of ["See shiftforge.ai", "Visit https://x.com", "write me@x.com", "call 713-555-0101"]) assert.equal(statusOf(checkStep("email1", E1 + " " + x, { freeAsset: ASSET })).status, "blocked", x);
});
t("email 1: a call, meeting or demo ask is BLOCKED", () => {
  for (const x of ["Can we book a call?", "Would you be open to a 30-minute free call?", "Let's schedule a demo", "a quick meeting this week"]) assert.equal(statusOf(checkStep("email1", E1 + " " + x, { freeAsset: ASSET })).status, "blocked", x);
});
t("email 1: over 450 characters is Check; no free asset set is Check with the Settings reason", () => {
  assert.equal(statusOf(checkStep("email1", E1 + " " + "x ".repeat(120), { freeAsset: ASSET })).status, "check");
  const r = statusOf(checkStep("email1", E1, {}));
  assert.equal(r.status, "check");
  assert.match(r.reasons.join(" "), /add a free asset in Settings/);
});
t("email 2 must be shorter than email 1 and carry the second asset; email 3 the shortest, asks who the right person is", () => {
  const e2 = "I wrote about missed calls last week. Another way to hear it: want me to send a number you can ring to try the assistant yourself?";
  assert.equal(statusOf(checkStep("email2", e2, { freeAsset: "a number", earlierChars: [E1.length] })).status, "ready");
  assert.equal(statusOf(checkStep("email2", E1, { freeAsset: "a number", earlierChars: [E1.length] })).status, "check");
  const e3 = "Is there someone else who looks after the phones? Fine to say no.";
  assert.equal(statusOf(checkStep("email3", e3, { earlierChars: [E1.length, e2.length] })).status, "ready");
  assert.equal(statusOf(checkStep("email3", "Fine to say no.", { earlierChars: [E1.length, e2.length] })).status, "check");
});
t("the demo and statistic figures are blocked unless Settings names a source", () => {
  for (const x of ["Apex Cooling saw +38% more bookings.", "About 27% of calls go unanswered.", "That is $81.9K a year."]) {
    assert.equal(statusOf(checkStep("email1", E1 + " " + x, { freeAsset: ASSET })).status, "blocked", x);
    assert.notEqual(statusOf(checkStep("email1", E1 + " " + x, { freeAsset: ASSET, namedSources: "Our 2026 call audit" })).status, "blocked", x + " with a source");
  }
});
t("rating repeated across messages is Check; criticising the website is BLOCKED", () => {
  assert.equal(statusOf(checkStep("email2", "You have 4.8 stars. Want me to send a number?", { freeAsset: "n", ratingAlready: true, earlierChars: [999] })).status, "check");
  assert.equal(statusOf(checkStep("email1", "Your website looks outdated and slow. Want me to send a recording?", { freeAsset: ASSET })).status, "blocked");
});
t("subject: under 3 words, lowercase, not a question, never Re:/Fwd:", () => {
  assert.deepEqual(checkSubject("missed calls"), []);
  assert.deepEqual(checkSubject("katy plumbing"), []);
  for (const s of ["Re: calls", "fwd: calls", "missed calls katy", "Missed calls", "calls?", "quick question", ""]) assert.ok(checkSubject(s).length > 0, s);
});
t("social first: no offer, service, asset or link; a question is needed; Instagram is 25-50 words", () => {
  const fb = "Hi there, I saw Katy Air has 4.8 stars from 210 reviews. When the phone rings after hours and nobody picks up, do those callers just try the next company?";
  assert.equal(statusOf(checkStep("social_first", fb, { channel: "facebook" })).status, "ready");
  assert.equal(statusOf(checkStep("social_first", fb + " I help companies with an AI receptionist.", { channel: "facebook" })).status, "blocked");
  assert.equal(statusOf(checkStep("social_first", fb + " Want me to send a recording?", { channel: "facebook" })).status, "blocked");
  assert.equal(statusOf(checkStep("social_first", "Hi, Katy Air has 4.8 stars. Do callers hang up on voicemail?", { channel: "instagram" })).status, "check"); // under 25 words
  const ig = "Katy Air has 4.8 stars from 210 reviews, which is rare. When a call comes in after hours and nobody answers, do those people just ring the next company on the list? Curious how often it happens.";
  assert.ok(!checkStep("social_first", ig, { channel: "instagram" }).some((h) => h.id === "too-long"));
});
t("social follow-up: shorter than the first, offers the free asset as a yes/no, no link; last: redirect and says it is the last message", () => {
  const first = "x ".repeat(60);
  assert.equal(statusOf(checkStep("social_follow_up", "I wrote about missed calls. Want me to send a short recording of it answering for you?", { channel: "facebook", freeAsset: ASSET, earlierChars: [first.length] })).status, "ready");
  assert.equal(statusOf(checkStep("social_follow_up", "I wrote about missed calls.", { channel: "facebook", freeAsset: ASSET, earlierChars: [first.length] })).status, "check");
  assert.equal(statusOf(checkStep("social_last", "Last message from me. Is someone else the right person for this? A simple no is fine.", { channel: "facebook" })).status, "ready");
  assert.equal(statusOf(checkStep("social_last", "Just a note.", { channel: "facebook" })).status, "check");
});
t("LinkedIn note: max 200 characters, observation only", () => {
  assert.equal(statusOf(checkStep("linkedin_note", "Saw Katy Air has 210 reviews at 4.8 stars.", { channel: "linkedin" })).status, "ready");
  assert.equal(statusOf(checkStep("linkedin_note", "x".repeat(201), { channel: "linkedin" })).status, "blocked");
  assert.equal(statusOf(checkStep("linkedin_note", "I help plumbers with an AI receptionist.", { channel: "linkedin" })).status, "blocked");
  assert.equal(statusOf(checkStep("linkedin_note", "Thanks for accepting.", { channel: "linkedin" })).status, "blocked");
});
t("an empty message is blocked", () => assert.equal(statusOf(checkStep("email1", "  ", { freeAsset: ASSET })).status, "blocked"));

t("subject repair: lowercase, first two words, no Re:/question mark", () => {
  assert.equal(tidySubject("Katy Plumbing Calls"), "katy plumbing");
  assert.equal(tidySubject("Re: Missed calls?"), "missed calls");
  assert.deepEqual(checkSubject(tidySubject("Katy Plumbing Calls")), []);
});
t("asks to send a free thing in several natural wordings; talking about their website is a soft Check", () => {
  for (const x of ["Would you like a 2-minute recording of it?", "Want me to send a number?", "Happy to send a sample.", "Should I send the recording?"]) assert.equal(statusOf(checkStep("email1", "You have 4.8 stars from 210 reviews. I help plumbers keep calls. " + x, { freeAsset: "a" })).reasons.join().includes("yes/no offer"), false, x);
  assert.ok(checkStep("email2", "Your contact form is slow. Want me to send a number?", { freeAsset: "a" }).some((h) => h.id === "mentions-site" && h.level === "soft"));
});

t("praise of the rating is flattery", () => { for (const x of ["a great 4.8 rating", "which is great to see", "a solid rating", "an impressive record"]) has(x, "flattery"); not("has a 4.8 rating from 210 reviews", "flattery"); });

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
