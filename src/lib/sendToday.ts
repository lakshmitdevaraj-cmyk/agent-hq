import { call } from "@/lib/api";

/** The extra lines of a send confirm box: how many went out today, this send, and a warning (never a block) above the daily limit. */
export async function sendTodayText(thisSend: number): Promise<string> {
  try {
    const r = await call<{ sent_today: number; limit: number }>("outreach.send.today");
    const over = r.sent_today + thisSend > r.limit;
    return `\n\nSent today: ${r.sent_today}. This send: ${thisSend}.${over ? `\nThis is above your daily limit of ${r.limit}. Send anyway?` : ""}`;
  } catch {
    return "";
  }
}
