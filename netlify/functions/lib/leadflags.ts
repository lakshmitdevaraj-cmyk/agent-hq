/**
 * Lead flags that need no website download (batch 8b): they are worked out from the lead's own fields, so they also apply
 * to leads that were checked before. Flags only: nothing here changes an address or deletes a lead.
 */
import { hostOf, keywordDomain, THROWAWAY_TLD, TOLL_FREE, TRADE_WORDS, categoryFitFlag } from "./sitecheck";
import { cityOf } from "./angle";

export { categoryFitFlag };

// ── Possible typos in an email domain ─────────────────────────────────
// Known look-alikes of ISP and mail domains. A flag to look at, never an automatic change.
const TYPO_DOMAINS: Record<string, string> = {
  "consolidate.net": "consolidated.net",
  "consolidated.com": "consolidated.net",
  "comcat.net": "comcast.net",
  "comcsat.net": "comcast.net",
  "comast.net": "comcast.net",
  "sbcgloba.net": "sbcglobal.net",
  "sbcgobal.net": "sbcglobal.net",
  "att.nett": "att.net",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.con": "gmail.com",
  "gamil.com": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "outlok.com": "outlook.com",
  "aol.con": "aol.com",
  "verzion.net": "verizon.net",
  "veirzon.net": "verizon.net",
};

export function possibleTypoDomain(email: string | null | undefined): { domain: string; suggestion: string } | null {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  const domain = e.slice(at + 1);
  const suggestion = TYPO_DOMAINS[domain];
  return suggestion ? { domain, suggestion } : null;
}

// ── Lead-gen websites that can be spotted from the lead's own fields ──
export type DomainLead = { website?: string | null; name?: string | null; address?: string | null; email?: string | null; phone?: string | null; reviews_count?: number | null; category?: string | null };

/**
 * "plumbingofmadeupville.com", "911plumbingmadeuptown.com": an address made only of trade words and the town names no company.
 * Supporting signs are added to the evidence: a service@ address on that domain, a toll-free number, a throwaway ending.
 * A web address that holds a real company name ("mockplumbing.com") is not flagged. Evidence text or null.
 */
export function domainLeadGenFlag(l: DomainLead): string | null {
  const host = l.website ? hostOf(l.website) : "";
  if (!host) return null;
  const city = cityOf(l.address ?? "");
  const noCompanyName = keywordDomain(host, "") || (city.length >= 4 && keywordDomain(host, city));
  const throwaway = THROWAWAY_TLD.test(host) && TRADE_WORDS.some((w) => host.replace(/[^a-z]/g, "").includes(w));
  if (!noCompanyName && !throwaway) return null;
  const parts: string[] = [noCompanyName ? `The website name "${host}" is only trade words and the town, with no company name` : `The website name "${host}" is a trade keyword on a throwaway domain ending`];
  const email = (l.email ?? "").trim().toLowerCase();
  if (email.startsWith("service@") && email.endsWith(`@${host}`)) parts.push(`the contact address is ${email} on that same keyword website`);
  const tf = TOLL_FREE.exec(l.phone ?? "");
  if (tf) parts.push(`the main phone number is toll-free (${tf[0].trim()})`);
  return parts.join("; ");
}
