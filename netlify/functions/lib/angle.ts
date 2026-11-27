/**
 * Decides, in code (not in the model), what a first cold email is about:
 * the ONE fact we are confident about and the angle that fits it. Also the
 * cheap code-side checks run on every model answer before the AI reviewer.
 * Pure functions, no network.
 */
import { leadHours, type Detail } from "./sitecheck";

export type Fact = { n: number; text: string; evidence: string };
export type AngleCode = "after_hours" | "instant_answers" | "missed_calls" | "phone_only" | "general";
export type Angle = { code: AngleCode; line: string };
export type AnglePlan = { angle: Angle; facts: Fact[]; uncertain: string | null; /** The email must talk about phone calls only (the site already has chat or booking, or the angle says so). */ calls_only?: boolean; /** The site says 24/7 / any time: never talk about after hours, closed, evenings or weekends. */ no_hours?: boolean };

export type LeadFacts = {
  rating?: number | null;
  reviews_count?: number | null;
  raw?: unknown;
  site_check?: {
    error?: string;
    via?: string;
    chat_widget?: string | null;
    booking_tool?: string | null;
    has_contact_form?: boolean;
    /** null = looked and none found; a name = a JavaScript form plugin is on the site; undefined = a check saved before this was recorded. */
    form_plugin?: string | null;
    request_form?: boolean;
    hours_usable?: boolean;
    advertises_emergency?: boolean;
    mentions_24_7?: boolean;
    whatsapp_url?: string | null;
    hours_evidence?: string | null;
    needs_browser?: boolean;
    facts?: Array<{ key: string; value: boolean | "unknown"; evidence: { url: string; text: string }; no_autolink?: boolean }>;
    evidence?: Record<string, string>;
    not_home_service?: string | null;
    lead_gen_listing?: string | null;
    real_trade?: string | null;
    site_hours?: unknown;
    details?: Detail[];
  } | null;
  name?: string | null;
};

const ANGLES: Record<AngleCode, string> = {
  after_hours: "Calls when the office is closed (they advertise emergency service but the office is closed on evenings or weekends)",
  instant_answers: "Customers who would rather send a message than wait for a call back: some are lost when nobody answers right away. Describe ONLY lost calls and lost customers; NEVER say anything about their website, contact form, chat or booking",
  missed_calls: "Calls missed while the team is out on jobs. PHONE CALLS ONLY: never mention website messages, chat, forms or booking",
  phone_only: "Customers who would rather send a message or book than call: some are lost when nobody picks up. Describe ONLY lost calls and lost customers; NEVER say what their website has or lacks",
  general: "Calls missed while the team is out on jobs or after hours (general; no claim about this business). PHONE CALLS ONLY: never mention website messages, chat, forms or booking, because the business may already have them",
};

/**
 * One confident gap, mapped to one angle:
 *  - closed evenings/weekends while advertising emergency service (and the site does not say it answers any time) -> after hours
 *  - no chat and only a call-back / contact form -> instant answers
 *  - already has chat or booking -> missed calls (never pitch chat)
 * Uncertain facts (never checked, site needs a browser check) -> no claim about the business at all.
 */
const NO_HOURS_NOTE = ". Their site says they are available 24/7, so NEVER say \"after hours\", \"closed\", \"evenings\", \"weekends\" or \"overnight\": talk about calls missed while the team is busy on jobs";

function withoutSiteGapFacts(plan: AnglePlan): AnglePlan {
  const kept = plan.facts.filter((f) => !isSiteGapFact(f.text)).map((f, i) => ({ ...f, n: i + 1 }));
  return kept.length === plan.facts.length ? plan : { ...plan, facts: kept };
}

function pickAngleBase(lead: LeadFacts): AnglePlan {
  const sc = lead.site_check;
  const noHours = !!sc && (sc.hours_usable === false || sc.mentions_24_7 === true);
  const generalLine = ANGLES.general + (noHours ? NO_HOURS_NOTE : "");
  const general: AnglePlan = { angle: { code: "general", line: generalLine }, facts: [], uncertain: null, no_hours: noHours };
  // A listing / lead-gen site or a supplier is never pitched as a normal local business: no claims about it at all.
  if (sc && (sc.lead_gen_listing || sc.not_home_service)) return { ...general, uncertain: `Flagged (${sc.lead_gen_listing ?? sc.not_home_service}), so no claim is made about this business.` };
  if (!sc || sc.error) return { ...general, uncertain: "The website was not checked, so no claim is made about it." };
  if (sc.needs_browser && sc.via !== "browser") return { ...general, uncertain: "The site needs a browser check, so no gap is mentioned." };

  const hasWeb = !!(sc.chat_widget || sc.booking_tool);
  const h = sc.hours_usable === false ? null : leadHours(lead);
  const closedLate = !!h && (h.closedWeekend || h.closesEarlyWeekdays);
  if (closedLate && sc.advertises_emergency && h) {
    const closedBit = h.closedWeekend ? `closed ${h.closedDays.length ? h.closedDays.join(" and ") : "on weekends"}` : "closed by 5 PM on weekdays";
    return {
      angle: { code: "after_hours", line: ANGLES.after_hours + (hasWeb ? ". PHONE CALLS ONLY: they already have chat or online booking on the site, so never mention website messages, chat, forms or booking" : "") },
      calls_only: hasWeb,
      facts: [{ n: 1, text: `Their office is ${closedBit} (${h.summary}), and their website says emergency service is available.`, evidence: `${h.source ?? "Google"} hours: ${h.summary}. Site mentions emergency service.` }],
      uncertain: null,
    };
  }
  if (!sc.chat_widget && !sc.booking_tool && (sc.request_form || sc.has_contact_form)) {
    return {
      angle: { code: "instant_answers", line: ANGLES.instant_answers },
      facts: [{ n: 1, text: `Their website only offers a ${sc.request_form && !sc.has_contact_form ? "request" : "contact or call-back"} form: no live chat and no online booking.`, evidence: [sc.evidence?.request_form, sc.evidence?.contact_form, `Checked${sc.via === "browser" ? " in a real browser" : ""}: no chat or booking tool found.`].filter(Boolean).join(" ") }],
      uncertain: null,
    };
  }
  if (sc.chat_widget || sc.booking_tool) return { angle: { code: "missed_calls", line: ANGLES.missed_calls + (noHours ? NO_HOURS_NOTE : "") }, facts: [], uncertain: null, no_hours: noHours };
  // "Phone only / no form" may be claimed only when a browser saw the page, or the plain page has no form-plugin script at all
  // (a form built by JavaScript, like Ninja Forms, is invisible to a plain download). A check saved before form_plugin existed is not trusted.
  const formUnseen = sc.via !== "browser" && sc.form_plugin !== null;
  if (formUnseen && !sc.chat_widget && !sc.booking_tool && !sc.has_contact_form && !sc.request_form && !sc.whatsapp_url) {
    return { ...general, uncertain: sc.form_plugin ? `The site uses a form plugin (${sc.form_plugin}) that a plain download cannot see, so "no form" is not claimed.` : "This check does not show whether the site has a form, so \"no form\" is not claimed." };
  }
  // Nothing but a phone number: no chat, no booking, no form (checked in a browser, or a plain site a browser would not change).
  if (!sc.chat_widget && !sc.booking_tool && !sc.has_contact_form && !sc.request_form && !sc.whatsapp_url) {
    const is247 = sc.hours_usable === false;
    return {
      angle: { code: "phone_only", line: ANGLES.phone_only + (noHours ? NO_HOURS_NOTE.replace("talk about calls missed while the team is busy on jobs", "you may mention that they are available 24/7") : "") },
      facts: [{ n: 1, text: `Their website gives visitors only a phone number: no contact form, live chat or online booking${is247 ? ", even though the site says they are available 24/7" : ""}.`, evidence: [`Checked${sc.via === "browser" ? " in a real browser" : ""}: no chat, booking tool or contact form found.`, is247 ? sc.hours_evidence : null].filter(Boolean).join(" ") }],
      uncertain: null,
      no_hours: noHours,
    };
  }
  return general;
}

/**
 * The angle plus, at most, ONE website fact that supports it. Only a phone-call angle can use the tap-to-call
 * fact, and only when the check says "true" AND the page switches off automatic number links (iPhone Safari makes
 * plain numbers tappable on its own, so otherwise the claim would be wrong for many visitors). The writer picks one fact in total (fact_used).
 */
/** A fact about what their website lacks ("only a contact form: no live chat", "only a phone number", "plain text number"): it steers the angle but is never given to a writer, because a message must not criticise the site. */
export const isSiteGapFact = (text: string): boolean => /(?:website|site)[^.]{0,70}(?:only offers|only gives|no (?:live )?chat|no contact form|no online booking|plain text|not a tap)|only a phone number|only offers a/i.test(text);

export function pickAngle(lead: LeadFacts): AnglePlan {
  const plan = withoutSiteGapFacts(pickAngleBase(lead));
  if (plan.uncertain) return plan;
  // The tap-to-call fact is a statement about what their website lacks, so it is no longer offered to a writer (messages describe lost calls, never their site).
  return plan;
}

// ── True details about the business (used to make every email specific) ──

/** Rating, plus whatever the site check saved (years in business, family-owned, services, area, emergency service). */
export function leadDetails(lead: LeadFacts): Detail[] {
  // A flagged listing or supplier gets no claims about it at all, so no details either.
  if (lead.site_check?.lead_gen_listing || lead.site_check?.not_home_service) return [];
  const out: Detail[] = [];
  const r = lead.rating;
  const n = lead.reviews_count;
  if (typeof r === "number" && r >= 4.3 && typeof n === "number" && n >= 5) {
    out.push({ kind: "rating", text: `${r.toFixed(1)} rating from ${n} Google reviews`, words: [r.toFixed(1), `${n} reviews`, `${n} google reviews`, `${n} five-star`, `${n} 5-star`], evidence: `Google: ${r} stars, ${n} reviews.` });
  }
  return [...out, ...(lead.site_check?.details ?? [])];
}

/** Words of the business name worth looking for in a subject (generic trade words and filler dropped). */
export function nameTokens(name: string | null | undefined): string[] {
  const drop = new Set(["the", "and", "llc", "inc", "co", "company", "service", "services", "heating", "cooling", "air", "hvac", "conditioning", "repair", "plumbing", "roofing", "home", "pros", "pro", "of", "ac", "heat"]);
  return (name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !drop.has(w));
}

/** A plain way to say the detail about the business, used as a suggested opening for the writer. */
export function detailPhrase(d: Detail, name: string): string {
  const n = name.replace(/\s+(?:llc|inc\.?|ltd\.?|co\.?)$/i, "");
  if (d.kind === "since") return `${n} has been in business ${d.text.replace(/^In business /i, "")}`;
  if (d.kind === "years") return `${n} has been in business for ${d.text.replace(/ in business$/i, "")}`;
  if (d.kind === "family") return `${n} is a family-owned business`;
  if (d.kind === "rating") return `${n} has ${d.text.replace(/^(\S+) rating from (\d+) Google reviews$/, "$2 Google reviews averaging $1 stars")}`;
  if (d.kind === "services") return `${n} lists ${d.text.replace(/^Services they list: /, "")} on its website`;
  return `${n}: ${d.text}`;
}

// ── Opening style rotation ─────────────────────────────────────────────

export const OPENING_STYLES = ["saw", "question", "problem"] as const;
export type OpeningStyle = (typeof OPENING_STYLES)[number];

/** Rotates by how many first emails the campaign already has; a draft with no fact cannot "saw". */
export function pickOpeningStyle(draftsSoFar: number, hasFact: boolean): OpeningStyle {
  const options = hasFact ? OPENING_STYLES : (["question", "problem"] as const);
  return options[draftsSoFar % options.length];
}

/** "123 Main St, Houston, TX 77001" -> "Houston" */
export function cityOf(address: string | null | undefined): string {
  const parts = (address ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2 && !/^[A-Z]{2}\b/.test(parts[1])) return parts[1];
  return "";
}

// ── Code-side checks on the model's answer ─────────────────────────────

export type ModelDraft = { subject: string; body: string; fact_used: number | null; opening_style: string };

/** fact_used is bookkeeping: no facts -> null; out of range or not a number -> null. */
export const normalizeFactUsed = (v: unknown, factCount: number): number | null => (factCount > 0 && typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= factCount ? v : null);

/** Retry hint when the subject-shape rule failed: show every subject already used and ask for a different kind. */
export function subjectRetryHint(used: string[], shortName: string): string {
  const list = used.length ? `Subjects already used in this campaign: ${used.map((x) => `"${x}"`).join(", ")}. ` : "";
  return `${list}Write a new subject that is a short question (for example "Who answers when ${shortName || "you"} is busy?") or a plain statement, 2-6 words, not "<business name> + one word".`;
}

export const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;

const BANNED_BODY: Array<[RegExp, string]> = [
  [/\bwe build\b/i, 'says "We build"'],
  [/\bi noticed\b/i, 'says "I noticed"'],
  [/capture/i, 'uses the word "capture"'],
  [/following up|follow(?:ing)? up on/i, 'says "following up"'],
  [/https?:\/\/|www\./i, "contains a link"],
  [/\b(?:intelligent|seamless(?:ly)?|leverag(?:e|es|ed|ing)|cutting-edge|game-?chang\w+|revolutioni[sz]\w*)\b/i, "uses a buzzword (intelligent, seamless, leverage, cutting-edge, game-changer, revolutionize)"],
  [/\b(?:implement(?:s|ed|ing)?|deploy\w*|configur\w+|solutions?|digital helper|automated (?:digital )?(?:helper|assistant|voice))\b/i, "uses a stiff word (implements, deploys, configures, solution, automated digital helper): say sets up, answers, takes the details, sends them to you"],
  [/\bin our (?:line of work|industry|trade|field)\b|\bas (?:a )?(?:fellow )?(?:contractor|tradesman|tradesperson|business owner)s?\b|\bfellow (?:contractor|business owner)s?\b|\bwe(?:'ve| have) (?:worked|been) (?:in|with) (?:the )?(?:hvac|trade|industry)/i, "makes a claim about the sender's own trade or background (the sender is not a contractor)"],
];

/** Words that talk about the time of day / being closed: never used for a business whose site says it is available 24/7. */
const HOURS_WORDS = /\b(?:after[- ]hours|off[- ]hours|outside (?:of )?(?:normal |regular |business |office )?hours|closed|closing|evenings?|weekends?|overnight|nights?)\b/i;
const HVAC_WORDS = /\bhvac\b|air[- ]conditioning|\bA\/C\b|heating (?:and|&) (?:cooling|air)/i;

/** Plain failures a model can fix on a retry. Empty list = passed. */
/** Angles that must talk about phone calls only (the business may already have chat or booking). */
export const callsOnly = (code: AngleCode): boolean => code === "general" || code === "missed_calls";
const WEB_CHANNEL_RX = /\b(?:website|web ?site|web) (?:messages?|chat|visitors?|enquir\w+|inquir\w+|forms?|leads?)|\b(?:live|web|site) ?chat\b|\bchat(?: ?bot| widget)?\b|\bonline (?:form|booking|chat|messages?)|\b(?:contact|request|call-?back) forms?\b|\btext messages?\b|\bsms\b/i;

export type DraftChecks = {
  callsOnly?: boolean;
  /** The site says 24/7: no after hours / closed / evenings wording. */
  noHours?: boolean;
  /** The business's real trade ("duct cleaning"); the email must not call a non-HVAC business HVAC. */
  trade?: string | null;
  /** Texts the draft must not repeat 8+ words in a row from (the offer, the worked examples). */
  copySources?: string[];
  /** Other first emails already in this campaign. */
  others?: Array<{ subject: string; body: string }>;
  /** Names to ignore when comparing subjects (business, city). */
  ignoreWords?: string[];
  /** True details about the business: the opening paragraph must use one of them. */
  details?: Detail[];
  /** The business name: the subject must name the business or use a true detail. */
  businessName?: string | null;
  /** True only for the confirmed "phone only" angle: otherwise the email must not say the site has only a phone number or no form. */
  phoneOnlyOk?: boolean;
};

const PHONE_ONLY_CLAIM = /\b(?:only|just)\s+(?:provides?|offers?|gives?|has|lists?|shows?|displays?)\s+(?:a\s+|its\s+|their\s+)?(?:phone|telephone)(?:\s+number)?\b|\bno\s+(?:contact\s+|online\s+)?form\b|\bwithout\s+a\s+(?:contact\s+)?form\b|\bonly\s+(?:way|option)\s+(?:to\s+reach|is\s+(?:to\s+)?call)/i;

const QUICK_Q = /quick question\s*:\s*([^.!?\n]*)([.!?]?)/i;
const UNOFFERED: Array<[RegExp, string]> = [
  [/\b(?:texts?|texting|sms)\b/i, "texting"],
  // Only when the assistant (or "we"/"it") is said to schedule, book, dispatch, quote, invoice or take payments; "busy schedule" is fine.
  [/\b(?:assistant|shiftforge(?: ai)?|we|it|our \w+)\b[^.!?\n]{0,50}?\b(?<!\b(?:busy|hectic|packed|full|tight|service|work|crew|team|job|daily|weekly)\s)(?:schedul(?:es|ing)|books?|booking|dispatch(?:es|ing)?|quot(?:es|ing)|invoic(?:es|ing)|takes? payments?|collects? payments?|sends? (?:them |you |customers? )?(?:a )?quotes?)\b(?!\s+(?:an?\s+|the\s+|your\s+)?(?:30|free|quick|short|brief|call|chat|time)\b)/i, "scheduling, dispatch, quotes or payments"],
];

/** Hours facts (weekend closure, 24/7, after hours) are saved in the site check but are not in the details list. */
const HOURS_OPENING = /\b(?:24\/7|24 hours|after[- ]hours|closed (?:on )?(?:the )?(?:weekends?|evenings?|nights?|sundays?|saturdays?)|(?:weekends?|evenings?|nights?)\b[^.!?]{0,40}\bclosed|open (?:late|weekends?)|office (?:hours|is closed))/i;

const detailHit = (text: string, details: Detail[]): boolean => {
  const t = text.toLowerCase();
  return details.some((d) => d.words.some((w) => t.includes(w.toLowerCase())));
};

/** The opening paragraph: everything between the greeting and the first blank line after it. */
const openingParagraph = (body: string): string => {
  const parts = body.replace(/\r/g, "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length && /^(?:hi|hello|hey)\b[^.!?]{0,40},?$/i.test(parts[0])) parts.shift();
  return parts[0] ?? "";
};

export function checkModelDraft(d: ModelDraft, factCount: number, opts: DraftChecks = {}): string[] {
  const fails: string[] = [];
  if (opts.noHours && HOURS_WORDS.test(`${d.subject} ${d.body}`)) fails.push('it mentions after hours, closed, evenings, weekends or nights, but their site says they are available 24/7: talk about calls missed while the team is busy on jobs');
  if (opts.trade && !/hvac/i.test(opts.trade) && HVAC_WORDS.test(`${d.subject} ${d.body}`)) fails.push(`it says HVAC or air conditioning, but this business does ${opts.trade}: use its real trade or no trade word`);
  if (!opts.phoneOnlyOk && PHONE_ONLY_CLAIM.test(d.body)) fails.push('it says the site only has a phone number or no form, which is not confirmed for this business: do not claim that');
  const qq = QUICK_Q.exec(d.body);
  if (qq && qq[2] !== "?") fails.push('"Quick question:" must be followed by a real question that ends with a question mark');
  for (const [rx, what] of UNOFFERED) if (rx.test(d.body)) fails.push(`it mentions ${what}, which is not part of the offer: only say that the assistant answers phone calls, takes the details and sends them to the owner`);
  // Any saved fact the opening actually uses counts (emergency service, hours or weekend closure, 24/7, services, rating, years, family-owned, owner, area).
  const openDetails = opts.details;
  if (openDetails?.length && !detailHit(openingParagraph(d.body), openDetails) && !HOURS_OPENING.test(openingParagraph(d.body))) fails.push(`the opening does not use one true detail about the business (${(openDetails ?? []).slice(0, 4).map((x) => `"${x.text}"`).join(", ")}): open with one of them`);
  if (opts.businessName !== undefined) {
    const tokens = nameTokens(opts.businessName);
    const sub = d.subject.toLowerCase();
    if ((tokens.length || opts.details?.length) && !tokens.some((t) => sub.includes(t)) && !(opts.details && detailHit(d.subject, opts.details.filter((x) => x.kind !== "area")))) fails.push("the subject is generic: it must name the business or one true detail about it");
  }
  const copied = copiedFrom(d.body, opts.copySources ?? []);
  if (copied) fails.push(`it repeats 8+ words from the examples or the offer ("${copied}"): write your own sentences`);
  const same = opts.others?.length ? samenessProblem(d, opts.others, opts.ignoreWords ?? [], opts.copySources ?? []) : null;
  if (same) fails.push(same);
  if (opts.callsOnly && WEB_CHANNEL_RX.test(d.body)) fails.push("the body mentions website messages, chat, forms or booking: talk about phone calls only");
  const words = wordCount(d.body);
  if (words < 50 || words > 110) fails.push(`the body has ${words} words (must be 60-100)`);
  for (const [rx, why] of BANNED_BODY) if (rx.test(d.body)) fails.push(`the body ${why}`);
  const sw = wordCount(d.subject);
  if (sw < 2 || sw > 6) fails.push(`the subject has ${sw} words (must be 2-6)`);
  if (/\bAI\b/.test(d.subject)) fails.push('the subject contains "AI"');
  if (/\bleads?\b/i.test(d.subject) || /capture/i.test(d.subject)) fails.push('the subject contains "leads" or "capture"');
  if (!/30-minute free call/i.test(d.body)) fails.push('the body does not ask for a "30-minute free call"');
  // fact_used is bookkeeping only: it never fails a draft (normalised by normalizeFactUsed when saved).
  return fails;
}


/**
 * The body-level rules of checkModelDraft that also apply to a short social message (no subject, no 60-100 word
 * rule): hours wording, wrong trade, unoffered features, phone-calls-only, copied text, banned words and links.
 */
export function checkSocialBody(text: string, opts: { callsOnly?: boolean; noHours?: boolean; trade?: string | null; copySources?: string[]; phoneOnlyOk?: boolean } = {}): string[] {
  const fails: string[] = [];
  if (!opts.phoneOnlyOk && PHONE_ONLY_CLAIM.test(text)) fails.push("it says the site only has a phone number or no form, which is not confirmed for this business");
  if (opts.noHours && HOURS_WORDS.test(text)) fails.push("it mentions after hours, closed, evenings, weekends or nights, but their site says they are available 24/7");
  if (opts.trade && !/hvac/i.test(opts.trade) && HVAC_WORDS.test(text)) fails.push(`it says HVAC or air conditioning, but this business does ${opts.trade}`);
  for (const [rx, what] of UNOFFERED) if (rx.test(text)) fails.push(`it mentions ${what}, which is not part of the offer`);
  if (opts.callsOnly && WEB_CHANNEL_RX.test(text)) fails.push("it mentions website messages, chat, forms or booking: talk about phone calls only");
  // The call-to-action sentence and the greeting are allowed to repeat, like in emails.
  const stripCta = (t: string) => t.split(/(?<=[.!?])\s+/).filter((x) => !/30-minute free call/i.test(x)).join(" ");
  const copied = copiedFrom(stripCta(text), (opts.copySources ?? []).map(stripCta));
  if (copied) fails.push(`it repeats 8+ words from the examples, the offer or another message ("${copied}")`);
  for (const [rx, why] of BANNED_BODY) if (rx.test(text)) fails.push(`it ${why}`);
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) fails.push("it contains an email address");
  if (/\b[a-z0-9-]+\.(?:com|net|org|co|io|us|biz)\b/i.test(text)) fails.push("it contains a web address");
  if (/\p{Extended_Pictographic}/u.test(text)) fails.push("it contains an emoji");
  if (/#\w+/.test(text)) fails.push("it contains a hashtag");
  return fails;
}

// ── Copying and sameness ──────────────────────────────────────────────

const wordsOf = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);

/** Body without the greeting line and without the call-to-action sentence (both are allowed to repeat). */
function comparable(body: string): string {
  const lines = body.replace(/\r/g, "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^(?:hi|hello|hey)\b[^.!?]{0,40},?$/i.test(lines[0])) lines.shift();
  return lines.join(" ").split(/(?<=[.!?])\s+/).filter((x) => !/30-minute free call/i.test(x)).join(" ");
}

/** The longest run of words that two texts share (case and punctuation ignored); "" when shorter than min. */
export function sharedRun(a: string, b: string, min = 8): string {
  const x = wordsOf(comparable(a));
  const y = wordsOf(comparable(b));
  if (x.length < min || y.length < min) return "";
  const at = new Map<string, number[]>();
  y.forEach((w, i) => at.set(w, [...(at.get(w) ?? []), i]));
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i < x.length; i++) {
    for (const j of at.get(x[i]) ?? []) {
      let k = 0;
      while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
      if (k > best) { best = k; bestAt = i; }
    }
  }
  return best >= min ? x.slice(bestAt, bestAt + Math.min(best, 12)).join(" ") : "";
}

/** The first phrase of `body` (8+ words in a row) that also appears in one of the sources; null when the draft is its own. */
export function copiedFrom(body: string, sources: string[], min = 8): string | null {
  // The plain description of the service ("answers calls and website messages, takes the details and sends them to you") is
  // in the offer and in every email; it is not copying. Everything else still counts.
  const mine = withoutServiceDescription(body);
  for (const src of sources) {
    if (!src) continue;
    const r = sharedRun(mine, withoutServiceDescription(src), min);
    if (r) return r;
  }
  return null;
}

const openingKey = (body: string): string => wordsOf(comparable(body).split(/(?<=[.!?:])\s+/)[0] ?? "").slice(0, 3).join(" ");
const subjectKey = (subject: string, ignore: string[]): string => {
  const drop = new Set(ignore.flatMap((x) => wordsOf(x)));
  return wordsOf(subject).filter((w) => !drop.has(w)).join(" ");
};

const QQ_OPEN = /^quick question\b/i;

/** The form of a subject line, so a campaign does not repeat one form: "Innovative Air Producers calls" = name_word. */
export function subjectShape(subject: string): string {
  const t = subject.trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (/\?$/.test(t)) return "question";
  if (/^[^:]{2,40}:\s*\S/.test(t)) return "colon";
  if (words.length >= 2 && /^[a-z][a-z'-]*$/.test(words[words.length - 1]) && words.slice(0, -1).every((w) => /^[A-Z0-9&(]/.test(w))) return "name_word";
  if (/\bsince\s+(?:19|20)\d{2}\b/i.test(t)) return "since_year";
  if (/\s(?:at|for|in)\s+[A-Z0-9]/.test(t)) return "detail_at_name";
  return "other";
}

/** Shared words between two emails of one campaign that count as copying. (Copying from the offer or the examples stays at 8.) */
export const CROSS_EMAIL_WORDS = 12;

/** Phrases that just describe what the assistant does; every email may say them. */
const SERVICE_PHRASES: RegExp[] = [
  /\b(?:answers?|picks? up|takes?|handles?) (?:your |their |the )?(?:phone )?(?:calls?|messages?|website messages?|texts?)(?: and (?:website |web |chat )?(?:calls?|messages?))?\b/gi,
  /\b(?:takes?|gets?|collects?) (?:down )?(?:the |their |your )?(?:caller['’]?s )?(?:details|information|name and number)\b/gi,
  /\b(?:sends?|passes?|forwards?|relays?) (?:them|those|it|the details|everything|that|every (?:enquiry|inquiry|lead|message|call))(?: straight| right| directly)? (?:over )?(?:on )?to (?:you|the owner|your team|your phone|the team)\b/gi,
];
let svcMark = 0;
/** Each removed phrase becomes a one-off marker word, so two emails never "share" a run across the gap. */
const withoutServiceDescription = (body: string): string => SERVICE_PHRASES.reduce((t, rx) => t.replace(rx, () => ` svcgap${svcMark++}x `), body);

/** F39: words a draft shares with the offer or the writer examples (a run of 5+) become one-off markers too. Copying those
 * is checked on its own (8 words, `copiedFrom`); between two emails, saying the offer the same way is not sameness. */
const SHARED_SOURCE_RUN = 5;
const normWord = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
function withoutSourceRuns(body: string, sources: string[]): string {
  const grams = new Set<string>();
  for (const src of sources) {
    const w = src.split(/\s+/).map(normWord).filter(Boolean);
    for (let i = 0; i + SHARED_SOURCE_RUN <= w.length; i++) grams.add(w.slice(i, i + SHARED_SOURCE_RUN).join(" "));
  }
  if (!grams.size) return body;
  return body.split("\n").map((line) => {
    const toks = line.split(/(\s+)/); // words and the spaces between them
    const idx = toks.map((t, i) => (/\S/.test(t) && normWord(t) ? i : -1)).filter((i) => i >= 0);
    const drop = new Set<number>();
    for (let k = 0; k + SHARED_SOURCE_RUN <= idx.length; k++) {
      const gram = idx.slice(k, k + SHARED_SOURCE_RUN).map((i) => normWord(toks[i])).join(" ");
      if (grams.has(gram)) for (let j = k; j < k + SHARED_SOURCE_RUN; j++) drop.add(idx[j]);
    }
    return drop.size ? toks.map((t, i) => (drop.has(i) ? `svcgap${svcMark++}x` : t)).join("") : line;
  }).join("\n");
}

/** Too close to another first email in the same campaign (12+ shared words, same opening as the last two, same subject pattern). */
export function samenessProblem(d: { subject: string; body: string }, others: Array<{ subject: string; body: string }>, ignoreWords: string[] = [], sharedSources: string[] = []): string | null {
  const plain = (body: string) => withoutSourceRuns(withoutServiceDescription(body), sharedSources);
  for (const o of others) {
    // Between emails the limit is 12 words, and plain descriptions of the service are ignored (nearly every email says the same true thing),
    // and so is wording taken from the offer or the examples (F39).
    const r = sharedRun(plain(d.body), plain(o.body), CROSS_EMAIL_WORDS);
    if (r) return `it repeats ${CROSS_EMAIL_WORDS}+ words from another email in this campaign ("${r}"): use different wording`;
  }
  // At most 1 in 4 emails of a campaign may open with "Quick question".
  if (QQ_OPEN.test(openingParagraph(d.body))) {
    const used = others.filter((o) => QQ_OPEN.test(openingParagraph(o.body))).length;
    const allowed = Math.max(1, Math.floor((others.length + 1) / 4));
    if (used + 1 > allowed) return `it opens with "Quick question", and ${used} of the ${others.length} other emails in this campaign already do (at most 1 in 4 may): open differently, for example with "I saw that...", a plain statement, or the customer's problem`;
  }
  // Subjects: "<business name> + one word" (e.g. "Innovative Air Producers calls") at most once per campaign, and no more than two subjects of any one shape.
  const shape = subjectShape(d.subject);
  if (shape === "name_word" && others.some((o) => subjectShape(o.subject) === "name_word")) return 'its subject is "<business name> + one word", which another email in this campaign already uses (at most one may): write a different kind of subject, such as a short question or a plain statement';
  if (shape !== "other" && others.filter((o) => subjectShape(o.subject) === shape).length >= 2) return `its subject has the same shape ("${shape.replace("_", " ")}") as two other emails in this campaign: change the form of the subject, not just the words`;
  const lastTwo = others.slice(-2);
  const open = openingKey(d.body);
  if (lastTwo.length === 2 && open && lastTwo.every((o) => openingKey(o.body) === open)) return `it opens like the last two emails ("${open} ..."): open differently`;
  if (/^[^:]{2,40}:\s*\S/.test(d.subject.trim()) && others.some((o) => /^[^:]{2,40}:\s*\S/.test(o.subject.trim()))) return 'its subject uses the "<name>: <detail>" shape that another email already uses: write the subject like a person would, in a different shape';
  const sk = subjectKey(d.subject, ignoreWords);
  if (sk && others.some((o) => subjectKey(o.subject, ignoreWords) === sk)) return "its subject follows the same pattern as another email in this campaign: vary the subject";
  return null;
}
