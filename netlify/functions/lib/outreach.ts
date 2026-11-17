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

/**
 * Build the sign-off block + opt-out line. Order (top to bottom):
 *   Best,
 *   <sender name>
 *   ShiftForge AI
 *   https://shiftforge.ai
 *   (blank)
 *   If you would rather not hear from me, ...
 *   <postal address, only if set>
 * `senderName` blank → the name line is omitted.
 */
export function buildFooter(
  postalAddress?: string | null,
  senderName?: string | null,
  /** The body already ends with a sign-off (older drafts): only add what is missing. */
  signedOff?: { hasCompany: boolean } | null,
): { text: string; html: string } {
  const postal = (postalAddress ?? "").trim();
  const name = (senderName ?? "").trim();
  const sigLines = signedOff
    ? [...(signedOff.hasCompany ? [] : [FOOTER_SIGNATURE]), FOOTER_URL]
    : ["Best,", ...(name ? [name] : []), FOOTER_SIGNATURE, FOOTER_URL];
  const text = [...sigLines, "", FOOTER_OPT_OUT_LINE, ...(postal ? [postal] : [])].join("\n");
  const html =
    `<p>${sigLines.slice(0, -1).map(escapeHtml).join("<br>")}<br><a href="${FOOTER_URL}">${FOOTER_URL}</a></p>` +
    `<p style="margin-top:24px">${escapeHtml(FOOTER_OPT_OUT_LINE)}` +
    (postal ? `<br>${escapeHtml(postal).replace(/\r?\n/g, "<br>")}` : "") +
    `</p>`;
  return { text, html };
}

/** True if the body already carries our opt-out line (so we never double-append). */
export function hasFooter(bodyText: string): boolean {
  return bodyText.includes(FOOTER_OPT_OUT_LINE);
}

/** Append the sign-off + footer to a text + html pair (idempotent). */
export function appendFooter(
  bodyText: string,
  bodyHtml: string,
  postalAddress?: string | null,
  senderName?: string | null,
): { text: string; html: string } {
  if (hasFooter(bodyText)) return { text: bodyText, html: bodyHtml };
  // Older drafts (or hand-edited ones) may already end with the sender's name:
  // don't print it twice.
  const tail = bodyText.trimEnd().split("\n").slice(-3).join("\n").toLowerCase();
  const alreadySigned = !!senderName && tail.includes(senderName.trim().toLowerCase());
  const f = buildFooter(postalAddress, senderName, alreadySigned ? { hasCompany: tail.includes(FOOTER_SIGNATURE.toLowerCase()) } : null);
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
  // Always enforce the greeting: a known first name, else "Hi there". Whatever
  // "Hi/Hello/Hey ...," the model opened with (including "Hi <Business> team,")
  // is replaced. Anything that does not start with hi/hello/hey is left alone.
  const target = greeting || "Hi there";
  const opener = /^(\s*(?:<p>)?\s*)(?:hi|hello|hey)\b[^,\n<]{0,80},/i;
  const fixGreeting = (s: string) => s.replace(opener, `$1${target},`);
  return {
    ...draft,
    subject: fixLen(draft.subject),
    body_text: fixGreeting(fixLen(draft.body_text)),
    body_html: fixGreeting(fixLen(draft.body_html)),
  };
}

/**
 * The greeting for a lead, or null when no person's first name is known (the
 * draft then opens with "Hi there,"). A business name is never used: scraped
 * leads only have a business name, so they get "Hi there,". A first name comes
 * from an explicit `contact_name`, or from a test lead's person-like name.
 */
export function greetingFor(lead: { name?: string | null; contact_name?: string | null; is_test?: boolean }): string | null {
  const personal = (lead.contact_name ?? "").trim() || (lead.is_test ? (lead.name ?? "").trim() : "");
  if (!personal || /@/.test(personal)) return null;
  // A test lead added without a name gets its email's local part as the name
  // (e.g. "shiftforge.ai+t4") — not something to greet.
  if (!/\s/.test(personal) && /[.+_\d]/.test(personal) && personal === personal.toLowerCase()) return null;
  const first = personal.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, "");
  if (!first) return null;
  return `Hi ${first}`;
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

// ── Lead quality filters ──────────────────────────────────────────────
// Skip leads that should never be cold-emailed: government / school
// addresses, big chains and franchise stores, and businesses outside the
// campaign's state. Computed on the fly (nothing stored), so it also applies to
// leads imported before these filters existed.

/** .gov / .edu / .mil addresses, including country forms (gov.uk, edu.au) and US state/K-12 domains. */
export function isGovEduEmail(email: string | null | undefined): boolean {
  const at = (email ?? "").toLowerCase().trim().split("@")[1];
  if (!at) return false;
  const labels = at.split(".");
  const last = labels[labels.length - 1];
  const prev = labels[labels.length - 2] ?? "";
  if (["gov", "edu", "mil"].includes(last)) return true;
  if (last.length === 2 && ["gov", "edu", "mil", "ac"].includes(prev)) return true; // gov.uk, edu.au, ac.uk
  if (last === "us" && (labels.includes("state") || labels.includes("k12") || labels.includes("fed"))) return true;
  return false;
}

// Known national chains / franchise brands. Matched as whole words in the
// business name, or against the website host. Extend this list as needed.
const CHAIN_NAMES = [
  "lennox", "trane", "rheem", "service experts", "aire serv", "one hour heating",
  "ars rescue rooter", "rescue rooter", "roto-rooter", "benjamin franklin plumbing", "mr. rooter", "mr rooter",
  "mr. handyman", "mr handyman", "servicemaster", "servpro", "terminix", "orkin", "rentokil", "trugreen",
  "home depot", "the home depot", "lowe's", "lowes", "best buy", "walmart", "costco", "sam's club",
  "ace hardware", "menards", "johnstone supply", "grainger", "fastenal",
  "mcdonald's", "mcdonalds", "starbucks", "burger king", "wendy's", "wendys", "taco bell", "kfc",
  "chick-fil-a", "chipotle", "domino's", "dominos", "pizza hut", "papa john's", "panera", "applebee's",
  "chili's", "olive garden", "ihop", "denny's", "dennys", "waffle house", "buffalo wild wings", "sonic drive-in",
  "jiffy lube", "firestone", "pep boys", "autozone", "o'reilly auto", "advance auto", "napa auto",
  "supercuts", "great clips", "sport clips", "planet fitness", "anytime fitness", "la fitness", "24 hour fitness",
  "h&r block", "state farm", "allstate", "farmers insurance", "geico", "liberty tax", "jackson hewitt",
  "cvs", "walgreens", "rite aid", "7-eleven", "circle k", "chevron", "exxon", 
  "wells fargo", "bank of america", "chase bank", "citibank", "us bank",
];
const CHAIN_HOSTS = [
  "lennox.com", "lennoxpros.com", "homedepot.com", "lowes.com", "sears.com", "walmart.com",
  "servicemaster.com", "servpro.com", "terminix.com", "orkin.com", "aireserv.com", "onehourheatandair.com",
  "rotorooter.com", "mrrooter.com", "mrhandyman.com", "acehardware.com", "mcdonalds.com",
  "starbucks.com", "statefarm.com", "allstate.com", "farmers.com", "geico.com",
];

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const CHAIN_RX = new RegExp(`(?:^|[^a-z0-9])(?:${CHAIN_NAMES.map(escapeRx).join("|")})(?:$|[^a-z0-9])`, "i");

export function isChainBusiness(name: string | null | undefined, website: string | null | undefined): boolean {
  const n = (name ?? "").toLowerCase();
  if (n && CHAIN_RX.test(n)) return true;
  const host = websiteKey(website ?? null)?.split("/")[0] ?? "";
  return !!host && CHAIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(US_STATES));

/** Best-effort 2-letter US state from free text ("Houston, TX 77002", "Houston, Texas", "TX"). Null when unknown. */
export function usStateOf(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (/^[A-Za-z]{2}$/.test(t) && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  // "..., TX 77002" or "..., TX" at the end / before a country
  const code = t.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?(?:,\s*(?:USA|US|United States))?\s*$/);
  if (code && STATE_CODES.has(code[1])) return code[1];
  const low = t.toLowerCase();
  // Longest state names first so "west virginia" wins over "virginia".
  for (const name of Object.keys(US_STATES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(?:^|[^a-z])${name}(?:$|[^a-z])`).test(low)) return US_STATES[name];
  }
  return null;
}

export type SkipReason = { code: "gov_edu_email" | "chain" | "out_of_state"; message: string };

/**
 * Why a lead should be skipped for email finding / drafting, or null when it
 * is fine. `campaignLocation` is the campaign's search location ("Houston, TX").
 * Out-of-state only triggers when BOTH states are known and differ.
 */
export function leadSkipReason(
  lead: { name?: string | null; email?: string | null; website?: string | null; address?: string | null; is_test?: boolean; raw?: unknown },
  campaignLocation: string | null | undefined,
): SkipReason | null {
  if (lead.is_test) return null;
  if (isGovEduEmail(lead.email)) return { code: "gov_edu_email", message: "Skipped: .gov/.edu address" };
  if (isChainBusiness(lead.name, lead.website)) return { code: "chain", message: "Skipped: chain / franchise store" };
  const rawState = (lead.raw && typeof lead.raw === "object" ? (lead.raw as { state?: unknown }).state : null) as string | null;
  const leadState = usStateOf(typeof rawState === "string" ? rawState : null) ?? usStateOf(lead.address);
  const wantState = usStateOf(campaignLocation);
  if (leadState && wantState && leadState !== wantState) {
    return { code: "out_of_state", message: `Skipped: out of state (${leadState}, campaign is ${wantState})` };
  }
  return null;
}
