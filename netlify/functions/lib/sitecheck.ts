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
  noWebsite: 80, // no website at all: the biggest gap there is
} as const;
export const GAP_RATING_MIN = 4.3;
export const GAP_REVIEWS_MIN = 30;

/** Pages fetched for one check (homepage, contact pages, About pages). */
export const SITE_CHECK_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/our-story", "/our-team", "/team", "/meet-the-owner"];

export type Page = { url: string; html: string };

// ── Automation signals ────────────────────────────────────────────────

/**
 * Live-chat widgets. Each pattern must match the widget's own script / iframe /
 * settings, never a plain link: a Birdeye or Podium "reviews" link is not chat.
 */
const CHAT_WIDGETS: Array<[string, RegExp]> = [
  ["Tidio", /code\.tidio\.co|tidiochat|tidio\.net/i],
  ["Intercom", /widget\.intercom\.io|intercomSettings|intercom-frame/i],
  ["Drift", /js\.driftt\.com|js\.drift\.com|window\.drift\b/i],
  ["LiveChat", /cdn\.livechatinc\.com|__lc\.license|livechat\.com\/chat/i],
  ["Tawk.to", /embed\.tawk\.to|tawk\.to\/chat/i],
  ["Crisp", /client\.crisp\.chat|\$crisp/i],
  ["HubSpot chat", /js\.usemessages\.com|hs-conversations|conversations-embed|HubSpotConversations/i],
  ["Podium", /connect\.podium\.com|podium\.com\/widget|podiumwebchat|podium-webchat|webchat\.podium/i],
  ["Birdeye chat", /birdeyewebchat|webchat\.birdeye|birdeye\.com\/[^"'\s]*webchat|bf-widget|birdeye-webchat/i],
  ["Facebook Messenger", /fb-customerchat|customerchat\.js/i],
  ["Zendesk", /static\.zdassets\.com|zopim|zendesk\.com\/embeddable|ze-snippet/i],
  ["Re:amaze", /cdn\.reamaze\.com|reamaze\.com\/assets|_reamaze|reamaze-embed/i],
  ["Olark", /static\.olark\.com|olark\.identify|olark\.configure/i],
  ["Chatra", /call\.chatra\.io|ChatraID/i],
  ["Freshchat", /wchat\.freshchat\.com|freshchat\.com\/js/i],
  ["Zoho SalesIQ", /salesiq\.zoho|zsiqchat|\$zoho\.salesiq/i],
  ["Smartsupp", /smartsuppchat|smartsupp\.com/i],
  ["JivoChat", /code\.jivosite\.com|jivo_config/i],
  ["Userlike", /userlike-cdn|userlike\.com\/widget/i],
  ["Gorgias", /config\.gorgias\.chat|gorgias-chat/i],
  ["Wix Chat", /wix-chat|wixchat|ascend\.wix\.com\/chat/i],
  ["GoHighLevel chat", /widgets\.leadconnectorhq\.com\/chat-widget|chat-widget\.leadconnectorhq|leadconnector[^"'\s]*chat/i],
  ["Broadly", /broadly\.com\/(?:widget|webchat)|webchat\.broadly|broadly-widget/i],
  ["Kenect", /kenect\.com|webchat\.kenect|kenect-widget/i],
  ["Smith.ai", /smith\.ai\/widget|widget\.smith\.ai/i],
  ["Hatch", /hatch\.co\/(?:widget|chat)|webchat\.hatch/i],
  ["Signpost", /signpost\.com\/(?:widget|chat)|webchat\.signpost/i],
  ["Numa", /numa\.com\/(?:widget|chat)/i],
  ["Housecall Pro chat", /housecallpro\.com\/[^"'\s]*(?:chat|widget)/i],
  ["ServiceTitan chat", /servicetitan\.com\/[^"'\s]*chat|st-webchat/i],
  ["LiveAgent", /ladesk\.com|liveagent\.com\/scripts/i],
  ["Gist", /widget\.getgist\.com|getgist\.com/i],
  ["Chatbot widget", /chatbot\.com\/widget|botpress|landbot\.io|manychat/i],
];

const BOOKING_TOOLS: Array<[string, RegExp]> = [
  ["Calendly", /calendly\.com/i],
  ["Housecall Pro", /housecallpro\.com|housecall\s?pro|online-booking\.housecallpro|book\.housecallpro/i],
  ["Jobber", /getjobber\.com|clienthub\.getjobber|jobber\.com\/(?:client|request)|jobber work request/i],
  ["ServiceTitan", /servicetitan\.com|scheduler\.servicetitan|st-scheduler/i],
  ["Acuity", /acuityscheduling\.com|squarespacescheduling\.com|app\.acuityscheduling/i],
  ["Square Appointments", /squareup\.com\/appointments|square\.site\/book|book\.squareup\.com/i],
  ["Setmore", /setmore\.com/i],
  ["Booksy", /booksy\.com/i],
  ["Workiz", /workiz\.com/i],
  ["GoDaddy Bookings", /\/m\/bookings\b|bookings\.godaddy|godaddy-bookings|\bgodaddy\.com\/[^"'\s]*bookings/i],
  ["Schedule Engine", /scheduleengine\.(?:net|com)|schedule-engine/i],
  ["FieldEdge", /fieldedge\.com/i],
  ["Service Fusion", /servicefusion\.com/i],
  ["ServiceM8", /servicem8\.com/i],
  ["Zuper", /zuper\.co/i],
  ["Kickserv", /kickserv\.com/i],
  ["SimplyBook.me", /simplybook\.(?:me|it)/i],
  ["Appointlet", /appointlet\.com/i],
  ["YouCanBook.me", /youcanbook\.me/i],
  ["Cal.com", /cal\.com\//i],
  ["TidyCal", /tidycal\.com/i],
  ["Vagaro", /vagaro\.com/i],
  ["Mindbody", /mindbodyonline\.com|mindbody\.io/i],
  ["GoHighLevel booking", /leadconnectorhq\.com\/widget\/(?:booking|bookings)|msgsndr\.com\/widget\/booking/i],
  ["Hatch", /hatch\.co\/booking/i],
  ["Smart Online Scheduling", /online-scheduler|onlinescheduler/i],
];

const BOOK_TEXT = /^\s*(?:book\s+(?:online|now|an?\s+appointment|a\s+(?:service|visit|call|technician|tech))|schedule\s+(?:online|service|now|an?\s+(?:appointment|service|visit)|a\s+(?:service|visit|call))|online\s+(?:booking|scheduling)|request\s+(?:an?\s+)?(?:appointment|service)|book\s+a\s+service\s+call)\s*$/i;
const BOOK_PATH = /book|schedul|appointment|reserve/i;
const CONTACT_PATH = /contact|quote|estimate|request|get-?in-?touch|call-?back|callback/i;

const WHATSAPP_RX = /https?:\/\/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\/[^\s"'<>)]*/i;

export type Signals = {
  chat_widget: string | null;
  booking_tool: string | null;
  has_contact_form: boolean;
  whatsapp_url: string | null;
  contact_form_url: string | null;
  /** "Schedule Now" / "Request service" that only opens the site's own contact or call-back form: not real online booking. */
  request_form: boolean;
  request_form_url: string | null;
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

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/** "booking" = a real scheduler; "request_form" = a button that only opens the site's own contact form. */
function classifyBookLink(a: Anchor, pageUrl: string): "booking" | "request_form" | null {
  if (!BOOK_TEXT.test(a.text)) return null;
  let u: URL;
  try { u = new URL(a.href); } catch { return null; }
  const external = hostOf(a.href) !== hostOf(pageUrl);
  if (external) return /facebook|instagram|linkedin|google\.com|yelp/i.test(u.hostname) ? null : "booking";
  const target = `${u.pathname}${u.hash}`;
  if (BOOK_PATH.test(target) && !CONTACT_PATH.test(u.pathname)) return "booking";
  return "request_form";
}

export type SignalResult = { signals: Signals; sources: Record<string, string>; evidence: Record<string, string> };

export function detectSignals(pages: Page[]): SignalResult {
  const signals: Signals = { chat_widget: null, booking_tool: null, has_contact_form: false, whatsapp_url: null, contact_form_url: null, request_form: false, request_form_url: null };
  const sources: Record<string, string> = {};
  const evidence: Record<string, string> = {};
  for (const p of pages) {
    if (!signals.chat_widget) {
      const hit = CHAT_WIDGETS.find(([, rx]) => rx.test(p.html));
      if (hit) {
        const m = p.html.match(hit[1]);
        signals.chat_widget = hit[0]; sources.chat_widget = p.url;
        evidence.chat_widget = `${hit[0]} chat widget code found: "${(m?.[0] ?? "").slice(0, 70)}" on ${p.url}`;
      }
    }
    if (!signals.booking_tool) {
      const hit = BOOKING_TOOLS.find(([, rx]) => rx.test(p.html));
      if (hit) {
        const m = p.html.match(hit[1]);
        signals.booking_tool = hit[0]; sources.booking_tool = p.url;
        evidence.booking_tool = `${hit[0]} booking link/code found: "${(m?.[0] ?? "").slice(0, 70)}" on ${p.url}`;
      } else {
        for (const a of extractAnchors(p.html, p.url)) {
          const kind = classifyBookLink(a, p.url);
          if (kind === "booking") {
            signals.booking_tool = "Book online link"; sources.booking_tool = p.url;
            evidence.booking_tool = `"${a.text}" button goes to ${a.href}`;
            break;
          }
          if (kind === "request_form" && !signals.request_form) {
            signals.request_form = true; signals.request_form_url = a.href;
            evidence.request_form = `"${a.text}" button only opens the site's own contact form (${a.href})`;
          }
        }
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
        evidence.contact_form = `Contact form on ${p.url}`;
      }
    }
  }
  if (signals.booking_tool) { signals.request_form = false; }
  return { signals, sources, evidence };
}

// ── Needs a real browser? ─────────────────────────────────────────────

const JS_BUILDERS: Array<[string, RegExp]> = [
  ["GoDaddy website builder", /wsimg\.com|godaddysites|img1\.wsimg|websitebuilder\.godaddy/i],
  ["Wix", /wixstatic\.com|static\.parastorage|wix\.com\/|X-Wix/i],
  ["Squarespace", /squarespace\.com|static1\.squarespace|sqsp/i],
  ["Duda", /multiscreensite\.com|dudaone|irp\.cdn-website|cdn-website\.com/i],
  ["hibu", /hibu\.com|hibu-|yellowpages-?website|webs\.com/i],
  ["Weebly", /weebly\.com|editmysite\.com/i],
  ["Webflow", /webflow\.com|assets\.website-files/i],
];

/**
 * Chat and booking widgets on these builders load with JavaScript, so a plain
 * download can miss them. True when nothing was found and the page looks JS-built.
 */
export function needsBrowserCheck(pages: Page[], s: Pick<Signals, "chat_widget" | "booking_tool">): { needs: boolean; reason: string | null } {
  if (s.chat_widget && s.booking_tool) return { needs: false, reason: null };
  const home = pages[0];
  if (!home) return { needs: false, reason: null };
  for (const p of pages.slice(0, 3)) {
    const b = JS_BUILDERS.find(([, rx]) => rx.test(p.html));
    if (b) return { needs: true, reason: `${b[0]} site: chat and booking may load with JavaScript` };
  }
  const text = visibleText(home.html);
  if (text.length < 400 && /<script\b/i.test(home.html)) return { needs: true, reason: "Page is mostly JavaScript" };
  return { needs: false, reason: null };
}

// ── Site wording: hours, fit ──────────────────────────────────────────

const ALL_HOURS_RX = /24\s*\/\s*7|24\s*x\s*7|24\s*hours|24-hour|day or night|around the clock|night or day|any ?time|nights? and weekends|nights?,? weekends/i;
const EMERGENCY_RX = /emergency/i;

/** If the site itself says it answers any time, Google's opening hours must not be used. */
export function siteHoursWording(pages: Page[]): { hours_usable: boolean; advertises_emergency: boolean; evidence: string | null } {
  let advertises = false;
  for (const p of pages) {
    const t = pageText(p.html);
    if (EMERGENCY_RX.test(t)) advertises = true;
    const m = ALL_HOURS_RX.exec(t);
    if (m) return { hours_usable: false, advertises_emergency: advertises || EMERGENCY_RX.test(t), evidence: `Site says "${t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim()}" (${p.url})` };
  }
  return { hours_usable: true, advertises_emergency: advertises, evidence: null };
}

const INDUSTRIAL_RX = /\b(industrial|marine|manufactur\w*|wholesale|distribut(?:or|ion)|oem\b|engineered|shipyard|offshore|vessel|oilfield|commercial (?:and|&) industrial|fabricat\w*|chiller|process (?:cooling|control)|replacement parts)\b/gi;
const RESIDENTIAL_RX = /\b(homeowners?|residential|your home|home comfort|house|homes)\b/i;
const LEADGEN_HOSTS = /(?:^|\.)(?:angi|angieslist|homeadvisor|thumbtack|yelp|bbb|yellowpages|manta|mapquest|porch|networx|fixr|buildzoom|houzz|nextdoor|facebook|superpages|chamberofcommerce|cylex|hotfrog|bark|expertise|homeguide|improvenet|fixd)\.(?:com|org|net)$/i;
const LEADGEN_TEXT = /(?:get|compare)\s+(?:free\s+)?(?:quotes|estimates)\s+from|find\s+(?:a\s+)?(?:local\s+)?(?:pro|contractor|plumber|electrician|hvac|roofer)s?\s+near|we\s+connect\s+(?:you|homeowners)\s+with|top\s+\d+\s+(?:best\s+)?(?:hvac|plumb|electric|roof)|directory\s+of|(?:hvac|plumbing|electrical)\s+(?:companies|contractors)\s+in\s+[A-Z]/i;

/** Warning flags: a lead that may not be a home-service company, or is a listing site rather than a business. */
export function fitFlags(pages: Page[], website?: string | null): { not_home_service: string | null; lead_gen_listing: string | null } {
  const text = pages.slice(0, 3).map((p) => pageText(p.html)).join(" ");
  const hits = new Set((text.match(INDUSTRIAL_RX) ?? []).map((x) => x.toLowerCase()));
  let notHome: string | null = null;
  if (hits.size >= 2 && !RESIDENTIAL_RX.test(text)) notHome = `Site talks about ${[...hits].slice(0, 4).join(", ")} and nothing about homes`;
  let lead: string | null = null;
  const host = website ? hostOf(website) : "";
  if (host && LEADGEN_HOSTS.test(host)) lead = `The website is ${host}, a listing site`;
  else {
    const m = LEADGEN_TEXT.exec(text);
    if (m) lead = `Site wording looks like a directory: "${m[0].slice(0, 60)}"`;
  }
  return { not_home_service: notHome, lead_gen_listing: lead };
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

export type Owner = { name: string; source_url: string; confidence: "high" | "low"; how: string; evidence: string };

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
const CURRENT_VERBS = "(?:purchased|bought|acquired|took over|now owns|now runs|currently owns|is the (?:current|new) owner|became (?:the )?owner)";

type Pat = { rx: RegExp; how: string; confidence: "high" | "low"; founderOnly?: boolean; current?: boolean };
const OWNER_PATTERNS: Pat[] = [
  // Someone who bought / took over the business is the CURRENT owner, whoever founded it.
  { rx: new RegExp(`${NAME}(?:,[^,.]{1,70},)?\\s+${CURRENT_VERBS}`, "g"), how: "bought/took over", confidence: "high", current: true },
  { rx: new RegExp(`(?:[Pp]urchased|[Aa]cquired|[Bb]ought|[Tt]aken over)(?:\\s+in\\s+\\d{4})?\\s+by\\s+${NAME}\\b`, "g"), how: "purchased by", confidence: "high", current: true },
  { rx: new RegExp(`(?:[Oo]wned|[Rr]un|[Oo]perated)(?:\\s+and\\s+(?:[Oo]perated|[Oo]wned|[Rr]un))?\\s+by\\s+${NAME}\\b(?!\\s+and\\b)`, "g"), how: "owned by", confidence: "high" },
  { rx: new RegExp(`(?:[Ff]ounded|[Ss]tarted|[Ee]stablished)(?:\\s+in\\s+\\d{4})?\\s+by\\s+${NAME}\\b(?!\\s+and\\b)`, "g"), how: "founded by", confidence: "low", founderOnly: true },
  { rx: new RegExp(`${NAME},?\\s+(?:the\\s+|our\\s+|is\\s+the\\s+|is\\s+our\\s+)?(?:[Oo]wner|[Pp]resident|CEO)(?:\\s*(?:and|&|/|,)\\s*${ROLE})*\\b`, "g"), how: "name, owner", confidence: "high" },
  { rx: new RegExp(`${NAME},?\\s+(?:the\\s+|our\\s+|is\\s+the\\s+|is\\s+our\\s+)?[Ff]ounder\\b(?!\\s+(?:and|&|/)\\s+(?:[Oo]wner|[Pp]resident|CEO))`, "g"), how: "name, founder", confidence: "low", founderOnly: true },
  { rx: new RegExp(`\\b(?:[Oo]wner|[Pp]resident|CEO)(?:\\s*(?:and|&|/|,)\\s*${ROLE})*(?:\\s*[:\\-–—|.]\\s*|\\s+)${NAME}`, "g"), how: "owner: name", confidence: "high" },
  { rx: new RegExp(`\\b(?:[Oo]ur\\s+)?[Ff]ounder(?:\\s*[:\\-–—|.,]\\s*|\\s+)${NAME}`, "g"), how: "our founder, name", confidence: "low", founderOnly: true },
  { rx: new RegExp(`\\b[Mm]eet\\s+(?:the\\s+owner,?\\s+|our\\s+(?:owner|founder),?\\s+)?${NAME}`, "g"), how: "meet name", confidence: "low" },
];

/** Words that say a person is NOT the current owner. */
const FORMER = /\b(retired|retiring|retirement|former(?:ly)?|previous|past owner|original owner|sold the (?:company|business)|sold (?:it|his|her|their)|stepped down|passed (?:away|the torch)|handed (?:over|down)|was (?:the )?(?:owner|founder|president)|originally (?:founded|started)|the late)\b/i;

function sentenceAround(text: string, idx: number, len: number): string {
  const before = text.slice(Math.max(0, idx - 260), idx);
  const bs = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  const start = Math.max(0, idx - 260) + (bs >= 0 ? bs + 2 : 0);
  const after = text.slice(idx + len, idx + len + 260);
  const ae = after.search(/[.!?](?:\s|$)/);
  const end = idx + len + (ae >= 0 ? ae + 1 : after.length);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Is the match about someone who has left? Looks a little before and after the name. */
function isFormer(text: string, m: RegExpExecArray, name: string): boolean {
  const pos = m.index + m[0].indexOf(name);
  const before = text.slice(Math.max(0, pos - 50), pos);
  const after = text.slice(pos + name.length, pos + name.length + 80);
  if (new RegExp(`^(?:,[^,.]{1,70},)?\\s*,?\\s*${CURRENT_VERBS}`, "i").test(after)) return false;
  const cutAfter = after.split(/[.!?]/)[0];
  return FORMER.test(before) || FORMER.test(cutAfter);
}

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
      if (DECEASED.test(`${job} ${typeof o.description === "string" ? o.description : ""}`) || FORMER.test(`${job} ${typeof o.description === "string" ? o.description : ""}`)) return;
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

type Cand = { name: string; url: string; how: string; confidence: "high" | "low"; evidence: string; current: boolean; founderOnly: boolean };

/**
 * The CURRENT owner from visible text patterns and schema.org JSON-LD, with the
 * sentence that shows it. Retired / former / late founders are never returned;
 * someone who "purchased" the company is preferred; a founder-only mention is
 * low confidence (never used in greetings). Null when nothing clear is found.
 */
export function findOwner(pages: Page[], businessName?: string | null): Owner | null {
  const aboutFirst = [...pages].sort((a, b) => Number(/about|story|team|owner/i.test(b.url)) - Number(/about|story|team|owner/i.test(a.url)));
  const cands: Cand[] = [];
  const formerNames = new Set<string>();
  for (const p of aboutFirst) {
    for (const person of ldPeople(p.html)) {
      const name = person.name.replace(/\s+/g, " ").trim();
      if (!validPersonName(name, businessName)) continue;
      const founderOnly = !/owner|president|ceo/i.test(person.role);
      cands.push({ name, url: p.url, how: "schema.org " + (person.role || "owner"), confidence: founderOnly ? "low" : "high", evidence: `Website data lists ${name} as ${person.role || "owner"}`, current: false, founderOnly });
    }
    const text = pageText(p.html);
    for (const pat of OWNER_PATTERNS) {
      pat.rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.rx.exec(text))) {
        const name = m[1].replace(/\s+/g, " ").trim();
        if (!validPersonName(name, businessName)) continue;
        if (DECEASED.test(text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 160))) { formerNames.add(name); continue; }
        if (isFormer(text, m, name)) { formerNames.add(name); continue; }
        cands.push({ name, url: p.url, how: pat.how, confidence: pat.confidence, evidence: sentenceAround(text, m.index, m[0].length), current: !!pat.current, founderOnly: !!pat.founderOnly });
        break;
      }
    }
  }
  const usable = cands.filter((c) => !formerNames.has(c.name) || c.current);
  const pick = (f: (c: Cand) => boolean) => usable.find(f);
  const best =
    pick((c) => c.current) ??
    pick((c) => c.confidence === "high" && !c.founderOnly) ??
    // A founder who is also named with an owner role elsewhere counts as the owner.
    usable.find((c) => c.founderOnly && usable.some((o) => o !== c && o.name === c.name && !o.founderOnly)) ??
    pick((c) => c.confidence === "low");
  if (!best) return null;
  return { name: best.name, source_url: best.url, confidence: best.confidence, how: best.how, evidence: best.evidence };
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
  s: Pick<Signals, "chat_widget" | "booking_tool" | "has_contact_form" | "whatsapp_url"> | null,
  opts: { hoursUsable?: boolean } = {},
): GapResult {
  let score = 0;
  const reasons: string[] = [];
  if (!s) return { score: GAP_WEIGHTS.noWebsite, reasons: ["No website"] };
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
  const h = opts.hoursUsable === false ? null : hoursInfo(lead.raw);
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

/** No website, a name stuffed with "<trade> Repair/Crew/Experts" and almost no reviews: often a lead-gen / fake listing. Label only. */
export function looksLikeLeadGenListing(lead: { name?: string | null; website?: string | null; reviews_count?: number | null }): string | null {
  if (lead.website && lead.website.trim()) return null;
  const name = lead.name ?? "";
  if (typeof lead.reviews_count === "number" && lead.reviews_count >= 10) return null;
  if (/(?:emergency|hvac|\bac\b|a\/c|air conditioning|plumb\w*|heating|roofing)\s+(?:repair|crew|experts?|pros?)\b/i.test(name)) return "No website, a name stuffed with trade keywords, and few reviews";
  return null;
}
