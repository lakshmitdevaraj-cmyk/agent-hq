// "Draft reply" helper for the Inbox: pure pieces. The AI writes only the short answer and the one sentence on why a
// 30-minute call helps; the three time slots and the booking link are built here from Settings, never by the AI.
// The result is shown for editing and is never sent.

/** The main time zone of each US state (a few states are split across two; the larger part is used). */
export const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

/** The two-letter state from an address like "1 Main St, Katy, TX 77494, USA". null when there is none. */
export function stateFromAddress(address: unknown): string | null {
  const m = /,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/.exec(typeof address === "string" ? address : "");
  return m && STATE_TZ[m[1]] ? m[1] : null;
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number; wd: string };
function partsIn(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, wd: o.weekday };
}

/** The UTC instant at which the wall clock in `tz` reads y-mo-d h:00. */
export function zonedInstant(y: number, mo: number, d: number, h: number, tz: string): Date {
  let guess = Date.UTC(y, mo - 1, d, h, 0);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, 0) - shown;
  }
  return new Date(guess);
}

/** "CST", "EST" ... and "IST" for India (Intl prints "GMT+5:30" for it). */
function zoneLabel(at: Date, tz: string): string {
  if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "IST";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? tz;
}

function clock(at: Date, tz: string): string {
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).formatToParts(at)) o[p.type] = p.value;
  return `${o.hour}:${o.minute} ${o.dayPeriod}`;
}

/** The slot as the prospect reads it, then the sender's own clock: "Tuesday, November 24 at 10:00 AM CST (9:30 PM IST for me)". */
function slotText(at: Date, tz: string, senderTz?: string): string {
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).formatToParts(at)) o[p.type] = p.value;
  const base = `${o.weekday}, ${o.month} ${o.day} at ${o.hour}:${o.minute} ${o.dayPeriod} ${zoneLabel(at, tz)}`;
  if (!senderTz || senderTz === tz) return base;
  const mine = partsIn(at, senderTz), theirs = partsIn(at, tz);
  const dayNote = mine.d !== theirs.d ? ` on ${new Intl.DateTimeFormat("en-US", { timeZone: senderTz, weekday: "short" }).format(at)}` : "";
  return `${base} (${clock(at, senderTz)}${dayNote} ${zoneLabel(at, senderTz)} for me)`;
}

export type Slot = { at: string; text: string };

/**
 * Three proposed call times, on three different working days starting the next working day. Each one falls inside working
 * hours (9:00 to 17:00) for the sender in `senderTz` AND for the prospect in `prospectTz`, and is shown in the prospect's zone.
 * These are proposals: match them against the real calendar before sending.
 */
export function proposeSlots(now: Date, senderTz: string, prospectTz: string, count = 3): Slot[] {
  // First the sender's 9:00 to 17:00; when the two zones barely overlap (an India based sender and a US prospect) the sender's evenings
  // count too, up to 23:30, so there are always three proposals.
  const strict = slotsWithin(now, senderTz, prospectTz, count, 540, 1020);
  if (strict.length >= count) return strict;
  return slotsWithin(now, senderTz, prospectTz, count, 480, 1410);
}

function slotsWithin(now: Date, senderTz: string, prospectTz: string, count: number, fromMin: number, toMin: number): Slot[] {
  const prefer = [10, 14, 11, 15, 9, 13, 12, 16]; // preferred start hours in the prospect's zone, tried in order
  const out: Slot[] = [];
  const base = partsIn(now, prospectTz);
  const seen = new Set<string>();
  for (let add = 1; add <= 21 && out.length < count; add++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + add, 12));
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(day);
    if (wd === "Sat" || wd === "Sun") continue;
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    // spread the hours: the first slot prefers late morning, the second early afternoon, the third mid morning
    const order = [prefer[out.length % prefer.length], ...prefer];
    for (const h of order) {
      const at = zonedInstant(y, mo, d, h, prospectTz);
      const mine = partsIn(at, senderTz);
      const startMin = mine.h * 60 + mine.mi;
      if (startMin < fromMin || startMin + 30 > toMin) continue; // inside the sender's window
      const key = at.toISOString();
      if (seen.has(key)) continue;
      seen.add(key);
      const text = slotText(at, prospectTz, senderTz);
      out.push({ at: key, text });
      break;
    }
  }
  return out;
}

export const REPLY_SYSTEM_PROMPT = `You write the short middle of a reply to a person who answered a cold email from a small AI-receptionist company. Output JSON only: {"answer": string, "why_call": string}.
- "answer": ONE or TWO plain sentences that answer what the person actually wrote or asked, using only what is in their message and the saved facts. If they asked for a call at a time (for example "Can you call me tomorrow?"), say yes to a call and, if one of the TIMES LISTED BELOW is on the day they asked for, say that day works; otherwise say the nearest times are below. The times are already printed right under your text, so NEVER say they will be sent later or shortly. Never promise a time that is not listed. If they asked something you cannot know, say you will cover it on the call. Never invent prices, results or customers. Never say "we discussed", "our chat" or "our conversation": nothing was discussed yet.
- "why_call": exactly ONE sentence saying why a 30-minute call helps THEM (for example, seeing the assistant answer a call for their business). It is about their benefit, not ours.
- No greeting, no sign-off, no times, no links (these are added separately). No exclamation marks, no dashes used as punctuation, no emoji, no hype, no apology.
- Plain, warm, direct. Do not repeat their words back to them.`;

export function replyUserPrompt(reply: { from?: string | null; subject?: string | null; text: string }, lead: { name?: string; city?: string; owner?: string }, ourEmail1?: string): string {
  return JSON.stringify({ their_reply: reply.text.slice(0, 1500), their_subject: reply.subject ?? null, business: lead.name ?? null, city: lead.city ?? null, owner_name: lead.owner ?? null, our_first_email: ourEmail1 ? ourEmail1.slice(0, 900) : null });
}

/** Puts the AI's two sentences together with the greeting, the three slots and the booking link. */
export function assembleReply(o: { greeting: string; answer: string; whyCall: string; slots: Slot[]; bookingLink: string; senderName: string }): string {
  const lines = [o.greeting, "", `${o.answer.trim()} ${o.whyCall.trim()}`.trim(), ""];
  if (o.slots.length) lines.push("Would any of these work for a 30-minute call?", ...o.slots.map((s) => `- ${s.text}`), "");
  lines.push(`If it is easier, pick a time here: ${o.bookingLink}`, "", "Best,", o.senderName);
  return lines.join("\n");
}

/** The first `n` sentences of a text (the writer sometimes runs long). */
export function firstSentences(text: string, n: number): string {
  const parts = text.trim().replace(/\s+/g, " ").match(/[^.?!]+[.?!]+(?:\s|$)|[^.?!]+$/g) ?? [text.trim()];
  return parts.slice(0, n).join("").trim();
}
export const sentenceCount = (text: string): number => (text.trim().replace(/\s+/g, " ").match(/[^.?!]+[.?!]+(?:\s|$)|[^.?!]+$/g) ?? []).length;

const NOT_A_PERSON = /\b(?:llc|inc|co|corp|ltd|plumbing|hvac|heating|air|roofing|electric|services?|team|office|support|info|sales|admin|contact|mail)\b/i;
/** "Katy Owner <katy@x.com>" gives "Katy". Null when the sender line has no personal first name (just an address, or a business). */
export function firstNameFromSender(from: string | null | undefined): string | null {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from ?? "")?.[1]?.trim();
  if (!name || /@/.test(name) || NOT_A_PERSON.test(name)) return null;
  const first = name.split(/\s+/)[0].replace(/[^A-Za-z'-]/g, "");
  return first.length >= 2 ? first[0].toUpperCase() + first.slice(1) : null;
}
