// Daily send warning (batch 8c): how many emails went out "today" in the user's own time zone, across all campaigns. A warning only, never a block.
export const DEFAULT_DAILY_LIMIT = 30;

export function dayIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** The day for the daily count when Settings has no time zone: the sender is in India. */
export const DEFAULT_COUNT_TZ = "Asia/Kolkata";

export type SentRow = { status?: string; sent_at?: string | null; agentmail_message_id?: string | null; lead_id?: string; to_email?: string };

/** A send that does not count: through the local mock (message id "mock-..."), to a test lead, or to one of Lakshmi's own addresses. */
export function isTestSend(e: SentRow, testLeadIds: Set<string>, isOwn: (addr: string) => boolean): boolean {
  return /^mock-/i.test(String(e.agentmail_message_id ?? "")) || (!!e.lead_id && testLeadIds.has(e.lead_id)) || (!!e.to_email && isOwn(e.to_email));
}

/**
 * Real emails sent today, across all campaigns, on the day in `tz` (default India). Drafted and failed rows do not count (a bounced or
 * replied email was still sent). Mock sends, test-lead sends and sends to Lakshmi's own addresses never count.
 */
export function countSentToday(emails: SentRow[], tz: string, now: Date = new Date(), skip?: { testLeadIds: Set<string>; isOwn: (addr: string) => boolean }): number {
  const today = dayIn(now.toISOString(), tz);
  return emails.filter((e) => e.status && e.status !== "drafted" && e.status !== "failed" && e.sent_at && dayIn(e.sent_at, tz) === today && !(skip && isTestSend(e, skip.testLeadIds, skip.isOwn))).length;
}

export function limitOrDefault(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : DEFAULT_DAILY_LIMIT;
}
