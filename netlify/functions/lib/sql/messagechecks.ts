// P2 chunk 5b: message checks that need the lead (F35, F36, F37, F40). Pure functions; `codeCheckDraft` runs them on
// every save on the SQL path. "Check this" findings are soft hits, false claims are hard (Blocked).
//   F35  the address's domain is not the website's, or the greeting doesn't match a personal address   → Check this
//   F36  the greeting is the first name taken from a personal address while no owner is saved           → Check this
//   F37  "your assistant" (says they already have one) → Check this; email 4 pitching → Blocked;
//        an opening-hours claim with no saved hours source → Blocked
//   F40  "the number isn't tap-to-call" unless the saved fact says the page turns phone links off      → Blocked
import type { Hit } from "../messagerules.ts";
import { leadHours } from "../sitecheck.ts";

export type MsgLead = {
  email?: string | null; website?: string | null; name?: string | null; owner_name?: string | null; contact_name?: string | null;
  site_check?: Record<string, unknown> | null; raw?: unknown;
};
type Kind = "email1" | "email2" | "email3" | "email4";
const H = (id: string, level: Hit["level"], label: string, because: string, excerpt?: string): Hit => ({ id, level, label, because, ...(excerpt ? { excerpt: excerpt.slice(0, 80) } : {}) });

/** Free-mail and ISP-free domains many small firms use: a different domain here is not a warning sign. */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "att.net", "sbcglobal.net", "comcast.net", "verizon.net", "bellsouth.net", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com"]);
/** Shared mailbox names: never a person's first name. */
const ROLE = new Set(["info", "office", "service", "services", "contact", "sales", "admin", "support", "hello", "hi", "team", "jobs", "billing", "dispatch", "help", "mail", "email", "owner", "booking", "bookings", "schedule", "scheduling", "estimates", "estimate", "quotes", "quote", "accounts", "accounting", "hr", "customerservice", "frontdesk", "reception", "inquiries", "enquiries", "service-desk", "repairs", "work", "web", "website", "marketing", "careers", "orders", "noreply", "no-reply"]);

const hostOf = (website: string | null | undefined): string | null => {
  if (!website?.trim()) return null;
  try { return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};
/** "mail.acme.com" and "acme.com" are the same business; "lane.com" and "laneplumbing.com" are not. */
const sameSite = (a: string, b: string): boolean => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** The first name in the greeting line ("Hi Dana," → "dana"), or null. */
export function greetingName(body: string): string | null {
  const first = body.replace(/\r/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const m = /^(?:hi|hello|hey|dear|good (?:morning|afternoon))\s+([A-Za-z][A-Za-z'-]+)\b/i.exec(first);
  if (!m) return null;
  const n = m[1].toLowerCase();
  return ["there", "team", "all", "folks", "everyone", "friend", "sir", "madam"].includes(n) ? null : n;
}

/** The first-name part of a personal address ("robin@…", "robin.lane@…" → "robin"), or null for shared mailboxes. */
export function addressFirstName(email: string | null | undefined, businessName?: string | null): string | null {
  const local = (email ?? "").split("@")[0]?.toLowerCase() ?? "";
  const part = local.split(/[._+-]/)[0].replace(/\d+$/, "");
  if (!/^[a-z]{2,12}$/.test(part) || ROLE.has(part) || ROLE.has(local)) return null;
  const bizWords = (businessName ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  if (bizWords.some((w) => part === w || part.startsWith(w) || w.startsWith(part))) return null; // "madeup@madeup-test.com", "lane@…" when the firm is Lane Plumbing
  // Only a part made of the separator-split first piece is a name when the address has a separator, or a short one alone.
  if (!/[._-]/.test(local) && part.length > 9) return null;
  return part;
}

/** Does this address belong to the person greeted? First name, initial + surname, or first + surname, from the saved owner. */
function addressFits(email: string, greet: string, owner: string | null | undefined): boolean {
  const local = email.split("@")[0].toLowerCase().replace(/\d+$/, "");
  if (local.startsWith(greet)) return true;
  const words = (owner ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const last = words.length > 1 ? words[words.length - 1] : "";
  if (!last || words[0] !== greet) return false;
  const flat = local.replace(/[._-]/g, "");
  return flat === last || flat === `${greet[0]}${last}` || flat === `${greet}${last}` || flat.startsWith(`${greet[0]}${last}`);
}

const YOUR_ASSISTANT = /\byour (?:own |new )?(?:ai |a\.i\. |virtual )?(?:assistant|receptionist)\b/i;
const PITCH = /\b(?:we set up|we build|i set up|i build|i built|i can set up|ai (?:receptionist|assistant|agent|phone)|answering service|virtual receptionist|our (?:service|product|software))\b/i;
const HOURS_CLAIM = /\b(?:open (?:until|till|til|from|late|early|on (?:mon|tues|wednes|thurs|fri|satur|sun)days?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|weekends?|evenings?|24 hours)|closed (?:on )?(?:mon|tues|wednes|thurs|fri|satur|sun)days?|closed (?:on )?weekends?|closed (?:at|by|after) \d|(?:after|before|from|until|till) \d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|(?:business|opening|office) hours (?:are|end|close|run))\b/i;
/** copy of the phone_not_tappable claim in lib/review.ts (FACT_CLAIMS) */
const TAP_CLAIM = /(?:can['’]?t|cannot|unable to|not able to)\s+(?:tap|click)[^.]{0,25}(?:call|number)|(?:no|not a)\s+(?:tap|click)[- ]to[- ]call|number\s+(?:isn['’]t|is not)\s+(?:clickable|tappable)/i;

/** Is a saved hours source there to back an hours claim (site hours we may use, or Google's opening hours)? */
function hoursSourced(lead: MsgLead): boolean {
  // Only "is there a source" (F37). `hours_usable` (the site claims round-the-clock cover) is the reviewer's call, not this check's.
  const sc = lead.site_check ?? {};
  try { return !!leadHours({ raw: lead.raw, site_check: sc as { site_hours?: unknown } }); } catch { return false; }
}

/** The lead-aware checks for one email. `to` is the address the email goes to (the draft's, else the lead's). */
export function messageChecks(kind: Kind, body: string, lead: MsgLead, to?: string | null): Hit[] {
  const hits: Hit[] = [];
  const t = body.trim();
  if (!t) return hits;
  const address = (to ?? lead.email ?? "").trim().toLowerCase();
  const dom = address.includes("@") ? address.split("@")[1] : null;
  const site = hostOf(lead.website);

  // F35: the address is on another business's domain.
  if (dom && site && !FREE_MAIL.has(dom) && !sameSite(dom, site)) {
    hits.push(H("recipient-domain", "soft", "The address is not on the website's domain", `It goes to @${dom} but the website is ${site}. Check this is the right business before sending.`));
  }
  // F35 / F36: the greeting and a personal address.
  const greet = greetingName(t);
  const fromAddress = address ? addressFirstName(address, lead.name) : null;
  if (greet && fromAddress && !addressFits(address, greet, lead.owner_name)) {
    hits.push(H("greeting-recipient", "soft", "The greeting does not match the address", `It says "Hi ${greet[0].toUpperCase()}${greet.slice(1)}" but goes to a personal address that looks like someone else's. Check who reads this inbox.`));
  } else if (greet && fromAddress === greet && !(lead.owner_name ?? "").trim()) {
    hits.push(H("greeting-from-address", "soft", "The greeting comes from the email address only", "No owner is saved, so the first name was read from the address. Check it is the person you mean to write to."));
  }
  // F37: "your assistant" says they already have one.
  const ya = YOUR_ASSISTANT.exec(t);
  if (ya) hits.push(H("your-assistant", "soft", "Says \"your assistant\"", "That reads as if they already have one. Say \"an assistant\" or describe what it does.", ya[0]));
  // F37: email 4 is the last note and must not pitch.
  const pitch = kind === "email4" ? PITCH.exec(t) : null;
  if (pitch) hits.push(H("email4-pitch", "hard", "Email 4 pitches the offer", "The last email only closes the loop and offers the free thing; it never pitches.", pitch[0]));
  // F37: opening hours only with a saved source.
  const hrs = HOURS_CLAIM.exec(t);
  if (hrs && !hoursSourced(lead)) hits.push(H("hours-unsourced", "hard", "An opening-hours claim with no saved source", "Hours may only be mentioned when the website or Google listing we saved shows them.", hrs[0]));
  // F40: tap-to-call is lead information only, unless the page really turns phone links off.
  const tap = TAP_CLAIM.exec(t);
  if (tap) {
    const facts = Array.isArray(lead.site_check?.facts) ? (lead.site_check?.facts as Array<{ key?: string; value?: unknown; no_autolink?: boolean }>) : [];
    const confirmed = facts.some((f) => f.key === "phone_not_tappable" && f.value === true && f.no_autolink === true);
    if (!confirmed) hits.push(H("tap-claim", "hard", "Says the number is not tap-to-call", "Phones make plain numbers tappable on their own; this is lead information, never a message claim, unless the page turns that off.", tap[0]));
  }
  return hits;
}
