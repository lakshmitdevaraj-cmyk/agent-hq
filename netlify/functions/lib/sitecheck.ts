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

/** Form plugins that build their form with JavaScript, so a plain download of the page does not contain the form. */
const FORM_PLUGINS: Array<[string, RegExp]> = [
  ["Ninja Forms", /ninja[-_ ]?forms|nf-form|nfForms/i],
  ["WPForms", /wpforms/i],
  ["Gravity Forms", /gravity[-_ ]?forms|gform_wrapper|gform_/i],
  ["Formidable Forms", /formidable|frm_forms/i],
  ["Jotform", /jotform/i],
  ["HubSpot forms", /hbspt\.forms|js\.hsforms\.net|hs-form/i],
  ["Contact Form 7", /wpcf7|contact-form-7/i],
  ["Forminator", /forminator/i],
  ["Fluent Forms", /fluentform|fluent-form/i],
  ["Typeform", /typeform/i],
  ["Formstack", /formstack/i],
  ["Cognito Forms", /cognitoforms/i],
  ["Wufoo", /wufoo/i],
  ["Elementor form", /elementor-form|elementor-widget-form/i],
];

/** The name of a form plugin whose script or markup is on any of the pages, or null when none is there. */
export function detectFormPlugin(pages: Page[]): string | null {
  for (const p of pages) for (const [name, rx] of FORM_PLUGINS) if (rx.test(p.html)) return name;
  return null;
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
export function siteHoursWording(pages: Page[]): { hours_usable: boolean; advertises_emergency: boolean; mentions_24_7: boolean; evidence: string | null } {
  let advertises = false;
  const mentions = pages.some((p) => ALL_HOURS_RX.test(pageText(p.html)));
  for (const p of pages) {
    const t = pageText(p.html);
    if (EMERGENCY_RX.test(t)) advertises = true;
    // "24/7 Emergency Services" next to normal office hours is an emergency line, not "open all day".
    const rx = new RegExp(ALL_HOURS_RX.source, "gi");
    let m: RegExpExecArray | null = null;
    for (let x = rx.exec(t); x; x = rx.exec(t)) {
      const around = t.slice(Math.max(0, x.index - 25), x.index + x[0].length + 25);
      if (/emergenc/i.test(around)) { advertises = true; continue; }
      m = x;
      break;
    }
    if (m) return { hours_usable: false, advertises_emergency: advertises || EMERGENCY_RX.test(t), mentions_24_7: true, evidence: `Site says "${t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim()}" (${p.url})` };
  }
  return { hours_usable: true, advertises_emergency: advertises, mentions_24_7: mentions, evidence: null };
}

const INDUSTRIAL_RX = /\b(industrial|marine|manufactur\w*|wholesale|distribut(?:or|ion)|oem\b|engineered|shipyard|offshore|vessel|oilfield|commercial (?:and|&) industrial|fabricat\w*|chiller|process (?:cooling|control)|replacement parts)\b/gi;
const RESIDENTIAL_RX = /\b(homeowners?|residential|your home|home comfort|house|homes)\b/i;
const LEADGEN_HOSTS = /(?:^|\.)(?:angi|angieslist|homeadvisor|thumbtack|yelp|bbb|yellowpages|manta|mapquest|porch|networx|fixr|buildzoom|houzz|nextdoor|facebook|superpages|chamberofcommerce|cylex|hotfrog|bark|expertise|homeguide|improvenet|fixd)\.(?:com|org|net)$/i;
const LEADGEN_TEXT = /(?:get|compare)\s+(?:free\s+)?(?:quotes|estimates)\s+from|find\s+(?:a\s+)?(?:local\s+)?(?:pro|contractor|plumber|electrician|hvac|roofer)s?\s+near|we\s+connect\s+(?:you|homeowners)\s+with|top\s+\d+\s+(?:best\s+)?(?:hvac|plumb|electric|roof)|directory\s+of/i;

export type FitCtx = { name?: string | null; category?: string | null; city?: string | null; reviews_count?: number | null; phone?: string | null; tls_problem?: boolean };

const WHOLESALE_TEXT = /\b(?:wholesale (?:distributor|supplier|only|prices?|and retail)|(?:distributor|supplier) of (?:hvac|plumbing|heating|air|electrical|building|roofing)|supply house|trade[- ]only|(?:dealer|contractor) accounts?|open an account|b2b)\b/i;
const WHOLESALE_CATEGORY = /\b(?:supplier|wholesaler?|distribut\w+|store|shop|parts|warehouse|manufacturer)\b/i;
const SERVICE_WORDING = /\b(?:repair|install\w*|maintenance|contractor|service (?:call|technician)|plumber|electrician|technicians?)\b/i;

/** Wholesalers and parts suppliers: they sell to contractors, not to homeowners. Evidence text or null. */
export function wholesalerFlag(text: string, category?: string | null): string | null {
  const cat = (category ?? "").trim();
  const m = WHOLESALE_TEXT.exec(text);
  if (m) {
    let from = Math.max(0, m.index - 40);
    if (from > 0) { const sp = text.indexOf(" ", from); if (sp >= 0 && sp < m.index) from = sp + 1; }
    return `Site says "${text.slice(from, m.index + m[0].length + 40).replace(/\s+/g, " ").trim()}": it sells to contractors, not homeowners`;
  }
  if (cat && WHOLESALE_CATEGORY.test(cat) && !SERVICE_WORDING.test(cat)) return `Google lists it as "${cat}", which is a supplier, not a home-service company`;
  return null;
}

const TRADE_WORDS = ["hvac", "ductcleaning", "airduct", "duct", "waterheater", "plumbing", "plumber", "heating", "cooling", "airconditioning", "acrepair", "aircon", "furnace", "electric", "electrician", "roofing", "roofer", "dryervent"];
const FILLER_TOKENS = ["1st", "first", "choice", "best", "top", "the", "and", "of", "in", "near", "me", "pro", "pros", "services", "service", "company", "repair", "repairs", "install", "installation", "air", "ac", "a", "c", "tx", "texas", "local", "cheap", "affordable", "emergency", "24", "7", "hour", "hr", "guys", "experts", "crew", "co", "inc", "llc"];
const THROWAWAY_TLD = /\.(?:xyz|site|pro|online|top|club|info|biz|click|live|store|website|space|today|co)$/i;
const TOLL_FREE = /(?:\+?1[\s.-]?)?\(?\b8(?:00|33|44|55|66|77|88)\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

const compact = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does the domain's name consist only of trade words, the town and filler (no real brand)? */
function keywordDomain(host: string, city: string): boolean {
  const label = compact(host.replace(/\.[a-z]{2,}$/i, "").replace(/\.[a-z]{2,}$/i, ""));
  if (!label) return false;
  const hasTrade = TRADE_WORDS.some((w) => label.includes(w));
  if (!hasTrade) return false;
  let rest = label;
  const c = compact(city);
  if (c.length >= 4) rest = rest.split(c).join("");
  for (const w of [...TRADE_WORDS, ...FILLER_TOKENS].sort((a, b) => b.length - a.length)) rest = rest.split(w).join("");
  return rest.replace(/\d+/g, "").length <= 3 && (c.length < 4 ? true : label.includes(c));
}

/**
 * Lead-gen / listing / network websites. Needs one strong signal or two weak ones. Label only, never deletes.
 * Returns evidence text, or null for a normal local company.
 */
export function leadGenWebsite(pages: Page[], website: string | null | undefined, ctx: FitCtx = {}): string | null {
  const strong: string[] = [];
  const weak: string[] = [];
  const host = website ? hostOf(website) : "";
  const text = pages.slice(0, 3).map((p) => pageText(p.html)).join(" ");
  if (host && LEADGEN_HOSTS.test(host)) strong.push(`The website is ${host}, a listing site`);
  const dm = LEADGEN_TEXT.exec(text);
  if (dm) strong.push(`Site wording looks like a directory: "${dm[0].slice(0, 60)}"`);
  let path = "";
  try { path = website ? new URL(website).pathname.replace(/\/+$/, "") : ""; } catch { /* ignore */ }
  const fewReviews = typeof ctx.reviews_count !== "number" || ctx.reviews_count < 30;
  const kw = host ? keywordDomain(host, ctx.city ?? "") : false;
  // A page per city on a keyword domain ("hvac-repair-guys.com/Dickinson").
  if (host && path && /^\/[A-Za-z][A-Za-z-]{2,24}$/.test(path) && TRADE_WORDS.some((w) => compact(host).includes(w))) strong.push(`The address ${host}${path} is one city page on a keyword website (a directory page)`);
  if (host && THROWAWAY_TLD.test(host) && TRADE_WORDS.some((w) => compact(host).includes(w))) strong.push(`The website name "${host}" is a trade keyword on a throwaway domain ending`);
  // A Google Sites page with a keyword-stuffed business name and few reviews.
  if (/(?:^|\.)sites\.google\.com$/i.test(host) && fewReviews && ctx.name && TRADE_WORDS.some((w) => compact(ctx.name!).includes(w))) strong.push("The website is a free Google Sites page and the business name is only trade keywords");
  // A throwaway domain ending whose name has nothing to do with the business ("Oasis System HVAC" on brooksdaniel.site).
  if (host && ctx.name && THROWAWAY_TLD.test(host)) {
    const label = compact(host.replace(/\.[a-z]{2,}$/i, ""));
    const words = (ctx.name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !FILLER_TOKENS.includes(w) && !TRADE_WORDS.some((t) => w.includes(t)) && !["system", "systems", "heating", "cooling", "comfort", "mechanical", "home"].includes(w));
    if (words.length > 0 && !words.some((w) => label.includes(w)) && !TRADE_WORDS.some((t) => label.includes(t))) strong.push(`The website name "${host}" has nothing to do with the business name, on a throwaway domain ending`);
  }
  if (ctx.tls_problem) weak.push("The website has an invalid security certificate");
  if (kw && fewReviews) strong.push(`The website name "${host}" is only trade words and the town, with no company name`);
  else if (kw) weak.push(`The website name "${host}" is only trade words and the town`);
  // A footer or pages that list many other companies as a network.
  if (host) {
    const others = new Set<string>();
    for (const p of pages.slice(0, 3)) for (const a of extractAnchors(p.html, p.url)) {
      const h = hostOf(a.href);
      if (!h || h === host || LEADGEN_HOSTS.test(h) || /google|facebook|instagram|youtube|twitter|linkedin|godaddy|wix|squarespace|apple|yelp|bbb\.org|maps/i.test(h)) continue;
      if (/\b(?:duct|hvac|air condition|a\/c|\bac\b|plumb|water heater|heating|cooling|roof|electric|repair|cleaning)/i.test(a.text)) others.add(h);
    }
    if (others.size >= 4) strong.push(`The site links to ${others.size} other companies' websites as a network`);
  }
  const cityList = (text.match(/\b(?:serving|service areas?|areas? we serve|cities we serve)\b[^.]{0,400}/i)?.[0].match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)?,/g) ?? []).length;
  if (cityList >= 8) weak.push(`The site lists ${cityList} towns it serves`);
  const tf = TOLL_FREE.exec(ctx.phone ?? "") ?? TOLL_FREE.exec(text.slice(0, 1500));
  if (tf) weak.push(`The main phone number is toll-free (${tf[0].trim()})`);
  const nameTokens = compact(ctx.name ?? "");
  if (ctx.name && TRADE_WORDS.some((w) => compact(ctx.name!).includes(w)) && keywordDomain(compact(ctx.name) + ".com", ctx.city ?? "") && fewReviews) weak.push("The business name is only trade words and a town");
  const title = (pages[0]?.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  if (title && nameTokens) {
    const words = (ctx.name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !FILLER_TOKENS.includes(w) && !TRADE_WORDS.some((t) => w.includes(t)));
    if (words.length > 0 && !words.some((w) => title.toLowerCase().includes(w)) && /\b(?:repair|service|company|professional|fast)\b/i.test(title)) weak.push(`The page title ("${title.slice(0, 60)}") does not name the business`);
  }
  if (strong.length > 0) return strong[0] + (strong.length > 1 ? `; ${strong[1]}` : "") + (weak.length ? `; ${weak[0]}` : "");
  if (weak.length >= 2) return `${weak[0]}; ${weak[1]}`;
  return null;
}

/** Warning flags: a lead that may not be a home-service company, or is a listing / lead-gen site rather than a business. */
export function fitFlags(pages: Page[], website?: string | null, ctx: FitCtx = {}): { not_home_service: string | null; lead_gen_listing: string | null } {
  const text = pages.slice(0, 3).map((p) => pageText(p.html)).join(" ");
  const hits = new Set((text.match(INDUSTRIAL_RX) ?? []).map((x) => x.toLowerCase()));
  let notHome: string | null = null;
  if (hits.size >= 2 && !RESIDENTIAL_RX.test(text)) notHome = `Site talks about ${[...hits].slice(0, 4).join(", ")} and nothing about homes`;
  if (!notHome) notHome = wholesalerFlag(text, ctx.category);
  return { not_home_service: notHome, lead_gen_listing: leadGenWebsite(pages, website, ctx) };
}

// ── True business details (saved with their evidence, used to make each email specific) ──

export type Detail = { kind: string; text: string; words: string[]; evidence: string };

const SERVICE_VOCAB: Array<[RegExp, string]> = [
  [/\bac (?:repair|service)|air conditioning (?:repair|service)/i, "AC repair"],
  [/\b(?:ac|a\/c|air conditioning) (?:install\w*|replacement)/i, "AC installation"],
  [/\bfurnace (?:repair|service)|heating repair/i, "furnace repair"],
  [/\bfurnace (?:install\w*|replacement)|heating install\w*/i, "furnace installation"],
  [/\bduct ?(?:work|cleaning)\b|\bductwork\b/i, "ductwork"],
  [/\bwater heaters?\b/i, "water heaters"],
  [/\bindoor air quality\b/i, "indoor air quality"],
  [/\bthermostats?\b/i, "thermostats"],
  [/\bheat pumps?\b/i, "heat pumps"],
  [/\b(?:tune-?ups?|maintenance plans?|preventive maintenance)\b/i, "maintenance plans"],
  [/\bmini[- ]?splits?|ductless\b/i, "ductless systems"],
];

/** Things that are true about this business according to its own pages (never invented). */
export function businessDetails(pages: Page[]): Detail[] {
  const text = pages.slice(0, 4).map((p) => pageText(p.html)).join(" ");
  const out: Detail[] = [];
  const near = (idx: number, len: number) => sentenceAround(text, idx, len);
  let since: RegExpExecArray | null = null;
  const sinceRx = /\b(?:since|established(?: in)?|est\.?|founded in)\s*(19[4-9]\d|20[01]\d)\b/gi;
  for (let m = sinceRx.exec(text); m; m = sinceRx.exec(text)) {
    // "he has worked in HVAC since 1995" is a person, not the company.
    if (!/\b(?:he|she|his|her|him)\b|experience|licensed|certified/i.test(text.slice(Math.max(0, m.index - 70), m.index + m[0].length + 30))) { since = m; break; }
  }
  if (since) out.push({ kind: "since", text: `In business since ${since[1]}`, words: [`since ${since[1]}`, since[1]], evidence: near(since.index, since[0].length) });
  else {
    // Business age only: "in business for 40 years", "serving Houston for 30 years". "X years of experience" is a person's, not the company's age.
    const re = /\b(\d{2})\+?\s*(?:years|yrs)\b/gi;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const n = Number(m[1]);
      const before = text.slice(Math.max(0, m.index - 70), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const ctx = `${before} ${m[0]} ${after}`;
      const aboutPerson = /experience|hands-on|expertise|\b(?:he|she|his|her|him|technicians?|owner|founder|our team|our techs?)\b/i.test(ctx);
      const aboutBusiness = /\bin business\b|\bserving\b|\bof service\b|\bfamily[- ](?:owned|operated)\b|\bproudly served\b/i.test(ctx);
      if (n >= 10 && n <= 90 && aboutBusiness && !aboutPerson && !/warrant|guarantee|financ|labor|parts/i.test(ctx)) {
        out.push({ kind: "years", text: `${n}+ years in business`, words: [`${n} years`, `${n}+ years`, `${n}-year`], evidence: near(m.index, m[0].length) });
        break;
      }
    }
  }
  const fam = /\bfamily[- ](?:owned|operated|run)\b|\bfamily business\b/i.exec(text);
  if (fam) out.push({ kind: "family", text: "Family-owned", words: ["family-owned", "family owned", "family-run", "family business", "family operated", "family-operated"], evidence: near(fam.index, fam[0].length) });
  const emerg = /\bemergency (?:services?|repairs?|calls?|hvac)\b/i.exec(text);
  if (emerg) out.push({ kind: "emergency", text: "Emergency service available", words: ["emergency"], evidence: near(emerg.index, emerg[0].length) });
  const found = SERVICE_VOCAB.filter(([rx]) => rx.test(text)).map(([, label]) => label).slice(0, 3);
  if (found.length >= 2) out.push({ kind: "services", text: `Services they list: ${found.join(", ")}`, words: found.map((x) => x.toLowerCase().split(" ")[0] === "ac" ? x.toLowerCase() : x.toLowerCase()), evidence: `The site lists ${found.join(", ")}.` });
  const area = /\bserving\s+((?:[A-Z][a-z]+(?:\s[A-Z][a-z]+)?(?:,\s*|\s+and\s+|\s*&\s*)){1,5}[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/.exec(text);
  if (area) {
    const towns = area[1].split(/,\s*|\s+and\s+|\s*&\s*/).map((x) => x.trim()).filter(Boolean);
    out.push({ kind: "area", text: `Serves ${towns.join(", ")}`, words: towns.map((x) => x.toLowerCase()), evidence: near(area.index, area[0].length) });
  }
  return out;
}

// ── Opening hours from the business's own site ───────────────────────

const DAY_RX = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?";
const TIME_RX = "\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s*(?:-|–|—|to)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)";
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Mon - Fri 9:30 am - 5:30 pm, Sat - Sun Closed" -> the same rows Google gives, so hoursInfo() can read them. */
export function siteHours(pages: Page[]): { openingHours: Array<{ day: string; hours: string }>; evidence: string } | null {
  const rows = new Map<string, string>();
  let evidence = "";
  for (const p of pages) {
    const t = pageText(p.html);
    const rx = new RegExp(`${DAY_RX}(?:\\s*(?:-|–|—|to|through|thru|&|and)\\s*${DAY_RX})?\\s*:?\\s*(${TIME_RX}|closed)`, "gi");
    for (let m = rx.exec(t); m; m = rx.exec(t)) {
      const a = WEEK.findIndex((d) => d.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
      const b = m[2] ? WEEK.findIndex((d) => d.toLowerCase().startsWith(m[2].toLowerCase().slice(0, 3))) : a;
      if (a < 0 || b < 0) continue;
      const hours = /closed/i.test(m[3]) ? "Closed" : m[3].replace(/\s+/g, " ");
      const amp = /(?:&|and)/i.test(m[0].slice(m[1].length, m[1].length + 8));
      const days = amp && b !== a ? [a, b] : a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
      for (const d of days) if (!rows.has(WEEK[d])) rows.set(WEEK[d], hours);
      if (!evidence) evidence = t.slice(Math.max(0, m.index - 10), m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
    }
    if (rows.size >= 3) break;
  }
  if (rows.size < 3) return null;
  return { openingHours: WEEK.filter((d) => rows.has(d)).map((d) => ({ day: d, hours: rows.get(d)! })), evidence: `Website hours: ${evidence}`.slice(0, 200) };
}

// ── The business's real trade (never the campaign niche) ──────────────

const HVAC_RX = /hvac|heating|air conditioning|a\/c|\bac\b|furnace|cooling|heat pump/i;
const TRADE_MAP: Array<[RegExp, string]> = [
  [/duct|dryer vent/i, "duct cleaning"],
  [/water heater/i, "water heater"],
  [/plumb|drain|sewer|septic/i, "plumbing"],
  [/electric/i, "electrical"],
  [/roof/i, "roofing"],
  [/pest|termite|exterminat/i, "pest control"],
  [/garage door/i, "garage doors"],
  [/landscap|lawn|tree service/i, "landscaping"],
  [/pool/i, "pool service"],
  [/appliance/i, "appliance repair"],
  [/locksmith/i, "locksmith"],
  [/handyman/i, "handyman"],
];

/**
 * The trade to use in the email, never the campaign niche. The business name and site title say more than a
 * generic Google category ("HVAC contractor" is given to roofers and duct cleaners found by an HVAC search):
 * a specific trade in the name or title wins unless the same text also says HVAC. Null when unclear.
 */
export function realTrade(category?: string | null, name?: string | null, title?: string | null): string | null {
  const srcs = [name, title, category].filter((x): x is string => !!x);
  for (const src of srcs) {
    if (HVAC_RX.test(src)) continue;
    for (const [rx, label] of TRADE_MAP) if (rx.test(src)) return label;
  }
  if (srcs.some((x) => HVAC_RX.test(x))) return "HVAC";
  for (const src of srcs) for (const [rx, label] of TRADE_MAP) if (rx.test(src)) return label;
  for (const src of srcs) if (/clean|maid|janitor/i.test(src)) return "cleaning";
  return null;
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
  // Team lists: "Al Rubio ~ Owner", "Al Rubio - Owner", "Al Rubio | Owner/Operator", "Al Rubio • President".
  { rx: new RegExp(`${NAME}\\s*[~\\-–—|•·:/]\\s*(?:[Oo]wner|[Pp]resident|CEO)(?:\\s*(?:and|&|/|-|,)\\s*(?:${ROLE}|[Oo]perator|[Gg]eneral [Mm]anager))*\\b`, "g"), how: "team list: name ~ owner", confidence: "high" },
  // "Owner/Operator Al Rubio", "Owner-Operator: Al Rubio"
  { rx: new RegExp(`\\b[Oo]wner\\s*[/-]\\s*[Oo]perator(?:\\s*[:\\-–—|~.]\\s*|\\s+)${NAME}`, "g"), how: "owner/operator: name", confidence: "high" },
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

export type HoursInfo = { summary: string; closedDays: string[]; closesEarlyWeekdays: boolean; closedWeekend: boolean; source?: string };

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

/** Opening hours: Google first, then the ones on the business own site (contact page, footer). */
export function leadHours(lead: { raw?: unknown; site_check?: { site_hours?: unknown } | null }): HoursInfo | null {
  const g = hoursInfo(lead.raw);
  if (g) return { ...g, source: "Google" };
  const w = hoursInfo(lead.site_check?.site_hours);
  return w ? { ...w, source: "their website" } : null;
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
