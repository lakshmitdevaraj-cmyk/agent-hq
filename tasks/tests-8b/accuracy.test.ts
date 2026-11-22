import assert from "node:assert/strict";
import fs from "node:fs";
import { websiteFacts } from "../../netlify/functions/lib/sitecheck";
import { pickAngle, checkModelDraft, copiedFrom } from "../../netlify/functions/lib/angle";
import { precheckSocial } from "../../netlify/functions/lib/social";
import { SOCIAL_SYSTEM_PROMPT, SOCIAL_REVIEW_SYSTEM_PROMPT, EXAMPLE_BODIES } from "../../netlify/functions/lib/prompts";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 160)); } };
const page = (head: string, body = "<p>Call us at (281) 555-0142 for service.</p>") => [{ url: "https://x.com/", html: `<html><head>${head}</head><body>${body}</body></html>` }];
const mobile = (head: string, jsBuilt = false, via: "raw" | "browser" = "raw") => websiteFacts(page(head), { via, jsBuilt }).find((f) => f.key === "not_mobile_friendly")!;

t("mobile: a viewport tag without a fixed width is mobile-friendly (width=device-width, initial-scale=1 only, Duda style)", () => {
  assert.equal(mobile('<meta name="viewport" content="width=device-width, initial-scale=1">').value, false);
  assert.equal(mobile('<meta name="viewport" content="initial-scale=1">').value, false, "initial-scale=1 without width=device-width IS mobile friendly");
  assert.equal(mobile('<meta name="viewport" content="initial-scale=1, minimum-scale=1, maximum-scale=5">').value, false, "Duda");
  assert.equal(mobile('<meta content="width=device-width, initial-scale=1" name="viewport">').value, false, "attribute order");
  assert.equal(mobile("<meta name='viewport' content='width=device-width'>").value, false, "single quotes");
  assert.equal(mobile("<meta name=viewport content=width=device-width,initial-scale=1>").value, false, "unquoted attributes (minified pages)");
});

t("mobile: not friendly only with no viewport tag or a fixed width", () => {
  assert.equal(mobile("<title>x</title>").value, true, "no viewport");
  assert.equal(mobile('<meta name="viewport" content="width=980">').value, true, "fixed width");
  assert.equal(mobile('<meta name="viewport" content="width=1024, initial-scale=1">').value, true, "fixed width with scale");
});

t("mobile: a JavaScript-built site seen only by a plain download is 'unknown', not 'not friendly'", () => {
  assert.equal(mobile("<title>x</title>", true, "raw").value, "unknown");
  assert.equal(mobile('<meta name="viewport" content="initial-scale=1">', true, "browser").value, false);
});

const lead = (facts: unknown[]) => ({ name: "Tri City Air", rating: 4.8, reviews_count: 60, site_check: { checked_at: "2026-11-20", via: "browser", chat_widget: true, facts } }) as never;
t("phone_not_tappable is information only: not offered to the writer unless the page switches off number links", () => {
  const plain = websiteFacts(page("<title>x</title>"), { via: "raw", jsBuilt: false }).find((f) => f.key === "phone_not_tappable")!;
  assert.equal(plain.value, true);
  assert.notEqual((plain as { no_autolink?: boolean }).no_autolink, true);
  const noMeta = pickAngle(lead([plain]));
  assert.ok(!noMeta.facts.some((f) => /tap-to-call/i.test(f.text)), "must not use the fact without no_autolink");
  const off = websiteFacts(page('<meta name="format-detection" content="telephone=no">'), { via: "raw", jsBuilt: false }).find((f) => f.key === "phone_not_tappable")!;
  assert.equal((off as { no_autolink?: boolean }).no_autolink, true);
  const withMeta = pickAngle(lead([off]));
  assert.ok(withMeta.facts.some((f) => /tap-to-call/i.test(f.text)), "offered when the page switches off number links");
});

const body = (extra: string) => `Hi Mike,\n\n${extra}\n\nIf calls get missed while the crew is on a job, an assistant can answer them, take the details and pass them to you. Open to a 30-minute free call?`;
t('"a busy service schedule" no longer trips the scheduling check; the assistant scheduling still does', () => {
  const ok = checkModelDraft({ subject: "Calls while you work", body: body("With a busy service schedule, I would guess the phone rings while you are under a house."), fact_used: null } as never, 0, {});
  assert.ok(!ok.some((f) => /scheduling/.test(f)), ok.join(" | "));
  const bad = checkModelDraft({ subject: "Calls while you work", body: body("Our assistant schedules appointments for you."), fact_used: null } as never, 0, {});
  assert.ok(bad.some((f) => /scheduling/.test(f)), "assistant scheduling must still be caught");
});

t("sameness / copying: the offer's plain service description does not count as copying", () => {
  const offer = "We set up AI assistants that answer calls and website messages for home-service businesses, take the details and pass every enquiry to the owner.";
  const email = "I run ShiftForge AI. The assistant answers calls and website messages, takes the details and sends them straight to you, so nothing is lost when the crew is out.";
  assert.equal(copiedFrom(email, [offer, ...EXAMPLE_BODIES]), null);
  const offer2 = "ShiftForge AI sets up an assistant that answers calls and website messages, takes the details and sends them straight to you, so you never lose a job.";
  const email3 = "Hi Mike, the assistant answers calls and website messages, takes the details and sends them straight to you, so nothing is lost while the crew is out. Open to a 30-minute free call?";
  assert.equal(copiedFrom(email3, [offer2]), null, "the offer's core phrase is not copying");
  const email2 = "The assistant answers calls and website messages, takes the details and passes them to the owner, so nothing is lost.";
  assert.equal(copiedFrom(email2, [offer]), null);
  // Real copying is still caught.
  assert.ok(copiedFrom(EXAMPLE_BODIES[0], EXAMPLE_BODIES), "a verbatim example is still copying");
  assert.ok(copiedFrom("Our team has served the Houston area for years and we treat every customer like a neighbor who deserves honest prices and quick help.", ["Our team has served the Houston area for years and we treat every customer like a neighbor who deserves honest prices and quick help."]));
});

t("the social reviewer gets the same offer text as the email reviewer", () => {
  const src = fs.readFileSync("netlify/functions/command.ts", "utf8");
  const emailCall = /aiJson\("review",\s*\{[^}]*SENDER_OFFER/.test(src);
  const socialCall = /SOCIAL_REVIEW_SYSTEM_PROMPT,\s*user:\s*JSON\.stringify\(\{[^}]*SENDER_OFFER/.test(src);
  assert.ok(emailCall, "email reviewer receives SENDER_OFFER");
  assert.ok(socialCall, "social reviewer receives SENDER_OFFER");
  assert.ok(!/chat only/i.test(SOCIAL_REVIEW_SYSTEM_PROMPT));
  assert.match(SOCIAL_REVIEW_SYSTEM_PROMPT, /phone calls/i);
  assert.match(SOCIAL_REVIEW_SYSTEM_PROMPT, /SENDER_OFFER/);
});

t('a LinkedIn connection note never says "Thanks for accepting"', () => {
  const fails = (note: string) => precheckSocial("linkedin", { note, dm: "Hi Mike, I run ShiftForge AI. An assistant answers your calls and sends you the details. Open to a 30-minute free call this week to see if it fits your crew and your busy season?" }, { factCount: 0, factUsed: null }).filter((f) => /note/i.test(f));
  assert.ok(fails("Thanks for accepting my request, Mike!").length > 0);
  assert.ok(fails("Thank you for connecting, Mike.").length > 0);
  assert.ok(fails("Glad we're connected, Mike.").length > 0);
  assert.equal(fails("Hi Mike, I work with home-service owners in Webster and would like to connect.").length, 0);
  assert.match(SOCIAL_SYSTEM_PROMPT, /never write "thanks for accepting"/i);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
