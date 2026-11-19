/**
 * Website check helpers (pure, no network): spot automation on a business's
 * website, collect social/contact LINKS (we never fetch LinkedIn or Facebook),
 * find the owner's name, and turn it all into an explainable gap score.
 */

// ── Gap score weights: change them here, nowhere else ─────────────────
export const GAP_WEIGHTS = {
  noChat: 30,
  noBooking: 30,
  contactFormOnly: 10, // a contact form but neither chat nor online booking
  noWhatsapp: 5,
  weakReputation: 10, // rating below GAP_RATING_MIN, or fewer than GAP_REVIEWS_MIN reviews
  closedEveningsOrWeekends: 15,
} as const;
export const GAP_RATING_MIN = 4.3;
export const GAP_REVIEWS_MIN = 30;

/** Pages fetched for one check (homepage, contact pages, About pages). */
export const SITE_CHECK_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/our-story", "/our-team", "/team", "/meet-the-owner"];

export type Page = { url: string; html: string };

// ── Automation signals ────────────────────────────────────────────────

const CHAT_WIDGETS: Array<[string, RegExp]> = [
  ["Tidio", /code\.tidio\.co|tidiochat|tidio\.net/i],
  ["Intercom", /widget\.intercom\.io|intercomSettings|intercom-frame/i],
  ["Drift", /js\.driftt\.com|drift\.com\/|driftt\.com|window\.drift\b/i],
  ["LiveChat", /cdn\.livechatinc\.com|livechatinc\.com|__lc\.license|livechat\.com\/chat/i],
  ["Tawk.to", /embed\.tawk\.to|tawk\.to\//i],
  ["Crisp", /client\.crisp\.chat|crisp\.chat|\$crisp/i],
  ["HubSpot chat", /js\.usemessages\.com|hs-conversations|conversations-embed|HubSpotConversations/i],
  ["Podium", /connect\.podium\.com|podium\.com\/widget|podiumwebchat|podium-webchat/i],
  ["Birdeye", /birdeye\.com|birdeyewebchat|bf-widget/i],
  ["Facebook Messenger", /fb-customerchat|customerchat\.js|messenger\.com\/|data-page-id/i],
  ["Zendesk", /static\.zdassets\.com|zopim|zendesk\.com\/embeddable|ze-snippet/i],
];

const BOOKING_TOOLS: Array<[string, RegExp]> = [
  ["Calendly", /calendly\.com/i],
  ["Housecall Pro", /housecallpro\.com|housecall\s?pro|online-booking\.housecallpro/i],
  ["Jobber", /getjobber\.com|clienthub\.getjobber|jobber\.com\/(?:client|request)|jobber work request/i],
  ["ServiceTitan", /servicetitan\.com|scheduler\.servicetitan|st-scheduler/i],
  ["Acuity", /acuityscheduling\.com|squarespacescheduling\.com|app\.acuityscheduling/i],
  ["Square Appointments", /squareup\.com\/appointments|square\.site\/book|book\.squareup\.com/i],
  ["Setmore", /setmore\.com/i],
  ["Booksy", /booksy\.com/i],
  ["Workiz", /workiz\.com/i],
];

// Visible link text that clearly offers online booking.
const BOOK_LINK_TEXT = /^\s*(?:book\s+(?:online|now|an?\s+appointment|a\s+(?:service|visit|call))|schedule\s+(?:online|service|now|an?\s+appointment)|online\s+(?:booking|scheduling)|request\s+(?:an?\s+)?appointment)\s*$/i;

const WHATSAPP_RX = /https?:\/\/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\/[^\s"'<>)]*/i;

export type Signals = {
  chat_widget: string | null;
  booking_tool: string | null;
  has_contact_form: boolean;
  whatsapp_url: string | null;
  contact_form_url: string | null;
};

type Anchor = { href: string; text: string };

/** Every <a href> with its visible text, hrefs resolved against the page URL. */
export function extractAnchors(html: string, base: string): Anchor[] {
  const out: Anchor[] = [];
  const rx = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) {
    const raw = (m[1] ?? m[2] ?? "").trim().replace(/&amp;/g, "&");
    // "#book" style links are kept: a "Book online" button often opens a booking pop-up.
    if (!raw || /^(?:mailto|tel|javascript):/i.test(raw)) continue;
    let href: string;
    try {
      href = new URL(raw, base).toString();
    } catch {
      continue;
    }
    out.push({ href, text: m[3].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** A form that asks for contact details (email/phone/message). Search and one-field newsletter forms do not count. */
function hasContactForm(html: string): boolean {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  return forms.some((f) => {
    if (/role\s*=\s*["']search["']|type\s*=\s*["']search["']|action\s*=\s*["'][^"']*\/search/i.test(f)) return false;
    const hasTextarea = /<textarea\b/i.test(f);
    const hasEmail = /type\s*=\s*["']email["']|name\s*=\s*["'][^"']*e-?mail/i.test(f);
    const hasPhone = /type\s*=\s*["']tel["']|name\s*=\s*["'][^"']*phone/i.test(f);
    const inputs = (f.match(/<input\b(?![^>]*type\s*=\s*["'](?:hidden|submit|button|checkbox)["'])/gi) ?? []).length;
    return hasTextarea || ((hasEmail || hasPhone) && inputs >= 2);
  });
}

export function detectSignals(pages: Page[]): { signals: Signals; sources: Record<string, string> } {
  const signals: Signals = { chat_widget: null, booking_tool: null, has_contact_form: false, whatsapp_url: null, contact_form_url: null };
  const sources: Record<string, string> = {};
  for (const p of pages) {
    if (!signals.chat_widget) {
      const hit = CHAT_WIDGETS.find(([, rx]) => rx.test(p.html));
      if (hit) { signals.chat_widget = hit[0]; sources.chat_widget = p.url; }
    }
    if (!signals.booking_tool) {
      const hit = BOOKING_TOOLS.find(([, rx]) => rx.test(p.html));
      if (hit) { signals.booking_tool = hit[0]; sources.booking_tool = p.url; }
      else if (extractAnchors(p.html, p.url).some((a) => BOOK_LINK_TEXT.test(a.text))) {
        signals.booking_tool = "Book online link";
        sources.booking_tool = p.url;
      }
    }
    if (!signals.whatsapp_url) {
      const m = p.html.match(WHATSAPP_RX);
      if (m) { signals.whatsapp_url = m[0].replace(/&amp;/g, "&"); sources.whatsapp_url = p.url; }
    }
    if (hasContactForm(p.html)) {
      signals.has_contact_form = true;
      // Prefer a page that is obviously a contact page.
      if (!signals.contact_form_url || (/contact/i.test(p.url) && !/contact/i.test(signals.contact_form_url))) {
        signals.contact_form_url = p.url;
        sources.contact_form_url = p.url;
      }
    }
  }
  return { signals, sources };
}

// ── Social and review links (links only) ──────────────────────────────

export type Social = {
  linkedin_company: string | null;
  linkedin_person: string | null;
  facebook: string | null;
  instagram: string | null;
  yelp: string | null;
  nextdoor: string | null;
  google_reviews: string | null;
};
export const emptySocial = (): Social => ({ linkedin_company: null, linkedin_person: null, facebook: null, instagram: null, yelp: null, nextdoor: null, google_reviews: null });

function classifyLink(href: string): keyof Social | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname;
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    if (/^\/company\/[^/]+/i.test(path)) return "linkedin_company";
    if (/^\/(?:in|pub)\/[^/]+/i.test(path)) return "linkedin_person";
    return null;
  }
  if (host === "facebook.com" || host === "m.facebook.com" || host === "fb.com") {
    if (/^\/(?:sharer|share|plugins|dialog|tr|login|policies|help|legal)\b/i.test(path) || path === "/" || /sharer\.php|share\.php/i.test(path)) return null;
    return "facebook";
  }
  if (host === "instagram.com") {
    if (/^\/(?:p|reel|reels|explore|accounts|stories|tv)\b/i.test(path) || path === "/") return null;
    return "instagram";
  }
  if (host === "yelp.com" || host.endsWith(".yelp.com")) return /^\/biz\//i.test(path) ? "yelp" : null;
  if (host === "nextdoor.com") return /^\/(?:pages|page|business|b)\//i.test(path) ? "nextdoor" : null;
  if (host === "g.page" || host === "maps.app.goo.gl" || host === "g.co") return "google_reviews";
  if (host === "search.google.com" && /\/local\/(?:writereview|reviews)/i.test(path)) return "google_reviews";
  if ((host === "google.com" || host.endsWith(".google.com")) && /^\/maps\/place|^\/maps\?/i.test(path)) return "google_reviews";
  if (host === "goo.gl" && /^\/maps\//i.test(path)) return "google_reviews";
  return null;
}

export function extractSocial(pages: Page[]): { social: Social; sources: Record<string, string> } {
  const social = emptySocial();
  const sources: Record<string, string> = {};
  for (const p of pages) {
    for (const a of extractAnchors(p.html, p.url)) {
      const kind = classifyLink(a.href);
      if (!kind || social[kind]) continue;
      social[kind] = a.href.split("#")[0];
      sources[kind] = p.url;
    }
  }
  return { social, sources };
}

// ── Owner / founder ───────────────────────────────────────────────────

/** A founder page can honour someone who has died ("In memoriam", "the late ..."): never greet them. */
const DECEASED = /in memoriam|in loving memory|passed away|the late\b|rest in peace|\bR\.?I\.?P\b|deceased|\(\s*19\d\d\s*[-–]\s*(?:19|20)\d\d\s*\)/i;

export type Owner = { name: string; source_url: string; confidence: "high" | "low"; how: string };

const NAME_STOP = new Set([
  "our", "the", "meet", "about", "us", "team", "staff", "operated", "owned", "since", "family", "company", "services", "service", "home", "homes",
  "contact", "welcome", "this", "that", "your", "my", "we", "you", "and", "of", "in", "at", "for", "with", "by", "from", "to", "licensed", "insured",
  "free", "call", "now", "today", "best", "top", "local", "proudly", "serving", "years", "experience", "customer", "customers", "owner", "founder",
  "president", "ceo", "manager", "technician", "plumber", "electrician", "hvac", "texas", "houston", "dallas", "austin", "sugar", "land", "woodlands",
]);
const BUSINESS_WORDS = /\b(inc|llc|ltd|co|corp|corporation|company|services?|plumbing|heating|cooling|air|hvac|electric|electrical|roofing|brothers|bros|sons|group|solutions|contractors?|construction|repair|restoration|landscaping|pest|control|cleaning|associates|enterprises|systems|mechanical|supply|heating|conditioning|and|the|our|us|about|team|staff)\b/i;

/** True for something that looks like a real person's name (2-3 capitalised words, no business words). */
export function validPersonName(name: string | null | undefined, businessName?: string | null): boolean {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.length > 40) return false;
  if (businessName && n.toLowerCase() === businessName.trim().toLowerCase()) return false;
  if (BUSINESS_WORDS.test(n)) return false;
  const parts = n.split(" ");
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((p) => /^(?:[A-Z][a-z]+(?:['-][A-Z][a-z]+)?|[A-Z]\.)$/.test(p) && !NAME_STOP.has(p.toLowerCase()));
}

/** Remove whole elements whose class/id says testimonial/review (depth-aware), plus blockquotes. */
export function stripTestimonials(html: string): string {
  let out = html.replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, " ");
  const open = /<(div|section|ul|li|article|aside)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:testimonial|review|quote)[^"']*["'][^>]*>/i;
  for (let guard = 0; guard < 50; guard++) {
    const m = open.exec(out);
    if (!m) break;
    const tag = m[1].toLowerCase();
    const start = m.index;
    let depth = 1;
    const rx = new RegExp(`<(/?)${tag}\\b`, "gi");
    rx.lastIndex = start + m[0].length;
    let end = out.length;
    let t: RegExpExecArray | null;
    while ((t = rx.exec(out))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = out.indexOf(">", t.index) + 1 || out.length; break; }
    }
    out = out.slice(0, start) + " " + out.slice(end);
  }
  return out;
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, " . ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
/** Visible text of a page without testimonial/review blocks; used for owner patterns and the Gemini fallback. */
export function pageText(html: string): string {
  return visibleText(stripTestimonials(html));
}

const NAME = "([A-Z][a-z]+(?:['-][A-Z][a-z]+)?(?:\\s+[A-Z]\\.)?\\s+[A-Z][a-z]+(?:['-][A-Z][a-z]+)?)";
const ROLE = "(?:[Oo]wner|[Ff]ounder|[Cc]o-?[Ff]ounder|[Pp]resident|CEO)";
// "Owner", "Owner and President", "Founder / CEO": a heading that may stack several titles.
const ROLES = `${ROLE}(?:\\s*(?:and|&|/|,)\\s*(?:${ROLE}|[Oo]perator|[Gg]eneral [Mm]anager))*`;
const OWNER_PATTERNS: Array<{ rx: RegExp; how: string; confidence: "high" | "low" }> = [
  { rx: new RegExp(`(?:[Ff]ounded|[Oo]wned|[Ss]tarted|[Ee]stablished|[Rr]un|[Oo]perated)(?:\\s+in\\s+\\d{4})?(?:\\s+and\\s+(?:[Oo]perated|[Oo]wned|[Rr]un))?\\s+by\\s+${NAME}\\b(?!\\s+and\\b)`, "g"), how: "founded/owned by", confidence: "high" },
  { rx: new RegExp(`${NAME},?\\s+(?:the\\s+|our\\s+|is\\s+the\\s+|is\\s+our\\s+)?${ROLES}\\b`, "g"), how: "name, owner/founder", confidence: "high" },
  { rx: new RegExp(`\\b${ROLES}(?:\\s*[:\\-–—|.]\\s*|\\s+)${NAME}`, "g"), how: "owner: name", confidence: "high" },
  { rx: new RegExp(`\\b[Mm]eet\\s+(?:the\\s+owner,?\\s+|our\\s+(?:owner|founder),?\\s+)?${NAME}`, "g"), how: "meet name", confidence: "low" },
];

function ldPeople(html: string): Array<{ name: string; role: string }> {
  const out: Array<{ name: string; role: string }> = [];
  const blocks = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const walk = (node: unknown, role: string) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, role)); return; }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o["@graph"])) walk(o["@graph"], role);
    const type = String(o["@type"] ?? "");
    if (/Person/i.test(type) && typeof o.name === "string") {
      const job = typeof o.jobTitle === "string" ? o.jobTitle : "";
      if (DECEASED.test(`${job} ${typeof o.description === "string" ? o.description : ""}`)) return;
      if (role || /owner|founder|president|ceo/i.test(job)) out.push({ name: o.name, role: role || job });
    }
    for (const k of ["founder", "founders", "owner"]) if (o[k]) walk(o[k], k);
    for (const v of Object.values(o)) if (v && typeof v === "object" && !Array.isArray(v) && !role) walk(v, "");
  };
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try { walk(JSON.parse(body), ""); } catch { /* ignore broken JSON-LD */ }
  }
  return out;
}

/**
 * Owner/founder from visible text patterns and schema.org JSON-LD. About pages
 * are searched first. Business-like names, testimonial names and staff lists
 * without a role are rejected. Null when nothing clear is found.
 */
export function findOwner(pages: Page[], businessName?: string | null): Owner | null {
  const aboutFirst = [...pages].sort((a, b) => Number(/about|story|team|owner/i.test(b.url)) - Number(/about|story|team|owner/i.test(a.url)));
  let low: Owner | null = null;
  for (const p of aboutFirst) {
    for (const person of ldPeople(p.html)) {
      const name = person.name.replace(/\s+/g, " ").trim();
      if (validPersonName(name, businessName)) return { name, source_url: p.url, confidence: "high", how: "schema.org founder" };
    }
    const text = pageText(p.html);
    for (const pat of OWNER_PATTERNS) {
      pat.rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.rx.exec(text))) {
        const name = m[1].replace(/\s+/g, " ").trim();
        if (!validPersonName(name, businessName)) continue;
        if (DECEASED.test(text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 160))) continue;
        if (pat.confidence === "high") return { name, source_url: p.url, confidence: "high", how: pat.how };
        low ??= { name, source_url: p.url, confidence: "low", how: pat.how };
        break;
      }
    }
  }
  return low;
}

// ── Opening hours ─────────────────────────────────────────────────────

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type DayHours = { day: string; closed: boolean; open?: number; close?: number; text: string };

function toMinutes(h: string, m: string | undefined, mer: string | undefined): number {
  let hh = Number(h) % 12;
  if (/p/i.test(mer ?? "")) hh += 12;
  return hh * 60 + Number(m ?? 0);
}

/** "7 AM to 6 PM", "8:30 AM – 5 PM", "9 AM to 12 PM, 1 to 5 PM", "Closed", "Open 24 hours". */
function parseDayText(text: string): Pick<DayHours, "closed" | "open" | "close"> {
  const t = text.replace(/[   ]/g, " ").trim();
  if (/closed/i.test(t) && !/\d/.test(t)) return { closed: true };
  if (/24\s*hours|open 24/i.test(t)) return { closed: false, open: 0, close: 24 * 60 };
  const rx = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:to|-|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi;
  let open: number | undefined;
  let close: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(t))) {
    const end = toMinutes(m[4], m[5], m[6]);
    let start = toMinutes(m[1], m[2], m[3] ?? m[6]);
    if (!m[3] && start > end) start = toMinutes(m[1], m[2], "AM");
    open = open === undefined ? start : Math.min(open, start);
    close = close === undefined ? end : Math.max(close, end);
  }
  if (open === undefined || close === undefined) return { closed: false };
  return { closed: false, open, close };
}

export function parseOpeningHours(raw: unknown): DayHours[] | null {
  const list = raw && typeof raw === "object" ? (raw as { openingHours?: unknown }).openingHours : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: DayHours[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const r = row as { day?: unknown; hours?: unknown };
    const day = DAYS.find((d) => typeof r.day === "string" && r.day.toLowerCase().startsWith(d.slice(0, 3).toLowerCase()));
    if (!day || typeof r.hours !== "string") continue;
    out.push({ day, text: r.hours.trim(), ...parseDayText(r.hours) });
  }
  return out.length >= 3 ? out : null;
}

const fmt = (min: number) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "PM" : "AM"}`;
};

export type HoursInfo = { summary: string; closedDays: string[]; closesEarlyWeekdays: boolean; closedWeekend: boolean };

export function hoursInfo(raw: unknown): HoursInfo | null {
  const days = parseOpeningHours(raw);
  if (!days) return null;
  const by = new Map(days.map((d) => [d.day, d]));
  const closedDays = DAYS.filter((d) => by.get(d)?.closed);
  const weekdays = DAYS.slice(0, 5).map((d) => by.get(d)).filter((d): d is DayHours => !!d && !d.closed && d.close !== undefined);
  const closesEarlyWeekdays = weekdays.length > 0 && weekdays.every((d) => (d.close as number) <= 17 * 60);
  const closedWeekend = ["Saturday", "Sunday"].some((d) => by.get(d)?.closed);
  // Compact summary: group consecutive days with identical hours.
  const parts: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    const d = by.get(DAYS[i]);
    if (!d) { i++; continue; }
    let j = i;
    while (j + 1 < DAYS.length && by.get(DAYS[j + 1])?.text === d.text) j++;
    const label = i === j ? DAYS[i].slice(0, 3) : `${DAYS[i].slice(0, 3)}-${DAYS[j].slice(0, 3)}`;
    const hrs = d.closed ? "closed" : d.open !== undefined && d.close !== undefined ? `${fmt(d.open)} to ${fmt(d.close)}` : d.text;
    parts.push(`${label} ${hrs}`);
    i = j + 1;
  }
  return { summary: parts.join("; "), closedDays, closesEarlyWeekdays, closedWeekend };
}

// ── Gap score ─────────────────────────────────────────────────────────

export type GapResult = { score: number; reasons: string[] };

/** Explainable 0-100 automation gap. Only call it for a lead whose website was actually fetched. */
export function gapScore(
  lead: { rating?: number | null; reviews_count?: number | null; raw?: unknown },
  s: Pick<Signals, "chat_widget" | "booking_tool" | "has_contact_form" | "whatsapp_url">,
): GapResult {
  let score = 0;
  const reasons: string[] = [];
  if (!s.chat_widget) { score += GAP_WEIGHTS.noChat; reasons.push("No chat"); }
  if (!s.booking_tool) { score += GAP_WEIGHTS.noBooking; reasons.push("No online booking"); }
  if (s.has_contact_form && !s.chat_widget && !s.booking_tool) { score += GAP_WEIGHTS.contactFormOnly; reasons.push("Contact form only"); }
  if (!s.whatsapp_url) { score += GAP_WEIGHTS.noWhatsapp; reasons.push("No WhatsApp"); }
  const lowRating = typeof lead.rating === "number" && lead.rating < GAP_RATING_MIN;
  const fewReviews = typeof lead.reviews_count === "number" && lead.reviews_count < GAP_REVIEWS_MIN;
  if (lowRating || fewReviews) {
    score += GAP_WEIGHTS.weakReputation;
    reasons.push(lowRating && fewReviews ? "Low rating, few reviews" : lowRating ? `Rating ${lead.rating}` : `Only ${lead.reviews_count} reviews`);
  }
  const h = hoursInfo(lead.raw);
  if (h && (h.closedWeekend || h.closesEarlyWeekdays)) {
    score += GAP_WEIGHTS.closedEveningsOrWeekends;
    if (h.closedDays.length > 0) reasons.push(h.closedDays.length >= 2 && h.closedWeekend ? "Closed weekends" : `Closed ${h.closedDays.map((d) => `${d}s`).join(", ")}`);
    if (h.closesEarlyWeekdays) reasons.push("Closes by 5 pm");
  }
  return { score: Math.min(100, score), reasons };
}

/** Ways to reach a lead other than email (for leads with no usable address). */
export function reachAnotherWay(lead: { social?: Partial<Social> | null; site_check?: { whatsapp_url?: string | null; contact_form_url?: string | null } | null }): Array<{ kind: string; url: string }> {
  const out: Array<{ kind: string; url: string }> = [];
  const sc = lead.site_check;
  if (sc?.contact_form_url) out.push({ kind: "contact_form", url: sc.contact_form_url });
  const so = lead.social ?? {};
  if (so.facebook) out.push({ kind: "facebook", url: so.facebook });
  if (so.instagram) out.push({ kind: "instagram", url: so.instagram });
  if (so.linkedin_company) out.push({ kind: "linkedin_company", url: so.linkedin_company });
  if (so.linkedin_person) out.push({ kind: "linkedin_person", url: so.linkedin_person });
  if (sc?.whatsapp_url) out.push({ kind: "whatsapp", url: sc.whatsapp_url });
  return out;
}
