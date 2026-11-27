// P2 chunk 3: copies of four helpers that are private to command.ts (campaignSkipCtx, withoutJunkEmail, autoNotFit,
// NOT_FIT_REASONS), so the SQL lead actions give the same answers without editing the old Blobs code. The bodies are
// the same as command.ts at 4e2eecb; the equivalence run over every lead (leads-equiv.test.mjs) proves it.
// When the Blobs code is removed (about 2 weeks after P5), this file becomes the only copy.
import { leadSkipReason, isJunkEmail } from "../outreach.ts";
import { leadGenDecision, otherRuleDecision } from "../leadgen.ts";
import { categoryFitFlag } from "../sitecheck.ts";

type CampaignRecord = Record<string, unknown> & { query?: string; structured_query?: { location?: string; searchTerms?: string[] } | null };
export type SkipCtx = { location: string | null; query: string; anyTrade: boolean };

/** What leadSkipReason needs to know about a campaign: where it searches and for which trade. */
export function campaignSkipCtx(c: CampaignRecord | null | undefined): SkipCtx {
  const sq = c?.structured_query;
  return { location: sq?.location ?? null, query: [c?.query ?? "", ...(Array.isArray(sq?.searchTerms) ? sq!.searchTerms! : [])].join(" "), anyTrade: c?.any_trade !== false };
}

/** A scraped address that is only a placeholder counts as "no email" (so Find emails tries again). */
export function withoutJunkEmail<T extends { email?: string | null }>(lead: T): T & { junk_email?: string } {
  return lead.email && isJunkEmail(lead.email) ? { ...lead, email: null, junk_email: lead.email } : lead;
}

/** Why a lead is marked "Not a fit" (stored as excluded_reason on the lead). */
export const NOT_FIT_REASONS = ["wholesaler", "lead_gen", "not_home_service", "has_chat_booking", "chain", "other"];

/**
 * The reason HQ itself would skip or flag this lead, in the same words as the Not a fit dropdown; null when nothing is off.
 * `hide` = the Prospects page hides it; false = it stays visible with a "check" flag.
 */
export function autoNotFit(lead: Record<string, unknown>, ctx: SkipCtx, contacted = false): { code: string; detail: string; hide: boolean; why: "contacted" | "reviews" | null } | null {
  if (lead.not_fit_kept === true) return null;
  const other = (code: string, detail: string) => ({ code, detail, ...otherRuleDecision({ code, detail }, contacted) });
  const why = leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], { ...ctx });
  if (why && why.code !== "excluded") return other(why.code === "chain" ? "chain" : "other", why.message.replace(/^Skipped: /, ""));
  const sc = (lead.site_check ?? {}) as { not_home_service?: string | null; lead_gen_listing?: string | null };
  if (sc.not_home_service) return other(/wholesal|distribut|supplier/i.test(sc.not_home_service) ? "wholesaler" : "not_home_service", sc.not_home_service);
  const lg = leadGenDecision(lead as Parameters<typeof leadGenDecision>[0], contacted);
  if (lg) return { code: "lead_gen", detail: lg.reasons.join("; "), hide: lg.hide, why: lg.why };
  const cf = categoryFitFlag(typeof lead.category === "string" ? lead.category : null);
  if (cf) return other("not_home_service", cf);
  return null;
}
