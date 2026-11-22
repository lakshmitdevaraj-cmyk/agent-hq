import { useState } from "react";
import { call } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export type FollowCounts = { email: number; social: number; total: number; week: number };

/** How many follow-ups are due today or overdue (read-only; refreshed every 2 minutes while the tab is visible). */
export function useFollowCount(): FollowCounts | null {
  const [c, setC] = useState<FollowCounts | null>(null);
  usePolling(async () => { try { const d = await call<{ counts: FollowCounts }>("followups.list"); setC(d.counts); } catch { /* the badge simply stays as it was */ } }, 120000, []);
  return c;
}
