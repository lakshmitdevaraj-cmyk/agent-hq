import assert from "node:assert/strict";
import { socialSkipReason, socialTypeFor, partsFor, precheckSocial, limitsText } from "../../netlify/functions/lib/social";
import { SOCIAL_SYSTEM_PROMPT, SOCIAL_REVIEW_SYSTEM_PROMPT } from "../../netlify/functions/lib/prompts";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 160)); } };

const ctx = { location: "Webster, TX", query: "hvac", anyTrade: true };
const base = { name: "Acme Air", email: "info@acmeair.com", website: "https://acmeair.com", address: "1 Main St, Webster, TX 77598", site_check: { checked_at: "2026-11-20", via: "raw", needs_browser: false } };
const skip = (lead: Record<string, unknown>, o: { replied?: boolean; manualStart?: boolean } = {}) => socialSkipReason({ ...base, ...lead } as never, ctx, { replied: false, ...o });

t("HAVING AN EMAIL (even one already sent) is never a reason to skip", () => {
  assert.equal(skip({}), null);
  assert.equal(skip({ email: null }), null);
  assert.equal(skip({ email: "filler@godaddy.com" }), null, "a placeholder address does not matter for social");
});

t("replied, do-not-contact, excluded and not-a-fit stay skipped, with the reason", () => {
  assert.match(skip({}, { replied: true }) ?? "", /replied/i);
  assert.match(skip({ do_not_contact: true }) ?? "", /do not contact/i);
  assert.match(skip({ excluded: true }) ?? "", /exclud/i);
  assert.match(skip({ site_check: { ...base.site_check, lead_gen_listing: "keyword domain" } }) ?? "", /lead-gen/i);
  assert.match(skip({ site_check: { ...base.site_check, not_home_service: "rental" } }) ?? "", /home-service/i);
  assert.equal(skip({ site_check: { ...base.site_check, lead_gen_listing: "x" }, not_fit_kept: true }), null, "kept by me");
});

t("website check is required in bulk, but a hand-started Facebook first touch may skip it", () => {
  assert.match(skip({ site_check: null }) ?? "", /not checked/i);
  assert.equal(skip({ site_check: null }, { manualStart: true }), null);
  assert.match(skip({ site_check: { checked_at: "x", needs_browser: true, via: "raw" } }) ?? "", /browser/i);
  assert.equal(skip({ site_check: { checked_at: "x", needs_browser: true, via: "raw" } }, { manualStart: true }), null);
  // still blocked by flags, DNC and replies even when started by hand
  assert.match(skip({ do_not_contact: true, site_check: null }, { manualStart: true }) ?? "", /do not contact/i);
  assert.match(skip({ site_check: { lead_gen_listing: "kw" } }, { manualStart: true }) ?? "", /lead-gen/i);
  assert.match(skip({ site_check: null }, { manualStart: true, replied: true }) ?? "", /replied/i);
});

t("message type: first by default, follow-up only after a message on that channel or when picked", () => {
  assert.equal(socialTypeFor(undefined, false), "first");
  assert.equal(socialTypeFor("first", false), "first");
  assert.equal(socialTypeFor("follow_up_email", false), "follow_up_email");
  assert.equal(socialTypeFor(undefined, true), "follow_up_channel", "second message on a channel is a follow-up");
  assert.equal(socialTypeFor("first", true), "follow_up_channel");
  assert.equal(socialTypeFor("follow_up_email", true), "follow_up_email");
});

const fbOk = "Hi Mike, I help Webster plumbers keep jobs from slipping when the phone rings under a house. We set up an assistant that answers calls, takes the details and sends them to you. Would you be open to a 30-minute free call this week to see if it fits your crew and your busy season?";
const ck = (type: "first" | "follow_up_email" | "follow_up_channel", text: string) => precheckSocial("facebook", { message: text }, { factCount: 0, factUsed: null, type });

t("a standalone first message never mentions the email", () => {
  assert.deepEqual(ck("first", fbOk).filter((f) => /email/i.test(f)), []);
  const withEmail = fbOk.replace("Hi Mike, ", "Hi Mike, I sent you an email last week. ");
  assert.ok(ck("first", withEmail).some((f) => /email/i.test(f)), "must flag the email mention");
});

t('"Follow-up (mention my email)" refers to the email naturally and never says "following up"', () => {
  const fu = "Hi Mike, I sent a short email to your office last week about missed calls and wanted to say hello here too. We set up an assistant that answers calls, takes the details and sends them to you. Are you open to a 30-minute free call this week to see if it fits your crew?";
  assert.deepEqual(ck("follow_up_email", fu), []);
  assert.ok(ck("follow_up_email", fbOk).some((f) => /email/i.test(f)), "a follow-up that never mentions the email fails");
  assert.ok(ck("follow_up_email", fu.replace("wanted to say hello here too", "am following up")).some((f) => /following up|follow up/i.test(f)));
  assert.ok(ck("follow_up_channel", fbOk.replace("Hi Mike, ", "Hi Mike, just checking in. ")).some((f) => /checking in|following up/i.test(f)));
});

t("LinkedIn follow-up is the message only (no second connection note)", () => {
  assert.deepEqual(partsFor("linkedin", "first").map((p) => p.key), ["note", "dm"]);
  assert.deepEqual(partsFor("linkedin", "follow_up_channel").map((p) => p.key), ["dm"]);
  assert.deepEqual(partsFor("facebook", "follow_up_email").map((p) => p.key), ["message"]);
  assert.match(limitsText("linkedin", "follow_up_channel"), /^First message|^Message/);
});

t("writer and reviewer prompts explain the three message types", () => {
  assert.match(SOCIAL_SYSTEM_PROMPT, /TYPE/);
  assert.match(SOCIAL_SYSTEM_PROMPT, /follow_up_email/);
  assert.match(SOCIAL_REVIEW_SYSTEM_PROMPT, /MESSAGE_TYPE/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
