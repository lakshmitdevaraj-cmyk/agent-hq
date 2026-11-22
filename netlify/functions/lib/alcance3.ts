/**
 * The "Alcance 3-step" email framework (batch 8c): defaults, prompts and pure helpers. No I/O.
 *
 * One model call per lead writes all three emails at once. Sending stays manual, one step at a time.
 *   email 1: a true observation about them, what I do for their kind of business, one honest supporting fact,
 *            and a yes/no offer to send something free
 *   email 2: a clause pointing back at email 1, the same offer from a new angle, a DIFFERENT free thing
 *   email 3: the shortest; who else is the right person, and permission to say no
 */
import { checkStep, checkSubject, statusOf, mentionsRating, type Hit, type StepStatus } from "./messagerules";

export const DEFAULT_ASSET_1 = "a 2-minute recording of an AI receptionist answering a call for [business name]: taking the job details and booking it";
export const DEFAULT_ASSET_2 = "a phone number you can call to hear the assistant yourself";
export const DEFAULT_PROOF = "I built the assistant on my own home-services website that answers owners' questions about missed calls and books a discussion call";
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

export const SEQUENCE_SYSTEM_PROMPT = `You write a three-email cold sequence from Lakshmi Devaraj (ShiftForge AI) to the owner or office of a local home-service business in the US. Each email is plain text, one person writing to one other person, in plain English a teenager could follow. "I" is Lakshmi.

You are given: BUSINESS, GREETING, CITY, TRADE, TRUE DETAILS ABOUT THEM (numbered, saved from their own site or Google), FACTS YOU MAY USE (numbered; nothing else may be claimed about them), HOW THE ASSISTANT WORKS (background), FREE THING 1, FREE THING 2 and PROOF LINE.

Write all three at once and answer with JSON only:
{"subject": "...", "email_1": "...", "email_2": "...", "email_3": "...", "fact_used": <number of the fact used, or null>}

EMAIL 1 (about 400 characters at most)
- Start with the GREETING you are given and a comma, then a new line.
- First sentence: one specific true thing about THEM that the reader could check in a minute. Take it from TRUE DETAILS or FACTS only. State a rating plainly if you use one, with no praise.
- Then say what you do, in first person, in the shape "I help <their kind of business> <one concrete outcome>". The outcome is about calls they would otherwise lose.
- Then ONE supporting line. If PROOF LINE is given, use it in your own words (no web address). If it is empty, skip this line. Never invent a client, a result or a number.
- Close with one yes/no question offering to send FREE THING 1. Never ask for a call, a meeting, a demo or any time.
- Use "you" more than "I". No links, no email addresses, no phone numbers.

EMAIL 2 (shorter than email 1)
- Greeting, then one clause that points back at email 1 without repeating it.
- The same help seen from a different angle (a different moment in their day when a call is lost; do not repeat a fact from email 1, and do not state their rating again).
- Close with one yes/no question offering FREE THING 2, which is different from FREE THING 1.

EMAIL 3 (the shortest of the three)
- Greeting, then ask who else is the right person for this, and say plainly that a no is fine.
- No new argument, no proof and no offer.

SUBJECT: one or two lowercase words, plain, never a question, never starting with "re" or "fwd". It is used for email 1 only.

WRITING RULES FOR ALL THREE
- No dashes as punctuation (use commas, full stops or colons), no exclamation marks, no emoji, no brackets, no placeholders.
- No flattery and no compliments on their logo, branding or website. Never criticise their website: describe the problem as calls or customers lost, never as something wrong with their site.
- Never say "following up", "checking in", "circling back", "touching base", "quick question", "quick chat", "hope you are well", "caught my eye", "came across", "let's connect" or "discovery call".
- Never mention that you are not selling or not pitching. Never apologise for writing.
- Never quote any figure that is not in TRUE DETAILS or FACTS. Do not mention demo businesses or industry statistics.
- Say nothing about the assistant that HOW THE ASSISTANT WORKS does not say. It answers calls and website messages, takes the details and passes them on. It does not text, dispatch, quote or take payments.
- No signature, no company line, no website, no opt-out line: those are added when the email is sent.
- Separate short paragraphs with a blank line.`;

export const SEQUENCE_REVIEW_PROMPT = `You check three cold emails written for ShiftForge AI (sender: Lakshmi Devaraj) before a person sends them. You get one LEAD with SAVED_EVIDENCE (the only things we know about the business), the three emails, and CODE_FINDINGS (problems a program already found).

For each email answer with a verdict:
- "ready": nothing to fix.
- "check": a person should look (thin evidence, awkward wording, the structure rule below is bent).
- "blocked": a claim about the business that SAVED_EVIDENCE does not support, a result or client that is invented, or a wrong owner name in the greeting.

STRUCTURE RULES
Email 1: first sentence is a specific true observation about this business that SAVED_EVIDENCE supports; then what Lakshmi does in first person; at most one supporting line that is true; it ends with one yes/no offer to send something free. No call, meeting or demo ask. No link.
Email 2: points back at email 1 in one clause, shows the same help from a new angle, offers a different free thing, and is shorter than email 1.
Email 3: the shortest; asks who else is the right person; says a no is fine; no new offer or argument.
All: one ask per email; no flattery; nothing negative about their website (the problem is lost calls); no invented facts, numbers, clients or results; the rating or review count appears at most once across the three.

Answer with a JSON array, one object per email: [{"step": 1, "verdict": "ready" | "check" | "blocked", "reasons": ["short plain sentence", ...]}, ...]. At most 4 reasons per email, each under 20 words. Do not comment on length or on style words: the program checks those.`;

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
    `FREE THING 1 (offer it in email 1): ${inp.freeAsset1 || "(empty)"}`,
    `FREE THING 2 (offer it in email 2): ${inp.freeAsset2 || "(empty)"}`,
    `PROOF LINE: ${inp.proofLine || "(empty)"}`,
    hint ? `\nYOUR LAST ANSWER FAILED THESE CHECKS: ${hint}\nWrite all three again and fix them. JSON only.` : "",
  ].filter(Boolean).join("\n");
}

export type SeqStep = { step: 1 | 2 | 3; subject: string; body: string };

/** Reads the writer's JSON. Email 2 and 3 carry email 1's subject: they go out as real replies, so no new subject (and never a fake "Re:") is written. */
export function parseSequence(json: unknown): { steps: SeqStep[]; fact_used: number | null } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const s = (k: string) => String(o[k] ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  const subject = s("subject").replace(/\s+/g, " ");
  const e1 = s("email_1") || s("email1"), e2 = s("email_2") || s("email2"), e3 = s("email_3") || s("email3");
  if (!e1 || !e2 || !e3) return null;
  const fu = typeof o.fact_used === "number" && Number.isInteger(o.fact_used) ? o.fact_used : null;
  return { steps: [{ step: 1, subject, body: e1 }, { step: 2, subject, body: e2 }, { step: 3, subject, body: e3 }], fact_used: fu };
}

export type StepCheck = { step: 1 | 2 | 3; status: StepStatus; reasons: string[]; hits: Hit[] };

/** The free code checks for all three emails together (length order, one rating, subject, Settings inputs). */
export function checkSequence(steps: SeqStep[], inp: StepInputs): StepCheck[] {
  const kinds = ["email1", "email2", "email3"] as const;
  const lens: number[] = [];
  let ratingSeen = false;
  return steps.map((s, i) => {
    const hits = checkStep(kinds[i], s.body, { channel: "email", earlierChars: lens.slice(), ratingAlready: ratingSeen, freeAsset: i === 0 ? inp.freeAsset1 : inp.freeAsset2, namedSources: inp.namedSources });
    if (i === 0) hits.push(...checkSubject(s.subject));
    lens.push(s.body.length);
    if (mentionsRating(s.body)) ratingSeen = true;
    return { step: s.step, ...statusOf(hits), hits };
  });
}

/** Failure lines for the one rewrite request: every HARD hit plus the soft ones that name a length or structure problem. */
export function failureLines(checks: StepCheck[]): string[] {
  return checks.flatMap((c) => c.hits.filter((h) => h.level === "hard" || /too-long|not-shorter|no-redirect|no-asset/.test(h.id)).map((h) => `email ${c.step}: ${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}`));
}

export type AiStepVerdict = { step: number; verdict: StepStatus; reasons: string[] };

/** Reads the reviewer's JSON array. Anything unreadable is "check" for that step. */
export function parseReview(json: unknown): AiStepVerdict[] {
  const arr = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { steps?: unknown }).steps) ? (json as { steps: unknown[] }).steps : [];
  return arr.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const v = o.verdict === "ready" || o.verdict === "blocked" ? o.verdict : "check";
    return { step: Number(o.step), verdict: v as StepStatus, reasons: Array.isArray(o.reasons) ? o.reasons.map((r) => String(r).slice(0, 200)).slice(0, 4) : [] };
  }).filter((v) => v.step >= 1 && v.step <= 3);
}

const RANK: Record<StepStatus, number> = { ready: 0, check: 1, blocked: 2 };

/** The final status of one step: the worse of the code checks and the AI reviewer (a missing AI verdict counts as "check"). */
export function mergeStatus(code: StepCheck, ai: AiStepVerdict | undefined): { status: StepStatus; reasons: string[] } {
  const a = ai ?? { step: code.step, verdict: "check" as StepStatus, reasons: ["The AI reviewer did not answer for this email"] };
  const status = RANK[a.verdict] > RANK[code.status] ? a.verdict : code.status;
  const reasons = [...code.reasons, ...(a.verdict === "ready" ? [] : a.reasons)].slice(0, 5);
  return { status, reasons };
}
