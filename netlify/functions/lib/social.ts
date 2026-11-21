/**
 * Social messages (batch 8): Facebook, Instagram and LinkedIn first messages that the user copies and sends by hand.
 * Pure helpers only (channels, limits, checks). The app never opens or posts on these sites.
 */
import { checkSocialBody, wordCount } from "./angle";
import { leadSkipReason } from "./outreach";

export type SocialChannel = "facebook" | "instagram" | "linkedin";
export type SocialPartKey = "message" | "note" | "dm";
export type SocialPart = { key: SocialPartKey; label: string; text: string };

type PartSpec = { key: SocialPartKey; label: string; minWords?: number; maxWords?: number; maxChars?: number; needsCall: boolean };
export const SOCIAL_SPECS: Record<SocialChannel, { label: string; parts: PartSpec[] }> = {
  facebook: { label: "Facebook", parts: [{ key: "message", label: "Message", minWords: 40, maxWords: 80, needsCall: true }] },
  instagram: { label: "Instagram", parts: [{ key: "message", label: "Message", minWords: 25, maxWords: 50, needsCall: true }] },
  linkedin: {
    label: "LinkedIn",
    parts: [
      { key: "note", label: "Connection note", maxChars: 200, needsCall: false },
      { key: "dm", label: "First message", minWords: 40, maxWords: 80, needsCall: true },
    ],
  },
};
export const SOCIAL_CHANNELS: SocialChannel[] = ["facebook", "instagram", "linkedin"];

/** "Facebook: 40-80 words" etc., sent to the writer and the reviewer. */
export function limitsText(channel: SocialChannel): string {
  return SOCIAL_SPECS[channel].parts.map((p) => `${p.label}: ${p.maxChars ? `at most ${p.maxChars} characters` : `${p.minWords}-${p.maxWords} words`}`).join("; ");
}

type LeadLinks = { social?: { facebook?: string | null; instagram?: string | null; linkedin_company?: string | null; linkedin_person?: string | null } | null };

/** The channels a lead has a saved page for, with the page to open. LinkedIn prefers the person. */
export function channelsFor(lead: LeadLinks): Array<{ channel: SocialChannel; url: string }> {
  const so = lead.social ?? {};
  const out: Array<{ channel: SocialChannel; url: string }> = [];
  if (so.facebook) out.push({ channel: "facebook", url: so.facebook });
  if (so.instagram) out.push({ channel: "instagram", url: so.instagram });
  const li = so.linkedin_person || so.linkedin_company;
  if (li) out.push({ channel: "linkedin", url: li });
  return out;
}

type SkipLead = Parameters<typeof leadSkipReason>[0] & {
  do_not_contact?: boolean;
  /** The user kept this lead although HQ flagged it (chain, lead-gen, not home service): the flags no longer skip it. */
  not_fit_kept?: boolean;
  site_check?: { checked_at?: string; error?: string; needs_browser?: boolean; via?: string; lead_gen_listing?: string | null; not_home_service?: string | null } | null;
};

/**
 * Why no social message is written for this lead, or null. Same rules as emails: skipped / excluded, do not contact,
 * chain or franchise, lead-gen flagged, not a home-service business, bounced. A social message also needs a finished
 * website check (and a browser check when the site needs one), so it never states a guess.
 */
export function socialSkipReason(lead: SkipLead, ctx: { location: string | null; query: string; anyTrade: boolean }, o: { bounced: boolean; contactBlocked: boolean }): string | null {
  if (lead.do_not_contact) return "Do not contact";
  const skip = leadSkipReason(lead, ctx);
  if (skip) return skip.message.replace(/^Skipped: /, "");
  if (o.contactBlocked) return "Already contacted or blocked";
  if (o.bounced) return "Email bounced";
  const sc = lead.site_check;
  if (!lead.not_fit_kept && sc?.lead_gen_listing) return `Flagged as a lead-gen listing (${sc.lead_gen_listing})`;
  if (!lead.not_fit_kept && sc?.not_home_service) return `May not be a home-service business (${sc.not_home_service})`;
  if (!sc?.checked_at || sc.error) return "Website not checked yet";
  if (sc.needs_browser && sc.via !== "browser") return "Needs a browser check first";
  return null;
}

export type SocialCheckCtx = { phoneOnlyOk?: boolean; callsOnly?: boolean; noHours?: boolean; trade?: string | null; copySources?: string[]; factCount: number; factUsed: number | null };

/** Free code checks for one channel's texts. Empty list = passed. */
export function precheckSocial(channel: SocialChannel, parts: Record<string, string>, ctx: SocialCheckCtx): string[] {
  const fails: string[] = [];
  for (const spec of SOCIAL_SPECS[channel].parts) {
    const text = (parts[spec.key] ?? "").trim();
    const tag = `${SOCIAL_SPECS[channel].label} ${spec.label.toLowerCase()}`;
    if (!text) { fails.push(`${tag} is empty`); continue; }
    if (spec.maxChars && text.length > spec.maxChars) fails.push(`${tag} has ${text.length} characters (the limit is ${spec.maxChars}; never cut it off, write it shorter)`);
    const w = wordCount(text);
    if (spec.minWords && w < spec.minWords) fails.push(`${tag} has ${w} words (must be ${spec.minWords}-${spec.maxWords})`);
    if (spec.maxWords && w > spec.maxWords) fails.push(`${tag} has ${w} words (must be ${spec.minWords}-${spec.maxWords})`);
    if (spec.needsCall && !/30-minute free call/i.test(text)) fails.push(`${tag} does not ask for a "30-minute free call"`);
    // The connection note goes out BEFORE they accept, so it cannot thank them for accepting or talk as if they are connected.
    if (spec.key === "note" && /\b(?:thanks?|thank you)\b[^.!?]{0,20}\b(?:accept\w*|connect\w*|adding|add(?:ed)? me)\b|\bglad (?:we['’]re|we are|to be) connected\b|\bnow that we['’]re connected\b|\bgreat to (?:be )?connect(?:ed)?\b/i.test(text)) fails.push(`${tag} thanks them for accepting or talks as if they are already connected, but it is sent before they accept: only say hello and why you are connecting`);
    if (!spec.needsCall && /30[- ]minute|free call|\bcall\b/i.test(text)) fails.push(`${tag} must only say hello, with no pitch or call to action`);
    // The last line must not be a signature ("Best," / "Thanks," / "Lakshmi").
    const last = text.split(/\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
    if (/^(?:best|regards|kind regards|thanks|thank you|cheers|sincerely|warmly)\b[,!.]?\s*(?:lakshmi.*)?$/i.test(last) || /^[-–—~]?\s*lakshmi(?: devaraj)?[,.]?$/i.test(last)) fails.push(`${tag} ends with a signature`);
    for (const f of checkSocialBody(text, { phoneOnlyOk: ctx.phoneOnlyOk, callsOnly: ctx.callsOnly, noHours: ctx.noHours, trade: ctx.trade, copySources: ctx.copySources })) fails.push(`${tag}: ${f}`);
  }
  // fact_used is bookkeeping only: never a failure.
  return fails;
}

/** The writer's JSON -> parts (a missing key stays empty and fails the check). */
export function partsFromAnswer(channel: SocialChannel, o: Record<string, unknown>): Record<string, string> {
  const clean = (v: unknown) => String(v ?? "").replace(/\r/g, "").trim();
  const out: Record<string, string> = {};
  for (const spec of SOCIAL_SPECS[channel].parts) out[spec.key] = clean(o[spec.key]);
  return out;
}

export const partsToList = (channel: SocialChannel, parts: Record<string, string>): SocialPart[] => SOCIAL_SPECS[channel].parts.map((s) => ({ key: s.key, label: s.label, text: parts[s.key] ?? "" }));
