/**
 * Pause and resume on Gemini's daily limit (pure helpers + a local-only test switch).
 *
 * The free daily quota resets at midnight US Pacific time (1:30 pm India time in winter, 12:30 pm
 * India time in summer). Daylight saving is handled by asking Intl for the Pacific wall clock.
 */

const PACIFIC = "America/Los_Angeles";

/** The next midnight in US Pacific time strictly after `now` (found by scanning in 15-minute steps, then 1-minute steps). */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const wall = (t: number) => {
    const parts = fmt.formatToParts(new Date(t));
    return { h: Number(parts.find((p) => p.type === "hour")?.value), m: Number(parts.find((p) => p.type === "minute")?.value) };
  };
  const step = 15 * 60_000;
  let t = Math.floor(now.getTime() / step) * step + step;
  for (let i = 0; i < 24 * 4 + 8; i++, t += step) {
    const w = wall(t);
    if (w.h === 0 && w.m === 0) return new Date(t);
  }
  return new Date(now.getTime() + 24 * 3600_000);
}

/** "1:30 pm" in the viewer's own zone is shown by the page; this is the same instant in India time for messages. */
export function istText(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(d).toLowerCase();
}

// ── Local-only test switch ────────────────────────────────────────────
// FAKE_GEMINI_QUOTA_AFTER=3 makes the 4th drafting/review call fail like a daily-limit 429, once.
// FAKE_RESUME_SECONDS=60 shortens resume_at for the test. Both only work under `netlify dev`
// on this Mac: they need NETLIFY_DEV=true AND CONTEXT=dev (both set only by `netlify dev`)
// and are ignored on Netlify (CONTEXT is production, deploy-preview or branch-deploy there).
function localTestSwitchAllowed(): boolean {
  return process.env.NETLIFY_DEV === "true" && process.env.CONTEXT === "dev";
}

let fakeCalls = 0;
let fakeTripped = false;
let fakeBlockedUntil = 0;
let fakeConfig = "";

/** True when this call must fail as a fake daily-limit error (local test only). */
export function fakeQuotaHit(): boolean {
  if (!localTestSwitchAllowed()) return false;
  const after = Number(process.env.FAKE_GEMINI_QUOTA_AFTER);
  if (!Number.isFinite(after) || after < 0 || process.env.FAKE_GEMINI_QUOTA_AFTER === "") return false;
  const secs = Number(process.env.FAKE_RESUME_SECONDS);
  const cfg = `${process.env.FAKE_GEMINI_QUOTA_AFTER}/${process.env.FAKE_RESUME_SECONDS ?? ""}`;
  if (cfg !== fakeConfig) { fakeConfig = cfg; fakeCalls = 0; fakeTripped = false; fakeBlockedUntil = 0; } // a new test setting starts fresh
  const block = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 60_000;
  if (fakeTripped) return Date.now() < fakeBlockedUntil; // the fake limit "resets" after the shortened wait
  if (fakeCalls >= after) { fakeTripped = true; fakeBlockedUntil = Date.now() + block; return true; }
  fakeCalls++;
  return false;
}

export function resetFakeQuota(): void { fakeCalls = 0; fakeTripped = false; fakeBlockedUntil = 0; }

/** When a paused job should resume: next Pacific midnight (or the shortened local-test wait). */
export function resumeAtFor(now: Date = new Date()): Date {
  const secs = Number(process.env.FAKE_RESUME_SECONDS);
  if (localTestSwitchAllowed() && Number.isFinite(secs) && secs > 0) return new Date(now.getTime() + secs * 1000);
  return nextPacificMidnight(now);
}

/** Counts of Gemini calls made by one job (shown on the banner, written to the job). */
export type CallStats = { drafter_calls: number; reviewer_calls: number; helper_calls: number; drafts_per_reviewer_call: number[] };
export const newStats = (): CallStats => ({ drafter_calls: 0, reviewer_calls: 0, helper_calls: 0, drafts_per_reviewer_call: [] });
