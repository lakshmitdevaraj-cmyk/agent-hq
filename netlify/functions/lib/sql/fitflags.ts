// P2 chunk 4: lead flags before drafting (F32, F33). Worked out on read from the lead record, so a fixed rule covers
// old leads too. These add to the skip rules that already exist (leadSkipReason, autoNotFit); they never hide a lead.
// Drafting (chunk 5) must call draftAllowed(): a flagged lead is drafted only after Lakshmi keeps it ("kept by me",
// not_fit_kept). The site facts behind some flags (several locations, real answering service) come in P4; until then
// the flags use today's site-check signals. Every list here is easy to extend.
import { keywordDomain } from "../sitecheck.ts";
import { cityOf } from "../angle.ts";

type Lead = Record<string, unknown>;
export type LeadFlag = { code: "chain" | "not_home_service" | "too_big" | "has_answering_booking" | "not_call_driven" | "template_site"; detail: string };

/** Franchise and chain brands that today's chain list (lib/outreach.ts CHAIN_NAMES) does not have. Whole words. */
const MORE_CHAINS = [
  "drymedic", "puroclean", "paul davis", "belfor", "rainbow restoration", "rainbow international", "servicemaster restore", "911 restoration",
  "chem-dry", "chemdry", "stanley steemer", "zerorez", "mosquito joe", "mosquito squad", "bath fitter", "re-bath", "certapro", "five star painting",
  "window nation", "renewal by andersen", "leaf filter", "leaffilter", "sears home", "eos fitness", "eōs fitness", "ta truck service", "ta petro", "petro stopping",
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CHAIN_RX = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${MORE_CHAINS.map(esc).join("|")})(?:$|[^\\p{L}\\p{N}])`, "iu");
const FRANCHISE_WORDS = /\bfranchise\b|independently owned and operated/i;
/** A US state as a slug part ("houston-tx-…"); the two-letter codes that are also English words are left out. */
const STATE_SLUG = /(?:^|\/)[a-z]+(?:-[a-z]+)?-(?:ak|az|ar|ca|ct|fl|ga|ia|il|ks|ky|md|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)(?:-|\/|$)/i;

const NOT_HOME = /\b(gym|fitness|health club|yoga|pilates|real estate|rental agency|property management|truck (repair|stop|service)|travel center|restaurant|car dealer|car wash|auto (repair|parts|body)|hotel|motel|church|school)\b/i;
const NOT_CALL_CATEGORY = /\b(remodel(l)?er|design[- ]build|custom home|home builder|builder|showroom|supply|supplier|wholesal\w*|distribut\w*|rentals?)\b/i;
const NOT_CALL_NAME = /\b(design[- ]build|custom homes?|rentals?|supply|supplies|wholesale)\b/i;

function pathOf(website: unknown): { host: string; path: string } | null {
  if (typeof website !== "string" || !website.trim()) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: u.pathname.replace(/\/+$/, "") };
  } catch { return null; }
}

/** Every flag that applies to the lead (empty when nothing is off). */
export function leadFlags(lead: Lead): LeadFlag[] {
  const out: LeadFlag[] = [];
  const name = typeof lead.name === "string" ? lead.name : "";
  const category = typeof lead.category === "string" ? lead.category : "";
  const site = pathOf(lead.website);
  const sc = (lead.site_check ?? {}) as Record<string, unknown>;

  // F33: chains and franchises today's list misses.
  const brand = CHAIN_RX.exec(name) ?? (site ? CHAIN_RX.exec(site.host.replace(/\.[a-z]+$/, "").replace(/-/g, " ")) : null);
  const locationPage = !!site && site.path !== "" && (/\/locations?\//i.test(`${site.path}/`) || (/ of [A-Z\p{Lu}]/u.test(name) && STATE_SLUG.test(site.path)));
  if (brand) out.push({ code: "chain", detail: `a chain or franchise brand ("${brand[0].trim()}")` });
  else if (locationPage) out.push({ code: "chain", detail: "the website is one location's page on a bigger brand's site (a franchise)" });
  else if (FRANCHISE_WORDS.test(name)) out.push({ code: "chain", detail: "the name says it is a franchise" });

  // F33: not a home-service business.
  const nh = NOT_HOME.exec(category) ?? NOT_HOME.exec(name);
  if (nh) out.push({ code: "not_home_service", detail: `not a home service (${category || nh[0]})` });

  // F32: too big to need an answering assistant.
  const reviews = typeof lead.reviews_count === "number" ? lead.reviews_count : Number(lead.reviews_count ?? NaN);
  const locations = typeof sc.locations_count === "number" ? sc.locations_count : null; // a P4 site fact; absent today
  if (Number.isFinite(reviews) && reviews >= 1000) out.push({ code: "too_big", detail: `${reviews} Google reviews: likely too big for this offer` });
  else if (locations !== null && locations >= 3) out.push({ code: "too_big", detail: `${locations} locations: likely too big for this offer` });

  // F32: already answers around the clock and books online.
  if (sc.booking_tool && (sc.chat_widget || sc.mentions_24_7 === true)) {
    out.push({ code: "has_answering_booking", detail: `already books online (${String(sc.booking_tool)}) and has ${sc.chat_widget ? `live chat (${String(sc.chat_widget)})` : "24/7 cover on the site"}` });
  }

  // F32: trades that don't run on incoming calls.
  const nc = NOT_CALL_CATEGORY.exec(category) ?? NOT_CALL_NAME.exec(name);
  if (nc) out.push({ code: "not_call_driven", detail: `works by appointment or sells goods, not on incoming calls (${nc[0]})` });

  // F32: template / keyword sites (a domain made only of trade words and the town).
  if (site && keywordDomain(site.host, cityOf(typeof lead.address === "string" ? lead.address : ""))) out.push({ code: "template_site", detail: `a keyword domain (${site.host}), often a template or lead-selling site` });
  return out;
}

/** May this lead be drafted? Only with no flag, or when Lakshmi kept it ("kept by me" = not_fit_kept). */
export function draftAllowed(lead: Lead): { ok: boolean; flags: LeadFlag[]; reason: string | null } {
  const flags = leadFlags(lead);
  if (!flags.length || lead.not_fit_kept === true) return { ok: true, flags, reason: null };
  return { ok: false, flags, reason: `Check first: ${flags.map((f) => f.detail).join("; ")}. Keep the lead ("kept by me") to draft it anyway.` };
}
