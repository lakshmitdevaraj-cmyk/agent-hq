/**
 * Free code checks for the "Alcance 3-step" email sequence and the social messages (batch 8c). Pure, no I/O.
 *
 * Written from the house principles, in our own words:
 *   - the first line is a true observation about them, not a cliché
 *   - the ask is a yes/no offer to send something free; no call, meeting or demo ask and no link before they reply
 *   - follow-ups are shorter and bring a new angle; the last message is a polite redirect
 *   - plain text: no dashes used as punctuation, no emoji, no placeholders, no hype, no flattery, no exclamation marks
 * Hard hits block a draft (status "blocked"); soft hits make it "check".
 */

export type Level = "hard" | "soft";
export type Hit = { id: string; level: Level; label: string; because: string; excerpt?: string };

type Rule = { id: string; level: Level; label: string; because: string; re: RegExp };

const R = (id: string, level: Level, label: string, because: string, re: RegExp): Rule => ({ id, level, label, because, re });

/** Phrases and marks that never belong in a cold message. */
export const BANNED: Rule[] = [
  R("cliche-opener", "hard", "Cliché opener", "An opener that fits any stranger proves nothing about them. Start with something true about this business.", /\b(?:caught my eye|(?:i )?(?:came across|stumbled (?:up)?on|ran across|found) (?:your|you)\b|hope (?:you(?:'|’)?re|you are) (?:doing )?(?:well|good|great)|hope this (?:email |message |note )?finds you)/i),
  R("quick-ask", "hard", "\"Quick question\" or \"quick chat/call\"", "Reads as a template. Ask the actual question.", /\bquick (?:question|chat|call|word|sync)\b/i),
  R("meeting-name", "hard", "Naming a meeting after its format", "\"Discovery call\" or \"let's connect\" announces a pitch. Offer something the reader receives instead.", /\b(?:discovery|intro(?:ductory)?|sales) call\b|\blet(?:'|’)?s (?:connect|hop on|jump on)\b/i),
  R("nudge", "hard", "A nudge with nothing new in it", "A follow-up must bring something new, not just poke.", /\b(?:just )?(?:following up|follow(?:ing)? up on|checking in|circling back|touching base|bumping this|resurfacing)\b/i),
  R("availability", "hard", "Asking when they are free", "Makes the reader do the scheduling work. A cold message does not ask for time at all.", /\bwhen (?:are|would) you (?:be )?(?:free|available)\b|\blet me know (?:a |what )?(?:good )?(?:time|works|your availability)\b|\bwhat(?:'|’)?s your availability\b/i),
  R("apology", "hard", "Apologising for writing", "Apologising hands the reader a reason to stop.", /\bsorry (?:to|for) (?:bother|bothering|interrupt|interrupting|the (?:random|cold|unsolicited))\b|\bapologi[sz]e for the (?:cold|random|unsolicited|intrusion)\b/i),
  R("design-compliment", "hard", "Compliment on their logo, branding or website design", "Judging their marketing is not an observation about their business.", /\b(?:love|like|admire|great|nice|beautiful|impressive|clean)\s+(?:your|the)\s+(?:new\s+)?(?:logo|brand(?:ing)?|web ?site(?: design)?|web design|site design)\b/i),
  R("hype", "hard", "Hype with nothing behind it", "Every claim needs a plain fact behind it.", /\b(?:cutting[- ]edge|game[- ]?chang\w*|skyrocket\w*|guaranteed (?:results|roi)|revolutioni[sz]\w*|world[- ]class|best[- ]in[- ]class|state[- ]of[- ]the[- ]art|supercharge\w*|no[- ]brainer|10x)\b/i),
  R("flattery", "hard", "Flattery", "Plain facts only; flattery reads as a template.", /\b(?:amazing|awesome|fantastic|incredible|stellar|outstanding|impressive|wonderful|phenomenal)\b/i),
  R("exclamation", "hard", "Exclamation mark", "Keep the tone flat and plain.", /!/),
  R("dash", "hard", "Dash used as punctuation", "Use a comma, a full stop or a colon.", /[—–]|\s-\s|--/),
  R("merge-field", "hard", "Unfilled placeholder", "A visible placeholder shows nobody wrote this.", /\{\{[^}]*\}\}|\[(?:first ?name|last ?name|name|business|company|city|owner)[^\]]*\]|\{(?:first ?name|last ?name|name|business|company|city|owner)\}|%(?:first ?name|name|business|company)%|<<[^>]*>>/i),
  R("html", "hard", "HTML in a plain-text message", "Plain text only.", /<\/?(?:a|b|i|u|p|br|div|span|img|table|ul|li|strong|em|h[1-6])(?:\s[^<>]*)?\/?>|&nbsp;/i),
  R("negated-pitch", "hard", "Saying what you are not doing", "\"Not selling\" makes the reader think of selling. Say what you are doing.", /\b(?:not (?:here )?(?:to )?(?:pitch|pitching|sell|selling|trying to sell)|no (?:sales )?pitch|this isn(?:'|’)?t a (?:sales )?pitch)\b/i),
  R("hedge", "hard", "Hedging", "Write flat and sure.", /\b(?:hope this isn(?:'|’)?t weird|worth (?:a |30 )?(?:seconds?|minute)|if you have a (?:sec|second|minute|moment))\b/i),
  R("ai-filler", "soft", "Template filler", "Filler that signals a template.", /\b(?:in today(?:'|’)?s (?:fast[- ]paced|digital)|delve into|leverage synerg\w+|it(?:'|’)?s worth noting)\b/i),
  R("emoji", "soft", "Emoji", "Wrong register for a first message and a spam signal.", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u),
  R("claimed-memory", "soft", "Claiming they said something", "Only true if they actually said it. Check this.", /\b(?:as you (?:mentioned|said|told me)|you told me|like you said|you mentioned (?:that|in))\b/i),
];

const excerpt = (text: string, m: RegExpExecArray): string => {
  const a = Math.max(0, m.index - 24), b = Math.min(text.length, m.index + m[0].length + 24);
  return `${a > 0 ? "…" : ""}${text.slice(a, b).trim()}${b < text.length ? "…" : ""}`;
};

/** Banned phrases and marks in one text. One hit per rule. */
export function scanBanned(text: string): Hit[] {
  const out: Hit[] = [];
  for (const r of BANNED) {
    const m = new RegExp(r.re.source, r.re.flags.replace("g", "")).exec(text);
    if (m) out.push({ id: r.id, level: r.level, label: r.label, because: r.because, excerpt: excerpt(text, m) });
  }
  return out;
}

// ── Structure checks ──────────────────────────────────────────────────

export type StepKind = "email1" | "email2" | "email3" | "social_first" | "social_follow_up" | "social_last" | "linkedin_note";

export type StepCtx = {
  channel?: "email" | "facebook" | "instagram" | "linkedin";
  /** Plain-text character counts of the earlier messages of this lead on this channel (for the "shorter than" rules). */
  earlierChars?: number[];
  /** True when an earlier message of this lead already stated the rating or review count. */
  ratingAlready?: boolean;
  /** Settings: free asset and proof line (an empty one makes the writer refuse rather than invent one). */
  freeAsset?: string;
  /** Figures the sender has put a named source behind in Settings (these demo and statistic figures may then be quoted). */
  namedSources?: string;
};

export const wordCount = (t: string): number => (t.trim().match(/\S+/g) ?? []).length;

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|us|app|site|biz|info)\b(?:\/\S*)?/i;
const ADDRESS_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const PHONE_RE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const CALL_ASK_RE = /\b(?:book|schedule|set up|hop on|jump on|grab|arrange|have|take|get on|do|fit in)\s+(?:a|an|some|\d+|\d+-minute|\d+ minutes?)\s+(?:quick |short |brief |free |discovery |intro |30-minute |15-minute )*(?:call|chat|demo|meeting|sync|zoom|walkthrough|conversation)\b|\b(?:30|15|20)[- ]?minute (?:free )?(?:call|chat|demo|meeting)\b|\b(?:free )?(?:call|demo|meeting) (?:with me|this week|next week|tomorrow)\b|\bcan we (?:talk|speak|chat|meet)\b|\bwould you (?:be )?(?:open|up) (?:to|for) a (?:call|chat|demo|meeting)\b/i;
const OFFER_RE = /\b(?:we set up|we build|i set up|i build|i built|i help|i can set up|ai (?:receptionist|assistant|agent|phone)|answering service|our (?:service|product|software)|virtual receptionist|shiftforge)\b/i;
const RATING_RE = /\b\d(?:\.\d)?\s*(?:stars?|\/\s*5|rating)\b|\b\d[\d,]*\s+(?:google\s+)?reviews?\b|★/i;
const CRITICISM_RE = /\byour (?:web ?site|site|page)\b[^.?!]{0,60}\b(?:is|looks|seems|feels|has)\b[^.?!]{0,30}\b(?:outdated|old|dated|bad|poor|slow|ugly|broken|confusing|clunky|lacking|weak|missing|terrible)\b|\b(?:your (?:web ?site|site)) (?:doesn(?:'|’)?t|does not|fails to|lacks)\b|\b(?:wrong|bad|poor|broken) with your (?:web ?site|site)\b/i;
// Figures that belong to a demo or to a chatbot's own statistics: never quoted as results unless a named source is saved in Settings.
const UNSOURCED_RE = /\bapex cooling\b|\+\s?38\s?%|\b38\s?%|\$\s?30\s?k\b|\$\s?45\s?k\b|\b27\s?%\s+of (?:all )?(?:calls|phone calls)\b|\$\s?81\.9\s?k\b|\b81\.9\s?k\b/i;
const ASSET_ASK_RE = /\b(?:want me to send|shall i send|would you like me to send|can i send|happy to send|want it|want to hear|want to see|should i send|ok if i send|okay if i send)\b/i;
const REDIRECT_RE = /\b(?:right person|someone else|who (?:else )?(?:handles|looks after|manages|should)|point me to|pass (?:this|it) (?:on|along))\b/i;
const LAST_RE = /\b(?:last (?:message|note|email|one)|won(?:'|’)?t (?:message|write|email|bother) (?:you )?again|closing (?:the|this) (?:file|loop)|close (?:the|this) (?:file|loop))\b/i;

const H = (id: string, level: Level, label: string, because: string): Hit => ({ id, level, label, because });

/** Words (not characters) allowed per social step; null = checked by characters instead. */
export const SOCIAL_WORD_LIMITS: Record<string, { min?: number; max: number }> = {
  facebook_first: { max: 85 }, instagram_first: { min: 25, max: 50 },
  facebook_follow_up: { max: 70 }, instagram_follow_up: { max: 50 }, linkedin_follow_up: { max: 80 },
  facebook_last: { max: 55 }, instagram_last: { max: 45 }, linkedin_last: { max: 60 }, linkedin_first: { max: 100 },
};

export function checkStep(kind: StepKind, text: string, ctx: StepCtx = {}): Hit[] {
  const hits: Hit[] = [...scanBanned(text)];
  const t = text.trim();
  if (!t) return [H("empty", "hard", "Empty message", "The writer returned nothing.")];
  const chars = t.length;
  const email = kind.startsWith("email");

  // Pre-reply: no link, no address, no phone number in any message.
  if (URL_RE.test(t) || ADDRESS_RE.test(t) || PHONE_RE.test(t)) hits.push(H("link-before-reply", "hard", "Link, address or number before they replied", "Nothing to click or call goes in before a reply; send it by hand after a yes."));
  // Pre-reply: never a call, meeting or demo ask.
  if (CALL_ASK_RE.test(t)) hits.push(H("call-ask", "hard", "A call, meeting or demo ask", "Before a reply the only ask is a yes or no to receive something free."));
  if (UNSOURCED_RE.test(t) && !(ctx.namedSources ?? "").trim()) hits.push(H("unsourced-figure", "hard", "A demo or statistic figure with no named source", "Demo figures and chatbot statistics are not results. Add a named source in Settings or leave them out."));
  if (CRITICISM_RE.test(t)) hits.push(H("site-criticism", "hard", "Criticises their website", "Describe the problem as lost calls or customers, not as something wrong with their site."));
  if ((t.match(/\?/g) ?? []).length > 1) hits.push(H("one-ask", "soft", "More than one question", "One ask only."));
  if (RATING_RE.test(t) && ctx.ratingAlready) hits.push(H("rating-twice", "soft", "Rating or review count repeated", "State the rating at most once across all of a lead's messages."));

  const earlierMin = (ctx.earlierChars ?? []).length ? Math.min(...(ctx.earlierChars ?? [])) : null;

  if (kind === "email1") {
    if (chars > 450) hits.push(H("too-long", "soft", `Email 1 is ${chars} characters`, "About 450 characters at most."));
    if (!ctx.freeAsset?.trim()) hits.push(H("no-asset", "soft", "No free asset in Settings", "Check this: add a free asset in Settings."));
    else if (!ASSET_ASK_RE.test(t)) hits.push(H("no-asset-ask", "soft", "No yes/no offer to send something", "Close by offering to send the free asset."));
    const you = (t.match(/\byou(?:r|rs)?\b/gi) ?? []).length, i = (t.match(/\b(?:i|i'm|i've|i'll|my)\b/gi) ?? []).length;
    if (i > you) hits.push(H("more-i-than-you", "soft", "More \"I\" than \"you\"", "Talk about them more than about you."));
  } else if (kind === "email2") {
    if (chars > 350) hits.push(H("too-long", "soft", `Email 2 is ${chars} characters`, "About 350 characters at most."));
    if (earlierMin !== null && chars >= earlierMin) hits.push(H("not-shorter", "soft", "Not shorter than email 1", "Each follow-up is shorter than the one before."));
    if (!ctx.freeAsset?.trim()) hits.push(H("no-asset", "soft", "No second free asset in Settings", "Check this: add a free asset in Settings."));
  } else if (kind === "email3") {
    if (chars > 320) hits.push(H("too-long", "soft", `Email 3 is ${chars} characters`, "About 320 characters at most."));
    if (earlierMin !== null && chars >= earlierMin) hits.push(H("not-shorter", "soft", "Not shorter than the earlier emails", "The last email is the shortest."));
    if (!REDIRECT_RE.test(t)) hits.push(H("no-redirect", "soft", "No \"who is the right person\" question", "Ask who else is the right person, and say declining is fine."));
    if (ASSET_ASK_RE.test(t)) hits.push(H("new-offer", "soft", "A new offer in the last email", "No new offer or argument in the last email."));
  } else if (kind === "linkedin_note") {
    if (chars > 200) hits.push(H("too-long", "hard", `Connection note is ${chars} characters`, "200 characters at most."));
    if (OFFER_RE.test(t) || ASSET_ASK_RE.test(t)) hits.push(H("pitch-in-note", "hard", "A pitch in the connection note", "Observation only."));
    if (/\bthank(?:s| you) for (?:accepting|connecting)\b/i.test(t)) hits.push(H("thanks-accepting", "hard", "Thanks for accepting", "The note is sent before they accept."));
  } else {
    const ch = ctx.channel ?? "facebook";
    const step = kind === "social_first" ? "first" : kind === "social_follow_up" ? "follow_up" : "last";
    const lim = SOCIAL_WORD_LIMITS[`${ch}_${step}`];
    const w = wordCount(t);
    if (lim) {
      if (w > lim.max) hits.push(H("too-long", "soft", `${w} words`, `At most ${lim.max} words on ${ch}.`));
      if (lim.min && w < lim.min) hits.push(H("too-short", "soft", `${w} words`, `At least ${lim.min} words on ${ch}.`));
    }
    if (kind === "social_first") {
      // First message: observation, one problem, an easy question. No offer, no proof, no service description, no asset.
      if (OFFER_RE.test(t) || ASSET_ASK_RE.test(t)) hits.push(H("pitch-in-first", "hard", "An offer or service description in the first message", "Observation, one problem and an easy question only."));
      if (!/\?/.test(t)) hits.push(H("no-question", "soft", "No closing question", "Close on one easy question."));
    } else if (kind === "social_follow_up") {
      if (earlierMin !== null && chars >= earlierMin) hits.push(H("not-shorter", "soft", "Not shorter than the first message", "The follow-up is shorter than the first message."));
      if (!ctx.freeAsset?.trim()) hits.push(H("no-asset", "soft", "No free asset in Settings", "Check this: add a free asset in Settings."));
      else if (!ASSET_ASK_RE.test(t)) hits.push(H("no-asset-ask", "soft", "No yes/no offer to send something", "Offer to send the free asset so that \"yes\" is the whole reply."));
    } else {
      if (!REDIRECT_RE.test(t)) hits.push(H("no-redirect", "soft", "No \"who is the right person\" question", "Ask who else is the right person."));
      if (!LAST_RE.test(t)) hits.push(H("not-last", "soft", "Does not say it is the last message", "Say plainly that this is the last message."));
    }
  }
  void email;
  return hits;
}

/** Subject line rules for email 1: fewer than 3 words, lowercase, plain, never a question, never Re:/Fwd:. Email 2 and 3 never carry a made-up "Re:". */
export function checkSubject(subject: string): Hit[] {
  const s = subject.trim();
  const hits: Hit[] = [];
  if (!s) return [H("empty-subject", "hard", "Empty subject", "Email 1 needs a subject.")];
  if (/^\s*(?:re|fwd?)\s*:/i.test(s)) hits.push(H("fake-re", "hard", "\"Re:\" or \"Fwd:\" in a subject", "Never fake a reply or a forward."));
  if (wordCount(s) >= 3) hits.push(H("subject-long", "hard", `Subject has ${wordCount(s)} words`, "Fewer than 3 words."));
  if (/[A-Z]/.test(s)) hits.push(H("subject-case", "hard", "Subject is not lowercase", "Lowercase, plain."));
  if (/\?/.test(s)) hits.push(H("subject-question", "hard", "Subject is a question", "Never a question."));
  if (/[!:;]|[\u{1F300}-\u{1FAFF}]/u.test(s)) hits.push(H("subject-marks", "hard", "Punctuation tricks in the subject", "Plain words only."));
  hits.push(...scanBanned(s).filter((h) => h.level === "hard" && h.id !== "dash"));
  return hits;
}

export type StepStatus = "ready" | "check" | "blocked";

/** Hard hits block the draft; soft hits make it "check". */
export function statusOf(hits: Hit[]): { status: StepStatus; reasons: string[] } {
  const hard = hits.filter((h) => h.level === "hard"), soft = hits.filter((h) => h.level === "soft");
  const line = (h: Hit) => `${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}. ${h.because}`.slice(0, 220);
  if (hard.length) return { status: "blocked", reasons: [...hard, ...soft].slice(0, 5).map(line) };
  if (soft.length) return { status: "check", reasons: soft.slice(0, 5).map(line) };
  return { status: "ready", reasons: [] };
}

/** Does this text state the rating or the review count? (for the once-per-lead rule) */
export const mentionsRating = (t: string): boolean => RATING_RE.test(t);
