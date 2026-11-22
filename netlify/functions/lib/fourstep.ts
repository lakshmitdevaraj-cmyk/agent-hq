/**
 * The "Alcance 4-step" email framework (batch 8c): defaults, prompts and pure helpers. No I/O.
 *
 * One model call per lead writes all four emails at once. Sending stays manual, one step at a time; emails 2 to 4 go as replies under email 1.
 *   email 1 (day 0):  a true observation about them, what I do for their kind of business, one honest supporting fact,
 *                     and a yes/no offer to send something free
 *   email 2 (day 3):  a clause pointing back at email 1, a new angle, a DIFFERENT free thing as a yes/no offer
 *   email 3 (day 8):  short proof (the Settings proof line, close to its own words) and a yes/no offer
 *   email 4 (day 15): the last email: who is the right person, says it is the last, a no is fine
 * Each email is shorter than the one before. The days come from Settings.
 */
import { checkStep, checkSubject, statusOf, mentionsRating, tidySubject, type Hit, type StepStatus } from "./messagerules";

export const DEFAULT_ASSET_1 = "a 2-minute recording of an AI receptionist answering a call for [business name]: taking the job details and booking it";
export const DEFAULT_ASSET_2 = "a phone number you can call to hear the assistant yourself";
export const DEFAULT_PROOF = "I use the same assistant on my own home-services website, where it answers business owners' questions about missed calls.";
export const DEFAULT_GAPS = [3, 8, 15];

export type StepInputs = { freeAsset1: string; freeAsset2: string; proofLine: string; namedSources: string };

type SettingsLike = { free_asset_1?: string; free_asset_2?: string; proof_line?: string; named_sources?: string };

/** A field never saved gets the default; one the user cleared stays empty (the writer then refuses rather than inventing one). */
export function resolveInputs(s: SettingsLike, businessName: string): StepInputs {
  const sub = (t: string) => t.replace(/\[business name\]/gi, businessName || "your business");
  return {
    freeAsset1: sub(s.free_asset_1 ?? DEFAULT_ASSET_1).trim(),
    freeAsset2: sub(s.free_asset_2 ?? DEFAULT_ASSET_2).trim(),
    proofLine: (s.proof_line ?? DEFAULT_PROOF).trim(),
    namedSources: (s.named_sources ?? "").trim(),
  };
}

/** Follow-up gaps in days after the first message: "3, 8, 15" or an array -> [3, 8, 15]. Invalid input gives the defaults. */
export function parseGaps(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/).filter(Boolean) : [];
  const nums = arr.map((x) => Number(x));
  if (nums.length === 0 || nums.some((x) => !Number.isInteger(x) || x < 1 || x > 120)) return [...DEFAULT_GAPS];
  return nums;
}

// ── Prompts (our own wording) ─────────────────────────────────────────

export const SEQUENCE_SYSTEM_PROMPT = `You write a four-email cold sequence from Lakshmi Devaraj (ShiftForge AI) to the owner or office of a local home-service business in the US. Each email is plain text, one person writing to one other person, in plain English a teenager could follow. "I" is Lakshmi.

You are given: BUSINESS, GREETING, CITY, TRADE, TRUE DETAILS ABOUT THEM (numbered, saved from their own site or Google), FACTS YOU MAY USE (numbered; nothing else may be claimed about them), HOW THE ASSISTANT WORKS (background), FREE THING 1, FREE THING 2 and PROOF LINE.

Write all four at once and answer with JSON only:
{"subject": "...", "email_1": "...", "email_2": "...", "email_3": "...", "email_4": "...", "fact_used": <number of the fact used, or null>}

EMAIL 1 (sent on day 0; about 400 characters at most)
- Start with the GREETING you are given and a comma, then a new line.
- First sentence: one specific true thing about THEM that the reader could check in a minute. Take it from TRUE DETAILS or FACTS only. State a rating plainly if you use one, with no praise.
- Then say what you do, in first person, in the shape "I help <their kind of business> <one concrete outcome>". The outcome is about calls they would otherwise lose.
- NO proof line and no sentence about where or how the assistant is used: the proof belongs in email 3 only. Never say "my business" or "my company": the sender does not run one. Never invent a client, a result or a number.
- Close with one yes/no question offering to send FREE THING 1. Never ask for a call, a meeting, a demo or any time.
- After the first sentence, use "you" and "your" more than "I" (the one "I help ..." sentence is not counted). No links, no email addresses, no phone numbers.

EMAIL 2 (sent on day 3; shorter than email 1, aim for about 280 characters and never above 340)
- Greeting, then open with one short clause that points back at email 1 (for example "I wrote to you earlier about missed calls."), without repeating what it said.
- The same help seen from a new angle (a different moment in their day when a call is lost; do not repeat a fact from email 1, and do not state their rating again).
- Close with one yes/no question offering FREE THING 2, which is different from FREE THING 1.

EMAIL 3 (sent on day 8; shorter than email 2, aim for about 220 characters and never above 290)
- Greeting, then ONE short proof sentence taken from the PROOF LINE in words very close to it (never "my business"; if the PROOF LINE is empty, skip the proof and say one plain true thing about calls instead).
- Close with a short yes/no re-offer of FREE THING 1 in NEW words, for example "Do you still want the recording?" or "Should I still send that recording?". Do NOT copy any sentence from email 1: not the proof, not the offer. Never describe the recording again in the same words.
- No new argument.

EMAIL 4 (sent on day 15; the shortest, aim for about 160 characters and never above 230)
- Greeting, then say plainly that this is your last email.
- Ask who else is the right person for new customer calls, and say that a no is fine.
- No offer, no proof and no new argument.

SUBJECT: one or two lowercase words, plain, never a question, never starting with "re" or "fwd". It is used for email 1 only; emails 2 to 4 go as replies in the same thread.

WRITING RULES FOR ALL FOUR
- No dashes as punctuation (use commas, full stops or colons), no exclamation marks, no emoji, no brackets, no placeholders.
- No flattery and no compliments on their logo, branding or website. You may state a plain fact about their contact form, chat or booking only if it is in TRUE DETAILS, and never judge or criticise it; prefer describing the problem as calls or customers lost.
- Never say "following up", "checking in", "circling back", "touching base", "quick question", "quick chat", "hope you are well", "caught my eye", "came across", "let's connect" or "discovery call".
- Never mention that you are not selling or not pitching. Never apologise for writing.
- Never quote any figure that is not in TRUE DETAILS or FACTS. Do not mention demo businesses or industry statistics.
- Say nothing about the assistant that HOW THE ASSISTANT WORKS does not say. It answers calls and website messages, takes the details and passes them on. It does not text, dispatch, quote or take payments.
- No signature, no company line, no website, no opt-out line: those are added when the email is sent.
- Separate short paragraphs with a blank line.`;

export const FOUR_STEP_REVIEW_PROMPT = `You check four cold emails written for ShiftForge AI (sender: Lakshmi Devaraj) before a person sends them. You get one LEAD with SAVED_EVIDENCE (the only things we know about the business), the four emails, and CODE_FINDINGS (problems a program already found).

For each email answer with a verdict:
- "ready": nothing to fix.
- "check": a person should look (thin evidence, awkward wording).
- "blocked": a claim about the business that SAVED_EVIDENCE does not support, a result or client that is invented, a claim that the sender runs a business of their own (the assistant was built on the sender's own website), or a wrong owner name in the greeting.

SENDER_SETTINGS holds the sender's own proof line and two free things. The proof line is TRUE and allowed to be quoted or closely paraphrased, even though it says the assistant was built on the sender's own website (that is not a claim that the sender runs a business) and even if it mentions a call. The proof line belongs in email 3 only; email 1 must not carry it. A free thing that is a recording or a number to ring to hear the assistant is the free offer itself, not a request for a call or meeting with the sender.

Email 4 is meant to ask who the right person is for new customer calls; that is not a request for a call or meeting and is no reason for "check".

Do NOT judge these: the program checks them. Whether an email ends with a yes/no offer, its length, the balance of I and you, its style words, whether it says it is the last email, and whether the proof matches the Settings proof line. Never mention them in a reason. A plain factual mention of their contact form, chat or booking that SAVED_EVIDENCE supports is allowed and is no reason for "check"; only criticism of it is.

Look only for: unsupported claims about the business, invented facts, numbers, clients or results, a wrong greeting, a claim that someone said something they did not, pushy or odd wording, a call, meeting or demo ask, and the rating or review count repeated across emails.

Answer with a JSON array, one object per email: [{"step": 1, "verdict": "ready" | "check" | "blocked", "reasons": ["short plain sentence", ...]}, ...]. At most 4 reasons per email, each under 20 words.`;

export type SequenceLead = {
  name?: string; greeting: string; city: string; trade: string;
  details: string[]; facts: Array<{ n: number; text: string }>;
};

/** The user message for the writer. */
export function sequenceUserPrompt(l: SequenceLead, inp: StepInputs, offerBackground: string, hint?: string): string {
  return [
    `BUSINESS: ${l.name ?? "the business"}`,
    `GREETING: ${l.greeting}`,
    `CITY: ${l.city || "(unknown)"}`,
    `TRADE: ${l.trade}`,
    l.details.length ? `TRUE DETAILS ABOUT THEM:\n${l.details.map((d, i) => `${i + 1}. ${d}`).join("\n")}` : "TRUE DETAILS ABOUT THEM:\n(none saved)",
    l.facts.length ? `FACTS YOU MAY USE:\n${l.facts.map((f) => `${f.n}. ${f.text}`).join("\n")}` : "FACTS YOU MAY USE:\n(none: open with a true detail, or the town and trade, and claim nothing else about them)",
    `HOW THE ASSISTANT WORKS (background, rewrite in your own words): ${offerBackground}`,
    `FREE THING 1 (offer it in email 1; email 3 re-offers it in new words): ${inp.freeAsset1 || "(empty)"}`,
    `FREE THING 2 (offer it in email 2): ${inp.freeAsset2 || "(empty)"}`,
    `PROOF LINE: ${inp.proofLine || "(empty)"}`,
    hint ? `\nYOUR LAST ANSWER FAILED THESE CHECKS: ${hint}\nWrite all four again and fix them. JSON only.` : "",
  ].filter(Boolean).join("\n");
}

export type SeqStep = { step: 1 | 2 | 3 | 4; subject: string; body: string };

/** Reads the writer's JSON. Email 2 and 3 carry email 1's subject: they go out as real replies, so no new subject (and never a fake "Re:") is written. */
export function parseSequence(json: unknown): { steps: SeqStep[]; fact_used: number | null } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const s = (k: string) => String(o[k] ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  const subject = tidySubject(s("subject"));
  const e1 = s("email_1") || s("email1"), e2 = s("email_2") || s("email2"), e3 = s("email_3") || s("email3"), e4 = s("email_4") || s("email4");
  if (!e1 || !e2 || !e3 || !e4) return null;
  const fu = typeof o.fact_used === "number" && Number.isInteger(o.fact_used) ? o.fact_used : null;
  return { steps: [{ step: 1, subject, body: e1 }, { step: 2, subject, body: e2 }, { step: 3, subject, body: e3 }, { step: 4, subject, body: e4 }], fact_used: fu };
}

export type StepCheck = { step: 1 | 2 | 3 | 4; status: StepStatus; reasons: string[]; hits: Hit[] };

/** The free code checks for all four emails together (length order, one rating, subject, Settings inputs). */
export function checkSequence(steps: SeqStep[], inp: StepInputs): StepCheck[] {
  const kinds = ["email1", "email2", "email3", "email4"] as const;
  const lens: number[] = [];
  let ratingSeen = false;
  return steps.map((s, i) => {
    const hits = checkStep(kinds[i], s.body, { channel: "email", earlierChars: lens.slice(), ratingAlready: ratingSeen, freeAsset: i === 1 ? inp.freeAsset2 : inp.freeAsset1, proofLine: inp.proofLine, earlierTexts: steps.slice(0, i).map((x) => x.body), namedSources: inp.namedSources });
    if (i === 0) hits.push(...checkSubject(s.subject));
    lens.push(s.body.length);
    if (mentionsRating(s.body)) ratingSeen = true;
    return { step: s.step, ...statusOf(hits), hits };
  });
}

/** Failure lines for the one rewrite request: every HARD hit plus the soft ones that name a length or structure problem. */
export function failureLines(checks: StepCheck[]): string[] {
  return checks.flatMap((c) => c.hits.filter((h) => h.level === "hard" || /too-long|not-shorter|no-redirect|not-last|no-asset|proof-drift/.test(h.id)).map((h) => `email ${c.step}: ${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}`));
}

export type AiStepVerdict = { step: number; verdict: StepStatus; reasons: string[] };

/** Reads the reviewer's JSON array. Anything unreadable is "check" for that step. */
export function parseReview(json: unknown): AiStepVerdict[] {
  const arr = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { steps?: unknown }).steps) ? (json as { steps: unknown[] }).steps : [];
  return arr.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const v = o.verdict === "ready" || o.verdict === "blocked" ? o.verdict : "check";
    return { step: Number(o.step), verdict: v as StepStatus, reasons: Array.isArray(o.reasons) ? o.reasons.map((r) => String(r).slice(0, 200)).slice(0, 4) : [] };
  }).filter((v) => v.step >= 1 && v.step <= 4);
}

const RANK: Record<StepStatus, number> = { ready: 0, check: 1, blocked: 2 };

/** The final status of one step: the worse of the code checks and the AI reviewer (a missing AI verdict counts as "check"). */
export function mergeStatus(code: StepCheck, ai: AiStepVerdict | undefined): { status: StepStatus; reasons: string[] } {
  const a0 = ai ?? { step: code.step, verdict: "check" as StepStatus, reasons: ["The AI reviewer did not answer for this email"] };
  // Whether an email ends with a yes/no offer is a CODE check. If the code found the offer, an AI remark about it is dropped; an AI "check" that rested only on such remarks becomes "ready".
  const offerOk = !code.hits.some((h) => h.id === "no-asset" || h.id === "no-asset-ask");
  const OFFER_TALK = /yes\/no|offer|free (?:asset|thing)|recording|ask(?:s|ing)? (?:for )?(?:a )?(?:yes|no)|closing question|does not end/i;
  const kept = offerOk ? a0.reasons.filter((r) => !OFFER_TALK.test(r)) : a0.reasons;
  const a = a0.verdict === "check" && offerOk && a0.reasons.length > 0 && kept.length === 0 ? { ...a0, verdict: "ready" as StepStatus, reasons: [] } : { ...a0, reasons: kept };
  const status = RANK[a.verdict] > RANK[code.status] ? a.verdict : code.status;
  const reasons = status === "ready" ? [] : [...code.reasons, ...(a.verdict === "ready" ? [] : a.reasons)].slice(0, 5);
  return { status, reasons };
}
