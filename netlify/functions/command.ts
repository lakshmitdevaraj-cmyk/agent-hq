import type { Handler } from "@netlify/functions";
import { connectLambda } from "@netlify/blobs";
import { nanoid } from "nanoid";
import { store, readJson, writeJson, listJson, listJsonFast } from "./lib/blobs";
import { getOrCreateApiKey, identifyApiKey, createAgentKey, hasApiKey, rotateApiKey } from "./lib/auth";
import {
  appendFooter,
  textToHtml,
  normalizeDraft,
  greetingFor,
  FIXED_OFFER,
  emptyIndex,
  addToIndex,
  matchesIndex,
  emailKey,
  leadSkipReason,
  isGovEduEmail,
  cleanEmail,
  isJunkEmail,
  extractEmailsFromHtml,
  isAutoReply,
} from "./lib/outreach";
import {
  SITE_CHECK_PATHS, detectSignals, extractSocial, findOwner, gapScore, hoursInfo, pageText, validPersonName, siteHoursWording, fitFlags, needsBrowserCheck, looksLikeLeadGenListing,
  type Page, type Owner,
} from "./lib/sitecheck";
import { pickAngle, pickOpeningStyle, cityOf, checkModelDraft, callsOnly, type AngleCode, type ModelDraft, type Fact } from "./lib/angle";
import { DRAFT_SYSTEM_PROMPT, OPENING_STYLE_HELP, REVIEW_SYSTEM_PROMPT } from "./lib/prompts";
import { evidenceFor, codeReview, parseVerdict, type ReviewLead, type ReviewStatus } from "./lib/review";
import { BROWSER_ACTOR, BROWSER_DEFAULT_CAP, browserInput, estimateBrowserCost, pagesByLead, logTail } from "./lib/browsercheck";
import { loadContacts, contactBlock, noteSent, noteBounced, type Contacts } from "./lib/contacts";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

type Req = { action: string; params?: Record<string, unknown> };

const json = (status: number, body: unknown) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

const ok = (data: unknown) => json(200, { ok: true, data });
const fail = (status: number, error: string) => json(status, { ok: false, error });
// Failure with a machine-readable code (and optional extras like retry_after)
// so the UI can react: wait and retry, stop, etc.
const failCode = (status: number, error: string, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { ok: false, error, code, ...extra });

const AGENTS = "agent-hq-agents";
const TASKS = "agent-hq-tasks";
const ACTIVITY = "agent-hq-activity";
const FORMS = "agent-hq-forms";
const SUBMISSIONS = "agent-hq-submissions";
const WEBHOOKS = "agent-hq-webhooks";
const WEBHOOK_EVENTS = "agent-hq-webhook-events";
const VOICE_CONFIG = "agent-hq-voice-config";
const VOICE_SESSIONS = "agent-hq-voice-sessions";
const VOICE_INVITATIONS = "agent-hq-voice-invitations";
const PAGES = "agent-hq-pages";
const SERVICE_CONFIG = "agent-hq-service-config"; // third-party API keys: apify, agentmail, gemini (shared)
// Stores copied by data.export / data.import. Deliberately excludes SERVICE_CONFIG (third-party keys),
// agent-hq-config (master key), agent-hq-agent-keys, and WEBHOOK_EVENTS (high-volume log).
const MOVABLE_STORES = [
  "agent-hq-outreach-campaigns", "agent-hq-outreach-leads", "agent-hq-outreach-emails",
  "agent-hq-outreach-replies", "agent-hq-outreach-clicks", "agent-hq-outreach-settings",
  "agent-hq-webhooks", "agent-hq-agents", "agent-hq-tasks", "agent-hq-forms", "agent-hq-submissions",
  "agent-hq-pages", "agent-hq-voice-config", "agent-hq-voice-sessions", "agent-hq-voice-invitations",
  "agent-hq-activity",
];
const OUTREACH_CAMPAIGNS = "agent-hq-outreach-campaigns";
const OUTREACH_LEADS = "agent-hq-outreach-leads"; // key: `<campaign_id>/<lead_id>`
const OUTREACH_EMAILS = "agent-hq-outreach-emails"; // key: `<campaign_id>/<email_id>`
const OUTREACH_REPLIES = "agent-hq-outreach-replies"; // inbound replies from AgentMail
const OUTREACH_SETTINGS = "agent-hq-outreach-settings"; // key: "settings" → { postal_address }

// Service keys we onboard. `gemini` doubles as the voice key — reads through VOICE_CONFIG for back-compat.
type ServiceKey = "gemini" | "apify" | "agentmail" | "ai2"; // ai2 = the optional second (OpenAI-compatible) AI provider
const SERVICE_KEYS: ServiceKey[] = ["gemini", "apify", "agentmail", "ai2"];

type ServiceConfigRecord = { key: string; updated_at: string; last_test?: { ok: boolean; at: string; message?: string } };

// Redact a stored key for display — keep first 4 and last 4 chars so the
// user can visually confirm it's theirs without exposing the full secret.
function maskKey(raw: string): string {
  if (!raw) return "";
  if (raw.length <= 10) return "•".repeat(raw.length);
  return `${raw.slice(0, 4)}${"•".repeat(Math.max(4, raw.length - 8))}${raw.slice(-4)}`;
}

async function readServiceKey(name: ServiceKey): Promise<string | null> {
  if (name === "gemini") {
    // Back-compat: voice wrote the Gemini key to VOICE_CONFIG first.
    const voice = await readJson<{ gemini_key?: string }>(store(VOICE_CONFIG), "config");
    if (voice?.gemini_key) return voice.gemini_key;
  }
  const rec = await readJson<ServiceConfigRecord>(store(SERVICE_CONFIG), name);
  return rec?.key ?? null;
}

async function writeServiceKey(name: ServiceKey, key: string, test?: ServiceConfigRecord["last_test"]): Promise<void> {
  const rec: ServiceConfigRecord = { key, updated_at: new Date().toISOString(), last_test: test };
  await writeJson<ServiceConfigRecord>(store(SERVICE_CONFIG), name, rec);
  // Keep voice store in sync when the gemini key is set, so voice.config.get still works.
  if (name === "gemini") {
    await writeJson(store(VOICE_CONFIG), "config", { gemini_key: key, updated_at: rec.updated_at });
  }
}

// ── Gemini access: model setting, retries, error classes ───────────────

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

type OutreachSettings = {
  postal_address?: string;
  gemini_model?: string; // legacy: the one model setting before batch 6 (now the Drafting/Helper fallback)
  draft_model?: string; // writes the emails (default gemini-3.5-flash-lite)
  review_model?: string; // checks every draft (default gemini-2.5-flash)
  helper_model?: string; // owner fallback + campaign planning (default gemini-3.5-flash-lite)
  draft_provider?: "gemini" | "second";
  review_provider?: "gemini" | "second";
  helper_provider?: "gemini" | "second";
  second_ai_base_url?: string; // OpenAI-compatible chat-completions base URL (key stored as service "ai2")
  second_ai_model?: string;
  default_sender_name?: string;
  default_sender_company?: string;
  default_sender_offer?: string;
  sending_inbox_id?: string; // AgentMail inbox all NEW sends use (blank = the first inbox, as before)
  browser_check_cap?: number; // most leads per campaign the Apify browser check may open (default 25)
  reply_alert_email?: string; // where a short "new reply" note is sent (blank = off)
  updated_at?: string;
};

async function readOutreachSettings(): Promise<OutreachSettings> {
  return (await readJson<OutreachSettings>(store(OUTREACH_SETTINGS), "settings")) ?? {};
}

async function getGeminiModel(): Promise<string> {
  // The default Gemini model for calls that do not name one (the Helper model).
  const s = await readOutreachSettings();
  return s.helper_model?.trim() || s.gemini_model?.trim() || DEFAULT_GEMINI_MODEL;
}

// Google's free-tier daily quota resets at midnight Pacific. Work out when
// that is in India time so the message can say it plainly.
function dailyResetText(): string {
  const fmtLA = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const half = 30 * 60_000;
  let t = Math.ceil(Date.now() / half) * half;
  for (let i = 0; i < 50; i++, t += half) {
    const parts = fmtLA.formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (h === 0 && m === 0) {
      const ist = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t));
      return `at about ${ist.toLowerCase()} India time`;
    }
  }
  return "at midnight Pacific time";
}

type GeminiErrorKind = "daily_quota" | "rate_limited" | "unavailable" | "model_unavailable" | "auth" | "timeout" | "other";

class GeminiError extends Error {
  constructor(
    message: string,
    public kind: GeminiErrorKind,
    public status: number,
    public retryAfterS?: number,
  ) {
    super(message);
  }
}

function classifyGeminiError(status: number, text: string, model: string): GeminiError {
  const snippet = text.replace(/\s+/g, " ").slice(0, 200);
  if (status === 429) {
    if (/PerDay|per day|daily/i.test(text)) {
      return new GeminiError(`Gemini's daily free limit is used up for today. It resets ${dailyResetText()}. Drafts already made are saved; run Generate again after the reset.`, "daily_quota", status);
    }
    const m = text.match(/"retryDelay"\s*:\s*"([\d.]+)s"/) ?? text.match(/retry in ([\d.]+)s/i);
    const retry = m ? Math.ceil(Number(m[1])) : 15;
    return new GeminiError(`Gemini per-minute limit reached (retry in ~${retry}s).`, "rate_limited", status, retry);
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return new GeminiError(`Gemini is busy right now (${status}).`, "unavailable", status, 5);
  }
  if (status === 404 || /no longer available|not found for API version/i.test(text)) {
    return new GeminiError(`Gemini model "${model}" is not available to this key (${status}). Pick another model in Settings. ${snippet}`, "model_unavailable", status);
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(text)) {
    return new GeminiError(`Gemini rejected the key (${status}): ${snippet}`, "auth", status);
  }
  return new GeminiError(`Gemini failed (${status}): ${snippet}`, "other", status);
}

/**
 * One Gemini generateContent call with retries. Retries 503/5xx and per-minute
 * 429 with backoff, but only inside `budgetMs` (Netlify functions have a hard
 * time cap): when the wait would blow the budget it throws, carrying
 * retryAfterS so the caller (the UI loop) can wait and try again. A daily-quota
 * 429 is never retried.
 */
type GeminiAiOpts = { budgetMs?: number; timeoutMs?: number; retryOnTimeout?: boolean };

async function geminiGenerate(
  body: unknown,
  opts: { key: string; model?: string } & GeminiAiOpts,
): Promise<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }> {
  const model = opts.model || (await getGeminiModel());
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  let attempt = 0;
  let timeouts = 0;
  for (;;) {
    let err: GeminiError;
    // One request may take at most `timeoutMs` (default: whatever is left of the budget).
    const reqMs = Math.max(3000, Math.min(opts.timeoutMs ?? Infinity, deadline - Date.now()));
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.key)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(reqMs) },
      );
      if (r.ok) return (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      err = classifyGeminiError(r.status, await r.text(), model);
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        err = new GeminiError(`Gemini did not answer within ${Math.round(reqMs / 1000)} seconds.`, "timeout", 0, 0);
        timeouts++;
        // A slow answer is retried once (when allowed), then reported as a plain timeout.
        if (!opts.retryOnTimeout || timeouts > 1 || Date.now() + 3000 > deadline) throw err;
        continue;
      }
      err = new GeminiError(`Could not reach Gemini: ${e instanceof Error ? e.message : "network error"}`, "unavailable", 0, 5);
    }
    const retryable = err.kind === "unavailable" || err.kind === "rate_limited";
    if (!retryable) throw err;
    attempt++;
    const wait = Math.max((err.retryAfterS ?? 0) * 1000, Math.min(8000, 1500 * 2 ** (attempt - 1))) + Math.floor(Math.random() * 400);
    if (attempt >= 4 || Date.now() + wait > deadline) throw err;
    await new Promise((res) => setTimeout(res, wait));
  }
}

/** Settings for the long-running background jobs (drafting, preview): up to 60 s per Gemini answer, one retry on a slow one. */
const BACKGROUND_AI: GeminiAiOpts = { budgetMs: 170_000, timeoutMs: 60_000, retryOnTimeout: true };


// ── AI roles: Drafting / Reviewer / Helper ────────────────────────────
// Each role has a model (and may use the optional second OpenAI-compatible provider).
// On 429 / 503 from the chosen provider we try the other one once. A reviewer that
// cannot answer never makes a draft "ready" (see reviewDraft).

type AiRole = "draft" | "review" | "helper";
const DEFAULT_REVIEW_MODEL = "gemini-2.5-flash";
const DEFAULT_SECOND_AI = { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" };

async function roleConfig(role: AiRole): Promise<{ provider: "gemini" | "second"; model: string }> {
  const s = await readOutreachSettings();
  const legacy = s.gemini_model?.trim();
  const model = role === "review" ? s.review_model?.trim() || DEFAULT_REVIEW_MODEL : (role === "draft" ? s.draft_model?.trim() : s.helper_model?.trim()) || legacy || DEFAULT_GEMINI_MODEL;
  return { provider: s[`${role}_provider` as const] === "second" ? "second" : "gemini", model };
}

async function secondAiConfig(): Promise<{ key: string; base_url: string; model: string } | null> {
  const key = await readServiceKey("ai2");
  if (!key) return null;
  const s = await readOutreachSettings();
  return { key, base_url: (s.second_ai_base_url?.trim() || DEFAULT_SECOND_AI.base_url).replace(/\/+$/, ""), model: s.second_ai_model?.trim() || DEFAULT_SECOND_AI.model };
}

/** Is any AI provider set up? (Gemini key, or the second provider.) */
async function aiAvailable(): Promise<boolean> {
  return !!(await readServiceKey("gemini")) || !!(await secondAiConfig());
}

function secondAiError(status: number, text: string, model: string): GeminiError {
  const snippet = text.replace(/\s+/g, " ").slice(0, 200);
  if (status === 429) return new GeminiError(`The second AI provider hit its limit (429).`, /quota|billing|insufficient/i.test(text) ? "daily_quota" : "rate_limited", status, 15);
  if (status >= 500) return new GeminiError(`The second AI provider is busy (${status}).`, "unavailable", status, 5);
  if (status === 401 || status === 403) return new GeminiError(`The second AI provider rejected the key (${status}): ${snippet}`, "auth", status);
  if (status === 404) return new GeminiError(`The second AI provider does not know the model "${model}" or the address is wrong (404). ${snippet}`, "model_unavailable", status);
  return new GeminiError(`The second AI provider failed (${status}): ${snippet}`, "other", status);
}

/** One OpenAI-style chat completion that must answer with JSON. */
async function secondAiGenerate(cfg: { key: string; base_url: string; model: string }, req: { system: string; user: string; temperature: number; maxTokens?: number }, opts: GeminiAiOpts): Promise<string> {
  const ms = Math.max(5000, Math.min(opts.timeoutMs ?? 40_000, opts.budgetMs ?? 40_000));
  const call = async (json: boolean) =>
    fetch(`${cfg.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        temperature: req.temperature,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(ms),
    });
  try {
    let r = await call(true);
    if (r.status === 400) {
      const t = await r.text();
      // Some providers do not know response_format: ask again without it (the prompt already says "JSON only").
      if (!/response_format|json_object|json mode/i.test(t)) throw secondAiError(400, t, cfg.model);
      r = await call(false);
    }
    if (!r.ok) throw secondAiError(r.status, await r.text(), cfg.model);
    const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new GeminiError("The second AI provider returned an empty answer.", "other", 200);
    return text;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    const name = (e as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new GeminiError("The second AI provider did not answer in time.", "timeout", 0, 0);
    throw new GeminiError(`Could not reach the second AI provider: ${e instanceof Error ? e.message : "network error"}`, "unavailable", 0, 5);
  }
}

function parseLooseJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* strip fences / surrounding text */ }
  const stripped = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { /* last try: first { ... last } */ }
  const a = stripped.indexOf("{");
  const b = stripped.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(stripped.slice(a, b + 1));
  throw new Error("The AI answer was not valid JSON.");
}

type AiJsonResult = { json: unknown; provider: "gemini" | "second"; model: string; fell_back: boolean };

async function aiJson(role: AiRole, req: { system: string; user: string; temperature?: number }, opts: GeminiAiOpts = {}): Promise<AiJsonResult> {
  const cfg = await roleConfig(role);
  const second = await secondAiConfig();
  const geminiKey = await readServiceKey("gemini");
  const temperature = req.temperature ?? 0.2;
  const attempt = async (provider: "gemini" | "second"): Promise<AiJsonResult> => {
    if (provider === "second") {
      if (!second) throw new GeminiError("The second AI provider is not set up.", "auth", 400);
      const text = await secondAiGenerate(second, { system: req.system, user: req.user, temperature }, opts);
      return { json: parseLooseJson(text), provider, model: second.model, fell_back: false };
    }
    if (!geminiKey) throw new GeminiError("Gemini key not configured — open Settings and add it first.", "auth", 400);
    const data = await geminiGenerate(
      {
        systemInstruction: { role: "system", parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { temperature, responseMimeType: "application/json" },
      },
      { key: geminiKey, model: cfg.model, ...opts },
    );
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) throw new GeminiError("Gemini returned an empty answer.", "other", 200);
    return { json: parseLooseJson(text), provider, model: cfg.model, fell_back: false };
  };
  const primary: "gemini" | "second" = cfg.provider === "second" && second ? "second" : "gemini";
  try {
    return await attempt(primary);
  } catch (e) {
    // Only a limit (429) or an overloaded provider (503/5xx) switches provider, once.
    const limited = e instanceof GeminiError && (e.kind === "rate_limited" || e.kind === "daily_quota" || e.kind === "unavailable");
    const other: "gemini" | "second" | null = primary === "gemini" ? (second ? "second" : null) : geminiKey ? "gemini" : null;
    if (!limited || !other) throw e;
    try {
      return { ...(await attempt(other)), fell_back: true };
    } catch {
      throw e; // report the original problem
    }
  }
}


/** What the Settings page shows. Old records without the new fields get the defaults. */
async function settingsView(rec: OutreachSettings): Promise<Record<string, unknown>> {
  const draft = rec.draft_model?.trim() || rec.gemini_model?.trim() || DEFAULT_GEMINI_MODEL;
  return {
    postal_address: rec.postal_address ?? "",
    gemini_model: draft,
    default_gemini_model: DEFAULT_GEMINI_MODEL,
    draft_model: draft,
    review_model: rec.review_model?.trim() || DEFAULT_REVIEW_MODEL,
    helper_model: rec.helper_model?.trim() || rec.gemini_model?.trim() || DEFAULT_GEMINI_MODEL,
    default_draft_model: DEFAULT_GEMINI_MODEL,
    default_review_model: DEFAULT_REVIEW_MODEL,
    default_helper_model: DEFAULT_GEMINI_MODEL,
    draft_provider: rec.draft_provider === "second" ? "second" : "gemini",
    review_provider: rec.review_provider === "second" ? "second" : "gemini",
    helper_provider: rec.helper_provider === "second" ? "second" : "gemini",
    second_ai_base_url: rec.second_ai_base_url?.trim() || DEFAULT_SECOND_AI.base_url,
    second_ai_model: rec.second_ai_model?.trim() || DEFAULT_SECOND_AI.model,
    second_ai_configured: !!(await readServiceKey("ai2")),
    // Name and company are pre-seeded until the user saves their own (even an empty one).
    default_sender_name: rec.default_sender_name ?? "Lakshmi Devaraj",
    default_sender_company: rec.default_sender_company ?? "ShiftForge AI",
    default_sender_offer: rec.default_sender_offer ?? "",
    sending_inbox_id: rec.sending_inbox_id ?? "",
    reply_alert_email: rec.reply_alert_email ?? "",
    browser_check_cap: rec.browser_check_cap ?? BROWSER_DEFAULT_CAP,
  };
}

// Turn a GeminiError into the structured API failure the UI understands.
function geminiFail(err: GeminiError) {
  const status = err.kind === "daily_quota" || err.kind === "rate_limited" ? 429 : err.kind === "unavailable" ? 503 : err.kind === "timeout" ? 504 : 502;
  return failCode(status, err.message, err.kind, err.retryAfterS ? { retry_after: err.retryAfterS } : {});
}

// Light-touch "does this key actually work" tests. We do NOT hit the full
// service surface here — just a cheap endpoint that returns 200 on a valid
// key and 401/403 on an invalid one. Keeps onboarding fast.
async function testServiceKey(name: ServiceKey, key: string, model?: string, extra: { base_url?: string } = {}): Promise<{ ok: boolean; message: string }> {
  try {
    if (name === "ai2") {
      const st = await readOutreachSettings();
      const cfg = { key, base_url: (extra.base_url?.trim() || st.second_ai_base_url?.trim() || DEFAULT_SECOND_AI.base_url).replace(/\/+$/, ""), model: model || st.second_ai_model?.trim() || DEFAULT_SECOND_AI.model };
      try {
        await secondAiGenerate(cfg, { system: 'Reply with JSON only: {"ok": true}', user: "ping", temperature: 0, maxTokens: 20 }, { timeoutMs: 22_000, budgetMs: 22_000 });
        return { ok: true, message: `Second AI provider verified (${cfg.model} at ${cfg.base_url})` };
      } catch (err) {
        if (err instanceof GeminiError && (err.kind === "rate_limited" || err.kind === "daily_quota")) return { ok: true, message: `Second AI provider accepted the key (${cfg.model}), but it is at its limit right now.` };
        return { ok: false, message: err instanceof Error ? err.message : "Test failed" };
      }
    }
    if (name === "gemini") {
      // A models-list call passes for keys whose chosen model is unusable, so
      // do one tiny REAL generate call with the chosen model. A bad key or an
      // unavailable model fails here, at save time, not later mid-campaign.
      const usedModel = model || (await getGeminiModel());
      try {
        await geminiGenerate(
          { contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }], generationConfig: { maxOutputTokens: 16, temperature: 0 } },
          { key, model: usedModel, budgetMs: 22_000, timeoutMs: 22_000 },
        );
        return { ok: true, message: `Gemini key verified (model ${usedModel})` };
      } catch (err) {
        if (err instanceof GeminiError) {
          // Quota messages mean the key and model are fine — just out of requests right now.
          if (err.kind === "daily_quota" || err.kind === "rate_limited") {
            return { ok: true, message: `Gemini key accepted (model ${usedModel}), but ${err.message}` };
          }
          return { ok: false, message: err.message };
        }
        throw err;
      }
    }
    if (name === "apify") {
      // Apify "user/me" requires a valid token.
      const r = await fetch("https://api.apify.com/v2/users/me", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (r.ok) return { ok: true, message: "Apify key verified" };
      const body = await r.text();
      return { ok: false, message: `Apify rejected key (${r.status}): ${body.slice(0, 120)}` };
    }
    if (name === "agentmail") {
      // AgentMail "inboxes" list is a cheap authenticated GET.
      const r = await fetch("https://api.agentmail.to/v0/inboxes?limit=1", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (r.ok) return { ok: true, message: "AgentMail key verified" };
      const body = await r.text();
      return { ok: false, message: `AgentMail rejected key (${r.status}): ${body.slice(0, 120)}` };
    }
    return { ok: false, message: `Unknown service: ${name}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Network error" };
  }
}

// Write activity log row — fire and forget.
async function logActivity(entry: {
  agent_id?: string | null;
  category: string;
  summary: string;
  details?: Record<string, unknown> | null;
}) {
  const id = nanoid(12);
  const created_at = new Date().toISOString();
  const key = `${created_at}-${id}`;
  await writeJson(store(ACTIVITY), key, { id, created_at, ...entry });
}

// ── AgentMail helpers ──────────────────────────────────────────────
// Thin fetch wrappers. We don't use the official SDK to keep the function
// bundle small and avoid @agentmail/sdk's surface area surprises.

async function agentmailFetch(key: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.agentmail.to/v0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

type AgentMailInbox = { inbox_id: string; email?: string; display_name?: string };

async function getOrCreateCampaignInbox(key: string, campaignName: string, preferredId?: string): Promise<AgentMailInbox> {
  // A sending inbox chosen in Settings wins. If it has been deleted we stop with a clear
  // message instead of quietly sending from a different address.
  if (preferredId) {
    const r = await agentmailFetch(key, `/inboxes/${encodeURIComponent(preferredId)}`);
    if (r.ok) return (await r.json()) as AgentMailInbox;
    throw new Error(`The sending inbox chosen in Settings (${preferredId}) could not be found in AgentMail (${r.status}). Pick another one in Settings.`);
  }
  // Otherwise reuse the first inbox on the account (most accounts only have one); create one if none exists.
  const listR = await agentmailFetch(key, "/inboxes?limit=10");
  if (listR.ok) {
    const body = (await listR.json()) as { inboxes?: AgentMailInbox[] };
    if (body.inboxes && body.inboxes.length > 0) return body.inboxes[0];
  }
  // Create a new inbox. AgentMail picks a username if we don't.
  const createR = await agentmailFetch(key, "/inboxes", {
    method: "POST",
    body: JSON.stringify({ display_name: campaignName.slice(0, 80) }),
  });
  if (!createR.ok) {
    const txt = await createR.text();
    throw new Error(`AgentMail inbox create failed (${createR.status}): ${txt.slice(0, 200)}`);
  }
  return (await createR.json()) as AgentMailInbox;
}

/**
 * AgentMail strips custom per-message `From` headers for anti-spoofing,
 * so the only reliable way to control what recipients see as the sender
 * name is the inbox-level `display_name`. Call this right before sending
 * so the name reflects whatever the campaign's current default is.
 */
async function ensureInboxDisplayName(key: string, inboxId: string, desired: string, current?: string): Promise<string> {
  const target = desired.replace(/["\r\n]/g, "").trim();
  if (!target) return current ?? "";
  if (current && current === target) return current;
  const r = await agentmailFetch(key, `/inboxes/${encodeURIComponent(inboxId)}`, {
    method: "PATCH",
    body: JSON.stringify({ display_name: target }),
  });
  if (!r.ok) {
    // Non-fatal — we'd rather send with the old name than fail the whole send.
    console.warn(`[agentmail] display_name patch failed (${r.status})`);
    return current ?? "";
  }
  return target;
}

// Rewrite every <a href="..."> in the HTML body to route through the
// ShiftForge HQ click tracker. The tracker function lives at /t/<token> and
// 302s to the original URL after logging the click.
function rewriteLinksForTracking(html: string, baseUrl: string, campaignId: string, leadId: string, emailId: string): string {
  return html.replace(/href="([^"]+)"/gi, (full, rawUrl) => {
    if (!rawUrl || typeof rawUrl !== "string") return full;
    // Skip anchor-only, mailto:, tel:, and already-tracked links.
    if (/^(#|mailto:|tel:|sms:)/i.test(rawUrl)) return full;
    if (rawUrl.startsWith(`${baseUrl}/t/`)) return full;
    const payload = { c: campaignId, l: leadId, e: emailId, u: rawUrl };
    const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `href="${baseUrl}/t/${token}"`;
  });
}

// ── Gemini email drafting ─────────────────────────────────────────────

const DRAFT_BASE_PROMPT = `You write short, high-reply-rate cold outreach emails. Rules:
- 70–120 words. Short subject (5–8 words, no emoji).
- One clear observation about the recipient's business from the data provided.
- One specific value hook tied to the sender's context.
- One low-friction ask: the offer is ALWAYS a free 30-minute call. Say "30-minute free call". Never offer a 10/15/20-minute call, a demo, or any other length.
- No fluff, no "I hope this finds you well", no superlatives, no fake flattery.
- Conversational and personal, not corporate — but use STANDARD sentence capitalization. Proper nouns (person names, company names, cities, products, brands) are ALWAYS capitalized. Never lowercase "I", never lowercase a person's name or company name. Sentences start with a capital letter.
- Greeting: start the email with exactly the GREETING line from the user message followed by a comma ("Hi <First Name>," when a person's first name is known, otherwise "Hi there,"). NEVER address the business name in the greeting: no "Hi <Business> team,", no "Hi <Business>,". Never invent a first name.
- Speak TO the recipient: use "you" and "your business/team". Use the business name at most once (in the greeting). Never end with a third-person line like "benefit <Business Name>?" — write "benefit your business?" or "help you" instead.
- Do NOT fabricate statistics, client counts, case studies, or specific numbers that weren't given in the sender context. No "We've helped 50+ clients" unless that exact number was provided.
- Do NOT write any sign-off. No "Best,", no "Thanks", no name, no company line, no website, no opt-out text. End the body right after the closing question/ask. The sign-off (name, company, website) and opt-out line are appended automatically after sending. (You may still mention the company in the body.)
- Do not introduce yourself by name in the body (no "I'm <Name>", "My name is <Name>"). The name appears only in the sign-off, which is added automatically.
- Output ONLY JSON: { "subject": "...", "body_text": "...", "body_html": "<p>...</p>" }.
- body_html = plain paragraphs with <p> tags only. No inline styles.`;

// Only sent for sequences (a framework other than one-off).
const DRAFT_SEQUENCE_PROMPT = `SEQUENCE MODE:
If the user message names a FRAMEWORK and STEP, write the email for that specific step. Supported frameworks:

PAS (Problem → Agitate → Solution):
  - Step 1 (Problem): name one concrete pain the recipient's business type likely runs into. Ask a light curious question about how they handle it today. Do NOT pitch the solution yet.
  - Step 2 (Agitate): follow up on step 1. Spell out a specific downstream cost of leaving the pain unaddressed (hours lost, revenue leaked, risk). Still no pitch — just sharpen the picture.
  - Step 3 (Solution): now propose the sender's offer as the resolution. Tie back explicitly to the pain named in step 1. End with a direct low-friction ask.

AIDA (Attention → Interest → Desire+Action):
  - Step 1 (Attention): open with an unexpected observation, stat, or framing about their category. Short hook. Set up curiosity.
  - Step 2 (Interest): build on step 1. Add one relevant proof point or insight. Paint the better state the sender's offer makes possible.
  - Step 3 (Desire + Action): reinforce the CTA. Make it very low-friction — a 30-minute free call on a specific day, or a single yes/no reply.

SDR (Direct → Value-add → Breakup):
  - Step 1 (Direct): 2–3 lines. What you do, why them specifically, would they be open to a quick call.
  - Step 2 (Value-add): a free resource, case study, or short insight that would genuinely help them — independent of whether they work with you. "Not asking for anything, thought this might help."
  - Step 3 (Breakup): acknowledge you've reached out twice. Graceful off-ramp. Leave a direct line and warm wishes. No hard sell.

Cross-framework continuity rule:
- Steps 2 and 3 MUST acknowledge the prior step implicitly so the thread reads as a coherent follow-up, not a fresh cold email. Openers like "Following up on my note last week about <pain>...", "Wanted to send you this — ...", "Last time I'll reach out — ..." Use the previous-step context supplied in the user message to do this well.
- Never copy phrases verbatim from the previous step. Reference, don't repeat.
- Keep subject lines related but distinct per step. For steps 2 and 3, a reply-style subject ("Re: <step 1 subject>") is often best.`;

// Added for one-off emails and for step 1 of any sequence.
const DRAFT_FIRST_EMAIL_RULE = `This is the FIRST email. Never use "Re:" in the subject, never write "following up", "as I mentioned" or any reference to an earlier message.`;

/** The system prompt: the sequence section only for sequences; the first-email rule for one-offs and step 1. */
const DRAFT_FACTS_RULE = `FACTS RULE: the recipient section may include "Website gaps", rating, review count and opening hours that we observed. Mention AT MOST ONE specific gap, and only if it is listed there and relevant; phrase it as something you noticed ("I could not find an online booking option on your site"), never as an accusation. Never invent facts, numbers or tools. If nothing useful is listed, do not mention any gap. Do not list several gaps.`;
const DRAFT_ANY_TRADE_RULE = `TRADE-NEUTRAL: the recipient may be any home-service business. Do not assume or name a specific trade (HVAC, plumbing, roofing...) unless the Category line says so; say "your business" or "your customers".`;

export function buildDraftPrompt(isSequence: boolean, step = 1, extras: { facts?: boolean; anyTrade?: boolean } = {}): string {
  const first = !isSequence || step <= 1;
  return [DRAFT_BASE_PROMPT, isSequence ? DRAFT_SEQUENCE_PROMPT : "", first ? DRAFT_FIRST_EMAIL_RULE : "", extras.facts ? DRAFT_FACTS_RULE : "", extras.anyTrade ? DRAFT_ANY_TRADE_RULE : ""].filter(Boolean).join("\n\n");
}

type EmailDraft = { subject: string; body_text: string; body_html: string };

type SequenceContext = {
  framework?: "one-off" | "pas" | "aida" | "sdr" | null;
  step?: number;
  total_steps?: number;
  previous_steps?: Array<{ step: number; subject: string; body_text: string }>;
};

async function generateEmailDraft(
  _geminiKey: string | null,
  lead: { name?: string; contact_name?: string; owner_name?: string | null; owner_confidence?: string | null; company?: string; website?: string; category?: string; address?: string; notes?: string; is_test?: boolean; rating?: number | null; reviews_count?: number | null; gap_reasons?: string[]; hours_summary?: string | null },
  senderContext: { sender_name?: string; sender_company?: string; sender_offer?: string; campaign_query?: string; any_trade?: boolean },
  sequence: SequenceContext = {},
  ai: GeminiAiOpts = {},
): Promise<EmailDraft & { written_by: string }> {
  const greeting = greetingFor(lead);
  const leadSummary = [
    `GREETING: ${greeting ?? "Hi there"}`,
    lead.name ? `Business: ${lead.name}` : null,
    lead.company && lead.company !== lead.name ? `Company: ${lead.company}` : null,
    lead.category ? `Category: ${lead.category}` : null,
    lead.address ? `Location: ${lead.address}` : null,
    lead.website ? `Website: ${lead.website}` : null,
    typeof lead.rating === "number" ? `Google rating: ${lead.rating}${typeof lead.reviews_count === "number" ? ` (${lead.reviews_count} reviews)` : ""}` : null,
    lead.hours_summary ? `Opening hours: ${lead.hours_summary}` : null,
    lead.gap_reasons && lead.gap_reasons.length > 0 ? `Website gaps we observed (pick at most one): ${lead.gap_reasons.join("; ")}` : null,
    lead.notes ? `Notes: ${lead.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const hasFacts = !!(lead.gap_reasons?.length || lead.hours_summary || typeof lead.rating === "number");

  const senderSummary = [
    senderContext.sender_name ? `Sender name: ${senderContext.sender_name}` : null,
    senderContext.sender_company ? `Sender company: ${senderContext.sender_company}` : null,
    `Call offer (fixed, always use exactly this): ${FIXED_OFFER}`,
    senderContext.sender_offer ? `What the sender does / value: ${senderContext.sender_offer}` : null,
    senderContext.campaign_query ? `ICP context: ${senderContext.campaign_query}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Assemble the sequence block only when we're actually in sequence mode.
  // One-off drafts skip this entirely to keep the prompt lean.
  const isSequence = sequence.framework && sequence.framework !== "one-off";
  let sequenceBlock = "";
  if (isSequence) {
    const step = sequence.step ?? 1;
    const total = sequence.total_steps ?? 3;
    sequenceBlock = `\n\nFRAMEWORK: ${sequence.framework}\nSTEP: ${step} of ${total}`;
    if (sequence.previous_steps && sequence.previous_steps.length > 0) {
      const prevBlock = sequence.previous_steps
        .map((p) => `--- STEP ${p.step} ---\nSubject: ${p.subject}\n\n${p.body_text}`)
        .join("\n\n");
      sequenceBlock += `\n\nPREVIOUS STEPS (for continuity — reference implicitly, never copy):\n${prevBlock}`;
    }
  }

  const body = {
    systemInstruction: { role: "system", parts: [{ text: buildDraftPrompt(!!isSequence, sequence.step ?? 1, { facts: hasFacts, anyTrade: senderContext.any_trade === true }) }] },
    contents: [
      {
        role: "user",
        parts: [{ text: `RECIPIENT\n${leadSummary || "(no data)"}\n\nSENDER\n${senderSummary || "(no context)"}${sequenceBlock}` }],
      },
    ],
    generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
  };
  const ans = await aiJson("draft", { system: body.systemInstruction.parts[0].text, user: body.contents[0].parts[0].text, temperature: 0.7 }, ai);
  const parsed = ans.json;
  const obj = parsed as Partial<EmailDraft>;
  // Enforce the fixed offer + greeting even if the model ignored the prompt.
  return {
    ...normalizeDraft(
      {
        subject: String(obj.subject ?? "").trim() || "Quick question",
        body_text: String(obj.body_text ?? "").trim(),
        body_html: String(obj.body_html ?? "").trim(),
      },
      greeting,
      { firstEmail: !isSequence || (sequence.step ?? 1) <= 1 },
    ),
    written_by: ans.model,
  };
}

// ── New first-email path: code picks the fact and angle, a small model writes ──

type FirstEmailLead = {
  name?: string; contact_name?: string; address?: string; category?: string; is_test?: boolean; website?: string | null; owner_name?: string | null; owner_confidence?: string | null;
  rating?: number | null; reviews_count?: number | null; raw?: unknown; site_check?: Record<string, unknown> | null;
};
type FirstEmailMeta = { written_by: string; fact_used: number | null; draft_facts: Fact[]; angle: string; opening_style: string; gap_note: string | null; check_reasons: string[] };

async function generateFirstEmail(
  lead: FirstEmailLead,
  sender: { sender_offer?: string },
  ctx: { draftsSoFar: number; any_trade: boolean; query: string },
  ai: GeminiAiOpts,
): Promise<{ draft: EmailDraft; meta: FirstEmailMeta }> {
  const plan = pickAngle(lead as Parameters<typeof pickAngle>[0]);
  const style = pickOpeningStyle(ctx.draftsSoFar, plan.facts.length > 0);
  const greetingLine = greetingFor(lead) ?? "Hi there";
  const trade = ctx.any_trade ? "home services" : (lead.category || ctx.query || "home services").slice(0, 60);
  const offer = sender.sender_offer?.trim() || "We set up AI assistants that answer calls and website messages for home-service businesses, take the details and pass every enquiry to the owner.";
  const user = [
    `BUSINESS: ${lead.name ?? "the business"}`,
    `GREETING: ${greetingLine}`,
    `CITY: ${cityOf(lead.address) || "(unknown)"}`,
    `TRADE: ${trade}`,
    plan.facts.length ? `FACTS YOU MAY USE:\n${plan.facts.map((f) => `${f.n}. ${f.text}`).join("\n")}` : "FACTS YOU MAY USE:\n(none: write without any claim about their business)",
    `ANGLE: ${plan.angle.line}`,
    `OPENING STYLE: ${style} - ${OPENING_STYLE_HELP[style]}`,
    `OFFER (background only, rewrite in your own words, tied to the angle, never paste it): "${offer}"`,
  ].join("\n");
  let failures: string[] = [];
  let ans: AiJsonResult | null = null;
  let md: ModelDraft = { subject: "", body: "", fact_used: null, opening_style: style };
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? user : `${user}\n\nYOUR LAST ANSWER FAILED THESE CHECKS: ${failures.join("; ")}. Write it again and fix them. Output JSON only.`;
    ans = await aiJson("draft", { system: DRAFT_SYSTEM_PROMPT, user: prompt, temperature: 0.4 }, ai);
    const o = (ans.json && typeof ans.json === "object" ? ans.json : {}) as Record<string, unknown>;
    md = {
      subject: String(o.subject ?? "").replace(/\s+/g, " ").trim(),
      body: String(o.body ?? o.body_text ?? "").replace(/\r/g, "").trim(),
      fact_used: typeof o.fact_used === "number" ? o.fact_used : null,
      opening_style: String(o.opening_style ?? style),
    };
    failures = md.body ? checkModelDraft(md, plan.facts.length, { callsOnly: callsOnly(plan.angle.code) }) : ["the body is empty"];
    if (failures.length === 0) break;
  }
  const draft = normalizeDraft({ subject: md.subject || "Quick question", body_text: md.body, body_html: textToHtml(md.body) }, greetingFor(lead), { firstEmail: true });
  return {
    draft,
    meta: { written_by: ans?.model ?? "", fact_used: md.fact_used, draft_facts: plan.facts, angle: plan.angle.code, opening_style: md.opening_style, gap_note: plan.uncertain, check_reasons: failures },
  };
}

// ── AI reviewer ───────────────────────────────────────────────────────

type ReviewOutcome = {
  status: ReviewStatus;
  reasons: string[];
  reviewed_by: string | null;
  rewritten?: { subject: string; body_text: string; body_html: string; original: { subject: string; body_text: string; body_html: string } };
};

type ReviewableEmail = { subject: string; body_text: string; body_html: string; sequence_position?: number; fact_used?: number | null; draft_facts?: Fact[]; check_reasons?: string[]; angle?: string };

/**
 * Checks one draft against the lead's saved evidence. Code-only checks come first (a wrong
 * owner or an unchecked website claim is blocked without asking a model). A reviewer that
 * cannot answer gives "check", never "ready".
 */
async function reviewDraft(email: ReviewableEmail, lead: ReviewLead & Record<string, unknown>, ai: GeminiAiOpts): Promise<ReviewOutcome> {
  const greeting = greetingFor(lead as Parameters<typeof greetingFor>[0]);
  const hours = hoursInfo((lead as { raw?: unknown }).raw);
  const forModel: ReviewLead = { ...lead, hours_summary: hours?.summary ?? null };
  const cr = codeReview(forModel, greeting, typeof email.fact_used === "number");
  const writerNotes = email.check_reasons ?? [];
  if (cr.blocked.length > 0) return { status: "blocked", reasons: [...cr.blocked, ...cr.check], reviewed_by: "code checks" };
  const ask = async (subject: string, body: string) => {
    const r = await aiJson(
      "review",
      {
        system: REVIEW_SYSTEM_PROMPT,
        user: JSON.stringify({ DRAFT: { subject, body }, GREETING_EXPECTED: greeting ? `${greeting},` : "Hi there,", EMAIL_STEP: email.sequence_position ?? 1, FACTS_GIVEN_TO_WRITER: email.draft_facts ?? "unknown (older draft)", SAVED_EVIDENCE: evidenceFor(forModel) }),
        temperature: 0,
      },
      ai,
    );
    return { verdict: parseVerdict(r.json), model: r.model };
  };
  try {
    const first = await ask(email.subject, email.body_text);
    const v = first.verdict;
    const extra = [...cr.check, ...writerNotes.map((n) => `Writer check: ${n}`)];
    if (v.status === "blocked") return { status: "blocked", reasons: [...v.reasons, ...extra], reviewed_by: first.model };
    if (v.status === "ready" && extra.length === 0) return { status: "ready", reasons: v.reasons, reviewed_by: first.model };
    if (v.status === "ready") return { status: "check", reasons: [...v.reasons, ...extra], reviewed_by: first.model };
    // Wording-only problem with a rewrite: fix it, then review the new version once more.
    if (v.problem === "wording" && v.rewrite) {
      const body_text = normalizeDraft({ subject: v.rewrite.subject, body_text: v.rewrite.body, body_html: "" }, greeting, { firstEmail: (email.sequence_position ?? 1) <= 1 }).body_text;
      const subject = v.rewrite.subject;
      const codeFails = (email.sequence_position ?? 1) <= 1 ? checkModelDraft({ subject, body: body_text, fact_used: email.fact_used ?? null, opening_style: "" }, email.draft_facts?.length ?? (typeof email.fact_used === "number" ? 1 : 0), { callsOnly: callsOnly((email.angle ?? "") as AngleCode) }) : [];
      if (codeFails.length === 0) {
        const second = await ask(subject, body_text);
        if (second.verdict.status === "ready" && extra.length === 0) {
          return {
            status: "ready",
            reasons: [`Reworded by the reviewer: ${v.reasons.join(" ")}`.slice(0, 300)],
            reviewed_by: second.model,
            rewritten: { subject, body_text, body_html: textToHtml(body_text), original: { subject: email.subject, body_text: email.body_text, body_html: email.body_html } },
          };
        }
      }
    }
    return { status: "check", reasons: [...v.reasons, ...extra].slice(0, 6), reviewed_by: first.model };
  } catch (err) {
    const why = err instanceof Error ? err.message : "the reviewer did not answer";
    return { status: "check", reasons: [`Not reviewed yet: ${why}`.slice(0, 200), ...cr.check], reviewed_by: null };
  }
}

/** The review fields to store on an email record. */
function reviewFields(o: ReviewOutcome, prevHistory?: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { review_status: o.status, review_reasons: o.reasons, reviewed_by: o.reviewed_by, reviewed_at: o.reviewed_by ? new Date().toISOString() : null };
  if (o.rewritten) {
    fields.subject = o.rewritten.subject;
    fields.body_text = o.rewritten.body_text;
    fields.body_html = o.rewritten.body_html;
    fields.review_history = [...(Array.isArray(prevHistory) ? prevHistory : []), { at: new Date().toISOString(), kind: "original_before_rewrite", ...o.rewritten.original }];
  }
  return fields;
}

// ── Apify helpers ─────────────────────────────────────────────────────

type ApifyLead = {
  title?: string;
  subTitle?: string;
  category?: string;
  categoryName?: string;
  address?: string;
  neighborhood?: string;
  street?: string;
  city?: string;
  state?: string;
  countryCode?: string;
  phone?: string;
  phoneUnformatted?: string;
  website?: string;
  url?: string;
  emails?: string[];
  totalScore?: number;
  reviewsCount?: number;
  placeId?: string;
  // We pass through whatever Apify gives us; this type only documents the
  // fields we actually read.
};

// Apify scrapes typically take 30s–3min. Netlify's synchronous function
// cap is ~26s, so we can't block on run-sync-get-dataset-items. Instead:
// start the actor asynchronously, persist the run id, and let the client
// call outreach.campaign.sync on a short poll loop to finalize once the
// run reaches SUCCEEDED.

async function startApifyGoogleMapsRun(
  apifyKey: string,
  searchTerms: string[],
  location: string,
  maxResults: number,
): Promise<{ runId: string; defaultDatasetId: string | null; status: string }> {
  const input = {
    searchStringsArray: searchTerms,
    locationQuery: location,
    maxCrawledPlacesPerSearch: Math.max(5, Math.min(200, Math.ceil(maxResults / Math.max(1, searchTerms.length)))),
    language: "en",
    scrapePlaceDetailPage: true,
    skipClosedPlaces: true,
    allPlacesNoSearchAction: "",
  };
  const r = await fetch(
    `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${encodeURIComponent(apifyKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Apify run start failed (${r.status}): ${txt.slice(0, 300)}`);
  }
  const data = (await r.json()) as { data?: { id?: string; defaultDatasetId?: string; status?: string } };
  if (!data.data?.id) throw new Error("Apify did not return a run id");
  return {
    runId: data.data.id,
    defaultDatasetId: data.data.defaultDatasetId ?? null,
    status: data.data.status ?? "READY",
  };
}

async function getApifyRunStatus(
  apifyKey: string,
  runId: string,
): Promise<{ status: string; defaultDatasetId: string | null; statusMessage: string | null }> {
  const r = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(apifyKey)}`,
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Apify run fetch failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  const data = (await r.json()) as { data?: { status?: string; defaultDatasetId?: string; statusMessage?: string } };
  return {
    status: data.data?.status ?? "UNKNOWN",
    defaultDatasetId: data.data?.defaultDatasetId ?? null,
    statusMessage: data.data?.statusMessage ?? null,
  };
}

async function getApifyLog(apifyKey: string, runId: string): Promise<string> {
  const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/log?token=${encodeURIComponent(apifyKey)}`);
  if (!r.ok) return "";
  return (await r.text()).slice(-20000);
}

async function getApifyDatasetItems(
  apifyKey: string,
  datasetId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const r = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(apifyKey)}&clean=true&limit=${limit}`,
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Apify dataset fetch failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  return (await r.json()) as Array<Record<string, unknown>>;
}

// ── Website check ─────────────────────────────────────────────────────
// One pass per lead: fetch the homepage, contact pages and About pages (in
// parallel, 6 s each, so the whole pass stays well inside Netlify's ~26 s cap),
// then read automation signals, social/contact LINKS (we never fetch LinkedIn
// or Facebook), the owner's name and any email address from the HTML.

async function fetchPage(url: string, ms = 6000): Promise<Page | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(ms),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShiftForgeHQ/1.0)", Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (type && !/html|xml|text/i.test(type)) return null;
    return { url: r.url || url, html: (await r.text()).slice(0, 700_000) };
  } catch {
    return null;
  }
}

function siteBase(website: string): URL | null {
  const w = website.trim();
  for (const candidate of [w, `https://${w}`]) {
    try {
      const u = new URL(candidate);
      if (/^https?:$/.test(u.protocol) && u.hostname.includes(".")) return u;
    } catch { /* try next */ }
  }
  return null;
}

/** Gemini fallback: a name only when the About text clearly names the owner/founder; the answer must appear in the text. */
async function geminiOwnerFallback(text: string, businessName: string, ai: GeminiAiOpts): Promise<string | null> {
  if (!(await aiAvailable()) || text.length < 80) return null;
  try {
    const { json } = await aiJson(
      "helper",
      {
        system: 'You read the About page text of a small business. Reply with JSON {"owner": string|null}. Give a name ONLY when the text clearly names the CURRENT owner of this business as a person. Never guess; return null for staff lists without a role, testimonials, reviewers, company names, and anyone described as retired, former, sold, late or passed away.',
        user: `Business: ${businessName}\n\nAbout text:\n${text.slice(0, 3500)}`,
        temperature: 0,
      },
      ai,
    );
    const name = (json as { owner?: unknown }).owner;
    if (typeof name !== "string") return null;
    const clean = name.replace(/\s+/g, " ").trim();
    return validPersonName(clean, businessName) && text.includes(clean) ? clean : null;
  } catch {
    return null; // fallback only: never fail the check because of it
  }
}

type SiteCheckResult = { fields: Record<string, unknown>; emails: string[]; fetched: number; tried: string[] };

/**
 * Turns fetched pages (plain download OR browser-rendered) into the lead fields:
 * signals with evidence, social links, owner with evidence, hours wording, fit
 * flags, gap score. Pure apart from the optional Gemini owner fallback.
 */
async function analyzeSite(lead: Record<string, unknown>, pages: Page[], viaIn: "raw" | "browser", started = Date.now()): Promise<SiteCheckResult> {
  let via = viaIn;
  const checkedAt = new Date().toISOString();
  const { signals, sources, evidence } = detectSignals(pages);
  // A plain re-check never throws away what a real browser already saw on this lead.
  if (via === "raw" && (lead.site_check as { via?: string } | null | undefined)?.via === "browser") via = "browser";
  if (via === "browser") {
    // The browser only looks at a few pages: anything the earlier plain check found on other pages is kept.
    const prior = (lead.site_check ?? {}) as Record<string, unknown>;
    const priorEv = (prior.evidence ?? {}) as Record<string, string>;
    for (const k of ["chat_widget", "booking_tool", "whatsapp_url", "contact_form_url"] as const) {
      if (!signals[k] && typeof prior[k] === "string") { (signals as Record<string, unknown>)[k] = prior[k]; if (priorEv[k]) evidence[k] = priorEv[k]; }
    }
    if (!signals.has_contact_form && prior.has_contact_form === true) signals.has_contact_form = true;
    if (signals.booking_tool) signals.request_form = false;
  }
  const { social, sources: socialSources } = extractSocial(pages);
  const emails: string[] = [];
  for (const p of pages) for (const e of extractEmailsFromHtml(p.html)) if (!emails.includes(e) && !isGovEduEmail(e)) emails.push(e);

  const name = typeof lead.name === "string" ? lead.name : null;
  let owner: Owner | null = findOwner(pages, name);
  if (!owner && Date.now() - started < 14_000) {
    const about = pages.find((p) => /about|story|team|owner/i.test(p.url));
    if (about) {
      const n = await geminiOwnerFallback(pageText(about.html), name ?? "this business", { budgetMs: 8000, timeoutMs: 8000 });
      // The model's answer is never trusted as much as a pattern match: low confidence, shown for review only.
      if (n) owner = { name: n, source_url: about.url, confidence: "low", how: "AI reading of the About page", evidence: "Found by an AI reading of the About page; not confirmed by a clear sentence." };
    }
  }

  const wording = siteHoursWording(pages);
  const fit = fitFlags(pages, typeof lead.website === "string" ? lead.website : null);
  const nb: { needs: boolean; reason: string | null } = via === "browser" ? { needs: false, reason: null } : needsBrowserCheck(pages, signals);
  const gap = gapScore(lead as { rating?: number | null; reviews_count?: number | null; raw?: unknown }, signals, { hoursUsable: wording.hours_usable });
  const fields: Record<string, unknown> = {
    site_check: {
      checked_at: checkedAt,
      via,
      ...signals,
      pages_checked: pages.length,
      sources: { ...sources, ...socialSources },
      evidence,
      hours_usable: wording.hours_usable,
      advertises_emergency: wording.advertises_emergency,
      hours_evidence: wording.evidence,
      needs_browser: nb.needs,
      needs_browser_reason: nb.reason,
      not_home_service: fit.not_home_service,
      lead_gen_listing: fit.lead_gen_listing,
    },
    social,
    gap_score: gap.score,
    gap_reasons: gap.reasons,
  };
  // An owner the user typed in is never overwritten by a re-check.
  if (lead.owner_source !== "manual") {
    if (owner) {
      Object.assign(fields, { owner_name: owner.name, owner_source_url: owner.source_url, owner_confidence: owner.confidence, owner_source: owner.how, owner_evidence: owner.evidence });
      // Only a high-confidence owner is used to greet the lead ("Hi Dana").
      fields.contact_name = owner.confidence === "high" ? owner.name : null;
    } else if (via === "raw" && lead.owner_name && lead.owner_confidence !== "high") {
      // An older guess that this check can no longer confirm (could be a retired founder): drop it.
      Object.assign(fields, { owner_name: null, owner_confidence: null, owner_source: null, owner_source_url: null, owner_evidence: null, contact_name: null });
    }
  }
  return { fields, emails, fetched: pages.length, tried: [] };
}

/** A lead with no website: "No website" is the biggest gap; a trade-keyword-stuffed name with few reviews is flagged as a possible lead-gen listing. */
function noWebsiteFields(lead: Record<string, unknown>, checkedAt: string): Record<string, unknown> {
  const g = gapScore(lead as { rating?: number | null; reviews_count?: number | null; raw?: unknown }, null);
  return {
    site_check: { checked_at: checkedAt, error: "no website", lead_gen_listing: looksLikeLeadGenListing(lead as { name?: string; website?: string; reviews_count?: number }) },
    gap_score: g.score,
    gap_reasons: g.reasons,
  };
}

async function checkLeadSite(lead: Record<string, unknown>): Promise<SiteCheckResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const base = typeof lead.website === "string" ? siteBase(lead.website) : null;
  const tried: string[] = [];
  if (!base) return { fields: noWebsiteFields(lead, checkedAt), emails: [], fetched: 0, tried };
  const urls = SITE_CHECK_PATHS.map((p) => new URL(p, base).toString());
  tried.push(...urls);
  const got = await Promise.all(urls.map((u) => fetchPage(u)));
  // A homepage that did not load gets one more, slower try (many sites are just slow).
  if (!got[0]) got[0] = await fetchPage(urls[0], 12000);
  // Several paths can redirect to the same page: keep each page once.
  const seen = new Set<string>();
  const pages = got.filter((p): p is Page => !!p).filter((p) => { const k = p.url.replace(/\/$/, ""); if (seen.has(k)) return false; seen.add(k); return true; });
  if (pages.length === 0) return { fields: { site_check: { checked_at: checkedAt, error: "website did not load (it may block automated visits)", needs_browser: true, needs_browser_reason: "The site did not load for a plain download; a browser may open it" } }, emails: [], fetched: 0, tried };
  const res = await analyzeSite(lead, pages, "raw", started);
  return { ...res, tried };
}

/** Best address from a list: role-based business addresses first. */
function pickBestEmail(emails: string[]): string | null {
  const preferred = emails.find((e) => /^(info|contact|hello|hi|admin|sales|office|reception|enquiries|inquiries|support)@/i.test(e));
  return preferred ?? emails[0] ?? null;
}

function extractLeadFromApify(raw: Record<string, unknown>): {
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  category: string | null;
  rating: number | null;
  reviews_count: number | null;
  maps_url: string | null;
} {
  const r = raw as ApifyLead;
  const emails = Array.isArray(r.emails)
    ? r.emails.map((e) => (typeof e === "string" ? cleanEmail(e) : null)).filter((e): e is string => !!e && !isJunkEmail(e) && !isGovEduEmail(e))
    : [];
  return {
    name: String(r.title ?? r.subTitle ?? "Unknown"),
    email: emails[0] ?? null,
    phone: (r.phone as string | undefined) ?? (r.phoneUnformatted as string | undefined) ?? null,
    website: (r.website as string | undefined) ?? null,
    address: (r.address as string | undefined) ?? null,
    category: (r.categoryName as string | undefined) ?? (r.category as string | undefined) ?? null,
    rating: typeof r.totalScore === "number" ? r.totalScore : null,
    reviews_count: typeof r.reviewsCount === "number" ? r.reviewsCount : null,
    maps_url: (r.url as string | undefined) ?? null,
  };
}

// ── Email status refresh from AgentMail's API ──────────────────────────
// Webhooks are the fast path, but they can be missed (not registered on a
// preview, a failed delivery of the webhook itself, ...), leaving an email on
// "sent" forever. On campaign sync we ask AgentMail directly for the message
// and move the status forward from its labels. Forward-only, like the webhook.

const STATUS_RANK: Record<string, number> = { drafted: 0, sent: 1, delivered: 2, clicked: 3, replied: 4 };

function statusFromLabels(labels: unknown): "bounced" | "complained" | "failed" | "delivered" | "sent" | null {
  if (!Array.isArray(labels)) return null;
  const set = new Set(labels.filter((l): l is string => typeof l === "string").map((l) => l.toLowerCase()));
  if (set.has("bounced")) return "bounced";
  if (set.has("complained")) return "complained";
  if (set.has("rejected") || set.has("failed")) return "failed";
  if (set.has("delivered")) return "delivered";
  if (set.has("sent")) return "sent";
  return null;
}

async function refreshEmailStatuses(agentmailKey: string, campaignId: string, max = 15): Promise<{ checked: number; updated: number }> {
  const es = store(OUTREACH_EMAILS);
  const { blobs } = await es.list({ prefix: `${campaignId}/` });
  let checked = 0;
  let updated = 0;
  for (const b of blobs) {
    if (checked >= max) break;
    const row = await readJson<Record<string, unknown>>(es, b.key);
    if (!row || !row.agentmail_message_id || !row.agentmail_inbox_id) continue;
    const cur = String(row.status ?? "");
    // Only messages still in flight: sent or delivered. Replied/clicked/bounced are final here.
    if (cur !== "sent" && cur !== "delivered") continue;
    checked++;
    try {
      const r = await agentmailFetch(
        agentmailKey,
        `/inboxes/${encodeURIComponent(row.agentmail_inbox_id as string)}/messages/${encodeURIComponent(row.agentmail_message_id as string)}`,
      );
      if (!r.ok) continue;
      const msg = (await r.json()) as { labels?: unknown };
      const next = statusFromLabels(msg.labels);
      if (!next || next === cur) continue;
      const negative = next === "bounced" || next === "complained" || next === "failed";
      if (!negative && (STATUS_RANK[next] ?? 0) <= (STATUS_RANK[cur] ?? 0)) continue;
      const now = new Date().toISOString();
      await writeJson(es, b.key, { ...row, status: next, [`${next}_at`]: now, status_source: "agentmail_api", updated_at: now });
      if (negative) { try { await noteBounced(row.to_email as string | undefined); } catch { /* best effort */ } }
      updated++;
    } catch {
      // Network hiccup on one message: leave it for the next sync.
    }
  }
  return { checked, updated };
}

// ── OUTREACH helpers ───────────────────────────────────────────────
// Turns a free-text ICP description into a structured query the Apify
// Google Maps scraper can run. We ask Gemini for JSON only, validate the
// shape, and fall back to a single literal search term if parsing fails
// (so the preview always returns *something* usable).

type StructuredQuery = { location: string; searchTerms: string[]; maxResults: number };

const PREVIEW_SYSTEM_PROMPT = `You convert a natural-language ICP description into a structured Google Maps search plan.

Output ONLY a JSON object with this exact shape — no prose, no markdown, no code fences:
{ "location": "<city, state/country>", "searchTerms": ["<term 1>", "<term 2>", ...], "maxResults": <int> }

Rules:
- "location" = the geographic target the user described. If multiple cities, pick the primary one. If the user named a region/metro, pick a representative anchor city (e.g. "San Francisco Bay Area" -> "San Francisco, CA").
- "searchTerms" = 1–5 distinct business-type queries. Each should be a short phrase a human would type into Google Maps. DO NOT append the location to the search term — that's the "location" field's job. Expand synonyms the user implied (e.g. "law firms" -> "personal injury lawyer", "family lawyer" if context warrants).
- "maxResults" = clamp the user-requested number into [10, 200]. If unspecified, use 50.
- Always return valid JSON. No trailing commas. Double-quoted strings only.`;

async function previewIcpWithGemini(_geminiKey: string | null, userQuery: string, maxResultsHint?: number, ai: GeminiAiOpts = {}): Promise<StructuredQuery> {
  const { json: parsed } = await aiJson(
    "helper",
    { system: PREVIEW_SYSTEM_PROMPT, user: `ICP description:\n${userQuery}\n\nMax results hint: ${typeof maxResultsHint === "number" ? maxResultsHint : "unspecified"}`, temperature: 0.2 },
    ai,
  );
  const obj = parsed as Partial<StructuredQuery>;
  const location = typeof obj.location === "string" && obj.location.trim() ? obj.location.trim() : "Unknown";
  const terms = Array.isArray(obj.searchTerms) ? obj.searchTerms.filter((t) => typeof t === "string" && t.trim()) : [];
  const searchTerms = terms.length > 0 ? terms.map((t) => (t as string).trim()).slice(0, 5) : [userQuery.slice(0, 80)];
  const rawMax = typeof obj.maxResults === "number" ? obj.maxResults : maxResultsHint ?? 50;
  const maxResults = Math.max(10, Math.min(200, Math.round(rawMax)));
  return { location, searchTerms, maxResults };
}

// ── Campaign skip context + drafting (shared by the sync action and the background job) ──

type CampaignRecord = Record<string, unknown> & { query?: string; structured_query?: { location?: string; searchTerms?: string[] } | null };

/** What leadSkipReason needs to know about a campaign: where it searches and for which trade. */
function campaignSkipCtx(c: CampaignRecord | null | undefined): { location: string | null; query: string; anyTrade: boolean } {
  const sq = c?.structured_query;
  return { location: sq?.location ?? null, query: [c?.query ?? "", ...(Array.isArray(sq?.searchTerms) ? sq!.searchTerms! : [])].join(" "), anyTrade: c?.any_trade === true };
}

/**
 * Counters and status come from the emails themselves. The stored counters were bumped by
 * whichever handler wrote the campaign record last (send, webhooks, draft jobs), and those
 * writes overwrote each other (e.g. 7 sent emails still showing "ready" and 0 sent).
 */
function deriveCampaign<T extends Record<string, unknown>>(c: T, emails: Array<{ status?: string; click_count?: number }>): T {
  if (emails.length === 0) return c;
  const sent = emails.filter((e) => e.status && e.status !== "drafted").length;
  const queued = emails.length - sent;
  const out: Record<string, unknown> = {
    ...c,
    emails_generated: emails.length,
    emails_sent: sent,
    emails_delivered: emails.filter((e) => ["delivered", "clicked", "replied"].includes(e.status ?? "")).length,
    emails_clicked: emails.filter((e) => e.status === "clicked" || e.status === "replied" || (e.click_count ?? 0) > 0).length,
    emails_replied: emails.filter((e) => e.status === "replied").length,
    emails_bounced: emails.filter((e) => ["bounced", "complained", "failed"].includes(e.status ?? "")).length,
  };
  const st = c.status as string | undefined;
  const sendingNow = st === "sending" && Date.now() - Date.parse((c.updated_at as string) ?? "") < 5 * 60_000;
  if (!sendingNow && (st === "ready" || st === "sending" || st === "completed" || st === "failed") && sent > 0) out.status = queued > 0 ? "ready" : "completed";
  return out as T;
}

/** The lead count comes from the leads themselves (the stored leads_imported was only bumped by some import paths). */
async function withLeadCount<T extends Record<string, unknown>>(c: T): Promise<T> {
  try {
    const { blobs } = await store(OUTREACH_LEADS).list({ prefix: `${String(c.id)}/` });
    const stored = typeof c.leads_imported === "number" ? c.leads_imported : 0;
    return { ...c, leads_imported: blobs.length > 0 ? blobs.length : stored };
  } catch {
    return c;
  }
}

async function campaignEmails(id: string): Promise<Array<{ status?: string; click_count?: number }>> {
  return listJsonFast<{ status?: string; click_count?: number }>(store(OUTREACH_EMAILS), `${id}/`);
}

/** Find one lead of a campaign by id (leads are keyed by creation time, so this scans the campaign's prefix). */
async function findLeadRow(campaign_id: string, lead_id: string): Promise<{ key: string; lead: Record<string, unknown> } | null> {
  const ls = store(OUTREACH_LEADS);
  const { blobs } = await ls.list({ prefix: `${campaign_id}/` });
  for (const b of blobs) {
    const row = await readJson<Record<string, unknown>>(ls, b.key);
    if (row?.id === lead_id) return { key: b.key, lead: row };
  }
  return null;
}

/** A scraped address that is only a placeholder counts as "no email" (so Find emails tries again). */
function withoutJunkEmail<T extends { email?: string | null }>(lead: T): T & { junk_email?: string } {
  return lead.email && isJunkEmail(lead.email) ? { ...lead, email: null, junk_email: lead.email } : lead;
}

type DraftOneResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string; code?: string; retry_after?: number };

const draftFail = (status: number, error: string, code?: string, retry_after?: number): DraftOneResult => ({ ok: false, status, error, code, retry_after });

/**
 * Drafts one email for one lead at one sequence step and stores it. Refuses leads
 * that must not be emailed (excluded, chain, wrong trade, placeholder address,
 * opted out, bounced, already contacted from another campaign). A lead added
 * seconds ago may not show in the store's list yet (Blobs lists lag about a
 * minute), so the caller can pass the lead it already has as `leadHint`.
 */
export async function draftOne(p: {
  campaign_id: string;
  lead_id: string;
  sender_name?: unknown;
  sender_company?: unknown;
  sender_offer?: unknown;
  framework?: unknown;
  step?: unknown;
  total_steps?: unknown;
  leadHint?: unknown;
  ai?: GeminiAiOpts;
  contacts?: Contacts;
  review?: boolean; // run the AI reviewer right after drafting (background jobs)
}): Promise<DraftOneResult> {
  const { campaign_id, lead_id, sender_name, sender_company, sender_offer, framework, step, total_steps, leadHint } = p;
  if (!(await aiAvailable())) return draftFail(400, "Gemini key not configured");

  const cs = store(OUTREACH_CAMPAIGNS);
  const campaign = await readJson<CampaignRecord>(cs, campaign_id);
  if (!campaign) return draftFail(404, "campaign not found");

  // Normalize framework + step inputs. Default = one-off at step 1.
  const fw = typeof framework === "string" && ["pas", "aida", "sdr"].includes(framework) ? (framework as "pas" | "aida" | "sdr") : "one-off";
  const stepNum = typeof step === "number" && step >= 1 && step <= 5 ? Math.floor(step) : 1;
  const totalNum = typeof total_steps === "number" && total_steps >= 1 && total_steps <= 5 ? Math.floor(total_steps) : fw === "one-off" ? 1 : 3;

  // Find the lead (iterate; scale here is in the hundreds).
  const leadsStore = store(OUTREACH_LEADS);
  const { blobs } = await leadsStore.list({ prefix: `${campaign_id}/` });
  let lead: Record<string, unknown> | null = null;
  for (const b of blobs) {
    const row = await readJson<Record<string, unknown>>(leadsStore, b.key);
    if ((row as { id?: string } | null)?.id === lead_id) {
      lead = row;
      break;
    }
  }
  if (!lead && leadHint && typeof leadHint === "object") {
    const hint = leadHint as Record<string, unknown>;
    if (hint.id === lead_id && hint.campaign_id === campaign_id) lead = hint;
  }
  // Blobs reads can lag a minute behind a write: the user's current tick state, sent by the page, wins.
  if (lead && leadHint && typeof leadHint === "object" && (leadHint as Record<string, unknown>).id === lead_id && typeof (leadHint as Record<string, unknown>).excluded === "boolean") {
    lead = { ...lead, excluded: (leadHint as Record<string, unknown>).excluded };
  }
  if (!lead) return draftFail(404, "lead not found");
  if (!lead.email) return draftFail(400, "lead has no email address — cannot draft");
  if (lead.do_not_contact) return draftFail(400, "lead is marked do-not-contact — no email will be drafted");
  {
    const skip = leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], campaignSkipCtx(campaign));
    if (skip) return draftFail(400, `${skip.message} — no draft created`, skip.code === "excluded" ? "excluded" : "skipped_lead");
  }
  {
    const block = contactBlock(p.contacts ?? (await loadContacts()), lead.email as string, campaign_id, { isTest: lead.is_test === true });
    if (block) return draftFail(400, `${block.message} — no draft created`, block.code);
  }
  {
    const mail = emailKey(lead.email as string);
    const flagged = (await listJson<{ email?: string | null; do_not_contact?: boolean }>(store(OUTREACH_LEADS))).some((l) => l.do_not_contact && emailKey(l.email) === mail);
    if (flagged) return draftFail(400, "this email address asked not to be contacted — no draft created");
  }

  // A draft for this (lead, step) already exists: return it (sequences need one per step).
  const es = store(OUTREACH_EMAILS);
  const existingEmails = await listJson<{ id: string; lead_id: string; sequence_position?: number }>(es, `${campaign_id}/`);
  const existing = existingEmails.find((e) => e.lead_id === lead_id && (e.sequence_position ?? 1) === stepNum);
  if (existing) return { ok: true, data: { ...existing, skipped: true } };

  // For steps >1, pull prior steps for this lead so Gemini can reference them implicitly.
  const previousSteps = existingEmails
    .filter((e) => e.lead_id === lead_id && (e.sequence_position ?? 1) < stepNum)
    .map((e) => {
      const full = e as unknown as { sequence_position?: number; subject?: string; body_text?: string };
      return { step: full.sequence_position ?? 1, subject: full.subject ?? "", body_text: full.body_text ?? "" };
    })
    .sort((a, b) => a.step - b.step);

  try {
    const isSeq = fw !== "one-off";
    let draft: EmailDraft;
    let meta: Record<string, unknown> = {};
    if (!isSeq) {
      // First email: the code picks the one confident fact and angle, a small model writes it.
      const sameStep = existingEmails.filter((e) => (e.sequence_position ?? 1) === 1).length;
      const first = await generateFirstEmail(
        { ...(lead as FirstEmailLead), site_check: (lead.site_check as Record<string, unknown> | null | undefined) ?? null },
        { sender_offer: typeof sender_offer === "string" ? sender_offer : undefined },
        { draftsSoFar: sameStep, any_trade: campaign.any_trade === true, query: String(campaign.query ?? "") },
        p.ai ?? {},
      );
      draft = first.draft;
      meta = first.meta;
    } else {
      // Sequences (PAS / AIDA / SDR) keep the older long prompt for every step.
      const d = await generateEmailDraft(
        null,
        {
          name: lead.name as string | undefined,
          contact_name: lead.contact_name as string | undefined,
          owner_name: lead.owner_name as string | undefined,
          owner_confidence: lead.owner_confidence as string | undefined,
          company: lead.company as string | undefined,
          website: lead.website as string | undefined,
          category: lead.category as string | undefined,
          address: lead.address as string | undefined,
          notes: lead.notes as string | undefined,
          is_test: lead.is_test === true,
          rating: typeof lead.rating === "number" ? lead.rating : null,
          reviews_count: typeof lead.reviews_count === "number" ? lead.reviews_count : null,
          gap_reasons: pickAngle({ site_check: lead.site_check as never }).uncertain ? [] : Array.isArray(lead.gap_reasons) ? (lead.gap_reasons as string[]).filter((r) => /chat|booking|whatsapp|contact form/i.test(r)) : [],
          hours_summary: (lead.site_check as { hours_usable?: boolean } | undefined)?.hours_usable === false ? null : hoursInfo(lead.raw)?.summary ?? null,
        },
        {
          sender_name: typeof sender_name === "string" ? sender_name : undefined,
          sender_company: typeof sender_company === "string" ? sender_company : undefined,
          sender_offer: typeof sender_offer === "string" ? sender_offer : undefined,
          campaign_query: campaign.query as string,
          any_trade: campaign.any_trade === true,
        },
        { framework: fw, step: stepNum, total_steps: totalNum, previous_steps: previousSteps },
        p.ai ?? {},
      );
      draft = d;
      meta = { written_by: d.written_by };
    }
    const emailId = nanoid(12);
    const createdAt = new Date().toISOString();
    const record = {
      id: emailId,
      campaign_id,
      lead_id,
      to_email: lead.email,
      to_name: lead.name,
      subject: draft.subject,
      body_text: draft.body_text,
      body_html: draft.body_html,
      sender_name: typeof sender_name === "string" ? sender_name : null,
      sequence_position: stepNum,
      sequence_total: totalNum,
      framework: fw,
      status: "drafted",
      ...meta,
      created_at: createdAt,
      updated_at: createdAt,
    };
    // Review right away (background jobs only): the Send button only sends "ready" drafts.
    if (p.review) {
      const outcome = await reviewDraft(record as unknown as ReviewableEmail, lead as ReviewLead & Record<string, unknown>, p.ai ?? {});
      Object.assign(record, reviewFields(outcome));
    } else {
      Object.assign(record, { review_status: "check", review_reasons: ["Not reviewed yet"], reviewed_by: null, reviewed_at: null });
    }
    await writeJson(es, `${campaign_id}/${createdAt}-${emailId}`, record);
    // Persist the sender context + default framework on the campaign (re-read: a job may have updated it meanwhile).
    const fresh = (await readJson<CampaignRecord>(cs, campaign_id)) ?? campaign;
    await writeJson(cs, campaign_id, {
      ...fresh,
      default_sender_name: (typeof sender_name === "string" && sender_name) || (fresh.default_sender_name as string | undefined) || null,
      default_sender_company: (typeof sender_company === "string" && sender_company) || (fresh.default_sender_company as string | undefined) || null,
      default_sender_offer: (typeof sender_offer === "string" && sender_offer) || (fresh.default_sender_offer as string | undefined) || null,
      default_framework: fw,
      default_sequence_total: totalNum,
      emails_generated: (fresh.emails_generated as number ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    return { ok: true, data: record };
  } catch (err) {
    if (err instanceof GeminiError) {
      const status = err.kind === "daily_quota" || err.kind === "rate_limited" ? 429 : err.kind === "unavailable" ? 503 : err.kind === "timeout" ? 504 : 502;
      return draftFail(status, err.message, err.kind, err.retryAfterS);
    }
    return draftFail(500, err instanceof Error ? err.message : "Draft failed");
  }
}

// ── Background jobs (run by netlify/functions/ai-background.ts) ───────────────
// A normal Netlify function is cut off after about 26 s, far less than a drafting
// run or a slow Gemini answer needs. The app starts a job with a quick action that
// validates and records it, then POSTs the same parameters to the background
// function, which returns at once and keeps working for up to 15 minutes.

const JOB_STALE_MS = 4 * 60_000; // no progress for this long: treat a running job as interrupted
const JOB_MAX_MS = 13 * 60_000; // stay well inside the 15-minute background limit

type PlannedPair = { lead: Record<string, unknown> & { id: string; name?: string }; step: number };

/** Which (lead, step) drafts a run would create: leads with a real address that are not skipped, excluded, contacted elsewhere or already drafted. */
async function planDraftPairs(campaign_id: string, framework: unknown, hints?: unknown): Promise<{ pairs: PlannedPair[]; totalSteps: number; fw: "one-off" | "pas" | "aida" | "sdr" }> {
  const campaign = await readJson<CampaignRecord>(store(OUTREACH_CAMPAIGNS), campaign_id);
  if (!campaign) throw new Error("campaign not found");
  const fw = typeof framework === "string" && ["pas", "aida", "sdr"].includes(framework) ? (framework as "pas" | "aida" | "sdr") : "one-off";
  const totalSteps = fw === "one-off" ? 1 : 3;
  const leads = await listJson<Record<string, unknown> & { id: string }>(store(OUTREACH_LEADS), `${campaign_id}/`);
  // Leads added seconds ago may not be in the list yet: the page sends the ones it already has.
  if (Array.isArray(hints)) {
    for (const h of hints as Array<Record<string, unknown>>) {
      if (!h || typeof h.id !== "string" || h.campaign_id !== campaign_id) continue;
      const have = leads.find((l) => l.id === h.id);
      if (!have) leads.push(h as Record<string, unknown> & { id: string });
      // A just-changed tick may not be readable yet: the page's value wins.
      else if (typeof h.excluded === "boolean") have.excluded = h.excluded;
    }
  }
  const emails = await listJson<{ lead_id: string; sequence_position?: number }>(store(OUTREACH_EMAILS), `${campaign_id}/`);
  const have = new Set(emails.map((e) => `${e.lead_id}__${e.sequence_position ?? 1}`));
  const ctx = campaignSkipCtx(campaign);
  const contacts = await loadContacts();
  const pairs: PlannedPair[] = [];
  for (const l of leads) {
    const email = l.email as string | null | undefined;
    if (!email || isJunkEmail(email) || l.do_not_contact) continue;
    if (leadSkipReason(l as Parameters<typeof leadSkipReason>[0], ctx) || contactBlock(contacts, email, campaign_id, { isTest: l.is_test === true })) continue;
    for (let step = 1; step <= totalSteps; step++) if (!have.has(`${l.id}__${step}`)) pairs.push({ lead: l, step });
  }
  // All step 1 first, then step 2, then step 3: later steps refer back to earlier ones.
  pairs.sort((a, b) => a.step - b.step || a.lead.id.localeCompare(b.lead.id));
  return { pairs, totalSteps, fw };
}

// What this run has already written to campaign.job. Blobs reads can be a little stale, so a patch
// is merged onto this memory too; otherwise a stale read could wipe the run's earlier progress.
const jobMemo = new Map<string, Record<string, unknown>>();

async function patchJob(campaign_id: string, patch: Record<string, unknown>): Promise<void> {
  const cs = store(OUTREACH_CAMPAIGNS);
  const c = await readJson<CampaignRecord>(cs, campaign_id);
  if (!c) return;
  const memo = { ...(jobMemo.get(campaign_id) ?? {}), ...patch };
  jobMemo.set(campaign_id, memo);
  await writeJson(cs, campaign_id, { ...c, job: { ...(c.job as object | undefined), ...memo, progress_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
}

/**
 * The page records the job and then calls the background function straight away, so the function can
 * read the campaign before the new job is visible (Blobs reads are eventually consistent) and used to
 * exit without doing anything. Wait up to ~30 s for the matching running job to appear.
 */
async function waitForJob(campaign_id: string, kind: string): Promise<boolean> {
  const cs = store(OUTREACH_CAMPAIGNS);
  for (let i = 0; i < 20; i++) {
    const c = await readJson<CampaignRecord & { job?: { status?: string; kind?: string } }>(cs, campaign_id);
    if (c?.job && c.job.kind === kind && c.job.status === "running") {
      jobMemo.set(campaign_id, { ...(c.job as Record<string, unknown>) });
      return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export type DraftJobParams = {
  campaign_id: string;
  sender_name?: string;
  sender_company?: string;
  sender_offer?: string;
  framework?: string;
  leads?: unknown;
};

/** The drafting job: one email at a time with a pause between (free Gemini tier: 15 requests/minute), progress written after each. */
export async function runDraftJob(p: DraftJobParams): Promise<void> {
  const { campaign_id } = p;
  const cs = store(OUTREACH_CAMPAIGNS);
  if (!(await waitForJob(campaign_id, "generate"))) return; // nothing was started
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let done = 0;
  let made = 0;
  let stopped: string | null = null;
  const failures: Array<{ name: string; error: string }> = [];
  try {
    const { pairs, totalSteps, fw } = await planDraftPairs(campaign_id, p.framework, p.leads);
    const contacts = await loadContacts();
    for (let i = 0; i < pairs.length && !stopped; i++) {
      if (Date.now() - t0 > JOB_MAX_MS) {
        stopped = `Time limit reached after ${made} draft${made === 1 ? "" : "s"}. Click Generate emails again to continue.`;
        break;
      }
      const { lead, step } = pairs[i];
      if (i > 0) await sleep(4500);
      for (let attempt = 1; ; attempt++) {
        const r = await draftOne({
          campaign_id,
          lead_id: lead.id,
          sender_name: p.sender_name,
          sender_company: p.sender_company,
          sender_offer: p.sender_offer,
          framework: fw,
          step,
          total_steps: totalSteps,
          leadHint: lead,
          ai: BACKGROUND_AI,
          contacts,
          review: true,
        });
        if (r.ok) { made++; break; }
        if (r.code === "daily_quota") { stopped = `${r.error} ${made} draft${made === 1 ? "" : "s"} were made before it stopped.`; break; }
        if ((r.code === "rate_limited" || r.code === "unavailable") && attempt < 4) { await sleep(Math.min(60, r.retry_after ?? 10) * 1000 + 500); continue; }
        failures.push({ name: String(lead.name ?? lead.id), error: r.error });
        break;
      }
      if (!stopped) { done++; await patchJob(campaign_id, { done, made }); }
    }
  } catch (err) {
    stopped = err instanceof Error ? err.message : "Drafting failed";
  }
  await patchJob(campaign_id, {
    status: stopped ? "stopped" : "done",
    done,
    made,
    finished_at: new Date().toISOString(),
    message: stopped ?? (failures.length ? `${failures.length} failed. Click Generate emails again to retry just those.` : undefined),
    failures: failures.length ? failures : undefined,
  });
}


// ── Browser check (Apify playwright-scraper) ──────────────────────────
// Chat and booking widgets on site builders (GoDaddy, Wix, ...) load with JavaScript, so a
// plain download can miss them. For leads that will really be emailed, one Apify run opens
// their pages in a real browser; the same detectors then read the rendered pages.
// Runs in the ai-background function (start, poll, finish); progress is written to campaign.job.

type BrowserCtx = ReturnType<typeof campaignSkipCtx>;

/** No usable email, but a way to reach them another way (Facebook, LinkedIn, Instagram, WhatsApp, contact form, phone). */
function hasOtherChannel(lead: Record<string, unknown>): boolean {
  const so = (lead.social ?? {}) as Record<string, unknown>;
  const sc = (lead.site_check ?? {}) as Record<string, unknown>;
  return !!(so.linkedin_company || so.linkedin_person || so.facebook || so.instagram || sc.whatsapp_url || sc.contact_form_url || (typeof lead.phone === "string" && lead.phone.trim()));
}

function browserEligible(lead: Record<string, unknown>, ctx: BrowserCtx, forced: boolean): boolean {
  if (!lead.website || typeof lead.website !== "string" || !siteBase(lead.website)) return false;
  if (forced) return true;
  const email = lead.email as string | null | undefined;
  if (lead.do_not_contact || lead.excluded || lead.is_test) return false;
  // Leads with an email come first (see planBrowserCheck); then leads we can only reach another way.
  if (!(email && !isJunkEmail(email)) && !hasOtherChannel(lead)) return false;
  if (leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], ctx)) return false;
  const sc = (lead.site_check ?? {}) as { needs_browser?: boolean; via?: string };
  return sc.needs_browser === true && sc.via !== "browser";
}

async function planBrowserCheck(campaign_id: string, leadId?: string): Promise<{ lead_ids: string[]; names: string[]; leads: number; pages: number; est_usd: number; cap: number; used: number; remaining: number }> {
  const campaign = await readJson<CampaignRecord & { browser_checked_ids?: string[] }>(store(OUTREACH_CAMPAIGNS), campaign_id);
  if (!campaign) throw new Error("campaign not found");
  const ctx = campaignSkipCtx(campaign);
  const settings = await readOutreachSettings();
  const cap = Math.max(1, Math.min(200, settings.browser_check_cap ?? BROWSER_DEFAULT_CAP));
  const done = new Set(campaign.browser_checked_ids ?? []);
  const leads = await listJson<Record<string, unknown> & { id: string }>(store(OUTREACH_LEADS), `${campaign_id}/`);
  let picked = leads.filter((l) => (leadId ? l.id === leadId : true) && browserEligible(l, ctx, !!leadId));
  // Leads with a usable email first, then the "reach another way" ones, so the cap goes to emailable leads first.
  const hasEmail = (l: Record<string, unknown>) => (l.email && !isJunkEmail(l.email as string) ? 0 : 1);
  picked = picked.map((l, i) => ({ l, i })).sort((a, b) => hasEmail(a.l) - hasEmail(b.l) || a.i - b.i).map((x) => x.l);
  // New leads count against the cap; one already browser-checked in this campaign can be re-checked for free.
  const remaining = Math.max(0, cap - done.size);
  let room = remaining;
  picked = picked.filter((l) => { if (done.has(l.id)) return true; if (room <= 0) return false; room--; return true; });
  const est = estimateBrowserCost(picked.length);
  return { lead_ids: picked.map((l) => l.id), names: picked.map((l) => String(l.name ?? l.id)), leads: picked.length, pages: est.pages, est_usd: est.usd, cap, used: done.size, remaining };
}

async function patchLeadFields(campaign_id: string, lead_id: string, patch: Record<string, unknown>): Promise<void> {
  const found = await findLeadRow(campaign_id, lead_id);
  if (!found) return;
  await writeJson(store(OUTREACH_LEADS), found.key, { ...found.lead, ...patch, updated_at: new Date().toISOString() });
}

export async function runBrowserJob(p: { campaign_id: string; lead_ids: string[] }): Promise<void> {
  const { campaign_id } = p;
  const cs = store(OUTREACH_CAMPAIGNS);
  if (!(await waitForJob(campaign_id, "browsercheck"))) return;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let done = 0;
  let stopped: string | null = null;
  try {
    const apify = await readServiceKey("apify");
    if (!apify) throw new Error("Apify key not configured");
    const leads: Array<Record<string, unknown> & { id: string }> = [];
    for (const id of p.lead_ids) {
      const f = await findLeadRow(campaign_id, id);
      if (f) leads.push(f.lead as Record<string, unknown> & { id: string });
    }
    const sites = leads.map((l) => ({ lead_id: l.id, base: siteBase(String(l.website))?.toString() ?? "" })).filter((x) => x.base);
    if (sites.length === 0) throw new Error("No lead with a usable website");
    const r = await fetch(`https://api.apify.com/v2/acts/${BROWSER_ACTOR}/runs?token=${encodeURIComponent(apify)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(browserInput(sites)) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(r.status === 402 || /credit|limit|usage/i.test(txt) ? "Apify has no credit left for a browser check. Drafting still works; gaps just will not be mentioned for these leads." : `Apify browser run could not start (${r.status}): ${txt.slice(0, 160)}`);
    }
    const started = (await r.json()) as { data?: { id?: string } };
    const runId = started.data?.id;
    if (!runId) throw new Error("Apify did not return a run id");
    await patchJob(campaign_id, { message: "The browser is opening the websites…", run_id: runId });
    let datasetId: string | null = null;
    let status = "RUNNING";
    while (Date.now() - t0 < JOB_MAX_MS) {
      await sleep(7000);
      const st = await getApifyRunStatus(apify, runId);
      status = st.status;
      datasetId = st.defaultDatasetId ?? datasetId;
      if (datasetId) {
        try {
          const items = await getApifyDatasetItems(apify, datasetId, 500);
          done = new Set(items.map((i) => i.lead_id).filter((x): x is string => typeof x === "string")).size;
          await patchJob(campaign_id, { done });
        } catch { /* progress only */ }
      }
      if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) break;
    }
    let runMessage: string | null = null;
    try { runMessage = (await getApifyRunStatus(apify, runId)).statusMessage; } catch { /* diagnostics only */ }
    let tail = "";
    try { tail = logTail(await getApifyLog(apify, runId)); } catch { /* diagnostics only */ }
    await patchJob(campaign_id, { apify_status: status, apify_message: runMessage ?? undefined, log_tail: tail || undefined });
    if (!datasetId) throw new Error(`The browser run ended without results (${status}).${runMessage ? ` ${runMessage}` : ""}`);
    const items = await getApifyDatasetItems(apify, datasetId, 600);
    const byLead = pagesByLead(items);
    const checkedIds = new Set(((await readJson<{ browser_checked_ids?: string[] }>(cs, campaign_id))?.browser_checked_ids) ?? []);
    for (const lead of leads) {
      const pages = byLead.get(lead.id);
      const nowIso = new Date().toISOString();
      if (pages && pages.length > 0) {
        const res = await analyzeSite(lead, pages, "browser");
        await patchLeadFields(campaign_id, lead.id, { ...res.fields, browser_checked_at: nowIso });
        checkedIds.add(lead.id);
      } else {
        // Keep the plain result, but say it is still uncertain so drafting and the reviewer do not trust gaps.
        const sc = (lead.site_check ?? {}) as Record<string, unknown>;
        await patchLeadFields(campaign_id, lead.id, { site_check: { ...sc, needs_browser: true, needs_browser_reason: "The browser check could not open this site", browser_error: "no pages loaded", browser_attempted_at: nowIso } });
      }
    }
    const fresh = await readJson<Record<string, unknown>>(cs, campaign_id);
    if (fresh) await writeJson(cs, campaign_id, { ...fresh, browser_checked_ids: [...checkedIds] });
    if (status !== "SUCCEEDED") stopped = `The browser run ended early (${status}${runMessage ? `: ${runMessage}` : ""}). Leads without results stay marked "needs browser check".`;
    else if (leads.every((l) => !byLead.get(l.id)?.length)) stopped = `The browser could not open the websites (run ${status}${runMessage ? `: ${runMessage}` : ""}). Leads stay marked "needs browser check"; drafting still works.`;
  } catch (err) {
    stopped = err instanceof Error ? err.message : "Browser check failed";
  }
  await patchJob(campaign_id, { status: stopped ? "stopped" : "done", done, finished_at: new Date().toISOString(), message: stopped ?? undefined });
}

/** Which drafts a review run covers: the ticked ones, else every draft that is not already "ready". */
async function planReview(campaign_id: string, emailIds?: string[]): Promise<Array<{ key: string; row: Record<string, unknown> & { id: string } }>> {
  const es = store(OUTREACH_EMAILS);
  const { blobs } = await es.list({ prefix: `${campaign_id}/` });
  const out: Array<{ key: string; row: Record<string, unknown> & { id: string } }> = [];
  const want = emailIds && emailIds.length ? new Set(emailIds) : null;
  for (const b of blobs) {
    const row = await readJson<Record<string, unknown> & { id: string }>(es, b.key);
    if (!row || row.status !== "drafted") continue;
    if (want ? !want.has(row.id) : row.review_status === "ready") continue;
    out.push({ key: b.key, row });
  }
  return out;
}

/** The review job: one draft at a time, progress written after each (runs in ai-background). */
export async function runReviewJob(p: { campaign_id: string; email_ids?: string[] }): Promise<void> {
  const { campaign_id } = p;
  const cs = store(OUTREACH_CAMPAIGNS);
  if (!(await waitForJob(campaign_id, "review"))) return;
  const t0 = Date.now();
  let done = 0;
  let stopped: string | null = null;
  try {
    const todo = await planReview(campaign_id, p.email_ids);
    const es = store(OUTREACH_EMAILS);
    for (let i = 0; i < todo.length && !stopped; i++) {
      if (Date.now() - t0 > JOB_MAX_MS) { stopped = `Time limit reached after ${done} reviews. Click Review again to continue.`; break; }
      const { key, row } = todo[i];
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const found = await findLeadRow(campaign_id, String(row.lead_id));
      if (!found) { done++; continue; }
      const outcome = await reviewDraft(row as unknown as ReviewableEmail, found.lead as ReviewLead & Record<string, unknown>, BACKGROUND_AI);
      // Re-read: if the draft was edited or sent while the reviewer worked, the verdict no longer applies.
      const fresh = await readJson<Record<string, unknown>>(es, key);
      if (fresh && fresh.status === "drafted" && fresh.updated_at === row.updated_at) {
        await writeJson(es, key, { ...fresh, ...reviewFields(outcome, fresh.review_history), updated_at: new Date().toISOString() });
      }
      done++;
      await patchJob(campaign_id, { done });
    }
  } catch (err) {
    stopped = err instanceof Error ? err.message : "Review failed";
  }
  await patchJob(campaign_id, { status: stopped ? "stopped" : "done", done, finished_at: new Date().toISOString(), message: stopped ?? undefined });
}

export async function runPreviewJob(p: { id: string; query: string; max_results?: number }): Promise<void> {
  const ss = store(OUTREACH_SETTINGS);
  const key = `preview/${p.id}`;
  try {
    if (!(await aiAvailable())) throw new GeminiError("Gemini key not configured — open Settings and add it first.", "auth", 400);
    const structured = await previewIcpWithGemini(null, p.query, p.max_results, BACKGROUND_AI);
    await writeJson(ss, key, { status: "done", result: structured, finished_at: new Date().toISOString() });
  } catch (err) {
    await writeJson(ss, key, {
      status: "error",
      error: err instanceof Error ? err.message : "Preview failed",
      code: err instanceof GeminiError ? err.kind : undefined,
      finished_at: new Date().toISOString(),
    });
  }
}

export const handler: Handler = async (event) => {
  // v1 Lambda-compat functions need this to wire up Blobs from the event headers
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") return fail(405, "Method not allowed");

  // Public actions that do not require an API key.
  const PUBLIC_ACTIONS = new Set(["auth.bootstrap"]);

  // Outer try/catch — ensures the function always returns JSON, never a bare
  // runtime error (which Netlify serves as an empty 500).
  try {
    let req: Req;
    try {
      req = JSON.parse(event.body ?? "{}");
    } catch {
      return fail(400, "Invalid JSON");
    }
    const { action, params = {} } = req;
    if (!action) return fail(400, "Missing 'action'");

    const rawKey = event.headers["x-api-key"] ?? event.headers["X-API-Key"] ?? null;
    const identity = await identifyApiKey(typeof rawKey === "string" ? rawKey : null);
    if (!PUBLIC_ACTIONS.has(action) && !identity) {
      return fail(401, "Invalid or missing X-API-Key");
    }

    switch (action) {
      // ── AUTH ──────────────────────────────────────────────
      case "auth.bootstrap": {
        // First-run only. It hands out the master key ONLY while none exists
        // (the very first visit claims it). After that it is closed: it used to
        // return the master key to anyone who asked. Existing browsers keep
        // working (their key is in localStorage); new browsers must paste the key.
        if (await hasApiKey()) {
          return failCode(403, "This workspace is already set up. Paste your API key to sign in.", "signin_required");
        }
        const apiKey = await getOrCreateApiKey();
        return ok({ api_key: apiKey });
      }
      case "auth.rotate": {
        // Issues a brand-new master key; the old one stops working immediately.
        // Master key only, and the caller must pass confirm: true.
        if (identity?.kind !== "master") return fail(403, "Only the master key can rotate the key");
        if ((params as Record<string, unknown>).confirm !== true) return fail(400, "Pass confirm: true. This invalidates the current key everywhere.");
        const fresh = await rotateApiKey();
        await logActivity({ category: "system", summary: "Master API key rotated" });
        return ok({ api_key: fresh });
      }

      // ── DATA MOVE (export / import between sites) ───────────────────
      // Master key only. Copies stored records as raw strings, so a round trip is exact.
      // Secrets (service keys, master key, agent keys) and webhook event logs are not in
      // MOVABLE_STORES on purpose; they are never exported.
      case "data.counts": {
        if (identity?.kind !== "master") return fail(403, "Only the master key can use data move");
        const counts: Record<string, number> = {};
        for (const name of MOVABLE_STORES) {
          const { blobs } = await store(name).list();
          counts[name] = blobs.length;
        }
        return ok({ counts });
      }
      case "data.export": {
        if (identity?.kind !== "master") return fail(403, "Only the master key can use data move");
        const { store: name, cursor } = params as { store?: string; cursor?: string | null };
        if (!name || !MOVABLE_STORES.includes(name)) return fail(400, "unknown store");
        const s = store(name);
        const keys = (await s.list()).blobs.map((b) => b.key).sort();
        const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
        const rest = start < 0 ? [] : keys.slice(start);
        const records: { key: string; value: string }[] = [];
        let bytes = 0;
        let last: string | null = null;
        for (const key of rest) {
          if (records.length >= 100 || bytes > 1_500_000) break;
          const value = await s.get(key);
          last = key;
          if (typeof value !== "string") continue;
          bytes += value.length + key.length;
          records.push({ key, value });
        }
        const done = !last || last === rest[rest.length - 1];
        return ok({ store: name, records, next_cursor: done ? null : last, total: keys.length });
      }
      case "data.import": {
        if (identity?.kind !== "master") return fail(403, "Only the master key can use data move");
        const { store: name, records, overwrite } = params as {
          store?: string;
          records?: { key?: unknown; value?: unknown }[];
          overwrite?: boolean;
        };
        if (!name || !MOVABLE_STORES.includes(name)) return fail(400, "unknown store");
        if (!Array.isArray(records)) return fail(400, "records must be an array");
        const s = store(name);
        let written = 0;
        let skipped = 0;
        for (const r of records) {
          if (typeof r?.key !== "string" || !r.key || r.key.length > 512 || r.key.includes("..") || typeof r.value !== "string") {
            return fail(400, "bad record");
          }
          if (!overwrite && (await s.get(r.key)) !== null) {
            skipped++;
            continue;
          }
          await s.set(r.key, r.value);
          written++;
        }
        return ok({ store: name, written, skipped });
      }

      // ── AGENTS ──────────────────────────────────────────────
      case "agent.register": {
        const { name, role, emoji = "🤖", color = "#00BFFF", sign_in_name: requested } =
          params as Record<string, string>;
        if (!name) return fail(400, "name required");
        const id = nanoid(10);
        const now = new Date().toISOString();
        const sign_in_name = slugify(requested || name) + "-" + id.slice(0, 4);
        const api_key = await createAgentKey(id, sign_in_name);
        const agent = {
          id,
          name,
          sign_in_name,
          api_key,
          role: role ?? "Generalist",
          emoji,
          color,
          status: "online",
          last_heartbeat: now,
          created_at: now,
        };
        await writeJson(store(AGENTS), id, agent);
        await logActivity({ agent_id: id, category: "system", summary: `Agent "${name}" registered as @${sign_in_name}` });
        return ok(agent);
      }
      case "agent.list": {
        const agents = await listJson(store(AGENTS));
        return ok(agents);
      }
      case "agent.heartbeat": {
        const { agent_id } = params as Record<string, string>;
        if (!agent_id) return fail(400, "agent_id required");
        const s = store(AGENTS);
        const existing = await readJson<Record<string, unknown>>(s, agent_id);
        if (!existing) return fail(404, "agent not found");
        const updated = { ...existing, status: "online", last_heartbeat: new Date().toISOString() };
        await writeJson(s, agent_id, updated);
        return ok(updated);
      }
      case "agent.delete": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        await store(AGENTS).delete(id);
        await logActivity({ agent_id: null, category: "system", summary: `Agent ${id} deleted` });
        return ok({ id, deleted: true });
      }

      // ── TASKS ──────────────────────────────────────────────
      case "task.create": {
        const { title, description, assignee_id, priority = "medium" } = params as Record<string, string>;
        if (!title) return fail(400, "title required");
        const id = nanoid(10);
        const now = new Date().toISOString();
        const task = {
          id,
          title,
          description: description ?? null,
          status: "todo",
          assignee_id: assignee_id ?? null,
          priority,
          created_at: now,
          updated_at: now,
        };
        await writeJson(store(TASKS), id, task);
        await logActivity({ agent_id: assignee_id ?? null, category: "task", summary: `Task created: "${title}"` });
        return ok(task);
      }
      case "task.list": {
        const tasks = await listJson(store(TASKS));
        return ok(tasks);
      }
      case "task.move": {
        const { id, status } = params as Record<string, string>;
        if (!id || !status) return fail(400, "id and status required");
        const s = store(TASKS);
        const existing = await readJson<Record<string, unknown>>(s, id);
        if (!existing) return fail(404, "task not found");
        const updated = { ...existing, status, updated_at: new Date().toISOString() };
        await writeJson(s, id, updated);
        await logActivity({
          agent_id: (existing.assignee_id as string) ?? null,
          category: "task",
          summary: `Task "${existing.title}" → ${status}`,
        });
        return ok(updated);
      }
      case "task.delete": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        await store(TASKS).delete(id);
        return ok({ id, deleted: true });
      }

      // ── ACTIVITY ──────────────────────────────────────────────
      case "activity.log": {
        const { agent_id, category, summary, details } = params as Record<string, unknown>;
        if (!summary || !category) return fail(400, "category and summary required");
        await logActivity({
          agent_id: (agent_id as string) ?? null,
          category: category as string,
          summary: summary as string,
          details: (details as Record<string, unknown>) ?? null,
        });
        return ok({ logged: true });
      }
      case "activity.list": {
        const { limit = 100 } = params as Record<string, number>;
        const rows = await listJson<{ created_at: string }>(store(ACTIVITY));
        rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return ok(rows.slice(0, limit));
      }

      // ── FORMS ──────────────────────────────────────────────
      case "form.create": {
        const { slug, title, description = "", fields } = params as Record<string, unknown>;
        if (!slug || !title || !Array.isArray(fields)) return fail(400, "slug, title, fields required");
        const ALLOWED_TYPES = ["text", "email", "textarea", "tel", "url", "number", "date"];
        const normalizedFields = (fields as Array<Record<string, unknown>>).map((f, i) => {
          const label = String(f.label ?? f.name ?? `Field ${i + 1}`);
          const nameRaw = String(f.name ?? label);
          const name = nameRaw
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_]+/g, "_")
            .replace(/^_+|_+$/g, "") || `field_${i + 1}`;
          const typeRaw = String(f.type ?? "text").toLowerCase();
          const type = ALLOWED_TYPES.includes(typeRaw) ? typeRaw : "text";
          return {
            name,
            label,
            type,
            required: Boolean(f.required ?? false),
          };
        });
        const config = {
          slug,
          title,
          description,
          fields: normalizedFields,
          created_at: new Date().toISOString(),
        };
        await writeJson(store(FORMS), slug as string, config);
        return ok(config);
      }
      case "form.list": {
        return ok(await listJson(store(FORMS)));
      }
      case "form.submissions": {
        const { slug } = params as Record<string, string>;
        if (!slug) return fail(400, "slug required");
        return ok(await listJson(store(SUBMISSIONS), `${slug}/`));
      }

      // ── WEBHOOKS ──────────────────────────────────────────────
      case "webhook.create": {
        const { name, description = "" } = params as Record<string, string>;
        if (!name) return fail(400, "name required");
        const id = nanoid(12);
        const w = { id, name, description, event_count: 0, created_at: new Date().toISOString() };
        await writeJson(store(WEBHOOKS), id, w);
        return ok(w);
      }
      case "webhook.list": {
        return ok(await listJson(store(WEBHOOKS)));
      }
      case "webhook.events": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        return ok(await listJson(store(WEBHOOK_EVENTS), `${id}/`));
      }

      // ── VOICE CONFIG ──────────────────────────────────────────────
      case "voice.config.check": {
        const cfg = await readJson<{ gemini_key?: string }>(store(VOICE_CONFIG), "config");
        return ok({ configured: !!cfg?.gemini_key });
      }
      case "voice.config.get": {
        // Requires master-key auth so the Gemini key can reach the browser
        // WebRTC client that needs it to speak directly to Gemini Live.
        if (identity?.kind !== "master") {
          return fail(403, "voice.config.get requires the master API key");
        }
        const cfg = await readJson<{ gemini_key?: string }>(store(VOICE_CONFIG), "config");
        if (!cfg?.gemini_key) return fail(404, "No Gemini key stored yet");
        return ok({ gemini_key: cfg.gemini_key });
      }
      case "voice.config.set": {
        const { gemini_key } = params as Record<string, string>;
        if (!gemini_key || !gemini_key.trim()) return fail(400, "gemini_key required");
        await writeJson(store(VOICE_CONFIG), "config", {
          gemini_key: gemini_key.trim(),
          updated_at: new Date().toISOString(),
        });
        await logActivity({ agent_id: null, category: "system", summary: "Voice: Gemini key configured" });
        return ok({ configured: true });
      }
      case "voice.config.clear": {
        await store(VOICE_CONFIG).delete("config");
        return ok({ cleared: true });
      }

      // ── SERVICE CONFIG (gemini / apify / agentmail) ───────────────
      // Used by the Onboarding wizard and /settings page. Each service
      // is tested against its own auth endpoint before we save, so by
      // the time the wizard dismisses all three keys are known-good.
      case "config.status": {
        // Returns which keys are set + a masked preview. Never returns raw keys.
        const out: Record<string, { configured: boolean; masked: string | null; updated_at?: string; last_test?: ServiceConfigRecord["last_test"] }> = {};
        for (const name of SERVICE_KEYS) {
          const key = await readServiceKey(name);
          const rec = await readJson<ServiceConfigRecord>(store(SERVICE_CONFIG), name);
          out[name] = {
            configured: !!key,
            masked: key ? maskKey(key) : null,
            updated_at: rec?.updated_at,
            last_test: rec?.last_test,
          };
        }
        return ok(out);
      }
      case "config.set": {
        const { service, key, skip_test = false, model } = params as Record<string, unknown>;
        if (!service || !SERVICE_KEYS.includes(service as ServiceKey)) {
          return fail(400, `service must be one of: ${SERVICE_KEYS.join(", ")}`);
        }
        if (typeof key !== "string" || !key.trim()) return fail(400, "key required");
        const trimmed = key.trim();
        let test: ServiceConfigRecord["last_test"] | undefined;
        if (!skip_test) {
          const result = await testServiceKey(service as ServiceKey, trimmed, typeof model === "string" && model.trim() ? model.trim() : undefined);
          test = { ok: result.ok, at: new Date().toISOString(), message: result.message };
          if (!result.ok) {
            // Store nothing on test failure — surface the rejection to the caller.
            return fail(400, result.message);
          }
        }
        await writeServiceKey(service as ServiceKey, trimmed, test);
        if (service === "gemini" && typeof model === "string" && model.trim()) {
          await writeJson(store(OUTREACH_SETTINGS), "settings", { ...(await readOutreachSettings()), gemini_model: model.trim(), updated_at: new Date().toISOString() });
        }
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "system",
          summary: `${service} API key configured`,
        });
        return ok({ configured: true, test });
      }
      case "config.test": {
        // Re-run the validity test for an already-stored key.
        const { service, model } = params as Record<string, unknown>;
        if (!service || !SERVICE_KEYS.includes(service as ServiceKey)) {
          return fail(400, `service must be one of: ${SERVICE_KEYS.join(", ")}`);
        }
        const key = await readServiceKey(service as ServiceKey);
        if (!key) return fail(404, `${service} key not configured`);
        const result = await testServiceKey(service as ServiceKey, key, typeof model === "string" && model.trim() ? model.trim() : undefined);
        const rec: ServiceConfigRecord = {
          key,
          updated_at: (await readJson<ServiceConfigRecord>(store(SERVICE_CONFIG), service as string))?.updated_at ?? new Date().toISOString(),
          last_test: { ok: result.ok, at: new Date().toISOString(), message: result.message },
        };
        await writeJson(store(SERVICE_CONFIG), service as string, rec);
        return ok(rec.last_test);
      }
      case "config.clear": {
        const { service } = params as Record<string, unknown>;
        if (!service || !SERVICE_KEYS.includes(service as ServiceKey)) {
          return fail(400, `service must be one of: ${SERVICE_KEYS.join(", ")}`);
        }
        await store(SERVICE_CONFIG).delete(service as string);
        if (service === "gemini") await store(VOICE_CONFIG).delete("config");
        return ok({ cleared: true });
      }

      // ── VOICE SESSIONS (past conversation transcripts) ────────────
      case "voice.session.save": {
        const { started_at, ended_at, transcripts, tools, invitation_id } = params as Record<string, unknown>;
        if (!started_at || !ended_at || !Array.isArray(transcripts)) {
          return fail(400, "started_at, ended_at, transcripts required");
        }
        const id = nanoid(12);
        const session = {
          id,
          started_at,
          ended_at,
          transcripts,
          tools: Array.isArray(tools) ? tools : [],
          invitation_id: invitation_id ?? null,
          duration_seconds: Math.round(
            (new Date(ended_at as string).getTime() - new Date(started_at as string).getTime()) / 1000,
          ),
        };
        await writeJson(store(VOICE_SESSIONS), `${started_at}-${id}`, session);
        const firstUser = (transcripts as Array<{ role: string; text: string }>).find(
          (t) => t.role === "user",
        );
        await logActivity({
          agent_id: null,
          category: "system",
          summary: `Voice session (${session.duration_seconds}s): ${firstUser?.text?.slice(0, 80) ?? "no user input"}`,
          details: { session_id: id },
        });
        return ok(session);
      }
      case "voice.session.list": {
        const { limit = 50 } = params as Record<string, number>;
        const all = await listJson<{ started_at: string }>(store(VOICE_SESSIONS));
        all.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
        return ok(all.slice(0, limit));
      }
      case "voice.session.get": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const all = await listJson<{ id: string }>(store(VOICE_SESSIONS));
        const found = all.find((s) => s.id === id);
        if (!found) return fail(404, "session not found");
        return ok(found);
      }
      case "voice.session.delete": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(VOICE_SESSIONS);
        const { blobs } = await s.list();
        for (const b of blobs) {
          const record = await readJson<{ id: string }>(s, b.key);
          if (record?.id === id) {
            await s.delete(b.key);
            return ok({ id, deleted: true });
          }
        }
        return fail(404, "session not found");
      }

      // ── VOICE INVITATIONS (agent → user "ring" requests) ────────────
      case "voice.invitation.create": {
        const { agent_name, reason, context } = params as Record<string, string>;
        if (!reason) return fail(400, "reason required");
        const id = nanoid(12);
        const invitation = {
          id,
          agent_name: agent_name ?? (identity?.kind === "agent" ? identity.sign_in_name : "Unknown Agent"),
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          reason,
          context: context ?? "",
          status: "pending",
          created_at: new Date().toISOString(),
        };
        await writeJson(store(VOICE_INVITATIONS), id, invitation);
        await logActivity({
          agent_id: invitation.agent_id,
          category: "decision",
          summary: `${invitation.agent_name} wants to talk: ${reason.slice(0, 80)}`,
          details: { invitation_id: id },
        });
        return ok(invitation);
      }
      case "voice.invitation.list": {
        const all = await listJson<{ created_at: string; status: string }>(store(VOICE_INVITATIONS));
        const pending = all.filter((i) => i.status === "pending");
        pending.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return ok(pending);
      }
      case "voice.invitation.get": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const record = await readJson(store(VOICE_INVITATIONS), id);
        if (!record) return fail(404, "invitation not found");
        return ok(record);
      }
      case "voice.invitation.dismiss": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(VOICE_INVITATIONS);
        const record = await readJson<Record<string, unknown>>(s, id);
        if (!record) return fail(404, "invitation not found");
        await writeJson(s, id, { ...record, status: "dismissed" });
        return ok({ id, status: "dismissed" });
      }
      case "voice.invitation.accept": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(VOICE_INVITATIONS);
        const record = await readJson<Record<string, unknown>>(s, id);
        if (!record) return fail(404, "invitation not found");
        await writeJson(s, id, { ...record, status: "accepted", accepted_at: new Date().toISOString() });
        return ok(record);
      }

      // ── PAGES (agent-generated landing pages served at /p/:slug) ──────
      case "page.create": {
        const { slug, title, html_body, theme = "dark-futuristic", linked_form_slug, accent } =
          params as Record<string, string>;
        if (!slug || !title || !html_body) return fail(400, "slug, title, html_body required");
        const normSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!normSlug) return fail(400, "slug resolved to empty after normalization");
        const page = {
          slug: normSlug,
          title,
          html_body,
          theme,
          linked_form_slug: linked_form_slug ?? null,
          accent: accent ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await writeJson(store(PAGES), normSlug, page);
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "content",
          summary: `Landing page "${title}" published at /p/${normSlug}`,
          details: { slug: normSlug, linked_form_slug: linked_form_slug ?? null },
        });
        return ok(page);
      }
      case "page.list": {
        return ok(await listJson(store(PAGES)));
      }
      case "page.get": {
        const { slug } = params as Record<string, string>;
        if (!slug) return fail(400, "slug required");
        const record = await readJson(store(PAGES), slug);
        if (!record) return fail(404, "page not found");
        return ok(record);
      }
      case "page.update": {
        const { slug, ...patch } = params as Record<string, string>;
        if (!slug) return fail(400, "slug required");
        const s = store(PAGES);
        const existing = await readJson<Record<string, unknown>>(s, slug);
        if (!existing) return fail(404, "page not found");
        const updated = { ...existing, ...patch, slug, updated_at: new Date().toISOString() };
        await writeJson(s, slug, updated);
        const changedKeys = Object.keys(patch).filter((k) => k !== "slug");
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "content",
          summary: `Landing page "${existing.title ?? slug}" updated (${changedKeys.join(", ") || "no fields"})`,
          details: { slug, changed: changedKeys },
        });
        return ok(updated);
      }
      case "page.delete": {
        const { slug } = params as Record<string, string>;
        if (!slug) return fail(400, "slug required");
        await store(PAGES).delete(slug);
        return ok({ slug, deleted: true });
      }

      // ── OUTREACH (ICP → leads → emails → replies) ─────────────────
      // Phase 2 scope: natural-language preview via Gemini + campaign CRUD.
      // Phase 3 will wire the Apify run, AgentMail send, and reply ingestion.

      case "outreach.preview": {
        // Turn free-text ICP into { location, searchTerms[], maxResults }.
        // This is cheap and safe to call repeatedly — no side effects.
        const { query, max_results } = params as Record<string, unknown>;
        if (typeof query !== "string" || !query.trim()) return fail(400, "query required");
        if (!(await aiAvailable())) return fail(400, "Gemini key not configured — open Settings and add it first.");
        try {
          const structured = await previewIcpWithGemini(
            null,
            query.trim(),
            typeof max_results === "number" ? max_results : undefined,
          );
          return ok(structured);
        } catch (err) {
          if (err instanceof GeminiError) return geminiFail(err);
          return fail(500, err instanceof Error ? err.message : "Preview failed");
        }
      }

      case "outreach.preview.start": {
        // Same as outreach.preview, but the slow Gemini call runs in the background function
        // (up to 60 s, one retry). The page then polls outreach.preview.result.
        const { query } = params as Record<string, unknown>;
        if (typeof query !== "string" || !query.trim()) return fail(400, "query required");
        if (!(await aiAvailable())) return fail(400, "Gemini key not configured — open Settings and add it first.");
        const id = nanoid(10);
        await writeJson(store(OUTREACH_SETTINGS), `preview/${id}`, { status: "running", started_at: new Date().toISOString() });
        return ok({ id });
      }

      case "outreach.preview.result": {
        const { id } = params as Record<string, unknown>;
        if (typeof id !== "string" || !/^[\w-]{4,40}$/.test(id)) return fail(400, "id required");
        const rec = await readJson<Record<string, unknown>>(store(OUTREACH_SETTINGS), `preview/${id}`);
        return rec ? ok(rec) : fail(404, "preview not found");
      }

      case "outreach.emails.review.start": {
        // Records a review job (all unreviewed/"check"/blocked drafts, or the given email_ids); the page then
        // POSTs { task: "review", params: { campaign_id, email_ids } } to the ai-background function.
        const { campaign_id, email_ids } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (!(await aiAvailable())) return fail(400, "No AI provider is set up. Add the Gemini key in Settings.");
        const cs = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(cs, campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const ids = Array.isArray(email_ids) ? (email_ids as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
        const todo = await planReview(campaign_id, ids);
        if (todo.length === 0) return fail(400, "No drafts to review.");
        const now = new Date().toISOString();
        await writeJson(cs, campaign_id, { ...campaign, job: { kind: "review", status: "running", total: todo.length, done: 0, started_at: now, progress_at: now }, updated_at: now });
        return ok({ total: todo.length, started_at: now });
      }

      case "outreach.browsercheck.plan": {
        // How many leads a browser check would open and what it would cost (an estimate), shown before anything starts.
        const { campaign_id, lead_id } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        try {
          return ok(await planBrowserCheck(campaign_id, typeof lead_id === "string" ? lead_id : undefined));
        } catch (err) {
          return fail(404, err instanceof Error ? err.message : "campaign not found");
        }
      }

      case "outreach.browsercheck.start": {
        // Records the job; the page then POSTs { task: "browsercheck", params: { campaign_id, lead_ids } } to ai-background.
        const { campaign_id, lead_id } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (!(await readServiceKey("apify"))) return fail(400, "Apify key not configured. Add it in Settings to use the browser check.");
        const cs = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(cs, campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const plan = await planBrowserCheck(campaign_id, typeof lead_id === "string" ? lead_id : undefined);
        if (plan.leads === 0) return fail(400, plan.remaining <= 0 && plan.used > 0 ? `The browser check limit for this campaign (${plan.cap} leads) is reached. You can raise it in Settings.` : "No lead needs a browser check right now.");
        const now = new Date().toISOString();
        await writeJson(cs, campaign_id, { ...campaign, job: { kind: "browsercheck", status: "running", total: plan.leads, done: 0, started_at: now, progress_at: now, message: "Starting the browser…" }, updated_at: now });
        return ok({ ...plan, started_at: now });
      }

      case "outreach.draft.start": {
        // Validates and records a drafting job; the page then POSTs the same parameters to the
        // ai-background function, which does the slow work and writes progress to campaign.job.
        const { campaign_id, framework, leads } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (!(await aiAvailable())) return fail(400, "Gemini key not configured");
        const cs = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(cs, campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const plan = await planDraftPairs(campaign_id, framework, leads);
        if (plan.pairs.length === 0) return fail(400, "Nothing to draft: every eligible lead already has a draft, or all were skipped.");
        const now = new Date().toISOString();
        await writeJson(cs, campaign_id, { ...campaign, job: { kind: "generate", status: "running", total: plan.pairs.length, done: 0, made: 0, started_at: now, progress_at: now }, updated_at: now });
        return ok({ total: plan.pairs.length, started_at: now });
      }

      case "outreach.campaign.create": {
        const { name, query, structured_query, description } = params as Record<string, unknown>;
        if (typeof name !== "string" || !name.trim()) return fail(400, "name required");
        if (typeof query !== "string" || !query.trim()) return fail(400, "query required");
        const id = nanoid(12);
        const now = new Date().toISOString();
        const campaign = {
          id,
          name: name.trim(),
          query: query.trim(),
          description: typeof description === "string" ? description : "",
          structured_query: (structured_query as StructuredQuery) ?? null,
          status: "draft" as const, // draft | searching | ready | sending | completed | failed
          total_leads_found: 0,
          leads_imported: 0,
          emails_generated: 0,
          emails_sent: 0,
          emails_delivered: 0,
          emails_bounced: 0,
          emails_clicked: 0,
          emails_replied: 0,
          created_by: identity?.kind === "agent" ? identity.agent_id : null,
          created_at: now,
          updated_at: now,
        };
        await writeJson(store(OUTREACH_CAMPAIGNS), id, campaign);
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "content",
          summary: `Outreach campaign created: "${campaign.name}"`,
          details: { campaign_id: id, query: campaign.query },
        });
        return ok(campaign);
      }

      case "outreach.campaign.list": {
        const all = await listJsonFast<{ id: string; created_at: string }>(store(OUTREACH_CAMPAIGNS));
        all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return ok(await Promise.all(all.map(async (c) => deriveCampaign(await withLeadCount(c as Record<string, unknown>), await campaignEmails(c.id)))));
      }

      case "outreach.campaign.get": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const record = await readJson(store(OUTREACH_CAMPAIGNS), id);
        if (!record) return fail(404, "campaign not found");
        return ok(deriveCampaign(await withLeadCount(record as Record<string, unknown>), await campaignEmails(id)));
      }

      case "outreach.campaign.update": {
        const { id, ...patch } = params as Record<string, unknown>;
        if (!id || typeof id !== "string") return fail(400, "id required");
        const s = store(OUTREACH_CAMPAIGNS);
        const existing = await readJson<Record<string, unknown>>(s, id);
        if (!existing) return fail(404, "campaign not found");
        const now = new Date().toISOString();
        // A job that starts running is stamped with the SERVER clock, so the UI can
        // count "drafts created since the job started" without clock-skew errors.
        const job = (patch as { job?: { status?: string } | null }).job;
        const resuming = !!job && (job as { resume?: boolean }).resume === true && typeof (existing.job as { started_at?: string } | null | undefined)?.started_at === "string";
        if (job && job.status === "running" && resuming) (patch as { job: Record<string, unknown> }).job.started_at = (existing.job as { started_at: string }).started_at;
        else if (job && job.status === "running") (patch as { job: Record<string, unknown> }).job.started_at = now;
        // A finishing update keeps the ORIGINAL server start time (the browser's copy of it
        // can be stale or from its own clock, which made finished jobs count 0 drafts).
        else if (job) {
          const prevStart = (existing.job as { started_at?: string } | null | undefined)?.started_at;
          if (prevStart) (patch as { job: Record<string, unknown> }).job.started_at = prevStart;
        }
        const updated = { ...existing, ...patch, id, updated_at: now };
        await writeJson(s, id, updated);
        return ok(updated);
      }

      case "outreach.campaign.delete": {
        // Removes the campaign, all its leads and its unsent drafts. Emails that were already sent stay as history.
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const leadsStore = store(OUTREACH_LEADS);
        const emailsStore = store(OUTREACH_EMAILS);
        let leadsDeleted = 0;
        let draftsDeleted = 0;
        let sentKept = 0;
        for (const b of (await leadsStore.list({ prefix: `${id}/` })).blobs) { await leadsStore.delete(b.key); leadsDeleted++; }
        for (const b of (await emailsStore.list({ prefix: `${id}/` })).blobs) {
          const em = await readJson<{ status?: string }>(emailsStore, b.key);
          if (em && em.status !== "drafted") { sentKept++; continue; }
          await emailsStore.delete(b.key);
          draftsDeleted++;
        }
        await store(OUTREACH_CAMPAIGNS).delete(id);
        return ok({ id, deleted: true, leads_deleted: leadsDeleted, drafts_deleted: draftsDeleted, sent_kept: sentKept });
      }

      case "outreach.campaign.run": {
        // Starts the Apify actor asynchronously and returns immediately.
        // Netlify's ~26s function cap means we can't block on a scrape
        // that typically runs 30s–3min. The client polls
        // outreach.campaign.sync to drive the state transition to "ready".
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<Record<string, unknown>>(s, id);
        if (!campaign) return fail(404, "campaign not found");
        const structured = campaign.structured_query as StructuredQuery | null;
        if (!structured) return fail(400, "campaign has no structured_query — run preview first");
        const apifyKey = await readServiceKey("apify");
        if (!apifyKey) return fail(400, "Apify key not configured");

        try {
          const run = await startApifyGoogleMapsRun(
            apifyKey,
            structured.searchTerms,
            structured.location,
            structured.maxResults,
          );
          const updated = {
            ...campaign,
            status: "searching" as const,
            apify_run_id: run.runId,
            apify_dataset_id: run.defaultDatasetId,
            apify_status: run.status,
            error_message: null,
            last_run_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          await writeJson(s, id, updated);
          await logActivity({
            agent_id: identity?.kind === "agent" ? identity.agent_id : null,
            category: "research",
            summary: `Apify run started for "${campaign.name}"`,
            details: { campaign_id: id, apify_run_id: run.runId },
          });
          return ok(updated);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Run start failed";
          await writeJson(s, id, {
            ...campaign,
            status: "failed",
            error_message: message,
            updated_at: new Date().toISOString(),
          });
          return fail(500, message);
        }
      }

      case "outreach.campaign.sync": {
        // Called by the UI on its poll loop while a campaign is "searching".
        // Queries Apify for run status, imports leads when SUCCEEDED, marks
        // failed when ABORTED/FAILED/TIMED-OUT. Safe no-op if the campaign
        // isn't currently running.
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<Record<string, unknown>>(s, id);
        if (!campaign) return fail(404, "campaign not found");
        // Refresh sent-email statuses from AgentMail (throttled to once a minute
        // per campaign) so a missed webhook cannot leave "sent" showing forever.
        let statusRefresh: { checked: number; updated: number } | null = null;
        {
          const last = typeof campaign.last_status_refresh_at === "string" ? Date.parse(campaign.last_status_refresh_at) : 0;
          const amKey = Date.now() - last > 60_000 ? await readServiceKey("agentmail") : null;
          if (amKey) {
            try {
              statusRefresh = await refreshEmailStatuses(amKey, id);
              await writeJson(s, id, { ...campaign, last_status_refresh_at: new Date().toISOString() });
              campaign.last_status_refresh_at = new Date().toISOString();
            } catch {
              // Non-fatal: the scrape sync below must still run.
            }
          }
        }
        if (campaign.status !== "searching" || !campaign.apify_run_id) {
          return ok({ status: campaign.status, apify_status: campaign.apify_status ?? null, changed: false, status_refresh: statusRefresh });
        }
        const apifyKey = await readServiceKey("apify");
        if (!apifyKey) return fail(400, "Apify key not configured");

        try {
          const runStatus = await getApifyRunStatus(apifyKey, campaign.apify_run_id as string);

          // Terminal states → import or mark failed.
          if (runStatus.status === "SUCCEEDED") {
            const datasetId = runStatus.defaultDatasetId ?? (campaign.apify_dataset_id as string | null);
            if (!datasetId) {
              const msg = "Apify succeeded but no dataset id was returned";
              await writeJson(s, id, { ...campaign, status: "failed", error_message: msg, apify_status: runStatus.status, updated_at: new Date().toISOString() });
              return fail(500, msg);
            }
            // Another poll may already be importing (the UI polls every 4s and an
            // import can take longer). A short-lived claim stops a double import.
            const claimedAt = typeof campaign.import_started_at === "string" ? Date.parse(campaign.import_started_at) : 0;
            if (claimedAt && Date.now() - claimedAt < 90_000) {
              return ok({ status: "searching", apify_status: runStatus.status, changed: false });
            }
            await writeJson(s, id, { ...campaign, import_started_at: new Date().toISOString() });

            const structured = campaign.structured_query as StructuredQuery;
            const items = await getApifyDatasetItems(apifyKey, datasetId, structured.maxResults);
            const leadsStore = store(OUTREACH_LEADS);

            // Dedupe: skip any scraped lead whose website domain, email or Google
            // place id already exists in ANY other campaign (do-not-contact leads
            // included — they are simply leads with a flag). Leads already saved
            // in THIS campaign (a retried import) are skipped silently so they are
            // not counted as "already contacted".
            const priorIndex = emptyIndex();
            const ownIndex = emptyIndex();
            const existingRows = await listJson<{ campaign_id?: string; email?: string | null; website?: string | null; raw?: unknown; is_test?: boolean }>(leadsStore);
            for (const row of existingRows) {
              if (row.is_test) continue; // your own test addresses must not block real leads
              addToIndex(row.campaign_id === id ? ownIndex : priorIndex, row);
            }

            let imported = 0;
            let skipped = 0;
            const skippedBy = { place_id: 0, email: 0, website: 0 };
            for (const raw of items) {
              const extracted = extractLeadFromApify(raw);
              // A .gov/.edu address is never a sales contact: keep the lead but drop the address.
              if (isGovEduEmail(extracted.email)) extracted.email = null;
              const candidate = { email: extracted.email, website: extracted.website, raw };
              if (matchesIndex(ownIndex, candidate)) continue; // already imported by an earlier attempt
              const hit = matchesIndex(priorIndex, candidate);
              if (hit) {
                skipped++;
                skippedBy[hit]++;
                continue;
              }
              addToIndex(priorIndex, candidate); // also catches duplicates inside this one scrape
              const leadId = nanoid(10);
              const createdAt = new Date().toISOString();
              await writeJson(leadsStore, `${id}/${createdAt}-${leadId}`, {
                id: leadId,
                campaign_id: id,
                ...extracted,
                raw,
                status: "new",
                is_test: false,
                tags: [],
                created_at: createdAt,
              });
              imported++;
            }
            // Preserve any test leads that were added while scrape was running
            // by adding their count to the imported count.
            const existingLeadsBlobs = await leadsStore.list({ prefix: `${id}/` });
            const totalAfter = existingLeadsBlobs.blobs.length;
            const { import_started_at: _claim, ...campaignRest } = campaign;
            void _claim;
            const updated = {
              ...campaignRest,
              status: "ready" as const,
              apify_status: runStatus.status,
              total_leads_found: items.length,
              leads_skipped_duplicate: skipped,
              leads_skipped_by: skippedBy,
              leads_imported: totalAfter,
              updated_at: new Date().toISOString(),
            };
            await writeJson(s, id, updated);
            await logActivity({
              agent_id: identity?.kind === "agent" ? identity.agent_id : null,
              category: "research",
              summary: `Apify scrape complete for "${campaign.name}": ${items.length} found, ${skipped} skipped as already contacted, ${imported} imported`,
              details: { campaign_id: id, found: items.length, skipped, imported },
            });
            return ok({ status: "ready", apify_status: runStatus.status, found: items.length, skipped, imported, changed: true });
          }

          if (["FAILED", "ABORTED", "TIMED-OUT"].includes(runStatus.status)) {
            const msg = `Apify run ${runStatus.status.toLowerCase()}: ${runStatus.statusMessage ?? "no details"}`;
            const updated = {
              ...campaign,
              status: "failed" as const,
              apify_status: runStatus.status,
              error_message: msg,
              updated_at: new Date().toISOString(),
            };
            await writeJson(s, id, updated);
            return ok({ status: "failed", apify_status: runStatus.status, changed: true });
          }

          // Still running — just surface the current Apify status for the UI.
          if (runStatus.status !== campaign.apify_status) {
            await writeJson(s, id, { ...campaign, apify_status: runStatus.status, updated_at: new Date().toISOString() });
          }
          return ok({ status: "searching", apify_status: runStatus.status, changed: false });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Sync failed";
          return fail(500, message);
        }
      }

      case "outreach.leads.list": {
        const { campaign_id, limit = 500 } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        const rows = await listJson<{ created_at?: string; name?: string; email?: string | null; website?: string | null; address?: string | null; category?: string | null; excluded?: boolean; is_test?: boolean; raw?: unknown }>(
          store(OUTREACH_LEADS),
          `${campaign_id}/`,
        );
        rows.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1));
        // Flag leads we will not email-find / draft for: excluded by you, .gov/.edu,
        // chains, out-of-state, wrong trade, bounced earlier, already contacted from
        // another campaign. Computed here, so older campaigns are covered too.
        const camp = await readJson<CampaignRecord>(store(OUTREACH_CAMPAIGNS), campaign_id);
        const ctx = campaignSkipCtx(camp);
        const contacts = await loadContacts();
        const annotated = rows.map((r0) => {
          const r = withoutJunkEmail(r0);
          const why = leadSkipReason(r, ctx) ?? (r.email ? contactBlock(contacts, r.email, campaign_id, { isTest: (r as { is_test?: boolean }).is_test === true }) : null);
          return why ? { ...r, skip_reason: why.message, skip_code: why.code } : r;
        });
        return ok(annotated.slice(0, typeof limit === "number" ? limit : 500));
      }

      case "outreach.leads.update": {
        // Per-lead things you control (send only the ones you want to change):
        //   excluded (true = never draft this lead), trade_override (true = include although
        //   it looks like a different trade), owner_name (your own entry; "" clears it).
        const { campaign_id, lead_id, excluded, trade_override, owner_name, delete_drafts } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id || typeof lead_id !== "string" || !lead_id) return fail(400, "campaign_id and lead_id required");
        if (excluded !== undefined && typeof excluded !== "boolean") return fail(400, "excluded must be true or false");
        if (trade_override !== undefined && typeof trade_override !== "boolean") return fail(400, "trade_override must be true or false");
        if (owner_name !== undefined && typeof owner_name !== "string") return fail(400, "owner_name must be text");
        if (excluded === undefined && trade_override === undefined && owner_name === undefined) return fail(400, "nothing to update");
        const found = await findLeadRow(campaign_id, lead_id);
        if (!found) return fail(404, "lead not found");
        const now = new Date().toISOString();
        const updated: Record<string, unknown> = { ...found.lead, updated_at: now };
        if (excluded !== undefined) Object.assign(updated, { excluded, excluded_at: excluded ? now : null });
        if (trade_override !== undefined) updated.trade_override = trade_override;
        if (owner_name !== undefined) {
          const n = owner_name.replace(/\s+/g, " ").trim().slice(0, 80);
          if (!n) {
            Object.assign(updated, { owner_name: null, owner_confidence: null, owner_source: null, owner_source_url: null, contact_name: null });
          } else {
            // A name you type is trusted: it is used in greetings and never overwritten by a re-check.
            Object.assign(updated, { owner_name: n, owner_confidence: "high", owner_source: "manual", owner_source_url: null, contact_name: n });
          }
        }
        await writeJson(store(OUTREACH_LEADS), found.key, updated);
        // Skipping a lead can also remove its unsent drafts (sent emails stay as history).
        let draftsDeleted = 0;
        if (excluded === true && delete_drafts === true) {
          const es = store(OUTREACH_EMAILS);
          const { blobs } = await es.list({ prefix: `${campaign_id}/` });
          for (const eb of blobs) {
            const em = await readJson<{ lead_id?: string; status?: string }>(es, eb.key);
            if (em?.lead_id === lead_id && em.status === "drafted") { await es.delete(eb.key); draftsDeleted++; }
          }
        }
        return ok({ ...updated, drafts_deleted: draftsDeleted });
      }

      case "outreach.prospects.list": {
        // Every lead across all campaigns in one slim list (no raw Apify blob), for the Prospects page.
        const [leads, emails, campaigns] = await Promise.all([
          listJsonFast<Record<string, unknown>>(store(OUTREACH_LEADS)),
          listJsonFast<{ lead_id?: string; status?: string; sent_at?: string; created_at?: string; review_status?: string }>(store(OUTREACH_EMAILS)),
          listJsonFast<{ id: string; name?: string; query?: string }>(store(OUTREACH_CAMPAIGNS)),
        ]);
        const campName = new Map(campaigns.map((c) => [c.id, c.name ?? c.query ?? c.id]));
        // Per lead: strongest email state and when we last emailed it.
        const byLead = new Map<string, { replied: boolean; bounced: boolean; sent: boolean; sent_at: string | null; review: string | null; review_at: string }>();
        for (const e of emails) {
          if (!e.lead_id) continue;
          const cur = byLead.get(e.lead_id) ?? { replied: false, bounced: false, sent: false, sent_at: null, review: null, review_at: "" };
          const st = e.status ?? "drafted";
          // The review status of the lead's newest unsent draft (older drafts without one count as "check").
          if (st === "drafted" && (e.created_at ?? "") >= cur.review_at) { cur.review = e.review_status === "ready" || e.review_status === "blocked" ? e.review_status : "check"; cur.review_at = e.created_at ?? ""; }
          if (st === "replied") cur.replied = true;
          if (["bounced", "complained", "failed"].includes(st)) cur.bounced = true;
          if (st !== "drafted") {
            cur.sent = true;
            const at = e.sent_at ?? e.created_at ?? null;
            if (at && (!cur.sent_at || at > cur.sent_at)) cur.sent_at = at;
          }
          byLead.set(e.lead_id, cur);
        }
        const rows = leads.map((l) => {
          const em = byLead.get(l.id as string);
          const contactedAt = (l.contacted_at as string | undefined) ?? null;
          const email_status = l.do_not_contact ? "do_not_contact" : em?.bounced ? "bounced" : em?.replied ? "replied" : em?.sent || contactedAt ? "emailed" : "not_emailed";
          const h = hoursInfo(l.raw);
          const social = (l.social as Record<string, string | null> | undefined) ?? {};
          const sc = (l.site_check as Record<string, unknown> | undefined) ?? {};
          return {
            id: l.id, campaign_id: l.campaign_id ?? null, campaign_name: campName.get(l.campaign_id as string) ?? null,
            name: l.name, category: l.category ?? null, address: l.address ?? null, email: l.email && !isJunkEmail(l.email as string) ? l.email : null,
            phone: l.phone ?? null, website: l.website ?? null, maps_url: l.maps_url ?? null, rating: l.rating ?? null, reviews_count: l.reviews_count ?? null,
            is_test: l.is_test === true, created_at: l.created_at ?? null,
            owner_name: l.owner_name ?? null, owner_confidence: l.owner_confidence ?? null, owner_source: l.owner_source ?? null, owner_source_url: l.owner_source_url ?? null,
            gap_score: typeof l.gap_score === "number" ? l.gap_score : null, gap_reasons: Array.isArray(l.gap_reasons) ? l.gap_reasons : [],
            checked_at: (sc.checked_at as string | undefined) ?? null, site_error: (sc.error as string | undefined) ?? null,
            site_check: l.site_check ?? null, social, hours_summary: h?.summary ?? null,
            email_status, emailed_at: em?.sent_at ?? contactedAt,
            review_status: em?.review ?? null,
            owner_evidence: l.owner_evidence ?? null,
          };
        });
        rows.sort((a, b) => (b.gap_score ?? -1) - (a.gap_score ?? -1) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
        return ok(rows);
      }

      case "outreach.leads.count": {
        const { campaign_id } = params as Record<string, string>;
        if (!campaign_id) return fail(400, "campaign_id required");
        const { blobs } = await store(OUTREACH_LEADS).list({ prefix: `${campaign_id}/` });
        return ok({ count: blobs.length });
      }

      case "outreach.leads.add_test": {
        // Self-seed a test lead so the attendee can demo the full send-→-reply
        // loop using their own email. Shows as 🧪 TEST in the UI.
        const { campaign_id, name, email, notes } = params as Record<string, string>;
        if (!campaign_id) return fail(400, "campaign_id required");
        if (!email) return fail(400, "email required");
        const campaign = await readJson<Record<string, unknown>>(store(OUTREACH_CAMPAIGNS), campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const leadId = nanoid(10);
        const createdAt = new Date().toISOString();
        const lead = {
          id: leadId,
          campaign_id,
          name: name || email.split("@")[0],
          email,
          phone: null,
          website: null,
          address: null,
          category: null,
          rating: null,
          reviews_count: null,
          maps_url: null,
          raw: { source: "test_lead" },
          notes: notes ?? null,
          status: "new",
          is_test: true,
          tags: ["test"],
          created_at: createdAt,
        };
        await writeJson(store(OUTREACH_LEADS), `${campaign_id}/${createdAt}-${leadId}`, lead);
        const updated = {
          ...campaign,
          leads_imported: (campaign.leads_imported as number ?? 0) + 1,
          updated_at: new Date().toISOString(),
        };
        await writeJson(store(OUTREACH_CAMPAIGNS), campaign_id, updated);
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "system",
          summary: `Test lead added to campaign "${campaign.name}": ${email}`,
          details: { campaign_id, lead_id: leadId },
        });
        return ok(lead);
      }

      case "outreach.leads.delete": {
        const { campaign_id, lead_id } = params as Record<string, string>;
        if (!campaign_id || !lead_id) return fail(400, "campaign_id and lead_id required");
        const leadsStore = store(OUTREACH_LEADS);
        const { blobs } = await leadsStore.list({ prefix: `${campaign_id}/` });
        for (const b of blobs) {
          const lead = await readJson<{ id: string }>(leadsStore, b.key);
          if (lead?.id === lead_id) {
            await leadsStore.delete(b.key);
            // A deleted lead must not leave drafts behind (they would still be
            // sent, possibly to a malformed address). Sent/delivered/replied
            // emails stay as history.
            const es = store(OUTREACH_EMAILS);
            let draftsDeleted = 0;
            const { blobs: emailBlobs } = await es.list({ prefix: `${campaign_id}/` });
            for (const eb of emailBlobs) {
              const em = await readJson<{ lead_id?: string; status?: string }>(es, eb.key);
              if (em?.lead_id === lead_id && em.status === "drafted") {
                await es.delete(eb.key);
                draftsDeleted++;
              }
            }
            if (draftsDeleted > 0) {
              const cs = store(OUTREACH_CAMPAIGNS);
              const camp = await readJson<Record<string, unknown>>(cs, campaign_id);
              if (camp) {
                await writeJson(cs, campaign_id, {
                  ...camp,
                  emails_generated: Math.max(0, ((camp.emails_generated as number) ?? 0) - draftsDeleted),
                  updated_at: new Date().toISOString(),
                });
              }
            }
            return ok({ deleted: true, drafts_deleted: draftsDeleted });
          }
        }
        return fail(404, "lead not found");
      }

      case "outreach.leads.enrich_one":
      case "outreach.leads.check_site": {
        // enrich_one: the "Find emails" pass. One website check per lead (homepage, contact and
        // About pages): finds an email when the lead has none, and records chat/booking signals,
        // social links, the owner's name and the gap score. Runs one lead at a time so the UI can
        // loop with progress and stay under Netlify's 26 s cap.
        // check_site: the same pass, information only, for any lead (also already emailed ones).
        // It never drafts or sends and never touches do-not-contact / contacted / bounced flags.
        const { campaign_id, lead_id } = params as Record<string, string>;
        if (!campaign_id || !lead_id) return fail(400, "campaign_id and lead_id required");
        const infoOnly = action === "outreach.leads.check_site";
        const leadsStore = store(OUTREACH_LEADS);
        const found = await findLeadRow(campaign_id, lead_id);
        if (!found) return fail(404, "lead not found");
        const storeKey = found.key;
        let lead = found.lead;
        const hadEmail = !!lead.email && !isJunkEmail(lead.email as string);
        if (!infoOnly && hadEmail && (lead.site_check as { checked_at?: string } | undefined)?.checked_at) return ok({ ...lead, already_had_email: true, enriched: false });
        // A placeholder address (johndoe@email.com ...) counts as no email: drop it and look again.
        if (lead.email && !hadEmail) lead = { ...lead, email: null, junk_email: lead.email };
        // Mark every attempt so a progress counter can survive a page reload.
        const checkedAt = new Date().toISOString();
        const skip = leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], campaignSkipCtx(await readJson<CampaignRecord>(store(OUTREACH_CAMPAIGNS), campaign_id)));
        // Chains and other-state leads are not worth a website visit (the exclude tick and trade skips still look).
        if (skip && (skip.code === "chain" || skip.code === "out_of_state")) {
          await writeJson(leadsStore, storeKey, { ...lead, enrich_checked_at: checkedAt, site_check: { checked_at: checkedAt, error: skip.message } });
          return ok({ ...lead, enriched: false, reason: skip.message });
        }
        if (!lead.website) {
          const noSite = { ...lead, enrich_checked_at: checkedAt, ...noWebsiteFields(lead, checkedAt) };
          await writeJson(leadsStore, storeKey, noSite);
          return ok({ ...noSite, enriched: false, reason: "no website to scrape" });
        }
        try {
          const res = await checkLeadSite(lead);
          // Re-read the lead right before writing: a check takes seconds, and a reply, a
          // do-not-contact flag or an edit made meanwhile must not be overwritten.
          const fresh = (await findLeadRow(campaign_id, lead_id))?.lead ?? lead;
          const updated: Record<string, unknown> = { ...fresh, ...(lead.junk_email && !lead.email ? { email: null, junk_email: lead.junk_email } : {}), ...res.fields, enrich_checked_at: checkedAt, updated_at: new Date().toISOString() };
          let enriched = false;
          const skipEmail = !!skip && skip.code === "gov_edu_email";
          if (!hadEmail && !skipEmail) {
            const email = pickBestEmail(res.emails);
            if (email) {
              Object.assign(updated, { email, enriched_at: new Date().toISOString(), enrichment_source: "website_scrape" });
              enriched = true;
            }
          }
          await writeJson(leadsStore, storeKey, updated);
          return ok({ ...updated, enriched, tried: res.tried, reason: enriched || hadEmail ? undefined : res.fetched === 0 ? "website did not load" : "no email found on website" });
        } catch (err) {
          return fail(500, err instanceof Error ? err.message : "Website check failed");
        }
      }

      case "outreach.emails.generate_one": {
        // Drafts exactly one email for one lead at one sequence step (see draftOne).
        // Kept for agents that loop with their own pacing. The app itself drafts in
        // the background (outreach.draft.start + the ai-background function).
        const { campaign_id, lead_id, sender_name, sender_company, sender_offer, framework, step, total_steps, lead: leadHint } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (typeof lead_id !== "string" || !lead_id) return fail(400, "lead_id required");
        const r = await draftOne({ campaign_id, lead_id, sender_name, sender_company, sender_offer, framework, step, total_steps, leadHint });
        if (r.ok) return ok(r.data);
        return r.code ? failCode(r.status, r.error, r.code, r.retry_after ? { retry_after: r.retry_after } : {}) : fail(r.status, r.error);
      }

      case "outreach.emails.create": {
        // Agent-authored draft — skips Gemini entirely. The calling agent
        // (Claude Code, OpenClaw, Hermes, whatever) writes its own subject
        // and body, we just persist it as a drafted email. Same downstream
        // pipeline as Gemini drafts — link tracking on send, webhook status
        // updates, reply correlation all work identically.
        const {
          campaign_id,
          lead_id,
          subject,
          body_text,
          body_html,
          sender_name,
          sequence_position,
          sequence_total,
          framework,
        } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (typeof lead_id !== "string" || !lead_id) return fail(400, "lead_id required");
        if (typeof subject !== "string" || !subject.trim()) return fail(400, "subject required");
        if (typeof body_text !== "string" || !body_text.trim()) return fail(400, "body_text required");

        const cs = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<Record<string, unknown>>(cs, campaign_id);
        if (!campaign) return fail(404, "campaign not found");

        // Verify the lead exists + has an email.
        const leadsStore = store(OUTREACH_LEADS);
        const { blobs } = await leadsStore.list({ prefix: `${campaign_id}/` });
        let lead: Record<string, unknown> | null = null;
        for (const b of blobs) {
          const row = await readJson<Record<string, unknown>>(leadsStore, b.key);
          if ((row as { id?: string } | null)?.id === lead_id) {
            lead = row;
            break;
          }
        }
        if (!lead) return fail(404, "lead not found");
        if (!lead.email) return fail(400, "lead has no email address");

        const stepNum = typeof sequence_position === "number" && sequence_position >= 1 ? Math.floor(sequence_position) : 1;
        const totalNum = typeof sequence_total === "number" && sequence_total >= 1 ? Math.floor(sequence_total) : stepNum;
        const fw = typeof framework === "string" && ["pas", "aida", "sdr", "one-off"].includes(framework) ? framework : "one-off";

        // Dedupe on (lead, step) — same rule as generate_one.
        const es = store(OUTREACH_EMAILS);
        const existingEmails = await listJson<{ id: string; lead_id: string; sequence_position?: number }>(
          es,
          `${campaign_id}/`,
        );
        const existing = existingEmails.find(
          (e) => e.lead_id === lead_id && (e.sequence_position ?? 1) === stepNum,
        );
        if (existing) return ok({ ...existing, skipped: true });

        const emailId = nanoid(12);
        const createdAt = new Date().toISOString();
        const record = {
          id: emailId,
          campaign_id,
          lead_id,
          to_email: lead.email,
          to_name: lead.name,
          subject: subject.trim(),
          body_text: body_text.trim(),
          body_html: typeof body_html === "string" && body_html.trim() ? body_html : `<p>${body_text.replace(/\n/g, "</p><p>")}</p>`,
          sender_name: typeof sender_name === "string" ? sender_name : null,
          sequence_position: stepNum,
          sequence_total: totalNum,
          framework: fw,
          source: "agent_drafted",
          status: "drafted",
          created_at: createdAt,
          updated_at: createdAt,
        };
        await writeJson(es, `${campaign_id}/${createdAt}-${emailId}`, record);
        await writeJson(cs, campaign_id, {
          ...campaign,
          default_sender_name: (typeof sender_name === "string" && sender_name) || (campaign.default_sender_name as string | undefined) || null,
          default_framework: fw,
          default_sequence_total: totalNum,
          emails_generated: (campaign.emails_generated as number ?? 0) + 1,
          updated_at: new Date().toISOString(),
        });
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "content",
          summary: `Agent drafted email (${fw} step ${stepNum}/${totalNum}) for ${lead.name}`,
          details: { campaign_id, lead_id, email_id: emailId, framework: fw, step: stepNum },
        });
        return ok(record);
      }

      case "outreach.emails.generate": {
        // Gemini drafts a per-lead email. We write one email record per
        // lead under OUTREACH_EMAILS and bump the campaign's emails_generated.
        const { campaign_id, sender_name, sender_company, sender_offer } = params as Record<string, string>;
        if (!campaign_id) return fail(400, "campaign_id required");
        const geminiKey = await readServiceKey("gemini");
        if (!geminiKey) return fail(400, "Gemini key not configured");
        const cs = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<Record<string, unknown>>(cs, campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const leads = await listJson<{ id: string; name: string; email: string | null; company?: string; website?: string; category?: string; address?: string; notes?: string; is_test?: boolean; do_not_contact?: boolean }>(
          store(OUTREACH_LEADS),
          `${campaign_id}/`,
        );
        const ctx = campaignSkipCtx(campaign as CampaignRecord);
        const contactsIdx = await loadContacts();
        const es = store(OUTREACH_EMAILS);
        const already = new Set((await listJson<{ lead_id: string }>(es, `${campaign_id}/`)).map((e) => e.lead_id));
        const sendable = leads.filter((l) => l.email && !l.do_not_contact && !leadSkipReason(l, ctx) && !contactBlock(contactsIdx, l.email, campaign_id, { isTest: l.is_test === true }) && !already.has(l.id));
        if (sendable.length === 0) return fail(400, "No leads with email addresses that still need a draft");

        // Paced: one lead at a time with a gap (the free tier allows 15 requests a
        // minute), inside a time budget (Netlify's function cap). Whatever does not
        // fit is reported as `remaining` so the caller can call again.
        const PACE_MS = 4500;
        const deadline = Date.now() + 18_000;
        let generated = 0;
        let stopped: { code: string; message: string } | null = null;
        const errors: Array<{ lead_id: string; error: string }> = [];
        let remaining = 0;
        for (let i = 0; i < sendable.length; i++) {
          const lead = sendable[i];
          if (Date.now() + PACE_MS + 8000 > deadline) { remaining = sendable.length - i; break; }
          if (i > 0) await new Promise((r) => setTimeout(r, PACE_MS));
          try {
            const draft = await generateEmailDraft(
              geminiKey,
              {
                name: lead.name,
                company: lead.company,
                website: lead.website,
                category: lead.category,
                address: lead.address,
                notes: lead.notes,
                is_test: lead.is_test === true,
                contact_name: (lead as { contact_name?: string }).contact_name,
              },
              {
                sender_name,
                sender_company,
                sender_offer,
                campaign_query: campaign.query as string,
              },
            );
            const emailId = nanoid(12);
            const createdAt = new Date().toISOString();
            await writeJson(es, `${campaign_id}/${createdAt}-${emailId}`, {
              id: emailId,
              campaign_id,
              lead_id: lead.id,
              to_email: lead.email,
              to_name: lead.name,
              subject: draft.subject,
              body_text: draft.body_text,
              body_html: draft.body_html,
              status: "drafted", // drafted | sent | delivered | bounced | clicked | replied | failed
              review_status: "check",
              review_reasons: ["Not reviewed yet"],
              created_at: createdAt,
              updated_at: createdAt,
            });
            generated++;
          } catch (err) {
            if (err instanceof GeminiError && err.kind === "daily_quota") {
              stopped = { code: err.kind, message: err.message };
              remaining = sendable.length - i;
              break;
            }
            errors.push({ lead_id: lead.id, error: err instanceof Error ? err.message : "unknown" });
          }
        }

        const updated = {
          ...campaign,
          emails_generated: (campaign.emails_generated as number ?? 0) + generated,
          updated_at: new Date().toISOString(),
        };
        await writeJson(cs, campaign_id, updated);
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "content",
          summary: `Drafted ${generated} emails for "${campaign.name}"`,
          details: { campaign_id, generated, errors: errors.length },
        });
        return ok({ generated, errors, remaining, stopped });
      }

      case "outreach.emails.list": {
        const { campaign_id, limit = 500 } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string") return fail(400, "campaign_id required");
        const rows = await listJson<{ created_at?: string; status?: string; lead_id?: string; to_email?: string }>(store(OUTREACH_EMAILS), `${campaign_id}/`);
        rows.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1));
        // Flag drafts that will never be sent because the recipient said no
        // (any lead, in any campaign, with that email or lead id is do-not-contact).
        const dncLeads = (await listJson<{ id: string; email?: string | null; do_not_contact?: boolean }>(store(OUTREACH_LEADS))).filter((l) => l.do_not_contact);
        const dncIds = new Set(dncLeads.map((l) => l.id));
        const dncMail = new Set(dncLeads.map((l) => emailKey(l.email)).filter((e): e is string => !!e));
        const campLeads = await listJson<{ id: string; excluded?: boolean; is_test?: boolean }>(store(OUTREACH_LEADS), `${campaign_id}/`);
        const skippedLeadIds = new Set(campLeads.filter((l) => l.excluded).map((l) => l.id));
        const testLeadIds = new Set(campLeads.filter((l) => l.is_test).map((l) => l.id));
        const contactsIdx = await loadContacts();
        const annotated = rows.map((r0) => {
          // Drafts from before the reviewer existed count as "check" (not reviewed yet).
          const rv = r0 as { review_status?: string; review_reasons?: string[] };
          const r = r0.status === "drafted" && !rv.review_status ? { ...r0, review_status: "check", review_reasons: ["Not reviewed yet"] } : r0;
          if (r.status !== "drafted") return r;
          if (r.lead_id && skippedLeadIds.has(r.lead_id)) return { ...r, blocked_lead_skipped: true };
          if ((r.lead_id && dncIds.has(r.lead_id)) || dncMail.has(emailKey(r.to_email) ?? "")) return { ...r, blocked_do_not_contact: true };
          const block = contactBlock(contactsIdx, r.to_email, campaign_id, { isTest: !!r.lead_id && testLeadIds.has(r.lead_id) });
          return block ? { ...r, blocked_contact: block.message.replace(/^Skipped: /, "") } : r;
        });
        return ok(annotated.slice(0, typeof limit === "number" ? limit : 500));
      }

      case "outreach.emails.update": {
        // Lets the UI tweak a drafted email (subject/body) before send. Only
        // drafts are editable — a sent email is a record of what went out.
        const { campaign_id, email_id, subject, body_text, body_html, to_email, review_status } = params as Record<string, string>;
        if (!campaign_id || !email_id) return fail(400, "campaign_id and email_id required");
        if (review_status !== undefined && review_status !== "ready") return fail(400, 'review_status can only be set to "ready" by hand');
        const newTo = to_email === undefined ? undefined : cleanEmail(to_email);
        if (to_email !== undefined && (!newTo || isJunkEmail(newTo))) return fail(400, "that is not a valid email address");
        if (subject !== undefined && !String(subject).trim()) return fail(400, "subject cannot be empty");
        if (body_text !== undefined && !String(body_text).trim()) return fail(400, "body cannot be empty");
        const es = store(OUTREACH_EMAILS);
        const { blobs } = await es.list({ prefix: `${campaign_id}/` });
        for (const b of blobs) {
          const row = await readJson<Record<string, unknown>>(es, b.key);
          if (row?.id === email_id) {
            if (row.status !== "drafted") return fail(400, `only drafted emails can be edited (this one is ${String(row.status)})`);
            // If the plain-text body changed and no explicit html came with it,
            // rebuild the html from the text — send uses html when present, so a
            // stale html body would silently send the OLD text.
            const nextHtml = body_html ? body_html : body_text ? textToHtml(body_text) : undefined;
            const updated = {
              ...row,
              ...(subject ? { subject: String(subject).trim() } : {}),
              ...(newTo && newTo !== row.to_email ? { to_email: newTo, original_to_email: (row.original_to_email as string | undefined) ?? row.to_email } : {}),
              ...(body_text ? { body_text } : {}),
              ...(nextHtml ? { body_html: nextHtml } : {}),
              edited: true,
              updated_at: new Date().toISOString(),
            };
            const changed = !!(subject || body_text || body_html || (newTo && newTo !== row.to_email));
            if (changed) Object.assign(updated, { review_status: "check", review_reasons: ["You edited this draft. Review it again, or mark it ready yourself."], reviewed_by: null, reviewed_at: null });
            if (review_status === "ready") {
              if (!changed && row.review_status === "blocked") return fail(400, "This draft is blocked. Fix it or use Review again first.");
              Object.assign(updated, { review_status: "ready", review_reasons: ["Marked ready by you."], reviewed_by: "you", reviewed_at: new Date().toISOString() });
            }
            await writeJson(es, b.key, updated);
            return ok(updated);
          }
        }
        return fail(404, "email not found");
      }

      case "outreach.emails.delete": {
        // Deletes one drafted email. Sent emails are kept as history.
        const { campaign_id, email_id } = params as Record<string, string>;
        if (!campaign_id || !email_id) return fail(400, "campaign_id and email_id required");
        const es = store(OUTREACH_EMAILS);
        const { blobs } = await es.list({ prefix: `${campaign_id}/` });
        for (const b of blobs) {
          const row = await readJson<Record<string, unknown>>(es, b.key);
          if (row?.id === email_id) {
            if (row.status !== "drafted") return fail(400, `only drafted emails can be deleted (this one is ${String(row.status)})`);
            await es.delete(b.key);
            const cs = store(OUTREACH_CAMPAIGNS);
            const camp = await readJson<Record<string, unknown>>(cs, campaign_id);
            if (camp) {
              await writeJson(cs, campaign_id, {
                ...camp,
                emails_generated: Math.max(0, ((camp.emails_generated as number) ?? 0) - 1),
                updated_at: new Date().toISOString(),
              });
            }
            return ok({ deleted: true });
          }
        }
        return fail(404, "email not found");
      }

      case "outreach.footer.preview": {
        // Exactly what send will append to a draft (sign-off + opt-out line),
        // computed by the same function the sender uses — so the UI preview
        // can't drift from the real email.
        const { campaign_id, email_id } = params as Record<string, string>;
        if (!campaign_id || !email_id) return fail(400, "campaign_id and email_id required");
        const campaign = await readJson<Record<string, unknown>>(store(OUTREACH_CAMPAIGNS), campaign_id);
        const es = store(OUTREACH_EMAILS);
        const { blobs } = await es.list({ prefix: `${campaign_id}/` });
        for (const b of blobs) {
          const row = await readJson<{ id: string; body_text?: string; sender_name?: string | null }>(es, b.key);
          if (row?.id !== email_id) continue;
          const settings = await readJson<{ postal_address?: string }>(store(OUTREACH_SETTINGS), "settings");
          const body = row.body_text ?? "";
          const full = appendFooter(body, "", settings?.postal_address ?? "", row.sender_name || (campaign?.default_sender_name as string | undefined) || "");
          return ok({ footer_text: full.text.slice(body.trimEnd().length).trim() });
        }
        return fail(404, "email not found");
      }

      // ── OUTREACH SETTINGS (footer postal address) ─────────────────
      case "outreach.settings.get": {
        return ok(await settingsView(await readOutreachSettings()));
      }

      case "outreach.inboxes.list": {
        // AgentMail inboxes for the Settings dropdown, plus which inboxes the reply webhook covers.
        const agentmailKey = await readServiceKey("agentmail");
        if (!agentmailKey) return fail(400, "AgentMail key not configured");
        const inboxes: AgentMailInbox[] = [];
        let pageToken: string | undefined;
        for (let i = 0; i < 5; i++) {
          const r = await agentmailFetch(agentmailKey, `/inboxes?limit=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`);
          if (!r.ok) return fail(502, `AgentMail inbox list failed (${r.status})`);
          const body = (await r.json()) as { inboxes?: AgentMailInbox[]; next_page_token?: string };
          inboxes.push(...(body.inboxes ?? []));
          pageToken = body.next_page_token;
          if (!pageToken) break;
        }
        // Best effort: are replies on every inbox delivered to this app? (null = could not tell)
        let webhooks: Array<{ url: string; enabled: boolean; events: string[]; inbox_ids: string[] | null }> | null = null;
        try {
          const w = await agentmailFetch(agentmailKey, "/webhooks");
          if (w.ok) {
            const wb = (await w.json()) as { webhooks?: Array<{ url?: string; enabled?: boolean; event_types?: string[]; inbox_ids?: string[]; inbox_id?: string }> };
            webhooks = (wb.webhooks ?? []).map((h) => ({
              url: h.url ?? "",
              enabled: h.enabled !== false,
              events: h.event_types ?? [],
              inbox_ids: h.inbox_ids && h.inbox_ids.length > 0 ? h.inbox_ids : h.inbox_id ? [h.inbox_id] : null,
            }));
          }
        } catch { /* informational only */ }
        const rec = await readOutreachSettings();
        return ok({ inboxes: inboxes.map((i) => ({ inbox_id: i.inbox_id, email: i.email ?? i.inbox_id, display_name: i.display_name ?? "" })), selected: rec.sending_inbox_id ?? "", webhooks });
      }
      case "outreach.settings.set": {
        // Partial update: only the fields that are present are changed.
        const p = params as Record<string, unknown>;
        const current = await readOutreachSettings();
        const next: OutreachSettings = { ...current };
        const text = (k: string, max: number): string | undefined | null => {
          if (p[k] === undefined) return undefined;
          if (typeof p[k] !== "string") return null;
          return (p[k] as string).trim().slice(0, max);
        };
        for (const [k, max] of [["postal_address", 300], ["default_sender_name", 120], ["default_sender_company", 120], ["default_sender_offer", 600]] as const) {
          const v = text(k, max);
          if (v === null) return fail(400, `${k} must be a string`);
          if (v !== undefined) next[k] = v;
        }
        const alertEmail = text("reply_alert_email", 200);
        if (alertEmail === null) return fail(400, "reply_alert_email must be text");
        if (alertEmail !== undefined) {
          if (alertEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(alertEmail)) return fail(400, "That does not look like an email address.");
          next.reply_alert_email = alertEmail.toLowerCase();
        }
        const inboxId = text("sending_inbox_id", 200);
        if (inboxId === null) return fail(400, "sending_inbox_id must be text");
        if (inboxId !== undefined && inboxId !== (current.sending_inbox_id ?? "")) {
          if (inboxId) {
            const amKey = await readServiceKey("agentmail");
            if (!amKey) return fail(400, "AgentMail key not configured");
            const chk = await agentmailFetch(amKey, `/inboxes/${encodeURIComponent(inboxId)}`);
            if (!chk.ok) return fail(400, `AgentMail does not know an inbox called "${inboxId}" (${chk.status}).`);
          }
          next.sending_inbox_id = inboxId;
        }
        if (p.browser_check_cap !== undefined) {
          const n = Number(p.browser_check_cap);
          if (!Number.isInteger(n) || n < 1 || n > 200) return fail(400, "browser_check_cap must be a whole number from 1 to 200");
          next.browser_check_cap = n;
        }
        // Second AI provider details (the key itself is saved with config.set, service "ai2").
        const sBase = text("second_ai_base_url", 200);
        const sModel = text("second_ai_model", 100);
        if (sBase === null || sModel === null) return fail(400, "second_ai_base_url and second_ai_model must be text");
        if (sBase !== undefined) {
          if (sBase && !/^https?:\/\/[^\s]+$/i.test(sBase)) return fail(400, "The second provider address must start with https://");
          next.second_ai_base_url = sBase;
        }
        if (sModel !== undefined) next.second_ai_model = sModel;
        // Which provider each role uses.
        for (const role of ["draft", "review", "helper"] as const) {
          const k = `${role}_provider` as const;
          if (p[k] === undefined) continue;
          if (p[k] !== "gemini" && p[k] !== "second") return fail(400, `${k} must be "gemini" or "second"`);
          if (p[k] === "second" && !(await readServiceKey("ai2"))) return fail(400, "Add the second AI provider's key first.");
          next[k] = p[k] as "gemini" | "second";
        }
        // Models: each is proven with a real call before it is saved (a bad name fails here, not mid-campaign).
        const gkey = await readServiceKey("gemini");
        const skey = await readServiceKey("ai2");
        const modelKeys: Array<["draft_model" | "review_model" | "helper_model", "draft" | "review" | "helper"]> = [["draft_model", "draft"], ["review_model", "review"], ["helper_model", "helper"]];
        // The old single "gemini_model" field now sets the Drafting model.
        if (p.gemini_model !== undefined && p.draft_model === undefined) p.draft_model = p.gemini_model;
        // The tests run side by side (one slow model must not eat the others' time: functions stop at ~26 s).
        // A model that fails its test is NOT saved, but every other change still is, and the answer says which failed.
        const todo: Array<{ field: "draft_model" | "review_model" | "helper_model"; v: string; test: Promise<{ ok: boolean; message: string }> | null }> = [];
        for (const [field, role] of modelKeys) {
          const v = text(field, 80);
          if (v === null) return fail(400, `${field} must be a string`);
          if (v === undefined || v === (current[field] ?? "")) continue;
          const usesSecond = next[`${role}_provider` as const] === "second";
          const chosen = v || (role === "review" ? DEFAULT_REVIEW_MODEL : DEFAULT_GEMINI_MODEL);
          let test: Promise<{ ok: boolean; message: string }> | null = null;
          if (usesSecond) {
            // With the second provider the model name is the second provider's model.
            if (skey && v) test = testServiceKey("ai2", skey, chosen, { base_url: next.second_ai_base_url });
          } else if (gkey) {
            test = testServiceKey("gemini", gkey, chosen);
          }
          todo.push({ field, v, test });
        }
        const modelErrors: Array<{ field: string; model: string; message: string }> = [];
        const results = await Promise.all(todo.map((t) => t.test ?? Promise.resolve({ ok: true, message: "" })));
        todo.forEach((t, i) => {
          if (!results[i].ok) { modelErrors.push({ field: t.field, model: t.v, message: results[i].message }); return; }
          next[t.field] = t.v;
          if (t.field === "draft_model") next.gemini_model = t.v; // keep the legacy field in step
        });
        next.updated_at = new Date().toISOString();
        await writeJson(store(OUTREACH_SETTINGS), "settings", next);
        return ok({ ...(await settingsView(next)), model_errors: modelErrors });
      }

      case "outreach.emails.send": {
        // Sends drafted emails via AgentMail. Rewrites outbound links
        // through the /t/:token tracker first, records AgentMail's
        // message_id + thread_id for later webhook correlation.
        //
        // Filtering:
        //   - email_ids: explicit list wins. Sends exactly those.
        //   - sequence_position: sends all drafts at that step only.
        //     For step 2+, automatically skips leads that already replied
        //     to an earlier step (don't nag people who said yes).
        //   - neither: sends all drafted emails in the campaign (legacy).
        //
        // Batching: `limit` (positive int) caps how many go out in this call,
        // oldest draft first; the rest stay "drafted" (queued) for a later send.
        //
        // Every outgoing email gets the opt-out + signature footer appended
        // here (not by Gemini). Leads flagged do-not-contact are never sent to.
        const { campaign_id, email_ids, sequence_position, limit, allow_check } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        const agentmailKey = await readServiceKey("agentmail");
        if (!agentmailKey) return fail(400, "AgentMail key not configured");
        const cs = store(OUTREACH_CAMPAIGNS);
        const campaign = await readJson<Record<string, unknown>>(cs, campaign_id);
        if (!campaign) return fail(404, "campaign not found");

        // Deployment URL lets the click-tracker links resolve back to us.
        const baseUrl = event.headers["x-forwarded-proto"] && event.headers["x-forwarded-host"]
          ? `${event.headers["x-forwarded-proto"]}://${event.headers["x-forwarded-host"]}`
          : (process.env.URL ?? "");

        // ── Decide what to send BEFORE touching AgentMail or campaign status ──
        const es = store(OUTREACH_EMAILS);
        const allEmails = await listJson<{ id: string; campaign_id: string; lead_id: string; to_email: string; subject: string; body_text: string; body_html: string; status: string; sender_name?: string | null; sequence_position?: number; created_at?: string; review_status?: string }>(
          es,
          `${campaign_id}/`,
        );
        const selectedIds = Array.isArray(email_ids) ? new Set(email_ids as string[]) : null;
        const targetStep = typeof sequence_position === "number" && sequence_position >= 1 ? Math.floor(sequence_position) : null;
        const batchLimit = typeof limit === "number" && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : null;

        // Leads that already replied (at any step) — skip for sequence follow-ups.
        const repliedLeadIds = new Set(
          allEmails.filter((e) => e.status === "replied").map((e) => e.lead_id),
        );

        // Do-not-contact: any lead (in any campaign) flagged by an opt-out reply.
        const allLeads = await listJson<{ id: string; email?: string | null; do_not_contact?: boolean; excluded?: boolean; is_test?: boolean }>(store(OUTREACH_LEADS));
        // A lead you skipped ("Skip this lead") never gets an email, even if a draft already exists.
        const excludedLeadIds = new Set(allLeads.filter((l) => l.excluded).map((l) => l.id));
        const dncLeadIds = new Set(allLeads.filter((l) => l.do_not_contact).map((l) => l.id));
        const dncEmails = new Set(allLeads.filter((l) => l.do_not_contact).map((l) => emailKey(l.email)).filter((e): e is string => !!e));
        const isDnc = (e: { lead_id: string; to_email: string }) => dncLeadIds.has(e.lead_id) || dncEmails.has(emailKey(e.to_email) ?? "");
        // Never send to an address that bounced earlier, or that was emailed from another campaign.
        const contactsIdx = await loadContacts();
        const testLeadIds = new Set(allLeads.filter((l) => l.is_test).map((l) => l.id));
        const contactBlocked = (e: { to_email: string; lead_id?: string }) => contactBlock(contactsIdx, e.to_email, campaign_id, { isTest: !!e.lead_id && testLeadIds.has(e.lead_id) });

        // Review gate: plain Send sends only drafts the AI reviewer passed ("ready"). Ticked drafts that
        // still say "check" go out only when the page confirmed it (allow_check). "blocked" never goes out.
        const reviewOf = (e: { review_status?: string }) => (e.review_status === "ready" || e.review_status === "blocked" ? e.review_status : "check");
        const passesReview = (e: { id: string; review_status?: string }) => {
          const st = reviewOf(e);
          if (st === "ready") return true;
          if (st === "check") return !!selectedIds && selectedIds.has(e.id) && allow_check === true;
          return false;
        };
        const inScope = (e: { id: string; sequence_position?: number }) => (selectedIds ? selectedIds.has(e.id) : targetStep !== null ? (e.sequence_position ?? 1) === targetStep : true);
        const eligible = allEmails.filter((e) => {
          if (e.status !== "drafted") return false;
          if (isDnc(e)) return false;
          if (excludedLeadIds.has(e.lead_id)) return false;
          if (contactBlocked(e)) return false;
          if (!passesReview(e)) return false;
          if (selectedIds) return selectedIds.has(e.id);
          if (targetStep !== null) {
            if ((e.sequence_position ?? 1) !== targetStep) return false;
            // Don't nag leads who already replied to an earlier step.
            if (targetStep > 1 && repliedLeadIds.has(e.lead_id)) return false;
          }
          return true;
        });
        // Oldest first, then cap to the requested batch size.
        eligible.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : (a.created_at ?? "") > (b.created_at ?? "") ? 1 : 0));
        const toSend = batchLimit ? eligible.slice(0, batchLimit) : eligible;
        const queuedBefore = allEmails.filter((e) => e.status === "drafted" && !isDnc(e) && !excludedLeadIds.has(e.lead_id) && !contactBlocked(e) && reviewOf(e) === "ready").length;
        const draftedInScope = allEmails.filter((e) => e.status === "drafted" && inScope(e) && !isDnc(e) && !contactBlocked(e));
        const skippedExcluded = draftedInScope.filter((e) => excludedLeadIds.has(e.lead_id)).length;
        const skippedBlocked = draftedInScope.filter((e) => !excludedLeadIds.has(e.lead_id) && reviewOf(e) === "blocked").length;
        const skippedNotReady = draftedInScope.filter((e) => !excludedLeadIds.has(e.lead_id) && reviewOf(e) === "check" && !passesReview(e)).length;
        const skipInfo = { skipped_excluded: skippedExcluded, skipped_blocked: skippedBlocked, skipped_not_ready: skippedNotReady };
        const skippedContacted = allEmails.filter((e) => e.status === "drafted" && !isDnc(e) && contactBlocked(e) && (!selectedIds || selectedIds.has(e.id))).map((e) => ({ email_id: e.id, to_email: e.to_email, reason: contactBlocked(e)!.message.replace(/^Skipped: /, "") }));

        if (toSend.length === 0) {
          return ok({ sent: 0, total: 0, queued: queuedBefore, errors: [], ...skipInfo, skipped_do_not_contact: allEmails.filter((e) => e.status === "drafted" && isDnc(e)).length, skipped_contacted: skippedContacted });
        }

        const settings = await readJson<{ postal_address?: string }>(store(OUTREACH_SETTINGS), "settings");
        const postalAddress = settings?.postal_address ?? "";

        await writeJson(cs, campaign_id, { ...campaign, status: "sending", updated_at: new Date().toISOString() });

        const inbox = await getOrCreateCampaignInbox(agentmailKey, campaign.name as string, (await readOutreachSettings()).sending_inbox_id || undefined);

        // Sender display name — per-email overrides campaign-level.
        const campaignSenderName = (campaign.default_sender_name as string | undefined) ?? "";
        // Patch the inbox's display_name if it doesn't match the campaign's
        // sender. AgentMail strips custom per-message From headers, so the
        // inbox display_name is the only knob that controls what recipients
        // see. Non-fatal on failure — we'd rather send than block.
        if (campaignSenderName) {
          await ensureInboxDisplayName(agentmailKey, inbox.inbox_id, campaignSenderName, inbox.display_name);
        }

        let sent = 0;
        const sentLeadIds = new Set<string>();
        const errors: Array<{ email_id: string; error: string }> = [];
        for (const em of toSend) {
          try {
            const trackedHtml = rewriteLinksForTracking(em.body_html || textToHtml(em.body_text || ""), baseUrl, campaign_id, em.lead_id, em.id);
            // Footer goes on AFTER link tracking so the shiftforge.ai link stays direct.
            const withFooter = appendFooter(em.body_text || "", trackedHtml, postalAddress, em.sender_name || campaignSenderName);
            const sendBody: Record<string, unknown> = {
              to: [em.to_email],
              subject: em.subject,
              text: withFooter.text,
              html: withFooter.html,
            };
            const r = await agentmailFetch(agentmailKey, `/inboxes/${inbox.inbox_id}/messages/send`, {
              method: "POST",
              body: JSON.stringify(sendBody),
            });
            if (!r.ok) {
              const txt = await r.text();
              errors.push({ email_id: em.id, error: `AgentMail send ${r.status}: ${txt.slice(0, 200)}` });
              continue;
            }
            const resp = (await r.json()) as { message_id?: string; thread_id?: string };
            // Re-read the email row (may have been updated), then mark as sent.
            const { blobs } = await es.list({ prefix: `${campaign_id}/` });
            for (const b of blobs) {
              const row = await readJson<{ id: string }>(es, b.key);
              if (row?.id === em.id) {
                await writeJson(es, b.key, {
                  ...row,
                  status: "sent",
                  agentmail_message_id: resp.message_id ?? null,
                  agentmail_thread_id: resp.thread_id ?? null,
                  agentmail_inbox_id: inbox.inbox_id,
                  sent_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });
                break;
              }
            }
            sent++;
            // Remember the address so it is never emailed again from another campaign.
            sentLeadIds.add(em.lead_id);
            try { await noteSent(em.to_email, campaign_id); } catch { /* the email is sent; bookkeeping must not turn that into an error */ }
          } catch (err) {
            errors.push({ email_id: em.id, error: err instanceof Error ? err.message : "unknown" });
          }
        }

        // Mark the leads we just emailed as contacted (one pass over the campaign's leads).
        if (sentLeadIds.size > 0) {
          try {
            const ls = store(OUTREACH_LEADS);
            const { blobs } = await ls.list({ prefix: `${campaign_id}/` });
            for (const b of blobs) {
              const row = await readJson<Record<string, unknown>>(ls, b.key);
              if (row && typeof row.id === "string" && sentLeadIds.has(row.id)) await writeJson(ls, b.key, { ...row, contacted_at: new Date().toISOString() });
            }
          } catch { /* best effort */ }
        }

        const queuedAfter = Math.max(0, queuedBefore - sent);
        // Re-read the campaign: other writers (draft jobs, webhooks) may have changed it while we were sending.
        const freshCampaign = (await readJson<Record<string, unknown>>(cs, campaign_id)) ?? campaign;
        const updated = {
          ...freshCampaign,
          // Drafts still queued → keep the campaign "ready" for the next batch.
          status: sent > 0 ? (queuedAfter > 0 ? "ready" : "completed") : "failed",
          last_send_at: new Date().toISOString(),
          agentmail_inbox_id: inbox.inbox_id,
          updated_at: new Date().toISOString(),
        };
        await writeJson(cs, campaign_id, updated);
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "email",
          summary: `Sent ${sent} of ${toSend.length} emails for "${campaign.name}" (${queuedAfter} still queued)`,
          details: { campaign_id, sent, queued: queuedAfter, errors: errors.length, inbox: inbox.inbox_id },
        });
        return ok({ sent, total: toSend.length, queued: queuedAfter, errors, inbox, skipped_contacted: skippedContacted, ...skipInfo });
      }

      // ── INBOX (AgentMail inbound replies) ─────────────────────────
      case "outreach.replies.list": {
        const { campaign_id, limit = 200 } = params as Record<string, unknown>;
        const s = store(OUTREACH_REPLIES);
        const prefix = typeof campaign_id === "string" && campaign_id ? `${campaign_id}/` : undefined;
        const rows = await listJson<{ received_at?: string }>(s, prefix);
        rows.sort((a, b) => ((a.received_at ?? "") < (b.received_at ?? "") ? 1 : -1));
        return ok(rows.slice(0, typeof limit === "number" ? limit : 200));
      }

      case "outreach.replies.delete": {
        // Removes one inbound reply from the Inbox. Does not touch the lead,
        // so a do-not-contact flag set by this reply stays in force.
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(OUTREACH_REPLIES);
        const { blobs } = await s.list();
        for (const b of blobs) {
          const rec = await readJson<{ id: string }>(s, b.key);
          if (rec?.id !== id) continue;
          // Campaign reply counters are left alone: the email still counts as replied.
          await s.delete(b.key);
          return ok({ id, deleted: true });
        }
        return fail(404, "reply not found");
      }

      case "outreach.replies.get": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(OUTREACH_REPLIES);
        const { blobs } = await s.list();
        for (const b of blobs) {
          const rec = await readJson<{ id: string }>(s, b.key);
          if (rec?.id === id) return ok(rec);
        }
        return fail(404, "reply not found");
      }

      case "outreach.replies.convert_to_task": {
        // Sugar action: read a reply, create a kanban task card with the
        // quoted body. Ties the outreach loop back to the Tasks board.
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const s = store(OUTREACH_REPLIES);
        const { blobs } = await s.list();
        let reply: Record<string, unknown> | null = null;
        for (const b of blobs) {
          const rec = await readJson<Record<string, unknown>>(s, b.key);
          if ((rec as { id?: string } | null)?.id === id) {
            reply = rec;
            break;
          }
        }
        if (!reply) return fail(404, "reply not found");
        const taskId = nanoid(10);
        const now = new Date().toISOString();
        const from = (reply.from as string) ?? "unknown";
        const preview = ((reply.text as string) ?? "").slice(0, 200);
        const task = {
          id: taskId,
          title: `Reply from ${from}`,
          description: `${(reply.subject as string) ?? "(no subject)"}\n\n${preview}\n\nCampaign: ${reply.campaign_id ?? "—"}`,
          status: "needs_input",
          assignee_id: null,
          priority: "medium",
          source: "outreach_reply",
          reply_id: id,
          created_at: now,
          updated_at: now,
        };
        await writeJson(store(TASKS), taskId, task);
        await logActivity({
          agent_id: identity?.kind === "agent" ? identity.agent_id : null,
          category: "decision",
          summary: `Reply from ${from} converted to task`,
          details: { task_id: taskId, reply_id: id },
        });
        return ok(task);
      }

      // ── ANALYTICS ─────────────────────────────────────────────────
      case "outreach.analytics.summary": {
        // Derives counters from the emails store instead of the campaign's
        // cached counters — the cache is race-prone when AgentMail fires
        // sent+delivered webhooks within the same millisecond. Reading
        // from emails gives the race-free source of truth.
        const campaigns = await listJson<{ id: string; name: string; created_at?: string; leads_imported?: number }>(
          store(OUTREACH_CAMPAIGNS),
        );
        const totals = {
          campaigns: campaigns.length,
          leads: 0,
          sent: 0,
          delivered: 0,
          bounced: 0,
          clicked: 0,
          replied: 0,
        };
        const perCampaign: Array<{
          id: string;
          name: string;
          created_at?: string;
          leads_imported?: number;
          emails_sent: number;
          emails_delivered: number;
          emails_bounced: number;
          emails_clicked: number;
          emails_replied: number;
        }> = [];
        for (const c of campaigns) {
          const emails = await listJson<{ status?: string; click_count?: number }>(
            store(OUTREACH_EMAILS),
            `${c.id}/`,
          );
          const sent = emails.filter((e) => e.status && e.status !== "drafted").length;
          const delivered = emails.filter((e) => ["delivered", "clicked", "replied"].includes(e.status ?? "")).length;
          const clicked = emails.filter((e) => e.status === "clicked" || e.status === "replied" || (e.click_count ?? 0) > 0).length;
          const replied = emails.filter((e) => e.status === "replied").length;
          const bounced = emails.filter((e) => ["bounced", "complained", "failed"].includes(e.status ?? "")).length;
          totals.leads += c.leads_imported ?? 0;
          totals.sent += sent;
          totals.delivered += delivered;
          totals.clicked += clicked;
          totals.replied += replied;
          totals.bounced += bounced;
          perCampaign.push({
            id: c.id,
            name: c.name,
            created_at: c.created_at,
            leads_imported: c.leads_imported,
            emails_sent: sent,
            emails_delivered: delivered,
            emails_bounced: bounced,
            emails_clicked: clicked,
            emails_replied: replied,
          });
        }
        perCampaign.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1));
        return ok({ totals, campaigns: perCampaign.slice(0, 50) });
      }

      // ── WEBHOOK HEALTH TEST ───────────────────────────────────────
      case "outreach.webhook.test": {
        // The onboarding "Run test" button. Sends a closed-loop email
        // (AgentMail inbox → same AgentMail inbox), then polls for
        // inbound webhook events at the given webhook_id for ~15s. If
        // any arrive, the pipe works.
        const { webhook_id } = params as Record<string, string>;
        if (!webhook_id) return fail(400, "webhook_id required");
        const agentmailKey = await readServiceKey("agentmail");
        if (!agentmailKey) return fail(400, "AgentMail key not configured");

        const inbox = await getOrCreateCampaignInbox(agentmailKey, "ShiftForge HQ Health Check", (await readOutreachSettings()).sending_inbox_id || undefined);
        const address = inbox.email ?? null;
        if (!address) return fail(500, "AgentMail returned an inbox without an email field. Check your AgentMail account setup.");

        // Snapshot existing event count so we can tell what's new.
        const { blobs: before } = await store(WEBHOOK_EVENTS).list({ prefix: `${webhook_id}/` });
        const beforeCount = before.length;

        // Send a test email to ourselves. The webhook should fire.
        const sendR = await agentmailFetch(agentmailKey, `/inboxes/${inbox.inbox_id}/messages/send`, {
          method: "POST",
          body: JSON.stringify({
            to: [address],
            subject: "ShiftForge HQ webhook health check",
            text: "This is an automated test from your ShiftForge HQ dashboard. If you see event counters tick on the Webhooks page, your integration is wired correctly.",
            html: "<p>This is an automated test from your ShiftForge HQ dashboard.</p><p>If you see event counters tick on the Webhooks page, your integration is wired correctly.</p>",
          }),
        });
        if (!sendR.ok) {
          const txt = await sendR.text();
          return fail(500, `Test send failed (${sendR.status}): ${txt.slice(0, 200)}`);
        }
        const sendBody = (await sendR.json()) as { message_id?: string };

        // Poll for up to 15s for new events on this webhook.
        const deadline = Date.now() + 15000;
        let newEvents = 0;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const { blobs: after } = await store(WEBHOOK_EVENTS).list({ prefix: `${webhook_id}/` });
          newEvents = Math.max(0, after.length - beforeCount);
          if (newEvents > 0) break;
        }

        return ok({
          ok: newEvents > 0,
          test_message_id: sendBody.message_id ?? null,
          test_address: address,
          new_events: newEvents,
          hint:
            newEvents > 0
              ? `Received ${newEvents} webhook event(s) within 15s — your integration is live.`
              : "No events in 15s. Double-check: (a) the webhook URL is pasted into AgentMail → Settings → Webhooks, (b) all event types are enabled, (c) your AgentMail key has webhook permissions.",
        });
      }

      // ── WEBHOOKS (extended for service tagging) ───────────────────
      // Note: base webhook.create/list/events are defined above. We add
      // a typed creation path here so the UI can tag a webhook as AgentMail.
      case "webhook.create_typed": {
        const { name, description = "", service = "generic" } = params as Record<string, string>;
        if (!name) return fail(400, "name required");
        const id = nanoid(12);
        const w = {
          id,
          name,
          description,
          service, // "generic" | "agentmail"
          event_count: 0,
          created_at: new Date().toISOString(),
        };
        await writeJson(store(WEBHOOKS), id, w);
        return ok(w);
      }
      case "webhook.delete": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        await store(WEBHOOKS).delete(id);
        return ok({ id, deleted: true });
      }

      default:
        return fail(400, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[command] handler error:", message, stack);
    return fail(500, message);
  }
};
