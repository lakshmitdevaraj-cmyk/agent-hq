/**
 * Contact history (batch 8b). Every touch on a lead (an email, a Facebook / Instagram / LinkedIn message) is an entry of its own:
 * channel, type (first touch or follow-up), date sent, text, and source (HQ wrote it, or recorded by hand).
 *
 * Nothing is migrated. A lead's history is DERIVED on read from what already exists (sent emails, social messages marked sent) plus the
 * entries stored in agent-hq-outreach-touches, so existing data carries over unchanged. A stored entry that points at a legacy
 * sent social message (ref) replaces it, so it never counts twice. Pure functions, no I/O.
 */
export type TouchChannel = "email" | "facebook" | "instagram" | "linkedin";
export const TOUCH_CHANNELS: TouchChannel[] = ["email", "facebook", "instagram", "linkedin"];
export type TouchKind = "first" | "follow_up";

export type Touch = {
  id: string;
  lead_id: string;
  campaign_id: string | null;
  channel: TouchChannel;
  kind: TouchKind;
  sent_at: string;
  text: string;
  subject?: string | null;
  source: "hq" | "manual";
  /** The legacy social record this entry replaces (`social-<campaign>-<lead>-<channel>`). */
  ref?: string;
  derived?: boolean;
};

type EmailLike = { id?: string; lead_id?: string; status?: string; sent_at?: string; created_at?: string; sequence_position?: number; subject?: string; body_text?: string };
type SocialLike = { campaign_id?: string; lead_id?: string; channel?: string; status?: string; sent_at?: string | null; parts?: Array<{ text?: string }>; type?: string };

export const legacySocialRef = (campaign_id: string, lead_id: string, channel: string) => `social-${campaign_id}-${lead_id}-${channel}`;

const joinParts = (parts: SocialLike["parts"]) => (parts ?? []).map((p) => p.text ?? "").filter(Boolean).join("\n\n");

export function touchFromSent(t: { id: string; lead_id: string; campaign_id: string | null; channel: TouchChannel; kind: TouchKind; sent_at: string; text: string; subject?: string | null; source: "hq" | "manual"; ref?: string }): Touch {
  return { id: t.id, lead_id: t.lead_id, campaign_id: t.campaign_id, channel: t.channel, kind: t.kind, sent_at: t.sent_at, text: t.text, subject: t.subject ?? null, source: t.source, ...(t.ref ? { ref: t.ref } : {}) };
}

/** Every touch on one lead, oldest first. */
export function deriveTouches(i: { lead_id: string; campaign_id: string | null; emails: EmailLike[]; socials: SocialLike[]; stored: Touch[] }): Touch[] {
  const out: Touch[] = [];
  for (const e of i.emails) {
    if (e.lead_id !== i.lead_id) continue;
    const st = e.status ?? "drafted";
    if (st === "drafted" || st === "failed") continue;
    const at = e.sent_at ?? e.created_at;
    if (!at) continue;
    out.push({ id: `email-${e.id ?? at}`, lead_id: i.lead_id, campaign_id: i.campaign_id, channel: "email", kind: (e.sequence_position ?? 1) > 1 ? "follow_up" : "first", sent_at: at, text: e.body_text ?? "", subject: e.subject ?? null, source: "hq", derived: true });
  }
  const replaced = new Set(i.stored.map((s) => s.ref).filter((x): x is string => !!x));
  for (const s of i.socials) {
    if (s.lead_id !== i.lead_id || s.status !== "sent" || !s.sent_at || !s.channel) continue;
    const ref = legacySocialRef(s.campaign_id ?? "", i.lead_id, s.channel);
    if (replaced.has(ref)) continue;
    out.push({ id: ref, lead_id: i.lead_id, campaign_id: s.campaign_id ?? i.campaign_id, channel: s.channel as TouchChannel, kind: s.type && s.type !== "first" ? "follow_up" : "first", sent_at: s.sent_at, text: joinParts(s.parts), source: "hq", ref, derived: true });
  }
  for (const t of i.stored) if (t.lead_id === i.lead_id) out.push(t);
  return out.sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id));
}

export type TouchSummary = { counts: Record<TouchChannel, number>; last_at: string | null; replied: boolean; total: number };

export function summarizeTouches(touches: Touch[], replied: boolean): TouchSummary {
  const counts = { email: 0, facebook: 0, instagram: 0, linkedin: 0 } as Record<TouchChannel, number>;
  let last: string | null = null;
  for (const t of touches) {
    counts[t.channel]++;
    if (!last || t.sent_at > last) last = t.sent_at;
  }
  return { counts, last_at: last, replied, total: touches.length };
}

/** A sent date from the date picker (YYYY-MM-DD): today keeps the real time, an earlier day is noon UTC, a future or invalid date is refused (null). */
export function parseSentOn(on: string | null | undefined, now: Date = new Date()): string | null {
  if (on === undefined || on === null || on === "") return now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return null;
  const d = new Date(`${on}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const today = now.toISOString().slice(0, 10);
  if (on === today) return now.toISOString();
  return on > today ? null : d.toISOString();
}

/** Prospects filters on the summary: not_on_<channel>, emailed_no_reply_no_social, older_than:<days>. */
export function filterMatches(filter: string, s: TouchSummary, now: Date = new Date()): boolean {
  const m = /^not_on_(email|facebook|instagram|linkedin)$/.exec(filter);
  if (m) return s.counts[m[1] as TouchChannel] === 0;
  if (filter === "emailed_no_reply_no_social") return s.counts.email > 0 && !s.replied && s.counts.facebook + s.counts.instagram + s.counts.linkedin === 0;
  const o = /^older_than:(\d+)$/.exec(filter);
  if (o) return !!s.last_at && now.getTime() - Date.parse(s.last_at) > Number(o[1]) * 86_400_000;
  return true;
}

/** CSV: touches per channel (email, facebook, instagram, linkedin) and the last-touch date. */
export function touchCsvColumns(s: TouchSummary): Array<number | string> {
  return [s.counts.email, s.counts.facebook, s.counts.instagram, s.counts.linkedin, s.last_at ? s.last_at.slice(0, 10) : ""];
}
