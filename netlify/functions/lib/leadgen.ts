/**
 * Auto "Not a fit" for lead-gen listings (batch 8c). Pure, no I/O.
 *
 * A lead is auto-hidden as lead_gen ONLY when ALL are true:
 *   1. it has fewer than 10 Google reviews (a missing count is 0),
 *   2. it shows at least one lead-gen sign (listed below; an invalid security certificate is NEVER one),
 *   3. it has not been contacted (sent email, unsent email draft, sent or recorded social message, or any reply).
 * Otherwise, when a sign is present, the lead stays visible with a "Possible lead-gen: check" flag and the reasons.
 * The other automatic rules (chain, wholesaler, rental, industrial, other trade) keep their logic but never hide a contacted lead.
 */
import { hostOf, keywordDomain, THROWAWAY_TLD, TRADE_WORDS, FILLER_TOKENS } from "./sitecheck";
import { cityOf } from "./angle";

export type LeadGenSign = { code: string; text: string };

export type LeadGenLead = {
  name?: string | null;
  website?: string | null;
  address?: string | null;
  phone?: string | null;
  reviews_count?: number | null;
  site_check?: { lead_gen_listing?: string | null } | null;
};

const compact = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const hasTrade = (x: string) => TRADE_WORDS.some((w) => compact(x).includes(w));

/**
 * Signs recorded by an earlier website check live in one joined sentence (`site_check.lead_gen_listing`). Each known sentence
 * the check can produce is read back as a sign; anything else in it (an invalid certificate, a town list, a lone toll-free
 * number) is not a sign and is dropped.
 */
export function parseStoredSigns(text: string | null | undefined): LeadGenSign[] {
  const s = (text ?? "").trim();
  if (!s) return [];
  const out: LeadGenSign[] = [];
  const add = (code: string, re: RegExp) => { const m = re.exec(s); if (m) out.push({ code, text: sentenceAround(s, m.index) }); };
  add("domain_keyword", /The website name "[^"]*" is only trade words and the town/);
  add("throwaway_domain", /The website name "[^"]*" is a trade keyword on a throwaway domain ending/);
  add("unrelated_domain", /The website name "[^"]*" has nothing to do with the business name/);
  add("city_page", /is one city page on a keyword website/);
  add("google_sites", /free Google Sites page/);
  // "No website, a name stuffed with trade keywords, and few reviews" is the text saved for a lead with no website at all.
  add("name_trade", /The business name is only trade words and a town|a name stuffed with trade keywords/);
  add("directory", /Site wording looks like a directory|, a listing site/);
  add("network", /links to \d+ other companies' websites as a network/);
  // A toll-free number counts only together with a page title that does not name the business (old text: two sentences; new: one).
  const tf = /toll-free/.test(s), title = /page title .*does not name the business/.test(s);
  if (tf && title) out.push({ code: "toll_free_title", text: "The main phone number is toll-free and the page title does not name the business" });
  return out;
}

/** The "; "-separated piece of the joined text that contains index i. */
function sentenceAround(s: string, i: number): string {
  const start = s.lastIndexOf("; ", i);
  const from = start >= 0 ? start + 2 : 0;
  const end = s.indexOf("; ", i);
  return s.slice(from, end >= 0 ? end : s.length).trim();
}

/**
 * A business name with initials (MPG, ABC) or a company ending (LLC, Inc, Co, Corp, Ltd) is a company name, not "trade words and a town",
 * even when the rest of it is a trade and a town.
 */
export function hasCompanyMark(name: string): boolean {
  if (/\b(?:llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|co|company)\b\.?/i.test(name.replace(/&/g, " "))) return true;
  return name.split(/[^A-Za-z]+/).some((w) => /^[A-Z]{2,5}$/.test(w) && !["HVAC", "AC", "TX", "USA", "LP", "DIY"].includes(w));
}

/** Every lead-gen sign for a lead: the ones that come from its own fields, plus those saved by an earlier website check. */
export function leadGenSigns(l: LeadGenLead): LeadGenSign[] {
  const out = new Map<string, LeadGenSign>();
  const add = (x: LeadGenSign) => { if (!out.has(x.code)) out.set(x.code, x); };
  const host = l.website ? hostOf(l.website) : "";
  const city = cityOf(l.address ?? "");
  if (host) {
    if (keywordDomain(host, "") || (city.length >= 4 && keywordDomain(host, city))) add({ code: "domain_keyword", text: `The website name "${host}" is only trade words and the town, with no company name` });
    if (THROWAWAY_TLD.test(host) && hasTrade(host)) add({ code: "throwaway_domain", text: `The website name "${host}" is a trade keyword on a throwaway domain ending` });
    if (/(?:^|\.)sites\.google\.com$/i.test(host)) add({ code: "google_sites", text: "The website is a free Google Sites page" });
    let path = "";
    try { path = new URL(l.website as string).pathname.replace(/\/+$/, ""); } catch { /* ignore */ }
    if (path && /^\/[A-Za-z][A-Za-z-]{2,24}$/.test(path) && hasTrade(host)) add({ code: "city_page", text: `The address ${host}${path} is one city page on a keyword website (a directory page)` });
    if (l.name && THROWAWAY_TLD.test(host)) {
      const label = compact(host.replace(/\.[a-z]{2,}$/i, ""));
      const words = l.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !FILLER_TOKENS.includes(w) && !TRADE_WORDS.some((t) => w.includes(t)) && !["system", "systems", "heating", "cooling", "comfort", "mechanical", "home"].includes(w));
      if (words.length > 0 && !words.some((w) => label.includes(w)) && !TRADE_WORDS.some((t) => label.includes(t))) add({ code: "unrelated_domain", text: `The website name "${host}" has nothing to do with the business name, on a throwaway domain ending` });
    }
  }
  if (l.name && hasTrade(l.name) && keywordDomain(compact(l.name) + ".com", city)) add({ code: "name_trade", text: "The business name is only trade words and a town" });
  for (const s of parseStoredSigns(l.site_check?.lead_gen_listing)) add(s);
  if (l.name && hasCompanyMark(l.name)) out.delete("name_trade");
  return [...out.values()];
}

export type AutoDecision = { hide: boolean; why: "contacted" | "reviews" | null; reasons: string[] };

/** The lead-gen decision: null = no sign. `contacted` = emailed, draft, social sent or recorded, or any reply. */
export function leadGenDecision(l: LeadGenLead, contacted: boolean): (AutoDecision & { signs: LeadGenSign[] }) | null {
  const signs = leadGenSigns(l);
  if (signs.length === 0) return null;
  const reviews = typeof l.reviews_count === "number" ? l.reviews_count : 0;
  const hide = reviews < 10 && !contacted;
  return { hide, why: hide ? null : contacted ? "contacted" : "reviews", reasons: signs.map((s) => s.text), signs };
}

/** The other automatic rules hide only a lead nobody has contacted; a contacted one is flagged instead. */
export function otherRuleDecision(r: { code: string; detail: string }, contacted: boolean): AutoDecision {
  return { hide: !contacted, why: contacted ? "contacted" : null, reasons: [r.detail] };
}

/** Contacted = an email sent, an unsent email draft, a sent or recorded social message, or any reply. Social drafts alone do not count. */
export function isContacted(x: { emailSent: boolean; emailDraft: boolean; touches: number; replied: boolean }): boolean {
  return x.emailSent || x.emailDraft || x.touches > 0 || x.replied;
}

export type AutoNotFit = { code: string; detail: string; hide: boolean; why: "contacted" | "reviews" | null };

/** What the Prospects row carries: `auto_not_fit` for a lead that is hidden, `auto_flag` for one that stays visible with a "check" flag. */
export function autoFitFields(r: AutoNotFit | null): { auto_not_fit: { code: string; detail: string } | null; auto_flag: { code: string; detail: string; why: "contacted" | "reviews" | null } | null } {
  if (!r) return { auto_not_fit: null, auto_flag: null };
  // "other" reasons (out of state, different trade...) were never hidden: they keep showing as a label.
  if (r.hide || r.code === "other") return { auto_not_fit: { code: r.code, detail: r.detail }, auto_flag: null };
  return { auto_not_fit: null, auto_flag: { code: r.code, detail: r.detail, why: r.why } };
}
