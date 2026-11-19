/**
 * Decides, in code (not in the model), what a first cold email is about:
 * the ONE fact we are confident about and the angle that fits it. Also the
 * cheap code-side checks run on every model answer before the AI reviewer.
 * Pure functions, no network.
 */
import { hoursInfo } from "./sitecheck";

export type Fact = { n: number; text: string; evidence: string };
export type AngleCode = "after_hours" | "instant_answers" | "missed_calls" | "general";
export type Angle = { code: AngleCode; line: string };
export type AnglePlan = { angle: Angle; facts: Fact[]; uncertain: string | null };

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
    request_form?: boolean;
    hours_usable?: boolean;
    advertises_emergency?: boolean;
    hours_evidence?: string | null;
    needs_browser?: boolean;
    evidence?: Record<string, string>;
  } | null;
};

const ANGLES: Record<AngleCode, string> = {
  after_hours: "Calls when the office is closed (they advertise emergency service but the office is closed on evenings or weekends)",
  instant_answers: "Website visitors get an instant answer (today the only option is waiting for a call back)",
  missed_calls: "Calls missed while the team is out on jobs",
  general: "Calls missed while the team is out on jobs (general; no claim about this business)",
};

/**
 * One confident gap, mapped to one angle:
 *  - closed evenings/weekends while advertising emergency service (and the site does not say it answers any time) -> after hours
 *  - no chat and only a call-back / contact form -> instant answers
 *  - already has chat or booking -> missed calls (never pitch chat)
 * Uncertain facts (never checked, site needs a browser check) -> no claim about the business at all.
 */
export function pickAngle(lead: LeadFacts): AnglePlan {
  const sc = lead.site_check;
  const general: AnglePlan = { angle: { code: "general", line: ANGLES.general }, facts: [], uncertain: null };
  if (!sc || sc.error) return { ...general, uncertain: "The website was not checked, so no claim is made about it." };
  if (sc.needs_browser && sc.via !== "browser") return { ...general, uncertain: "The site needs a browser check, so no gap is mentioned." };

  const h = sc.hours_usable === false ? null : hoursInfo(lead.raw);
  const closedLate = !!h && (h.closedWeekend || h.closesEarlyWeekdays);
  if (closedLate && sc.advertises_emergency && h) {
    const closedBit = h.closedWeekend ? `closed ${h.closedDays.length ? h.closedDays.join(" and ") : "on weekends"}` : "closed by 5 PM on weekdays";
    return {
      angle: { code: "after_hours", line: ANGLES.after_hours },
      facts: [{ n: 1, text: `Their office is ${closedBit} (${h.summary}), and their website says emergency service is available.`, evidence: `Google hours: ${h.summary}. Site mentions emergency service.` }],
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
  if (sc.chat_widget || sc.booking_tool) return { angle: { code: "missed_calls", line: ANGLES.missed_calls }, facts: [], uncertain: null };
  return general;
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

export const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;

const BANNED_BODY: Array<[RegExp, string]> = [
  [/\bwe build\b/i, 'says "We build"'],
  [/\bi noticed\b/i, 'says "I noticed"'],
  [/capture/i, 'uses the word "capture"'],
  [/following up|follow(?:ing)? up on/i, 'says "following up"'],
  [/https?:\/\/|www\./i, "contains a link"],
];

/** Plain failures a model can fix on a retry. Empty list = passed. */
export function checkModelDraft(d: ModelDraft, factCount: number): string[] {
  const fails: string[] = [];
  const words = wordCount(d.body);
  if (words < 50 || words > 110) fails.push(`the body has ${words} words (must be 60-100)`);
  for (const [rx, why] of BANNED_BODY) if (rx.test(d.body)) fails.push(`the body ${why}`);
  const sw = wordCount(d.subject);
  if (sw < 2 || sw > 6) fails.push(`the subject has ${sw} words (must be 2-6)`);
  if (/\bAI\b/.test(d.subject)) fails.push('the subject contains "AI"');
  if (/\bleads?\b/i.test(d.subject) || /capture/i.test(d.subject)) fails.push('the subject contains "leads" or "capture"');
  if (!/30-minute free call/i.test(d.body)) fails.push('the body does not ask for a "30-minute free call"');
  if (factCount === 0) {
    if (d.fact_used !== null && d.fact_used !== undefined) fails.push("fact_used must be null because no facts were given");
  } else if (typeof d.fact_used !== "number" || d.fact_used < 1 || d.fact_used > factCount) {
    fails.push(`fact_used must be a number from 1 to ${factCount}`);
  }
  return fails;
}

/** Plain text with blank-line paragraphs -> simple <p> html. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}
