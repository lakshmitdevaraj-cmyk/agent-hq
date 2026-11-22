/**
 * Debug lines for the Netlify function log (batch 8b). The first draft, each rewrite and the reviewer's reasons are written
 * here so they can be read while debugging, instead of being stored as draft history (which only grows the data).
 * Email addresses and anything that looks like an API key are masked before a line is written.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEYLIKE = /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|ahq_[A-Za-z0-9]{8,}|apify_api_[A-Za-z0-9]{8,}|am_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;

export function maskSecrets(text: string): string {
  return text.replace(KEYLIKE, "[key]").replace(EMAIL, "[email]");
}

export function debugLine(kind: "draft" | "rewrite" | "review" | "social" | "social-review" | "four-step" | "four-step-review", data: Record<string, unknown>): string {
  const clean = JSON.parse(maskSecrets(JSON.stringify(data))) as Record<string, unknown>;
  return `[debug:${kind}] ${JSON.stringify(clean)}`;
}

export function debugLog(kind: Parameters<typeof debugLine>[0], data: Record<string, unknown>): void {
  try { console.log(debugLine(kind, data)); } catch { /* logging must never break a run */ }
}
