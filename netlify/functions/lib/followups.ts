// Follow-up reminders (batch 8c). Everything here is derived at read time from what was sent, the Settings gaps and the small
// per-step notes the user saves. Nothing is stored as a due date and nothing is ever sent from here. Pure helpers only.

export type FollowChannel = "email" | "facebook" | "instagram" | "linkedin";
export const FOLLOW_CHANNELS: FollowChannel[] = ["email", "facebook", "instagram", "linkedin"];

/** What the user saved about one step of one lead on one channel. */
export type StepState = { skipped?: boolean; note?: string; moved_to?: string | null };
/** One document per lead and channel (key `<lead_id>/<channel>`). `replied_by_hand` lives on the lead-wide document `<lead_id>/all`. */
export type FollowState = { lead_id: string; channel: string; steps?: Record<string, StepState>; accepted_at?: string | null; withdrawn_at?: string | null; replied_by_hand?: string | null; updated_at?: string };

export type FollowStepIn = {
  key: string; label: string; text: string; sent_at: string | null;
  status?: "ready" | "check" | "blocked" | null;
  /** Email rows only: the row id (for sending). */
  id?: string;
};
export type StoppedReason = "replied" | "opt_out" | "do_not_contact";
export type FollowInput = {
  lead_id: string; campaign_id: string; name: string; channel: FollowChannel;
  /** In order: the first message, then each follow-up. For LinkedIn the connection note comes first, then the first message. */
  steps: FollowStepIn[];
  state?: FollowState | null;
  /** Days after the FIRST message for follow-up 1, follow-up 2, ... (Settings, default 3, 8, 15). */
  gaps: number[];
  stopped?: StoppedReason | null;
  /** Today as YYYY-MM-DD in the user's own time zone. */
  today: string;
};
export type Bucket = "overdue" | "today" | "week" | "later" | "waiting" | "stopped";
export type FollowRow = {
  lead_id: string; campaign_id: string; name: string; channel: FollowChannel;
  step_key: string; step_label: string; position: number;
  due_date: string | null; bucket: Bucket; days_late: number;
  last_sent_at: string | null; text: string; review_status: FollowStepIn["status"]; email_id?: string;
  note?: string; moved: boolean;
  stopped_reason?: StoppedReason; waiting_text?: string; withdraw_prompt?: boolean; can_mark: boolean;
};

export const WITHDRAW_AFTER_DAYS = 21;
export const STOP_TEXT: Record<StoppedReason, string> = { replied: "Stopped: replied", opt_out: "Stopped: asked us to stop", do_not_contact: "Stopped: do not contact" };

const DAY = 86_400_000;
export const dayOf = (iso: string): string => iso.slice(0, 10);
export const addDays = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

export function bucketOf(due: string, today: string): Bucket {
  const d = daysBetween(today, due);
  return d < 0 ? "overdue" : d === 0 ? "today" : d <= 7 ? "week" : "later";
}

/**
 * The NEXT unsent step for one lead on one channel, as a row. A lead with nothing left, or whose first message is not sent yet, gives no row.
 * Stopped (replied, opt-out, do-not-contact) gives one row marked stopped so it can be shown as "Stopped: replied" and is never counted as due.
 */
export function nextFollowUp(i: FollowInput): FollowRow | null {
  const st = i.state?.steps ?? {};
  const steps = i.steps;
  const linkedin = i.channel === "linkedin";
  // Index of the first message of the run: for LinkedIn the connection note is step 0 and the first message step 1.
  const firstIdx = linkedin ? 1 : 0;
  if (steps.length <= firstIdx) return null;
  const first = steps[firstIdx];
  const note = linkedin ? steps[0] : null;
  const rowBase = (s: FollowStepIn, idx: number) => ({ lead_id: i.lead_id, campaign_id: i.campaign_id, name: i.name, channel: i.channel, step_key: s.key, step_label: s.label, position: idx + 1, text: s.text, review_status: s.status ?? null, email_id: s.id, note: st[s.key]?.note || undefined, moved: !!st[s.key]?.moved_to });
  const nextIdx = steps.findIndex((s, idx) => !s.sent_at && !st[s.key]?.skipped && idx >= (first.sent_at ? firstIdx + 1 : 0));
  const stopRow = (s: FollowStepIn, idx: number): FollowRow => ({ ...rowBase(s, idx), due_date: null, bucket: "stopped", days_late: 0, last_sent_at: null, stopped_reason: i.stopped!, can_mark: false });

  if (linkedin && note) {
    // Note not sent yet: nothing is waiting on a follow-up.
    if (!note.sent_at) return null;
    if (i.state?.withdrawn_at) return null;
    if (!first.sent_at && !i.state?.accepted_at) {
      const idx0 = 0;
      if (i.stopped) return stopRow(first, 1);
      const sentDay = dayOf(note.sent_at);
      const waited = daysBetween(sentDay, i.today);
      const prompt = waited >= WITHDRAW_AFTER_DAYS;
      return { ...rowBase(note, idx0), step_key: first.key, step_label: first.label, position: 2, text: first.text, review_status: first.status ?? null, due_date: null, bucket: "waiting", days_late: 0, last_sent_at: note.sent_at, waiting_text: prompt ? `Waiting for them to accept since ${sentDay} (${waited} days). Withdraw the invitation?` : `Waiting for them to accept (sent ${sentDay}, ${waited} day${waited === 1 ? "" : "s"} ago).`, withdraw_prompt: prompt, can_mark: false };
    }
  }
  if (!first.sent_at && !(linkedin && i.state?.accepted_at)) return null; // the first message is not out yet: nothing to follow up
  if (nextIdx < 0) return null; // everything sent or skipped
  const s = steps[nextIdx];
  if (i.stopped) return stopRow(s, nextIdx);
  const moved = st[s.key]?.moved_to;
  let anchor: string;
  let offset: number;
  if (linkedin && !first.sent_at) {
    // Accepted: the first message is due the day after they accepted.
    anchor = dayOf(i.state!.accepted_at!);
    offset = 1;
  } else {
    anchor = dayOf(first.sent_at!);
    const nth = nextIdx - firstIdx; // 1 = the first follow-up
    offset = i.gaps[Math.max(0, nth - 1)] ?? i.gaps[i.gaps.length - 1] ?? 3;
  }
  const due = moved && /^\d{4}-\d{2}-\d{2}$/.test(moved) ? moved : addDays(anchor, offset);
  const prev = [...steps.slice(0, nextIdx)].reverse().find((x) => x.sent_at);
  const bucket = bucketOf(due, i.today);
  return { ...rowBase(s, nextIdx), due_date: due, bucket, days_late: Math.max(0, daysBetween(due, i.today)), last_sent_at: prev?.sent_at ?? null, can_mark: true };
}

/** Counts for the page, the Office card and the sidebar: only rows that are due today or overdue. */
export function countDue(rows: FollowRow[]): { email: number; social: number; total: number; week: number } {
  const due = rows.filter((r) => r.bucket === "overdue" || r.bucket === "today");
  const email = due.filter((r) => r.channel === "email").length;
  return { email, social: due.length - email, total: due.length, week: rows.filter((r) => r.bucket === "week").length };
}

/** Parses the Settings gaps ("3, 8, 15") back to numbers; anything unusable gives the default. */
export function gapsOrDefault(v: unknown, fallback: number[] = [3, 8, 15]): number[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const nums = arr.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 120);
  return nums.length ? nums : fallback;
}
