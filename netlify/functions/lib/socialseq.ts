// Social sequences (Facebook, Instagram, LinkedIn): every step of a channel written in ONE call, checked by code per step, then one AI review.
// Own prompt wording. The shared structure rules live in messagerules.ts. Pure helpers only.
import { checkStep, statusOf, mentionsRating, type Hit, type StepKind, type StepStatus } from "./messagerules";
import type { SocialChannel, SocialPartKey } from "./social";
import type { StepInputs } from "./threestep";

export const SEQ_KEYS: Record<SocialChannel, SocialPartKey[]> = {
  facebook: ["message", "follow_up", "last"],
  instagram: ["message", "follow_up", "last"],
  linkedin: ["note", "dm", "follow_up", "last"],
};

/** The JSON key the writer uses for each step. */
export const WRITER_KEY: Record<SocialPartKey, string> = { note: "connection_note", message: "first", dm: "first", follow_up: "follow_up", last: "last" };

const kindOf = (k: SocialPartKey): StepKind => (k === "note" ? "linkedin_note" : k === "follow_up" ? "social_follow_up" : k === "last" ? "social_last" : "social_first");

export const SOCIAL_SEQ_SYSTEM_PROMPT = `You write a short run of direct messages from Lakshmi Devaraj (ShiftForge AI) to the owner of a local home-service business in the US, for one channel (Facebook, Instagram or LinkedIn). She copies and sends each one by hand on a different day. Plain English a teenager could follow. "I" is Lakshmi. Messages are casual and short, like a person typing on a phone.

You are given: CHANNEL, BUSINESS, GREETING, CITY, TRADE, TRUE DETAILS (saved from their own pages), FACTS YOU MAY USE (numbered; nothing else may be claimed about them), FREE THING (what the follow-up offers), PROOF LINE (one supporting line, may be empty), HOW THE ASSISTANT WORKS (background only).

Answer with JSON only. Keys depend on the channel:
- facebook and instagram: {"first": "...", "follow_up": "...", "last": "...", "fact_used": <fact number or null>}
- linkedin: {"connection_note": "...", "first": "...", "follow_up": "...", "last": "...", "fact_used": <fact number or null>}

CONNECTION NOTE (linkedin only; 200 characters at most, hard limit)
- One true thing you noticed about their business and why you are adding them. It goes out BEFORE they accept: no pitch, no offer, no thanks for accepting, no question about a call.

FIRST MESSAGE
- Start with the GREETING and a comma (Facebook: use "Hi there" unless the GREETING names the owner).
- One specific true observation about them from TRUE DETAILS or FACTS. If you state a rating, state it plainly with no praise.
- Then ONE problem that is common for businesses like theirs, about calls or customers they lose when nobody picks up.
- End on one easy question that takes one word to answer. Do not describe what you sell, do not offer anything, do not mention a call or a meeting, no link.
- Length: Facebook up to about 80 words; Instagram 25 to 50 words; LinkedIn under 100 words.

FOLLOW-UP (shorter than the first message)
- Greeting, then one clause that points back to your earlier message without repeating it. Never write "following up", "checking in" or "circling back".
- ONE supporting line from PROOF LINE in your own words (skip it if the PROOF LINE is empty). Never invent a client, a result or a number.
- Close with one yes/no question offering FREE THING. No call, no meeting, no link.
- Do not state their rating again.

LAST MESSAGE (the shortest)
- Say plainly that this is your last message. Ask who the right person is for new customer calls, and say that a simple no is fine. Give them an easy way out in one or two words. No new offer, no new argument, no link.

For all messages: no emoji, no exclamation marks, no dashes used as punctuation, no hype, no flattery, no apology, no sign-off or signature, no merge fields. Never say anything about their website. Never claim they said anything to you.`;

export const SOCIAL_SEQ_REVIEW_PROMPT = `You check a run of direct messages written for ShiftForge AI (sender: Lakshmi Devaraj) before a person sends them one by one. You get CHANNEL, SAVED_EVIDENCE (the only things we know about the business), the messages with their step keys, and CODE_FINDINGS (problems a program already found).
For each message answer "ready", "check" or "blocked":
- blocked: states something about the business that is not in SAVED_EVIDENCE; claims they said or did something; pitches in the connection note or first message; asks for a call, meeting or demo; contains a link, address or phone number.
- check: reads like a template; the first message does not end on an easy question; the follow-up does not offer the free thing as a yes/no; the last message does not say it is the last; a message repeats the rating; wrong greeting; sounds pushy or odd.
- ready: none of the above.
Answer JSON only: an array of {"step": "<the step key given>", "verdict": "ready|check|blocked", "reasons": ["short reason in plain words"]}. Reasons only when the verdict is not ready.`;

export type SeqLeadInfo = { name?: string; greeting: string; city: string; trade: string; details: string[]; facts: Array<{ n: number; text: string }> };

export function socialSeqUserPrompt(channel: SocialChannel, l: SeqLeadInfo, inp: StepInputs, offerBackground: string, hint?: string): string {
  return [
    `CHANNEL: ${channel}`,
    `BUSINESS: ${l.name ?? "the business"}`,
    `GREETING: ${l.greeting}`,
    `CITY: ${l.city || "(unknown)"}`,
    `TRADE: ${l.trade}`,
    l.details.length ? `TRUE DETAILS ABOUT THEM:\n${l.details.map((d, i) => `${i + 1}. ${d}`).join("\n")}` : "TRUE DETAILS ABOUT THEM:\n(none saved)",
    l.facts.length ? `FACTS YOU MAY USE:\n${l.facts.map((f) => `${f.n}. ${f.text}`).join("\n")}` : "FACTS YOU MAY USE:\n(none: claim nothing about their business)",
    `HOW THE ASSISTANT WORKS (background, rewrite in your own words): ${offerBackground}`,
    `FREE THING (offered in the follow-up): ${inp.freeAsset1 || "(empty)"}`,
    `PROOF LINE: ${inp.proofLine || "(empty)"}`,
    hint ? `\nYOUR LAST ANSWER FAILED THESE CHECKS: ${hint}\nWrite all of them again and fix them. JSON only.` : "",
  ].filter(Boolean).join("\n");
}

/** Reads the writer's JSON into { part key: text }. Null when a step is missing. */
export function parseSocialSeq(channel: SocialChannel, json: unknown): { texts: Record<string, string>; fact_used: number | null } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const clean = (v: unknown) => String(v ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  const texts: Record<string, string> = {};
  for (const k of SEQ_KEYS[channel]) {
    const t = clean(o[WRITER_KEY[k]]);
    if (!t) return null;
    texts[k] = t;
  }
  const fu = typeof o.fact_used === "number" && Number.isInteger(o.fact_used) ? o.fact_used : null;
  return { texts, fact_used: fu };
}

export type SocialStepCheck = { key: SocialPartKey; status: StepStatus; reasons: string[]; hits: Hit[] };

/** Free code checks for every step of one channel (hard hit = blocked, soft = check). */
export function checkSocialSeq(channel: SocialChannel, texts: Record<string, string>, inp: StepInputs): SocialStepCheck[] {
  const out: SocialStepCheck[] = [];
  const lens: number[] = [];
  let ratingSeen = false;
  for (const k of SEQ_KEYS[channel]) {
    const text = texts[k] ?? "";
    const hits = checkStep(kindOf(k), text, { channel, earlierChars: k === "follow_up" || k === "last" ? lens.slice() : [], ratingAlready: ratingSeen, freeAsset: k === "follow_up" ? inp.freeAsset1 : undefined, namedSources: inp.namedSources });
    if (k !== "note") lens.push(text.length);
    if (mentionsRating(text)) ratingSeen = true;
    out.push({ key: k, ...statusOf(hits), hits });
  }
  return out;
}

export function socialFailureLines(checks: SocialStepCheck[]): string[] {
  return checks.flatMap((c) => c.hits.filter((h) => h.level === "hard" || /too-long|too-short|not-shorter|no-redirect|not-last|no-asset-ask/.test(h.id)).map((h) => `${WRITER_KEY[c.key]}: ${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}`));
}

export type SocialVerdict = { key: string; verdict: StepStatus; reasons: string[] };

export function parseSocialReview(json: unknown): SocialVerdict[] {
  const arr = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { steps?: unknown }).steps) ? (json as { steps: unknown[] }).steps : [];
  return arr.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const v = o.verdict === "ready" || o.verdict === "blocked" ? o.verdict : "check";
    return { key: String(o.step ?? ""), verdict: v as StepStatus, reasons: Array.isArray(o.reasons) ? o.reasons.map((r) => String(r).slice(0, 200)).slice(0, 4) : [] };
  }).filter((v) => v.key);
}

const RANK: Record<StepStatus, number> = { ready: 0, check: 1, blocked: 2 };

/** The worse of the code checks and the AI verdict for one step. A step the AI did not answer for counts as "check". The AI step key may be the part key or the writer key. */
export function mergeSocial(code: SocialStepCheck, ai: SocialVerdict[]): { status: StepStatus; reasons: string[] } {
  const v = ai.find((x) => x.key === code.key || x.key === WRITER_KEY[code.key]) ?? { key: code.key, verdict: "check" as StepStatus, reasons: ["The AI reviewer did not answer for this message"] };
  const status = RANK[v.verdict] > RANK[code.status] ? v.verdict : code.status;
  return { status, reasons: [...code.reasons, ...(v.verdict === "ready" ? [] : v.reasons)].slice(0, 5) };
}
