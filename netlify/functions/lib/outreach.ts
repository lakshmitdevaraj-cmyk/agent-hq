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
  // don't print it twice. Only the LAST non-empty line counts: a name that merely
  // appears near the end ("Thanks for reading, Lakshmi is based in...") is not a sign-off.
  const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
  const norm = (x: string) => x.toLowerCase().replace(/[\s,.;:!-]+$/, "").trim();
  const alreadySigned = !!senderName && !!senderName.trim() && lines.length > 0 && norm(lines[lines.length - 1]) === norm(senderName);
  const f = buildFooter(postalAddress, senderName, alreadySigned ? { hasCompany: false } : null);
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
  opts: { firstEmail?: boolean } = {},
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
    // The first email of a thread is never a reply: drop any "Re:" / "Fwd:" the model added.
    subject: opts.firstEmail ? fixLen(draft.subject).replace(/^\s*(?:(?:re|fwd?)\s*:\s*)+/i, "").trim() : fixLen(draft.subject),
    body_text: fixGreeting(fixLen(draft.body_text)),
    body_html: fixGreeting(fixLen(draft.body_html)),
  };
}

const BUSINESS_WORDS = /\b(air|hvac|heating|cooling|plumbing|electric\w*|roofing|services?|experts?|pros?|company|co\.?|inc\.?|llc|usa|group|solutions|mechanical|conditioning|a\/c|ac)\b/i;

/**
 * The greeting for a lead, or null when no person's first name is known (the
 * draft then opens with "Hi there,"). A business name is never used: scraped
 * leads only have a business name, so they get "Hi there,". A first name comes
 * from an explicit `contact_name`, or from a test lead's person-like name.
 */
export function greetingFor(lead: { name?: string | null; contact_name?: string | null; is_test?: boolean; website?: string | null; owner_name?: string | null; owner_confidence?: string | null }): string | null {
  // The code, never the model, decides who is greeted. Only a confirmed owner (high confidence, or typed in by
  // the user) is used; a weak match ("low") or a business name always gives "Hi there,".
  if (lead.owner_name && lead.owner_confidence && lead.owner_confidence !== "high") return null;
  // A test lead's own name stands for a person only when it is not a business: leads copied from a real
  // website (they have one) are named after the business, so greeting them by name would be wrong.
  const testName = lead.is_test && !(lead.website ?? "").trim() && !BUSINESS_WORDS.test(lead.name ?? "") ? (lead.name ?? "").trim() : "";
  const personal = (lead.contact_name ?? "").trim() || testName;
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;
    // Gmail wraps the quote header over two lines: "On Thu, 19 Nov 2026 at 15:41, Name <" + "addr@x.com> wrote:".
    const twoLine = /^\s*on\s.{3,200}$/i.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? "") && (line + (lines[i + 1] ?? "")).length < 400;
    if (/^\s*on .{5,200}wrote:\s*$/i.test(line) || twoLine || /^\s*-{2,}\s*original message/i.test(line) || /^\s*from:\s.+/i.test(line) && out.length > 0) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export const AUTO_REPLY = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|undeliverable|delivery status|mailer-daemon|vacation)/i;

/** Out-of-office, bounce and other automatic messages (subject or the start of the new text). */
export function isAutoReply(subject: string | null | undefined, text: string | null | undefined): boolean {
  return AUTO_REPLY.test(subject ?? "") || AUTO_REPLY.test(newPartOfReply(text ?? "").slice(0, 300));
}

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
  "mr. electric", "mr electric", "mister sparky", "ies residential", "ies commercial", "mr. appliance", "mr appliance",
  "molly maid", "window genie", "dryer vent wizard", "one hour air conditioning", "american home shield", "frontdoor",
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
  "mrelectric.com", "mollymaid.com", "mrappliance.com", "neighborly.com", "iesresidential.com", "mistersparky.com",
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

export type SkipReason = {
  code: "gov_edu_email" | "chain" | "out_of_state" | "placeholder_email" | "other_trade" | "excluded";
  message: string;
};

/**
 * Why a lead should be skipped for email finding / drafting, or null when it
 * is fine. `campaign` is the campaign's search location ("Houston, TX") or
 * `{ location, query }`, where `query` is the campaign's trade/ICP text.
 * Out-of-state only triggers when BOTH states are known and differ; a wrong
 * trade only when the campaign's trade and the lead's trade are both known and
 * do not overlap.
 */
export function leadSkipReason(
  lead: { name?: string | null; email?: string | null; website?: string | null; address?: string | null; category?: string | null; excluded?: boolean; trade_override?: boolean; is_test?: boolean; raw?: unknown },
  campaign: string | null | undefined | { location?: string | null; query?: string | null; anyTrade?: boolean },
): SkipReason | null {
  if (lead.excluded) return { code: "excluded", message: "Excluded by you" };
  if (lead.is_test) return null;
  const campaignLocation = typeof campaign === "string" || !campaign ? campaign : campaign.location;
  const campaignQuery = campaign && typeof campaign === "object" ? campaign.query : null;
  if (isGovEduEmail(lead.email)) return { code: "gov_edu_email", message: "Skipped: .gov/.edu address" };
  if (lead.email && isJunkEmail(lead.email)) return { code: "placeholder_email", message: "Skipped: placeholder email address" };
  if (isChainBusiness(lead.name, lead.website)) return { code: "chain", message: "Skipped: chain / franchise store" };
  const rawState = (lead.raw && typeof lead.raw === "object" ? (lead.raw as { state?: unknown }).state : null) as string | null;
  const leadState = usStateOf(typeof rawState === "string" ? rawState : null) ?? usStateOf(lead.address);
  const wantState = usStateOf(campaignLocation);
  if (leadState && wantState && leadState !== wantState) {
    return { code: "out_of_state", message: `Skipped: out of state (${leadState}, campaign is ${wantState})` };
  }
  // "Home services, any trade" campaigns, or a lead you chose to include anyway, skip the trade check.
  const anyTrade = !!(campaign && typeof campaign === "object" && campaign.anyTrade) || lead.trade_override === true;
  const wantTrades = anyTrade ? new Set<string>() : tradesOf(campaignQuery);
  const leadTrades = tradesOf(`${lead.category ?? ""} ${lead.name ?? ""}`);
  if (wantTrades.size > 0 && leadTrades.size > 0 && ![...leadTrades].some((t) => wantTrades.has(t))) {
    return { code: "other_trade", message: `Skipped: different trade (${[...leadTrades].join(", ")})` };
  }
  return null;
}


// ── Finding email addresses on a web page ─────────────────────────────

/** Remove parts of a page whose "emails" are never real contacts: forms (placeholders like johndoe@email.com), scripts, styles, comments. */
export function stripNonContactHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|form|textarea|select|option|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<input\b[^>]*>/gi, " ")
    .replace(/\s(?:placeholder|value|data-[\w-]+|alt|title|content)\s*=\s*(?:"[^"]*"|'[^']*')/gi, " ");
}

const EMAIL_SHAPE = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** Clean stray characters off a scraped address (leading slashes, quotes, %20, JSON-escaped "u003e", trailing dots). Null if it is not an address. */
export function cleanEmail(raw: string | null | undefined): string | null {
  let e = (raw ?? "").trim();
  try { e = decodeURIComponent(e); } catch { /* keep as is */ }
  e = e
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/^(?:u003[ce]|x3[ce]|&[lg]t;)+/i, "")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  return EMAIL_SHAPE.test(e) ? e : null;
}

const JUNK_DOMAINS = [
  "example.com", "example.org", "example.net", "email.com", "contractor.com", "sentry.io", "wixpress.com",
  "sentry-next.wixpress.com", "domain.com", "yourdomain.com", "yoursite.com", "mysite.com", "website.com", "test.com", "sample.com",
];
const PLACEHOLDER_LOCALS = new Set([
  "johndoe", "janedoe", "john.doe", "jane.doe", "yourname", "youremail", "your.email", "youremailaddress", "your-email",
  "first.last", "firstlast", "firstname.lastname", "username", "email", "name", "user", "someone", "test", "noreply", "no-reply",
]);

/** Placeholder / tracking / asset-looking addresses that are never a business contact. */
export function isJunkEmail(email: string | null | undefined): boolean {
  const e = cleanEmail(email);
  if (!e) return true;
  const [local, domain] = e.split("@");
  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  if (PLACEHOLDER_LOCALS.has(local)) return true;
  if (/^[a-f0-9]{16,}$/.test(local)) return true; // random hex ids (sentry, wix, trackers)
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?)$/.test(e)) return true;
  if (/@\d+x\./.test(e)) return true; // image.png@2x.png
  return false;
}

/** All plausible contact addresses on a page: mailto links first, then visible text. Junk removed, order kept, no duplicates. */
export function extractEmailsFromHtml(html: string): string[] {
  const body = stripNonContactHtml(html);
  const out: string[] = [];
  const add = (raw: string) => {
    const e = cleanEmail(raw);
    if (e && !isJunkEmail(e) && !out.includes(e)) out.push(e);
  };
  for (const m of body.matchAll(/href\s*=\s*["']\s*mailto:([^"'?\s>]+)/gi)) add(m[1]);
  const text = body.replace(/<[^>]+>/g, " ");
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) add(m[0]);
  return out;
}

// ── Trades (so an electrician does not land in an HVAC campaign) ──────

const TRADE_PATTERNS: Array<[string, RegExp]> = [
  ["hvac", /\b(?:hvac|heating|cooling|air[\s-]*conditioning|a\/c|ac|furnace|heat pump|refrigeration)\b/i],
  ["electrical", /\belectric(?:al|ian|ians)?\b/i],
  ["plumbing", /\b(?:plumb\w*|rooter|drain\w*|sewer|septic|water heater)\b/i],
  ["roofing", /\broof\w*\b/i],
  ["pest", /\b(?:pest|exterminat\w*|termite|rodent)\b/i],
  ["restoration", /\b(?:restoration|water damage|fire damage|mold|remediation)\b/i],
  ["landscaping", /\b(?:landscap\w*|lawn|tree service|irrigation|sprinkler)\b/i],
  ["cleaning", /\b(?:cleaning|maid|janitorial|carpet)\b/i],
  ["garage", /\bgarage door\w*\b/i],
  ["painting", /\bpaint(?:ing|er|ers)?\b/i],
  ["solar", /\bsolar\b/i],
  ["pool", /\bpool\b/i],
];

/** Which trades a piece of text (business name, category, campaign query) mentions. Empty = unknown. */
export function tradesOf(text: string | null | undefined): Set<string> {
  const t = (text ?? "").toLowerCase();
  const out = new Set<string>();
  for (const [name, rx] of TRADE_PATTERNS) if (rx.test(t)) out.add(name);
  return out;
}
