/**
 * Social messages (batch 8): Facebook, Instagram and LinkedIn first messages that the user copies and sends by hand.
 * Pure helpers only (channels, limits, checks). The app never opens or posts on these sites.
 */
import { checkSocialBody, wordCount } from "./angle";
import { leadSkipReason, isGovEduEmail } from "./outreach";

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

/**
 * first            = a standalone first message on this channel (never mentions an email: the owner may never have seen it)
 * follow_up_email  = the user picked "Follow-up (mention my email)": refers to the email naturally
 * follow_up_channel = a second message on a channel where one was already sent
 */
export type SocialType = "first" | "follow_up_email" | "follow_up_channel";
export const SOCIAL_TYPES: SocialType[] = ["first", "follow_up_email", "follow_up_channel"];

/** The type of a new message: first by default; a follow-up only when a message was already sent on that channel or the user picked it. */
export function socialTypeFor(requested: string | null | undefined, sentOnChannel: boolean): SocialType {
  if (requested === "follow_up_email") return "follow_up_email";
  return sentOnChannel ? "follow_up_channel" : "first";
}

/** The texts a message has: LinkedIn's connection note belongs to a first message only; a follow-up is the message alone. */
export function partsFor(channel: SocialChannel, type: SocialType = "first"): PartSpec[] {
  const all = SOCIAL_SPECS[channel].parts;
  return type === "first" ? all : all.filter((p) => p.key !== "note");
}

/** "Facebook: 40-80 words" etc., sent to the writer and the reviewer. */
export function limitsText(channel: SocialChannel, type: SocialType = "first"): string {
  return partsFor(channel, type).map((p) => `${p.label}: ${p.maxChars ? `at most ${p.maxChars} characters` : `${p.minWords}-${p.maxWords} words`}`).join("; ");
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
 * Why no social message is written for this lead, or null. A sent email, an email on file or a bounced address is NEVER a
 * reason (they say nothing about a Facebook page). Still skipped: replied (on any channel), do not contact, excluded, chain or
 * franchise, lead-gen flagged, not a home-service business. A bulk run also needs a finished website check (and a browser check when
 * the site needs one), so it never states a guess; `manualStart` (the user starts one Facebook first message by hand) skips only that.
 */
export function socialSkipReason(lead: SkipLead, ctx: { location: string | null; query: string; anyTrade: boolean }, o: { replied: boolean; manualStart?: boolean }): string | null {
  if (lead.do_not_contact) return "Do not contact";
  if (o.replied) return "Already replied";
  if (isGovEduEmail(lead.email)) return ".gov/.edu address";
  // The lead's email is left out of the shared rules: a placeholder address must not block a Facebook message.
  const skip = leadSkipReason({ ...lead, email: null }, ctx);
  if (skip) return skip.message.replace(/^Skipped: /, "");
  const sc = lead.site_check;
  if (!lead.not_fit_kept && sc?.lead_gen_listing) return `Flagged as a lead-gen listing (${sc.lead_gen_listing})`;
  if (!lead.not_fit_kept && sc?.not_home_service) return `May not be a home-service business (${sc.not_home_service})`;
  if (o.manualStart) return null;
  if (!sc?.checked_at || sc.error) return "Website not checked yet";
  if (sc.needs_browser && sc.via !== "browser") return "Needs a browser check first";
  return null;
}

export type SocialCheckCtx = { type?: SocialType; phoneOnlyOk?: boolean; callsOnly?: boolean; noHours?: boolean; trade?: string | null; copySources?: string[]; factCount: number; factUsed: number | null };

const EMAIL_MENTION = /\b(?:my|our|the|an?|your) (?:short |quick |earlier |recent )?e-?mail\b|\be-?mail(?:ed)? (?:you|me|last|earlier|yesterday)|\bsent (?:you )?(?:an? |a short |a quick )?e-?mail\b|\bemailed (?:you|your|the)\b/i;
const FOLLOW_UP_WORDS = /\b(?:following up|follow(?:ing)?[- ]up|just checking in|checking in|circling back|touching base|bumping this|bump)\b/i;

/** Free code checks for one channel's texts. Empty list = passed. */
export function precheckSocial(channel: SocialChannel, parts: Record<string, string>, ctx: SocialCheckCtx): string[] {
  const fails: string[] = [];
  const type: SocialType = ctx.type ?? "first";
  for (const spec of partsFor(channel, type)) {
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
    if (spec.needsCall) {
      // A standalone first message must not mention an email (the owner may never have seen it); "Follow-up (mention my email)" must.
      if (type === "first" && EMAIL_MENTION.test(text)) fails.push(`${tag} mentions an email, but this is a standalone first message and the owner may never have seen it: leave the email out`);
      if (type === "follow_up_email" && !/e-?mail/i.test(text)) fails.push(`${tag} must refer to the email you sent, naturally (for example "I sent a short email to your office last week")`);
      if (type !== "first" && FOLLOW_UP_WORDS.test(text)) fails.push(`${tag} sounds like a nudge ("${(FOLLOW_UP_WORDS.exec(text) ?? [""])[0]}"): say something new instead of following up`);
    }
    for (const f of checkSocialBody(text, { phoneOnlyOk: ctx.phoneOnlyOk, callsOnly: ctx.callsOnly, noHours: ctx.noHours, trade: ctx.trade, copySources: ctx.copySources })) fails.push(`${tag}: ${f}`);
  }
  // fact_used is bookkeeping only: never a failure.
  return fails;
}

/** The writer's JSON -> parts (a missing key stays empty and fails the check). */
export function partsFromAnswer(channel: SocialChannel, o: Record<string, unknown>, type: SocialType = "first"): Record<string, string> {
  const clean = (v: unknown) => String(v ?? "").replace(/\r/g, "").trim();
  const out: Record<string, string> = {};
  for (const spec of partsFor(channel, type)) out[spec.key] = clean(o[spec.key]);
  return out;
}

export const partsToList = (channel: SocialChannel, parts: Record<string, string>, type: SocialType = "first"): SocialPart[] => partsFor(channel, type).map((s) => ({ key: s.key, label: s.label, text: parts[s.key] ?? "" }));

export type EarlierMessage = { at: string; text: string };
export type EarlierEmail = { at: string; subject: string | null };

/**
 * What the follow-up writer is told about earlier contact (batch 8b):
 * - every earlier message sent on THIS channel, with its date and text (oldest first), so it does not repeat them;
 * - for "Follow-up (mention my email)" only: the subject and date of every email sent to the lead, so it can refer to the email naturally.
 * A first message gets neither (it must stand alone and never mention an email). Dates are YYYY-MM-DD.
 */
export function socialContextLines(type: SocialType, earlier: EarlierMessage[], emails: EarlierEmail[]): string[] {
  const out: string[] = [];
  if (type !== "first" && earlier.length > 0) {
    out.push(`EARLIER MESSAGES SENT ON THIS CHANNEL (oldest first). Do not repeat them: say something new and refer back to them naturally. Never write "following up":\n${earlier.slice(-4).map((m, i) => `${i + 1}. [${m.at.slice(0, 10)}] ${m.text.slice(0, 600)}`).join("\n")}`);
  }
  if (type === "follow_up_email" && emails.length > 0) {
    out.push(`EMAILS ALREADY SENT TO THIS LEAD (subject and date). Mention the email naturally, once; never write "following up":\n${emails.slice(-3).map((e, i) => `${i + 1}. [${e.at.slice(0, 10)}] subject: ${e.subject ?? "(no subject)"}`).join("\n")}`);
  }
  return out;
}
