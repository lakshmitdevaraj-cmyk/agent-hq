// Daily send warning (batch 8c): how many emails went out "today" in the user's own time zone, across all campaigns. A warning only, never a block.
export const DEFAULT_DAILY_LIMIT = 30;

export function dayIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Emails actually sent today (drafted and failed rows do not count; a bounced or replied email was still sent). */
export function countSentToday(emails: Array<{ status?: string; sent_at?: string | null }>, tz: string, now: Date = new Date()): number {
  const today = dayIn(now.toISOString(), tz);
  return emails.filter((e) => e.status && e.status !== "drafted" && e.status !== "failed" && e.sent_at && dayIn(e.sent_at, tz) === today).length;
}

export function limitOrDefault(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : DEFAULT_DAILY_LIMIT;
}
