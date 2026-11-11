// Pure helpers shared by command.ts and webhook-receive.ts for the outreach
// flow: send-time footer, opt-out detection, draft normalisation and the
// keys used to dedupe leads across campaigns. No I/O in this file so it can
// be unit-tested directly.

// ── Footer (appended at send time, never written by Gemini) ──────────

export const FOOTER_OPT_OUT_LINE = `If you would rather not hear from me, just reply "no thanks" and I won't email you again.`;
export const FOOTER_SIGNATURE = "ShiftForge AI";
export const FOOTER_URL = "https://shiftforge.ai";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the footer. `postalAddress` is optional; blank/whitespace = omitted. */
export function buildFooter(postalAddress?: string | null): { text: string; html: string } {
  const postal = (postalAddress ?? "").trim();
  const text = [FOOTER_OPT_OUT_LINE, "", FOOTER_SIGNATURE, FOOTER_URL, ...(postal ? [postal] : [])].join("\n");
  const html =
    `<p style="margin-top:24px">${escapeHtml(FOOTER_OPT_OUT_LINE)}</p>` +
    `<p>${escapeHtml(FOOTER_SIGNATURE)}<br><a href="${FOOTER_URL}">${FOOTER_URL}</a>` +
    (postal ? `<br>${escapeHtml(postal).replace(/\r?\n/g, "<br>")}` : "") +
    `</p>`;
  return { text, html };
}

/** True if the body already carries our opt-out line (so we never double-append). */
export function hasFooter(bodyText: string): boolean {
  return bodyText.includes(FOOTER_OPT_OUT_LINE);
}

/** Append the footer to a text + html pair (idempotent). */
export function appendFooter(
  bodyText: string,
  bodyHtml: string,
  postalAddress?: string | null,
): { text: string; html: string } {
  if (hasFooter(bodyText)) return { text: bodyText, html: bodyHtml };
  const f = buildFooter(postalAddress);
  return {
    text: `${bodyText.trimEnd()}\n\n${f.text}`,
    html: `${bodyHtml}${f.html}`,
  };
}

/** Plain text → simple <p> html (used when a draft is edited in the UI). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ── Draft consistency (fixed offer, greeting) ─────────────────────────

/** The offer is always a 30-minute free call. */
export const FIXED_OFFER = "30-minute free call";

const SHORT_CALL = /\b(?:5|10|15|20|25)[\s-]?(?:minutes?|mins?)\b/gi;

/**
 * Post-process a Gemini draft so the output is consistent even when the
 * model ignores the prompt: other call lengths become "30-minute", and a
 * generic "Hi there," greeting is replaced when we know who we are writing to.
 */
export function normalizeDraft<T extends { subject: string; body_text: string; body_html: string }>(
  draft: T,
  greeting?: string | null,
): T {
  const fixLen = (s: string) => s.replace(SHORT_CALL, "30-minute");
  const generic = /^(\s*(?:<p>)?\s*)(?:hi|hello|hey)\s+there\s*,?/i;
  const fixGreeting = (s: string) => (greeting ? s.replace(generic, `$1${greeting},`) : s);
  return {
    ...draft,
    subject: fixLen(draft.subject),
    body_text: fixGreeting(fixLen(draft.body_text)),
    body_html: fixGreeting(fixLen(draft.body_html)),
  };
}

const BUSINESS_HINT = /\b(llc|inc|ltd|co|corp|company|services|roofing|plumbing|repair|restoration|construction|contractors?|group|solutions|studio|agency|clinic|dental|law|firm|partners)\b/i;

/**
 * Greeting to open the email with, or null when we know nothing (the model
 * then falls back to its own rule). Scraped businesses get "Hi <Business> team",
 * person-like names (test / manual leads) get "Hi <First>".
 */
export function greetingFor(lead: { name?: string | null; category?: string | null; website?: string | null; is_test?: boolean }): string | null {
  const name = (lead.name ?? "").trim();
  if (!name || /@/.test(name)) return null;
  // A test lead added without a name gets its email's local part as the name
  // (e.g. "shiftforge.ai+t4") — not something to greet.
  if (!/\s/.test(name) && /[.+_\d]/.test(name) && name === name.toLowerCase()) return null;
  const businessLike = !lead.is_test && (!!lead.category || !!lead.website || BUSINESS_HINT.test(name) || name.split(/\s+/).length > 2);
  if (businessLike) return `Hi ${name} team`;
  return `Hi ${name.split(/\s+/)[0]}`;
}

// ── Opt-out detection for inbound replies ─────────────────────────────

/** Drop quoted history ("> ..." lines and everything after "On <date> ... wrote:"). */
export function newPartOfReply(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*on .{5,200}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*original message/i.test(line) || /^\s*from:\s.+/i.test(line) && out.length > 0) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

const AUTO_REPLY = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|undeliverable|delivery status|mailer-daemon|vacation)/i;

const STRONG_PHRASES = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bstop (?:emailing|email|contacting|messaging|sending|writing)\b/i,
  /\bdo(?: not|n'?t) (?:contact|email|message)\b/i,
  /\bno longer (?:wish|want|interested)\b/i,
  /\bnot interested\b/i,
];

const SHORT_NO = /^\W*(?:no|nope|stop|no,? thanks?|no,? thank you|thanks?,? but no|no thanks? (?:i'?m|we'?re) (?:good|all set|set))\W*$/i;
const NO_THANKS = /\bno,? thanks?\b|\bno,? thank you\b/i;

/**
 * Conservative check: does this reply clearly ask us to stop / say no?
 * Only the new text of the reply is inspected (quoted history is ignored, so
 * our own footer line quoted back never triggers it) and auto-replies are
 * ignored. Longer, conversational replies only match on strong phrases.
 */
export function isOptOutReply(subject: string | null | undefined, text: string | null | undefined): boolean {
  const body = newPartOfReply(text ?? "");
  if (!body) return false;
  if (AUTO_REPLY.test(subject ?? "") || AUTO_REPLY.test(body.slice(0, 300))) return false;
  const firstLines = body.split("\n").slice(0, 6).join("\n");
  if (SHORT_NO.test(firstLines.split("\n").find((l) => l.trim()) ?? "")) return true;
  if (body.length <= 400) {
    if (NO_THANKS.test(body)) {
      // "No thanks" next to "yes / sure / interested" is ambiguous — don't flag.
      const positives = /\byes\b|\bsure\b|\binterested\b|\blet'?s (?:talk|chat|connect)\b/i;
      return !positives.test(body.replace(/not interested/gi, ""));
    }
  }
  return STRONG_PHRASES.some((re) => re.test(firstLines));
}

// ── Lead dedupe keys ──────────────────────────────────────────────────

// Hosts many small businesses list instead of a real site: matching on the
// host alone would wrongly dedupe unrelated businesses, so include the path.
const SHARED_HOSTS = new Set([
  "facebook.com", "m.facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "yelp.com",
  "google.com", "goo.gl", "g.page", "youtube.com", "tiktok.com", "linktr.ee", "business.site", "sites.google.com",
  "wixsite.com", "godaddysites.com", "square.site", "weebly.com", "wordpress.com", "yellowpages.com", "angi.com",
  "homeadvisor.com", "nextdoor.com", "thumbtack.com", "bbb.org", "mapquest.com",
]);

/** Normalised dedupe key for a website, or null. e.g. https://www.Acme.com/a → "acme.com". */
export function websiteKey(website: string | null | undefined): string | null {
  if (!website || typeof website !== "string") return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host || !host.includes(".")) return null;
  const shared = SHARED_HOSTS.has(host) || [...SHARED_HOSTS].some((h) => host.endsWith(`.${h}`));
  if (shared) {
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return path ? `${host}${path}` : null; // bare facebook.com tells us nothing
  }
  return host;
}

export function emailKey(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

export function placeIdKey(raw: unknown): string | null {
  const id = (raw as { placeId?: unknown } | null | undefined)?.placeId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export type DedupeIndex = { websites: Set<string>; emails: Set<string>; placeIds: Set<string> };

export function emptyIndex(): DedupeIndex {
  return { websites: new Set(), emails: new Set(), placeIds: new Set() };
}

type LeadLike = { email?: string | null; website?: string | null; raw?: unknown };

export function addToIndex(idx: DedupeIndex, lead: LeadLike): void {
  const w = websiteKey(lead.website);
  const e = emailKey(lead.email);
  const p = placeIdKey(lead.raw);
  if (w) idx.websites.add(w);
  if (e) idx.emails.add(e);
  if (p) idx.placeIds.add(p);
}

/** Which key matched (for logging), or null if the lead is new. */
export function matchesIndex(idx: DedupeIndex, lead: LeadLike): "place_id" | "email" | "website" | null {
  const p = placeIdKey(lead.raw);
  if (p && idx.placeIds.has(p)) return "place_id";
  const e = emailKey(lead.email);
  if (e && idx.emails.has(e)) return "email";
  const w = websiteKey(lead.website);
  if (w && idx.websites.has(w)) return "website";
  return null;
}

/** Pull a bare address out of "Name <a@b.com>" or "a@b.com". */
export function extractEmailAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const m = /<([^>]+@[^>]+)>/.exec(from) ?? /([^\s<>,;]+@[^\s<>,;]+)/.exec(from);
  return emailKey(m?.[1]);
}
