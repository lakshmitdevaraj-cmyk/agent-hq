import { scanBanned, checkStep, checkSubject, statusOf, mentionsRating, dedupeReasons, RULES_VERSION, type Hit } from "./lib/messagerules";
import { countSentToday, limitOrDefault, DEFAULT_COUNT_TZ, type SentRow } from "./lib/sendcount";
import { nextFollowUp, countDue, gapsOrDefault, type FollowRow, type FollowState, type FollowStepIn, type StoppedReason } from "./lib/followups";
import { SOCIAL_SEQ_SYSTEM_PROMPT, SOCIAL_SEQ_REVIEW_PROMPT, socialSeqUserPrompt, parseSocialSeq, checkSocialSeq, socialFailureLines, parseSocialReview, mergeSocial, type SeqLeadInfo, type SocialStepCheck } from "./lib/socialseq";
import type { Handler } from "@netlify/functions";
import { STATE_TZ, stateFromAddress, validTimeZone, proposeSlots, REPLY_SYSTEM_PROMPT, replyUserPrompt, assembleReply, sentenceCount, firstSentences, firstNameFromSender } from "./lib/replydraft";
import { connectLambda } from "@netlify/blobs";
import https from "node:https";
import { nanoid } from "nanoid";
import { store, readJson, writeJson, listJson, listJsonFast } from "./lib/blobs";
import { getOrCreateApiKey, identifyApiKey, createAgentKey, hasApiKey, rotateApiKey } from "./lib/auth";
import {
  appendFooter,
  extractEmailAddress,
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
  SITE_CHECK_PATHS, detectSignals, detectFormPlugin, extractSocial, findOwner, gapScore, hoursInfo, leadHours, pageText, validPersonName, siteHoursWording, fitFlags, needsBrowserCheck, looksLikeLeadGenListing, realTrade, businessDetails, siteHours,
  websiteFacts, type SiteFact, type Page, type Owner,
} from "./lib/sitecheck";
import { pickAngle, pickOpeningStyle, leadDetails, detailPhrase, cityOf, checkModelDraft, normalizeFactUsed, subjectRetryHint, callsOnly, copiedFrom, type AngleCode, type ModelDraft, type Fact } from "./lib/angle";
import { DRAFT_SYSTEM_PROMPT, OPENING_STYLE_HELP, REVIEW_SYSTEM_PROMPT, EXAMPLE_BODIES, SOCIAL_SYSTEM_PROMPT, SOCIAL_REVIEW_SYSTEM_PROMPT } from "./lib/prompts";
import { nextPacificMidnight, resumeAtFor, fakeQuotaHit, istText, newStats, type CallStats } from "./lib/gemini-pause";
import { evidenceFor, codeReview, unbackedFactClaims, factsForReviewer, parseVerdict, type ReviewLead, type ReviewStatus } from "./lib/review";
import { BROWSER_ACTOR, BROWSER_DEFAULT_CAP, browserInput, estimateBrowserCost, pagesByLead, screenshotsByLead, screenshotErrorsByLead, logTail } from "./lib/browsercheck";
import { loadContacts, contactBlock, noteSent, noteBounced, type Contacts } from "./lib/contacts";
import { isListedInbound, listedToMessage, isHealthCheckMessage, isBounceReport, isOwnAddress, isSystemReply, isTestReply, flagFor, ownReplyEmailIds, dryRunWebhookPatch, listMessagesQuery, replyBodyText, type ListedMessage } from "./lib/replies";
import { ingestInboundReply, ownAddressList } from "./lib/inbound";
import { debugLog } from "./lib/debuglog";
import { possibleTypoDomain, domainLeadGenFlag, categoryFitFlag } from "./lib/leadflags";
import { leadGenDecision, otherRuleDecision, isContacted, autoFitFields } from "./lib/leadgen";
import { DEFAULT_ASSET_1, DEFAULT_ASSET_2, DEFAULT_PROOF, parseGaps, resolveInputs, SEQUENCE_SYSTEM_PROMPT, FOUR_STEP_REVIEW_PROMPT, sequenceUserPrompt, parseSequence, checkSequence, failureLines, parseReview, mergeStatus } from "./lib/fourstep";
import { channelsFor, socialSkipReason, socialTypeFor, precheckSocial, socialContextLines, type EarlierMessage, type EarlierEmail, partsFromAnswer, partsToList, limitsText, type SocialChannel, type SocialPart, type SocialType } from "./lib/social";
import { deriveTouches, summarizeTouches, touchFromSent, parseSentOn, filterMatches, legacySocialRef, type Touch, type TouchChannel } from "./lib/touches";

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
  "agent-hq-activity", "agent-hq-outreach-social", "agent-hq-outreach-touches", "agent-hq-outreach-followups",
];
const OUTREACH_CAMPAIGNS = "agent-hq-outreach-campaigns";
const LEAD_SCREENSHOTS = "agent-hq-lead-screenshots"; // key: `<campaign_id>/<lead_id>` -> { jpeg_base64, saved_at, bytes } (never inside the lead record)
const OUTREACH_SOCIAL = "agent-hq-outreach-social"; // key: `<campaign_id>/<lead_id>/<channel>`
const OUTREACH_STATE = "agent-hq-outreach-campaign-state"; // running-job + sender defaults, kept apart from campaign settings (batch 7)
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

// Defaults for a new install (saved settings are never changed): Drafting and Reviewer use gemini-2.5-flash, Helper (owner fallback, campaign planning) the lite model.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"; // = the Helper default
const DEFAULT_DRAFT_MODEL = "gemini-2.5-flash";

type OutreachSettings = {
  postal_address?: string;
  gemini_model?: string; // legacy: the one model setting before batch 6 (now the Drafting/Helper fallback)
  draft_model?: string; // writes the emails (default gemini-2.5-flash)
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
  // Batch 8c drafting inputs (a field never saved uses the default; one saved empty stays empty and the writer refuses).
  free_asset_1?: string;
  free_asset_2?: string;
  proof_line?: string;
  named_sources?: string; // a named source for the demo / statistic figures, if any
  booking_link?: string;
  daily_send_limit?: number; // a warning in the send confirm boxes, never a block
  time_zone?: string; // the sender's own time zone (IANA), used by the reply helper
  follow_up_gaps_email?: number[];
  follow_up_gaps_social?: number[];
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
type GeminiAiOpts = { budgetMs?: number; timeoutMs?: number; retryOnTimeout?: boolean; stats?: CallStats };

// Tests only: point AgentMail calls at a local mock (tasks/tests-8b/mock-agentmail.mjs). Unset in production.
const AGENTMAIL_BASE = process.env.AGENTMAIL_TEST_BASE_URL || "https://api.agentmail.to/v0";
// Tests only: point Gemini calls at a local mock (tasks/tests-8b/mock-gemini.mjs). Unset in production.
const GEMINI_BASE = process.env.GEMINI_TEST_BASE_URL || "https://generativelanguage.googleapis.com";

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
        `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.key)}`,
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
  const model = role === "review" ? s.review_model?.trim() || DEFAULT_REVIEW_MODEL : role === "draft" ? s.draft_model?.trim() || legacy || DEFAULT_DRAFT_MODEL : s.helper_model?.trim() || legacy || DEFAULT_GEMINI_MODEL;
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
  if (opts.stats) { if (role === "draft") opts.stats.drafter_calls++; else if (role === "review") opts.stats.reviewer_calls++; else opts.stats.helper_calls++; }
  // Local test switch only (never active on Netlify): a fake daily-limit answer for drafting/reviewing.
  if (role !== "helper" && fakeQuotaHit()) throw new GeminiError("Gemini's daily free limit is used up for today (local test).", "daily_quota", 429);
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
    // A limit (429) switches only when the second provider is the one chosen for this role; otherwise the job pauses.
    // An overloaded provider (503/5xx) keeps today's switch.
    const limited = e instanceof GeminiError && (e.kind === "unavailable" || ((e.kind === "rate_limited" || e.kind === "daily_quota") && cfg.provider === "second"));
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
  const draft = rec.draft_model?.trim() || rec.gemini_model?.trim() || DEFAULT_DRAFT_MODEL;
  return {
    postal_address: rec.postal_address ?? "",
    gemini_model: draft,
    default_gemini_model: DEFAULT_GEMINI_MODEL,
    draft_model: draft,
    review_model: rec.review_model?.trim() || DEFAULT_REVIEW_MODEL,
    helper_model: rec.helper_model?.trim() || rec.gemini_model?.trim() || DEFAULT_GEMINI_MODEL,
    default_draft_model: DEFAULT_DRAFT_MODEL,
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
    free_asset_1: rec.free_asset_1 ?? DEFAULT_ASSET_1,
    free_asset_2: rec.free_asset_2 ?? DEFAULT_ASSET_2,
    proof_line: rec.proof_line ?? DEFAULT_PROOF,
    named_sources: rec.named_sources ?? "",
    booking_link: rec.booking_link ?? "",
    time_zone: rec.time_zone ?? "",
    daily_send_limit: limitOrDefault(rec.daily_send_limit),
    follow_up_gaps_email: parseGaps(rec.follow_up_gaps_email),
    follow_up_gaps_social: parseGaps(rec.follow_up_gaps_social),
    default_free_asset_1: DEFAULT_ASSET_1,
    default_free_asset_2: DEFAULT_ASSET_2,
    default_proof_line: DEFAULT_PROOF,
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
      const r = await fetch(`${AGENTMAIL_BASE}/inboxes?limit=1`, {
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
  return fetch(`${AGENTMAIL_BASE}${path}`, {
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
type FirstEmailMeta = { trade?: string; written_by: string; fact_used: number | null; draft_facts: Fact[]; angle: string; opening_style: string; gap_note: string | null; check_reasons: string[]; rewrites_used: number };

/** First emails written by this process, per campaign (the email list can lag behind a fresh write). */
const firstDraftMemo = new Map<string, Array<{ id: string; subject: string; body: string }>>();

const DEFAULT_OFFER = "We set up AI assistants that answer phone calls for home-service businesses, take the details and pass every enquiry to the owner.";

async function generateFirstEmail(
  lead: FirstEmailLead,
  sender: { sender_offer?: string },
  ctx: { draftsSoFar: number; any_trade: boolean; query: string; others?: Array<{ subject: string; body: string }>; priorFailures?: string[] },
  ai: GeminiAiOpts,
): Promise<{ draft: EmailDraft; meta: FirstEmailMeta }> {
  const plan = pickAngle(lead as Parameters<typeof pickAngle>[0]);
  const style = pickOpeningStyle(ctx.draftsSoFar, plan.facts.length > 0);
  const greetingLine = greetingFor(lead) ?? "Hi there";
  // The business's own trade (from its site or Google category), never the campaign niche.
  const realTradeNow = ((lead.site_check as { real_trade?: string | null } | null | undefined)?.real_trade) ?? realTrade(lead.category, lead.name);
  const trade = realTradeNow ?? (ctx.any_trade ? "home services" : (lead.category || ctx.query || "home services")).slice(0, 60);
  const others = ctx.others ?? [];
  const offer = sender.sender_offer?.trim() || DEFAULT_OFFER;
  const details = leadDetails(lead as Parameters<typeof leadDetails>[0]);
  const detailLine = details.length ? details.map((d, i) => `${i + 1}. ${d.text}`).join("\n") : null;
  // Years in business, family-owned and the rating read best in an opening; a list of services only when nothing else is known.
  const strong = details.filter((d) => ["since", "years", "family", "rating"].includes(d.kind));
  const openable = strong.length ? strong : details.filter((d) => d.kind !== "emergency" && d.kind !== "area");
  const mustOpen = (openable.length ? openable : details)[ctx.draftsSoFar % Math.max(1, (openable.length ? openable : details).length)];
  const shortName = (lead.name ?? "").replace(/\s+(?:llc|inc\.?|ltd\.?|co\.?)$/i, "").split(/\s+/).slice(0, 3).join(" ");
  const user = [
    `BUSINESS: ${lead.name ?? "the business"}`,
    `GREETING: ${greetingLine}`,
    `CITY: ${cityOf(lead.address) || "(unknown)"}`,
    `TRADE: ${trade}`,
    plan.facts.length ? `FACTS YOU MAY USE:\n${plan.facts.map((f) => `${f.n}. ${f.text}`).join("\n")}` : "FACTS YOU MAY USE:\n(none: write without any claim about their business)",
    detailLine ? `TRUE DETAILS ABOUT THEM (the opening MUST use one of these, and different emails use different ones; this campaign has ${ctx.draftsSoFar} so far, so use this one in the opening, in your own words, for example "${detailPhrase(mustOpen, shortName)}"):\n${detailLine}\nSUBJECT: 2-6 words, written like a person (for example "Weekend calls at Tri City" or "Website enquiries at Absolute Value AC"); name the business or one detail; never the "<name>: <detail>" shape; make it different from the subjects already used` : null,
    `ANGLE: ${plan.angle.line}`,
    `OPENING STYLE: ${style} - ${OPENING_STYLE_HELP[style]}`,
    `OFFER (background only, rewrite in your own words, tied to the angle, never paste it): "${offer}"`,
    others.length ? `SUBJECTS ALREADY USED IN THIS CAMPAIGN (do not reuse the pattern): ${others.slice(-6).map((o) => `"${o.subject}"`).join(", ")}` : null,
  ].filter(Boolean).join("\n");
  const checks = { phoneOnlyOk: plan.angle.code === "phone_only", callsOnly: plan.calls_only ?? callsOnly(plan.angle.code), noHours: plan.no_hours === true, trade: realTradeNow, copySources: [offer, ...EXAMPLE_BODIES], others, ignoreWords: [lead.name ?? "", cityOf(lead.address)], details, businessName: lead.name ?? "" };
  // At most ONE rewrite per draft: the first answer plus one retry that lists the exact failures
  // (a draft sent back by the review step is that one retry, so it gets a single call).
  let failures: string[] = ctx.priorFailures ?? [];
  let ans: AiJsonResult | null = null;
  let md: ModelDraft = { subject: "", body: "", fact_used: null, opening_style: style };
  let calls = 0;
  for (let attempt = 0; attempt < (ctx.priorFailures ? 1 : 2); attempt++) {
    calls++;
    const hints = [
      failures.some((f) => /true detail/.test(f)) && mustOpen ? `The first paragraph must say something like: "${detailPhrase(mustOpen, shortName)}".` : "",
      failures.some((f) => /<business name> \+ one word|same shape/.test(f)) ? subjectRetryHint(others.map((o) => o.subject), shortName) : "",
      failures.some((f) => /repeats 8\+ words/.test(f)) ? 'Do not start the offer paragraph with "At ShiftForge AI, we set up": describe what the owner gets, in a different sentence shape.' : "",
    ].filter(Boolean).join(" ");
    const prompt = failures.length === 0 ? user : `${user}\n\nYOUR LAST ANSWER FAILED THESE CHECKS: ${failures.join("; ")}. Write it again and fix them. ${hints} Output JSON only.`;
    ans = await aiJson("draft", { system: DRAFT_SYSTEM_PROMPT, user: prompt, temperature: 0.4 }, ai);
    const o = (ans.json && typeof ans.json === "object" ? ans.json : {}) as Record<string, unknown>;
    md = {
      subject: String(o.subject ?? "").replace(/\s+/g, " ").trim(),
      body: String(o.body ?? o.body_text ?? "").replace(/\r/g, "").trim(),
      fact_used: normalizeFactUsed(o.fact_used, plan.facts.length),
      opening_style: String(o.opening_style ?? style),
    };
    failures = md.body ? checkModelDraft(md, plan.facts.length, checks) : ["the body is empty"];
    debugLog(attempt === 0 && !ctx.priorFailures ? "draft" : "rewrite", { lead: lead.name, attempt: attempt + 1, model: ans.model, subject: md.subject, body: md.body, code_failures: failures });
    if (failures.length === 0) break;
  }
  const draft = normalizeDraft({ subject: md.subject || "Quick question", body_text: md.body, body_html: textToHtml(md.body) }, greetingFor(lead), { firstEmail: true });
  return {
    draft,
    meta: { trade, written_by: ans?.model ?? "", fact_used: md.fact_used, draft_facts: plan.facts, angle: plan.angle.code, opening_style: md.opening_style, gap_note: plan.uncertain, check_reasons: failures, rewrites_used: ctx.priorFailures || calls > 1 ? 1 : 0 },
  };
}

// ── AI reviewer ───────────────────────────────────────────────────────
// Order for every draft: free code checks first (blocked / wording failures never reach the model), then
// the AI reviewer in groups of up to 5 drafts per call, then ONE rewrite at most (counting a writer
// retry), which is checked by code and by a second review before it can be "ready".

type ReviewOutcome = {
  status: ReviewStatus;
  reasons: string[];
  reviewed_by: string | null;
  rewrites_used?: number;
  rewritten?: { subject: string; body_text: string; body_html: string; original: { subject: string; body_text: string; body_html: string } };
};

type ReviewableEmail = { id?: string; subject: string; body_text: string; body_html: string; sequence_position?: number; fact_used?: number | null; draft_facts?: Fact[]; check_reasons?: string[]; angle?: string; created_at?: string; rewrites_used?: number };
type ReviewContext = {
  offer?: string;
  others?: Array<{ subject: string; body: string }>;
  /** Sends the draft back to the writer once with the exact code failures; null when that is not possible. */
  redraft?: (failures: string[]) => Promise<{ subject: string; body: string } | null>;
};
type ReviewItem = { id: string; email: ReviewableEmail; lead: ReviewLead & Record<string, unknown>; rctx: ReviewContext };

const REVIEW_BATCH = 5;
const VERDICTS = ["ready", "check", "blocked"];

type Prep = {
  item: ReviewItem;
  greeting: string | null;
  forModel: ReviewLead;
  plan: ReturnType<typeof pickAngle>;
  firstEmail: boolean;
  crCheck: string[];
  codeChecks: (subject: string, body: string) => string[];
  subject: string;
  body: string;
  found: string[];
  rewritesUsed: number;
  redrafted: { subject: string; body: string } | null;
};

/** Everything that needs no AI. Returns a final outcome (blocked, or failed code checks) or the data for the AI step. */
async function prepareReview(item: ReviewItem): Promise<{ outcome?: ReviewOutcome; prep?: Prep }> {
  const { email, lead, rctx } = item;
  const greeting = greetingFor(lead as Parameters<typeof greetingFor>[0]);
  const hours = leadHours(lead as Parameters<typeof leadHours>[0]);
  const forModel: ReviewLead = { ...lead, hours_summary: hours?.summary ?? null };
  const cr = codeReview(forModel, greeting, typeof email.fact_used === "number");
  // A claim about how long the business has existed must be backed by a saved detail from its own site (a person's years of experience does not count).
  const ageClaim = /\bin business\b|\bsince (?:19|20)\d\d\b|\b(?:over|more than|nearly)?\s*\d{2}\+?[- ]years?\b[^.]{0,30}\b(?:business|serving|family|company)\b|\bfor (?:over |more than )?\d{2}\+? years\b/i.exec(email.body_text);
  if (ageClaim && !leadDetails(lead as Parameters<typeof leadDetails>[0]).some((d) => d.kind === "since" || d.kind === "years")) cr.blocked.push(`Says how long the business has been around ("${ageClaim[0].trim()}"), but no page of its own site says so. Re-check the website.`);
  cr.blocked.push(...unbackedFactClaims(email.body_text, (lead.site_check as { facts?: Array<{ key: string; value: boolean | "unknown" }> } | null | undefined)?.facts));
  if (cr.blocked.length > 0) return { outcome: { status: "blocked", reasons: [...cr.blocked, ...cr.check], reviewed_by: "code checks", rewrites_used: email.rewrites_used ?? 0 } };
  const firstEmail = (email.sequence_position ?? 1) <= 1;
  const plan = pickAngle(lead as Parameters<typeof pickAngle>[0]);
  const realTradeNow = (lead.site_check as { real_trade?: string | null } | null | undefined)?.real_trade ?? realTrade(lead.category as string | null, lead.name as string | null);
  const offer = rctx.offer?.trim() ?? "";
  const details = leadDetails(lead as Parameters<typeof leadDetails>[0]);
  const codeChecks = (subject: string, body: string): string[] =>
    firstEmail
      ? checkModelDraft(
          { subject, body, fact_used: email.fact_used ?? null, opening_style: "" },
          email.draft_facts?.length ?? (typeof email.fact_used === "number" ? 1 : 0),
          { phoneOnlyOk: email.angle === "phone_only", callsOnly: plan.calls_only ?? callsOnly((email.angle ?? "") as AngleCode), noHours: plan.no_hours === true, trade: realTradeNow, copySources: offer ? [offer, ...EXAMPLE_BODIES] : EXAMPLE_BODIES, others: rctx.others ?? [], ignoreWords: [String(lead.name ?? ""), cityOf(String(lead.address ?? ""))], details, businessName: String(lead.name ?? "") },
        )
      : [];
  let subject = email.subject;
  let body = email.body_text;
  let found = codeChecks(subject, body);
  let rewritesUsed = email.rewrites_used ?? 0;
  let redrafted: Prep["redrafted"] = null;
  if (found.length > 0) {
    // Back to the writer ONCE (if it has not been rewritten already); still failing = "Check this", never sent to the AI reviewer.
    if (rewritesUsed < 1 && rctx.redraft) {
      let nd: { subject: string; body: string } | null = null;
      try { nd = await rctx.redraft(found); } catch (e) { if (e instanceof GeminiError && e.kind === "daily_quota") throw e; }
      rewritesUsed = 1;
      if (nd) {
        redrafted = { subject: nd.subject, body: normalizeDraft({ subject: nd.subject, body_text: nd.body, body_html: "" }, greeting, { firstEmail }).body_text };
        subject = redrafted.subject;
        body = redrafted.body;
        found = codeChecks(subject, body);
      }
    }
    if (found.length > 0) {
      const outcome: ReviewOutcome = { status: "check", reasons: dedupeReasons([...found.map((f) => `Code check: ${f}`), ...cr.check]), reviewed_by: "code checks", rewrites_used: rewritesUsed };
      if (redrafted) outcome.rewritten = { subject, body_text: body, body_html: textToHtml(body), original: { subject: email.subject, body_text: email.body_text, body_html: email.body_html } };
      return { outcome };
    }
  }
  return { prep: { item, greeting, forModel, plan, firstEmail, crCheck: cr.check, codeChecks, subject, body, found, rewritesUsed, redrafted } };
}

type Entry = { prep: Prep; subject: string; body: string; findings: string[] };
type VerdictAnswer = { verdict: ReturnType<typeof parseVerdict>; model: string };

/** One reviewer call for up to 5 drafts of one campaign. Entries the model skipped or garbled are asked again on their own, once. */
async function askBatch(entries: Entry[], ai: GeminiAiOpts, retry = true): Promise<Map<string, VerdictAnswer | null>> {
  const out = new Map<string, VerdictAnswer | null>();
  if (entries.length === 0) return out;
  const first = entries[0].prep;
  ai.stats?.drafts_per_reviewer_call.push(entries.length);
  const payload = entries.map((e) => ({
    ID: e.prep.item.id,
    DRAFT: { subject: e.subject, body: e.body },
    GREETING_EXPECTED: e.prep.greeting ? `${e.prep.greeting},` : "Hi there,",
    EMAIL_STEP: e.prep.item.email.sequence_position ?? 1,
    FACTS_GIVEN_TO_WRITER: e.prep.item.email.draft_facts ?? "unknown (older draft)",
    SAVED_EVIDENCE: evidenceFor(e.prep.forModel),
    WEBSITE_FACTS: factsForReviewer((e.prep.forModel.site_check as { facts?: Array<{ key: string; value: unknown; evidence: { text: string }; no_autolink?: boolean }> } | null | undefined)?.facts),
    CODE_FINDINGS: e.findings,
    ANGLE_GIVEN_TO_WRITER: e.prep.plan.angle.line,
    OTHER_EMAILS_IN_CAMPAIGN: (e.prep.item.rctx.others ?? []).slice(-3).map((o) => o.body.slice(0, 400)),
  }));
  // An answer that is not valid JSON counts as "no usable answers": every draft is then asked again alone, once.
  const r = await aiJson(
    "review",
    { system: REVIEW_SYSTEM_PROMPT, user: JSON.stringify({ DRAFTS: payload, SENDER_OFFER: first.item.rctx.offer?.trim() || null, WRITER_EXAMPLES: EXAMPLE_BODIES }), temperature: 0 },
    ai,
  ).catch((e) => { if (e instanceof GeminiError) throw e; return { json: null, model: "", provider: "gemini" as const, fell_back: false } as AiJsonResult; });
  const j = r.json as unknown;
  const arr: unknown[] = Array.isArray(j) ? j : Array.isArray((j as { results?: unknown })?.results) ? ((j as { results: unknown[] }).results) : j && typeof j === "object" && entries.length === 1 && "verdict" in (j as object) ? [{ ...(j as object), id: entries[0].prep.item.id }] : [];
  for (const raw of arr) {
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.verdict !== "string" || !VERDICTS.includes(o.verdict.toLowerCase())) continue;
    if (!entries.some((e) => e.prep.item.id === o.id) || out.has(o.id)) continue;
    out.set(o.id, { verdict: parseVerdict(o), model: r.model });
  }
  const missing = entries.filter((e) => !out.has(e.prep.item.id));
  for (const m of missing) {
    if (retry) {
      const again = await askBatch([m], ai, false);
      out.set(m.prep.item.id, again.get(m.prep.item.id) ?? null);
    } else out.set(m.prep.item.id, null);
  }
  return out;
}

/**
 * Reviews drafts of ONE campaign: code checks first, then the AI in groups of up to 5. Calls onOutcome as each
 * draft is final. A daily Gemini limit is rethrown so the job can pause; every draft finished before it is already reported.
 */
async function reviewMany(items: ReviewItem[], ai: GeminiAiOpts, onOutcome: (id: string, o: ReviewOutcome) => Promise<void> | void): Promise<void> {
  const ready: Prep[] = [];
  for (const it of items) {
    const { outcome, prep } = await prepareReview(it);
    if (outcome) await onOutcome(it.id, outcome);
    else if (prep) ready.push(prep);
  }
  const notYet = (e: unknown) => (e instanceof Error ? e.message : "the reviewer did not answer");
  for (let i = 0; i < ready.length; i += REVIEW_BATCH) {
    const chunk = ready.slice(i, i + REVIEW_BATCH);
    const entries1: Entry[] = chunk.map((p) => ({ prep: p, subject: p.subject, body: p.body, findings: p.found }));
    const finish = async (p: Prep, o: ReviewOutcome) => {
      const out: ReviewOutcome = { ...o, rewrites_used: Math.max(o.rewrites_used ?? 0, p.rewritesUsed) };
      if (p.redrafted && !out.rewritten) out.rewritten = { subject: p.subject, body_text: p.body, body_html: textToHtml(p.body), original: { subject: p.item.email.subject, body_text: p.item.email.body_text, body_html: p.item.email.body_html } };
      debugLog("review", { lead: p.item.lead.name, status: out.status, reasons: out.reasons, reviewed_by: out.reviewed_by, rewrites_used: out.rewrites_used ?? 0, ...(out.rewritten ? { rewritten_subject: out.rewritten.subject, rewritten_body: out.rewritten.body_text, original_subject: out.rewritten.original.subject } : {}) });
      await onOutcome(p.item.id, out);
    };
    let answers: Map<string, VerdictAnswer | null>;
    try {
      answers = await askBatch(entries1, ai);
    } catch (e) {
      if (e instanceof GeminiError && e.kind === "daily_quota") throw e;
      for (const p of chunk) await finish(p, { status: "check", reasons: dedupeReasons([`Not reviewed yet: ${notYet(e)}`.slice(0, 200), ...p.crCheck]), reviewed_by: null });
      continue;
    }
    const second: Entry[] = [];
    const rewriteOf = new Map<string, { v: VerdictAnswer; rw: { subject: string; body: string } }>();
    for (const p of chunk) {
      const a = answers.get(p.item.id);
      if (!a) { await finish(p, { status: "check", reasons: dedupeReasons(["The reviewer's answer for this draft was missing or unreadable.", ...p.crCheck]), reviewed_by: null }); continue; }
      const v = a.verdict;
      const extra = [...p.crCheck, ...p.found.map((f) => `Check: ${f}`)];
      if (v.status === "blocked") { await finish(p, { status: "blocked", reasons: dedupeReasons([...v.reasons, ...extra]), reviewed_by: a.model }); continue; }
      if (v.status === "ready" && extra.length === 0) { await finish(p, { status: "ready", reasons: v.reasons, reviewed_by: a.model }); continue; }
      if (v.status === "ready") { await finish(p, { status: "check", reasons: dedupeReasons([...v.reasons, ...extra]), reviewed_by: a.model }); continue; }
      if (v.problem === "wording" && v.rewrite) {
        if (p.rewritesUsed >= 1) { await finish(p, { status: "check", reasons: dedupeReasons([...v.reasons, "It was already rewritten once, so a person should look at it.", ...extra]), reviewed_by: a.model }); continue; }
        // The ONE rewrite: checked by code now, by a second review next.
        const body_text = normalizeDraft({ subject: v.rewrite.subject, body_text: v.rewrite.body, body_html: "" }, p.greeting, { firstEmail: p.firstEmail }).body_text;
        const codeFails = p.codeChecks(v.rewrite.subject, body_text);
        if (codeFails.length > 0) { await finish(p, { status: "check", reasons: dedupeReasons([...v.reasons, ...codeFails.map((f) => `The rewrite still failed: ${f}`), ...p.crCheck]), reviewed_by: a.model, rewrites_used: 1 }); continue; }
        rewriteOf.set(p.item.id, { v: a, rw: { subject: v.rewrite.subject, body: body_text } });
        second.push({ prep: p, subject: v.rewrite.subject, body: body_text, findings: [] });
        continue;
      }
      await finish(p, { status: "check", reasons: dedupeReasons([...v.reasons, ...extra]), reviewed_by: a.model });
    }
    if (second.length === 0) continue;
    let answers2: Map<string, VerdictAnswer | null>;
    try {
      answers2 = await askBatch(second, ai);
    } catch (e) {
      if (e instanceof GeminiError && e.kind === "daily_quota") throw e;
      for (const en of second) await finish(en.prep, { status: "check", reasons: dedupeReasons([`Not reviewed after the rewrite: ${notYet(e)}`.slice(0, 200), ...en.prep.crCheck]), reviewed_by: null });
      continue;
    }
    for (const en of second) {
      const p = en.prep;
      const first = rewriteOf.get(p.item.id)!;
      const a2 = answers2.get(p.item.id);
      if (a2 && a2.verdict.status === "ready" && p.crCheck.length === 0) {
        await finish(p, {
          status: "ready",
          reasons: [`Reworded by the reviewer: ${first.v.verdict.reasons.join(" ")}`.slice(0, 300)],
          reviewed_by: a2.model,
          rewrites_used: 1,
          rewritten: { subject: en.subject, body_text: en.body, body_html: textToHtml(en.body), original: { subject: p.item.email.subject, body_text: p.item.email.body_text, body_html: p.item.email.body_html } },
        });
      } else {
        await finish(p, { status: "check", reasons: [...first.v.verdict.reasons, ...(a2 ? a2.verdict.reasons.map((r) => `After rewrite: ${r}`) : ["After the rewrite the reviewer gave no usable answer."]), ...p.crCheck].slice(0, 6), reviewed_by: a2?.model ?? first.v.model, rewrites_used: 1 });
      }
    }
  }
}

/** One draft (single-lead generate and tests): the same path with a group of one. */
async function reviewDraft(email: ReviewableEmail, lead: ReviewLead & Record<string, unknown>, ai: GeminiAiOpts, rctx: ReviewContext = {}): Promise<ReviewOutcome> {
  let result: ReviewOutcome | null = null;
  await reviewMany([{ id: email.id ?? "draft", email, lead, rctx }], ai, (_id, o) => { result = o; });
  return result ?? { status: "check", reasons: ["The reviewer did not answer."], reviewed_by: null };
}

/** The review fields to store on an email record. */
function reviewFields(o: ReviewOutcome, prevHistory?: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { review_status: o.status, review_reasons: o.reasons, reviewed_by: o.reviewed_by, reviewed_at: o.reviewed_by ? new Date().toISOString() : null };
  if (typeof o.rewrites_used === "number") fields.rewrites_used = o.rewrites_used;
  if (o.rewritten) {
    fields.subject = o.rewritten.subject;
    fields.body_text = o.rewritten.body_text;
    fields.body_html = o.rewritten.body_html;
    fields.review_history = [...(Array.isArray(prevHistory) ? prevHistory : []), { at: new Date().toISOString(), kind: "original_before_rewrite", ...o.rewritten.original }];
  }
  return fields;
}

// ── Alcance 4-step emails (batch 8c) ──────────────────────────────────
// One model call per lead writes all four emails; each is saved as its own row (sequence_position 1 to 4) on the
// existing sequence machinery, with its own review status. Sending stays manual, one step at a time.

/** Makes the body start with the expected greeting line. */
function withGreeting(body: string, greeting: string): string {
  const lines = body.split("\n");
  const first = lines[0].trim();
  const g = `${greeting},`;
  if (first.toLowerCase() === g.toLowerCase()) return body.trim();
  if (/^(?:hi|hello|hey|dear)\b/i.test(first) && first.length < 40) lines[0] = g;
  else lines.unshift(g, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function a3Context(lead: Record<string, unknown>) {
  const plan = pickAngle(lead as Parameters<typeof pickAngle>[0]);
  const details = leadDetails(lead as Parameters<typeof leadDetails>[0]);
  const greeting = greetingFor(lead as Parameters<typeof greetingFor>[0]) ?? "Hi there";
  const real = ((lead.site_check as { real_trade?: string | null } | null | undefined)?.real_trade) ?? realTrade(typeof lead.category === "string" ? lead.category : null, typeof lead.name === "string" ? lead.name : null);
  const trade = real ?? (typeof lead.category === "string" && lead.category ? lead.category : "home services");
  return { plan, details, greeting, trade, city: cityOf(typeof lead.address === "string" ? lead.address : undefined) };
}

/** Writes all four emails and runs the free code checks, with ONE retry that lists the exact failures. Null = a Settings input is empty (refuse, never invent). */
async function generateFourStep(lead: Record<string, unknown>, settings: OutreachSettings, offer: string, ai: GeminiAiOpts) {
  const inp = resolveInputs(settings, String(lead.name ?? ""));
  if (!inp.freeAsset1 || !inp.freeAsset2) return { refused: "Check this: add a free asset in Settings" as const };
  const c = a3Context(lead);
  if (c.plan.facts.length === 0 && c.details.length === 0) {
    const missing = [typeof lead.rating !== "number" ? "rating" : "", lead.website ? "" : "website", cityOf(typeof lead.address === "string" ? lead.address : undefined) ? "" : "address"].filter(Boolean);
    return { refused: `Not enough facts about this lead: no ${missing.join(", no ") || "saved details"}. Run the website check or add a rating or website, then try again.` };
  }
  const sl = { name: typeof lead.name === "string" ? lead.name : undefined, greeting: c.greeting, city: c.city, trade: c.trade, details: c.details.map((d) => d.text), facts: c.plan.facts.map((f) => ({ n: f.n, text: f.text })) };
  const ratingElsewhere = await leadRatingUsed(String(lead.campaign_id ?? ""), String(lead.id ?? ""), { emails: true }); // a social message already states it
  let hint = "";
  let problem = "";
  let model = "";
  let calls = 0;
  let steps: Array<{ step: 1 | 2 | 3 | 4; subject: string; body: string }> = [];
  let checks = [] as ReturnType<typeof checkSequence>;
  let factUsed: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const ans = await aiJson("draft", { system: SEQUENCE_SYSTEM_PROMPT, user: sequenceUserPrompt(sl, inp, offer, hint || undefined, ratingElsewhere), temperature: 0.4 }, ai);
    model = ans.model;
    const parsed = parseSequence(ans.json);
    if (!parsed) {
      const o = (ans.json && typeof ans.json === "object" ? ans.json : {}) as Record<string, unknown>;
      const lacking = ["email_1", "email_2", "email_3", "email_4"].filter((k) => !String(o[k] ?? "").trim());
      problem = lacking.length ? `the answer had no ${lacking.join(", ")}` : "the answer was not in the expected shape";
      hint = `${problem} (JSON with subject, email_1, email_2, email_3, email_4)`; debugLog("four-step", { lead: lead.name, attempt: attempt + 1, failures: [hint] }); continue; }
    steps = parsed.steps.map((s) => ({ ...s, body: withGreeting(s.body, c.greeting) }));
    factUsed = parsed.fact_used;
    checks = checkSequence(steps, inp, { ratingElsewhere });
    const fails = failureLines(checks);
    debugLog("four-step", { lead: lead.name, attempt: attempt + 1, model, subject: steps[0].subject, code_failures: fails });
    if (fails.length === 0) break;
    hint = fails.join("; ");
  }
  if (steps.length !== 4) throw new Error(`The writer did not return four emails: ${problem || "no usable answer"}.`);
  return { steps, checks, model, calls, factUsed, ctx: c };
}

/** The AI structure review for one lead's four emails (one call). Returns one verdict per step; any failure of the call but a quota error gives none. */
async function reviewFourStepLead(lead: Record<string, unknown>, steps: Array<{ step: number; subject: string; body: string }>, checks: ReturnType<typeof checkSequence>, ai: GeminiAiOpts) {
  const c = a3Context(lead);
  const evidence = {
    business: lead.name ?? null, city: c.city, greeting_expected: c.greeting,
    owner: { name: lead.owner_name ?? null, confidence: lead.owner_confidence ?? null },
    google_rating: typeof lead.rating === "number" ? lead.rating : null, google_reviews: typeof lead.reviews_count === "number" ? lead.reviews_count : null,
    true_details: c.details.map((d) => d.text), facts: c.plan.facts.map((f) => f.text),
    fit_warnings: [(lead.site_check as { not_home_service?: string | null } | null | undefined)?.not_home_service].filter(Boolean),
  };
  const inp = resolveInputs(await readOutreachSettings(), String(lead.name ?? ""));
  const user = JSON.stringify({ LEAD: lead.name ?? "", SENDER_SETTINGS: { proof_line: inp.proofLine || null, free_thing_1: inp.freeAsset1 || null, free_thing_2: inp.freeAsset2 || null }, SAVED_EVIDENCE: evidence, EMAILS: steps.map((s) => ({ step: s.step, subject: s.step === 1 ? s.subject : "(same thread)", body: s.body })), CODE_FINDINGS: checks.map((x) => ({ step: x.step, problems: x.reasons })) });
  try {
    const ans = await aiJson("review", { system: FOUR_STEP_REVIEW_PROMPT, user, temperature: 0.1 }, ai);
    debugLog("four-step-review", { lead: lead.name, model: ans.model, verdicts: parseReview(ans.json).map((v) => `${v.step}:${v.verdict}`) });
    return { verdicts: parseReview(ans.json), model: ans.model };
  } catch (err) {
    if (err instanceof GeminiError && (err.kind === "daily_quota" || err.kind === "rate_limited")) throw err;
    return { verdicts: [], model: null as string | null };
  }
}

/** Writes the four rows for one lead (steps that already exist are left alone) and returns all rows of the lead's sequence. */
async function writeFourStepRows(a: { campaign_id: string; lead: Record<string, unknown>; sender_name?: string; offer: string; have: Set<number>; ai: GeminiAiOpts }): Promise<Array<Record<string, unknown>>> {
  const settings = await readOutreachSettings();
  const gen = await generateFourStep(a.lead, settings, a.offer, a.ai);
  if ("refused" in gen) throw new Error(gen.refused);
  const rv = await reviewFourStepLead(a.lead, gen.steps, gen.checks, a.ai);
  const es = store(OUTREACH_EMAILS);
  const base = Date.now();
  const out: Array<Record<string, unknown>> = [];
  for (const s of gen.steps) {
    if (a.have.has(s.step)) continue;
    const code = gen.checks.find((x) => x.step === s.step)!;
    const m = mergeStatus(code, rv.verdicts.find((v) => v.step === s.step));
    const emailId = nanoid(12);
    const createdAt = new Date(base + s.step).toISOString();
    const rec = {
      id: emailId, campaign_id: a.campaign_id, lead_id: a.lead.id, to_email: a.lead.email, to_name: a.lead.name,
      subject: s.subject, body_text: s.body, body_html: textToHtml(s.body),
      sender_name: a.sender_name ?? null, sequence_position: s.step, sequence_total: 4, framework: "four-step", status: "drafted",
      written_by: gen.model, fact_used: gen.factUsed, angle: gen.ctx.plan.angle.code, draft_facts: gen.ctx.plan.facts,
      review_status: m.status, review_reasons: m.reasons, reviewed_by: rv.model ?? "code checks", reviewed_at: new Date().toISOString(),
      created_at: createdAt, updated_at: createdAt,
    };
    await writeJson(es, `${a.campaign_id}/${createdAt}-${emailId}`, rec);
    out.push(rec);
  }
  return out;
}

/** (Re)reviews Alcance 4-step rows. Each lead's four emails are checked together; a row edited meanwhile keeps its newer text. */
async function reviewFourStepRows(campaign_id: string, todo: Array<{ key: string; row: Record<string, unknown> & { id: string } }>, ai: GeminiAiOpts, onDone: (n: number) => Promise<void> | void): Promise<void> {
  const es = store(OUTREACH_EMAILS);
  const all = await listJson<Record<string, unknown> & { id: string; lead_id: string; sequence_position?: number; created_at?: string; framework?: string }>(es, `${campaign_id}/`);
  let done = 0;
  const leads = [...new Set(todo.map((t) => String(t.row.lead_id)))];
  for (const leadId of leads) {
    const rows = all.filter((e) => e.lead_id === leadId && e.framework === "four-step").sort((x, y) => (x.sequence_position ?? 1) - (y.sequence_position ?? 1));
    const found = await findLeadRow(campaign_id, leadId);
    const mine = todo.filter((t) => String(t.row.lead_id) === leadId);
    if (!found || rows.length === 0) { done += mine.length; await onDone(done); continue; }
    const steps = rows.map((r) => ({ step: (r.sequence_position ?? 1) as 1 | 2 | 3 | 4, subject: String(r.subject ?? ""), body: String(r.body_text ?? "") }));
    const inp = resolveInputs(await readOutreachSettings(), String(found.lead.name ?? ""));
    const checks = checkSequence(steps, inp, { ratingElsewhere: await leadRatingUsed(campaign_id, leadId, { emails: true }) });
    const rv = await reviewFourStepLead(found.lead, steps, checks, ai);
    for (const t of mine) {
      const pos = (t.row.sequence_position ?? 1) as number;
      const code = checks.find((x) => x.step === pos);
      if (!code) continue;
      const m = mergeStatus(code, rv.verdicts.find((v) => v.step === pos));
      const fresh = await readJson<Record<string, unknown>>(es, t.key);
      if (fresh && fresh.status === "drafted" && fresh.updated_at === t.row.updated_at) {
        await writeJson(es, t.key, { ...fresh, review_status: m.status, review_reasons: m.reasons, reviewed_by: rv.model ?? "code checks", reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
      done++;
      await onDone(done);
    }
  }
}


// ── Code checks on every saved email (generated, agent-written, edited, marked ready) ──

/** Has another message to this lead (any channel) already stated the rating or review count? `skip` leaves out the messages being written/checked. */
async function leadRatingUsed(campaign_id: string, lead_id: string, skip: { emails?: boolean; channel?: string } = {}): Promise<boolean> {
  try {
    if (!skip.emails) {
      const rows = await listJson<{ lead_id?: string; body_text?: string }>(store(OUTREACH_EMAILS), `${campaign_id}/`);
      if (rows.some((e) => e.lead_id === lead_id && mentionsRating(String(e.body_text ?? "")))) return true;
    }
    for (const ch of ["facebook", "instagram", "linkedin"]) {
      if (ch === skip.channel) continue;
      const rec = await readJson<{ parts?: Array<{ text?: string }> }>(store(OUTREACH_SOCIAL), `${campaign_id}/${lead_id}/${ch}`);
      if ((rec?.parts ?? []).some((x) => mentionsRating(String(x.text ?? "")))) return true;
    }
  } catch { /* a read failure never blocks a check */ }
  return false;
}

const hitLine = (h: Hit): string => `${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}. ${h.because}`.slice(0, 240);

/**
 * The free code checks for ONE saved email, with the same rules as generation (position decides the rules; later steps are measured
 * against the lead's earlier emails; the rating is stated at most once across email and social). Hard hits mean "blocked".
 */
async function codeCheckSavedEmail(row: Record<string, unknown>, campaign_id: string): Promise<{ status: "ready" | "check" | "blocked"; reasons: string[]; hard: string[]; hits: Hit[] }> {
  const inp = resolveInputs(await readOutreachSettings(), String(row.to_name ?? ""));
  const all = await listJson<Record<string, unknown> & { id: string; lead_id: string; sequence_position?: number; framework?: string; body_text?: string }>(store(OUTREACH_EMAILS), `${campaign_id}/`);
  const four = row.framework === "four-step";
  const pos = Math.min(4, Math.max(1, Number(row.sequence_position ?? 1)));
  const earlier = four ? all.filter((e) => e.lead_id === row.lead_id && e.id !== row.id && e.framework === "four-step" && (e.sequence_position ?? 1) < pos).sort((a, b) => (a.sequence_position ?? 1) - (b.sequence_position ?? 1)) : [];
  const body = String(row.body_text ?? "");
  const subject = String(row.subject ?? "");
  const ratingAlready = (await leadRatingUsed(campaign_id, String(row.lead_id), { emails: true })) || earlier.some((e) => mentionsRating(String(e.body_text ?? "")));
  const kinds = ["email1", "email2", "email3", "email4"] as const;
  let hits = checkStep(four ? kinds[pos - 1] : "email1", body, { channel: "email", earlierChars: earlier.map((e) => String(e.body_text ?? "").length), ratingAlready, freeAsset: pos === 2 ? inp.freeAsset2 : inp.freeAsset1, proofLine: inp.proofLine, earlierTexts: earlier.map((e) => String(e.body_text ?? "")), namedSources: inp.namedSources });
  // Older frameworks have no length or structure rules: only hard hits count for them.
  if (!four) hits = hits.filter((h) => h.level === "hard");
  const subjectHits = four && pos === 1 ? checkSubject(subject) : [...scanBanned(subject).filter((h) => h.level === "hard" && h.id !== "dash"), ...checkSubject(subject).filter((h) => h.id === "fake-re" || h.id === "empty-subject")];
  hits = [...hits, ...subjectHits.filter((h) => !hits.some((x) => x.id === h.id))];
  const st = statusOf(hits);
  return { status: st.status, reasons: st.reasons, hard: hits.filter((h) => h.level === "hard").map(hitLine), hits };
}

/** Saves a patch onto one stored draft (its blob key is created_at + id; falls back to a scan) and onto the in-memory row. */
async function saveDraftPatch(row: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
  const es = store(OUTREACH_EMAILS);
  const cid = String(row.campaign_id ?? "");
  let key = `${cid}/${row.created_at}-${row.id}`;
  let cur = await readJson<Record<string, unknown>>(es, key);
  if (!cur || cur.id !== row.id) {
    cur = null;
    const { blobs } = await es.list({ prefix: `${cid}/` });
    for (const b of blobs) { if (!b.key.endsWith(`-${row.id}`)) continue; const r = await readJson<Record<string, unknown>>(es, b.key); if (r?.id === row.id) { key = b.key; cur = r; break; } }
  }
  if (!cur) return;
  await writeJson(es, key, { ...cur, ...patch });
  Object.assign(row, patch);
}

/**
 * Re-runs the free code checks on the unsent steps of a saved social run. A hard hit makes that step Blocked (reasons saved).
 * Used before "Copy" / "Mark as sent" and once per rules change on read. Returns the record (changed or not) and what is blocked.
 */
async function verifySocialRecord(rec: SocialRecord, opts: { stamp?: boolean } = {}): Promise<{ rec: SocialRecord; blocked: Array<{ key: string; label: string; reasons: string[] }> }> {
  if (rec.type !== "sequence" || rec.status === "sent") return { rec, blocked: [] };
  const inp = resolveInputs(await readOutreachSettings(), "");
  const checks = checkSocialSeq(rec.channel, partsMap(rec.parts), inp, { ratingElsewhere: await leadRatingUsed(rec.campaign_id, rec.lead_id, { channel: rec.channel }) });
  const blocked: Array<{ key: string; label: string; reasons: string[] }> = [];
  let changed = false;
  const parts = rec.parts.map((p) => {
    if (p.sent_at || p.skipped) return p;
    const ck = checks.find((x) => x.key === p.key);
    if (!ck || !ck.hits.some((h) => h.level === "hard")) return p;
    blocked.push({ key: p.key, label: p.label, reasons: ck.reasons });
    if (p.review_status === "blocked") return p;
    changed = true;
    return { ...p, review_status: "blocked" as const, review_reasons: ck.reasons };
  });
  const stampNeeded = opts.stamp && (rec as { rules_version?: number }).rules_version !== RULES_VERSION;
  if (!changed && !stampNeeded) return { rec, blocked };
  const RK = { ready: 0, check: 1, blocked: 2 } as const;
  const open = parts.filter((x) => !x.sent_at && !x.skipped);
  const worst = open.reduce((w, x) => (x.review_status && RK[x.review_status] > RK[w] ? x.review_status : w), "ready" as "ready" | "check" | "blocked");
  const next = { ...rec, parts, ...(changed ? { review_status: worst, review_reasons: open.filter((x) => x.review_reasons?.length).flatMap((x) => x.review_reasons!.map((r) => `${x.key === "message" ? "first" : x.key}: ${r}`)) } : {}), rules_version: RULES_VERSION } as SocialRecord;
  await writeJson(store(OUTREACH_SOCIAL), socialKey(rec.campaign_id, rec.lead_id, rec.channel), next);
  return { rec: next, blocked };
}

const TIME_WORDS_RE = /\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? \d{1,2}\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;

export type Downgrade = { id: string; campaign_id: string; lead_id?: string; step: number; name?: string; was: string; reasons: string[] };

/**
 * Re-checks every UNSENT draft whose last code check is older than RULES_VERSION. A hard hit makes it Blocked (reasons saved);
 * otherwise the draft is only stamped with the version, so this runs once per rules change, not on every load.
 * Mutates the rows it is given, so the caller's list is already current.
 */
async function recheckDraftRows(rows: Array<Record<string, unknown>>): Promise<Downgrade[]> {
  const out: Downgrade[] = [];
  for (const r of rows) {
    if (!r || r.status !== "drafted" || r.rules_version === RULES_VERSION || !r.campaign_id || !r.id) continue;
    try {
      const ck = await codeCheckSavedEmail(r, String(r.campaign_id));
      const at = new Date().toISOString();
      if (ck.hard.length) {
        const was = String(r.review_status ?? "check");
        await saveDraftPatch(r, { review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: at, rules_version: RULES_VERSION });
        out.push({ id: String(r.id), campaign_id: String(r.campaign_id), lead_id: String(r.lead_id ?? ""), step: Number(r.sequence_position ?? 1), name: String(r.to_name ?? ""), was, reasons: ck.reasons });
      } else await saveDraftPatch(r, { rules_version: RULES_VERSION });
    } catch { /* one odd draft must not stop the list */ }
  }
  return out;
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
  const homeTitle = (pages[0]?.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const fit = fitFlags(pages, typeof lead.website === "string" ? lead.website : null, { name, category: typeof lead.category === "string" ? lead.category : null, city: cityOf(typeof lead.address === "string" ? lead.address : ""), reviews_count: typeof lead.reviews_count === "number" ? lead.reviews_count : null, phone: typeof lead.phone === "string" ? lead.phone : null, tls_problem: (lead.site_check as { tls_problem?: boolean } | undefined)?.tls_problem === true });
  const tradeNow = realTrade(typeof lead.category === "string" ? lead.category : null, name, homeTitle);
  const nb: { needs: boolean; reason: string | null } = via === "browser" ? { needs: false, reason: null } : needsBrowserCheck(pages, signals);
  // Plain-code website facts. A plain re-check keeps the facts an earlier browser check produced.
  const priorChecked = (lead.site_check ?? {}) as { via?: string; facts?: SiteFact[] };
  const priorChecked2 = (lead.site_check ?? {}) as { screenshot?: { saved_at: string; bytes: number } | null };
  const facts: SiteFact[] = viaIn === "raw" && priorChecked.via === "browser" && Array.isArray(priorChecked.facts) && priorChecked.facts.length > 0
    ? priorChecked.facts
    : websiteFacts(pages, { via: viaIn, jsBuilt: needsBrowserCheck(pages, { chat_widget: null, booking_tool: null }).needs });
  const gap = gapScore(lead as { rating?: number | null; reviews_count?: number | null; raw?: unknown }, signals, { hoursUsable: wording.hours_usable });
  const fields: Record<string, unknown> = {
    site_check: {
      checked_at: checkedAt,
      via,
      ...signals,
      // null = looked and found no form plugin; a name = a JavaScript form plugin is on the site (a plain download cannot see its form).
      form_plugin: detectFormPlugin(pages),
      pages_checked: pages.length,
      sources: { ...sources, ...socialSources },
      evidence,
      hours_usable: wording.hours_usable,
      advertises_emergency: wording.advertises_emergency,
      mentions_24_7: wording.mentions_24_7,
      real_trade: tradeNow,
      details: businessDetails(pages),
      site_hours: siteHours(pages),
      hours_evidence: wording.evidence,
      needs_browser: nb.needs,
      needs_browser_reason: nb.reason,
      not_home_service: fit.not_home_service,
      lead_gen_listing: fit.lead_gen_listing,
      facts,
      screenshot: priorChecked2.screenshot ?? null,
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
    site_check: { checked_at: checkedAt, error: "no website", real_trade: realTrade(typeof lead.category === "string" ? lead.category : null, typeof lead.name === "string" ? lead.name : null), lead_gen_listing: looksLikeLeadGenListing(lead as { name?: string; website?: string; reviews_count?: number }) },
    gap_score: g.score,
    gap_reasons: g.reasons,
  };
}

/** True when the site answers only if its certificate is ignored (expired, wrong name, self-signed). */
function tlsProblem(base: URL): Promise<boolean> {
  return new Promise((resolve) => {
    if (base.protocol !== "https:") return resolve(false);
    const req = https.request({ host: base.hostname, port: base.port || 443, path: "/", method: "HEAD", rejectUnauthorized: false, timeout: 5000 }, (res) => { res.resume(); resolve(true); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
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
  if (pages.length === 0) {
    // Nothing loaded. The address itself can still tell us something (an unrelated throwaway domain), and a bad certificate is worth knowing.
    const tls = await tlsProblem(base);
    const name = typeof lead.name === "string" ? lead.name : null;
    const fit = fitFlags([], typeof lead.website === "string" ? lead.website : null, { name, category: typeof lead.category === "string" ? lead.category : null, city: cityOf(typeof lead.address === "string" ? lead.address : ""), reviews_count: typeof lead.reviews_count === "number" ? lead.reviews_count : null, phone: typeof lead.phone === "string" ? lead.phone : null, tls_problem: tls });
    return { fields: { site_check: { facts: tls ? [{ key: "no_https", value: true, evidence: { url: base.toString(), text: "The site's security certificate is not valid." } }] : [], checked_at: checkedAt, error: tls ? "website has an invalid security certificate, so it did not load" : "website did not load (it may block automated visits)", needs_browser: !tls, needs_browser_reason: tls ? null : "The site did not load for a plain download; a browser may open it", tls_problem: tls || undefined, lead_gen_listing: fit.lead_gen_listing, real_trade: realTrade(typeof lead.category === "string" ? lead.category : null, name) } }, emails: [], fetched: 0, tried };
  }
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
  return { location: sq?.location ?? null, query: [c?.query ?? "", ...(Array.isArray(sq?.searchTerms) ? sq!.searchTerms! : [])].join(" "), anyTrade: c?.any_trade !== false };
}

/**
 * Counters and status come from the emails themselves. The stored counters were bumped by
 * whichever handler wrote the campaign record last (send, webhooks, draft jobs), and those
 * writes overwrote each other (e.g. 7 sent emails still showing "ready" and 0 sent).
 */
function deriveCampaign<T extends Record<string, unknown>>(c: T, emails: Array<{ status?: string; click_count?: number; own_reply_only?: boolean }>): T {
  if (emails.length === 0) return c;
  const sent = emails.filter((e) => e.status && e.status !== "drafted").length;
  const queued = emails.length - sent;
  const out: Record<string, unknown> = {
    ...c,
    emails_generated: emails.length,
    emails_sent: sent,
    emails_delivered: emails.filter((e) => ["delivered", "clicked", "replied"].includes(e.status ?? "")).length,
    emails_clicked: emails.filter((e) => e.status === "clicked" || (e.click_count ?? 0) > 0).length, // a reply is not a click
    // A reply that only came from Lakshmi's own address (a test) does not count.
    emails_replied: emails.filter((e) => e.status === "replied" && !e.own_reply_only).length,
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

async function campaignEmails(id: string): Promise<Array<{ status?: string; click_count?: number; own_reply_only?: boolean }>> {
  const [emails, replies] = await Promise.all([
    listJsonFast<{ id?: string; status?: string; click_count?: number }>(store(OUTREACH_EMAILS), `${id}/`),
    listJsonFast<{ original_email_id?: string | null; is_test?: boolean; from?: string | null }>(store(OUTREACH_REPLIES), `${id}/`),
  ]);
  const ownOnly = ownReplyEmailIds(replies);
  return emails.map((e) => (e.id && ownOnly.has(e.id) ? { ...e, own_reply_only: true } : e));
}

// ── P2: the campaign actions on Postgres ───────────────────────────────
// Only when DATA_BACKEND=sql (P2 tests; the switch at P5). Unset or any other value keeps the Blobs code below each
// case, unchanged. The SQL modules load only on this path, so the Blobs path never opens a database connection.
const sqlBackend = (): boolean => process.env.DATA_BACKEND === "sql";

async function sqlCampaignCase(action: import("./lib/sql/campaigns.ts").CampaignAction, params: unknown, identity: Awaited<ReturnType<typeof identifyApiKey>>) {
  const [{ withTx }, campaigns] = await Promise.all([import("./lib/db/client.ts"), import("./lib/sql/campaigns.ts")]);
  const ctx = { newId: () => nanoid(12), createdBy: identity?.kind === "agent" ? identity.agent_id : null };
  try {
    return ok(await withTx((tx) => campaigns.runCampaignAction(tx, action, (params ?? {}) as Record<string, unknown>, ctx)));
  } catch (e) {
    if (e instanceof campaigns.CampaignError) return fail(e.status, e.message);
    throw e;
  }
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

  const campaign = await readCampaign<CampaignRecord>(campaign_id);
  if (!campaign) return draftFail(404, "campaign not found");

  // Normalize framework + step inputs. Default = one-off at step 1.
  const fw = typeof framework === "string" && ["pas", "aida", "sdr", "four-step"].includes(framework) ? (framework as "pas" | "aida" | "sdr" | "four-step") : "one-off";
  const stepNum = typeof step === "number" && step >= 1 && step <= 5 ? Math.floor(step) : 1;
  const totalNum = fw === "four-step" ? 4 : typeof total_steps === "number" && total_steps >= 1 && total_steps <= 5 ? Math.floor(total_steps) : fw === "one-off" ? 1 : 3;

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
  const existingEmails = await listJson<{ id: string; lead_id: string; sequence_position?: number; subject?: string; body_text?: string }>(es, `${campaign_id}/`);
  const existing = existingEmails.find((e) => e.lead_id === lead_id && (e.sequence_position ?? 1) === stepNum);
  if (existing) return { ok: true, data: { ...existing, skipped: true } };

  // Alcance 4-step: one call writes all four emails (the other steps are saved now, so later steps find them here).
  if (fw === "four-step") {
    try {
      const have = new Set(existingEmails.filter((e) => e.lead_id === lead_id).map((e) => e.sequence_position ?? 1));
      const rows = await writeFourStepRows({ campaign_id, lead, sender_name: typeof sender_name === "string" ? sender_name : undefined, offer: (typeof sender_offer === "string" && sender_offer.trim()) || DEFAULT_OFFER, have, ai: p.ai ?? {} });
      const rec = rows.find((r) => r.sequence_position === stepNum) ?? rows[0];
      if (!rec) return draftFail(500, "No email was written");
      const prev = await readState(campaign_id);
      await patchState(campaign_id, {
        default_sender_name: (typeof sender_name === "string" && sender_name) || (prev.default_sender_name as string | undefined) || (campaign.default_sender_name as string | undefined) || null,
        default_sender_company: (typeof sender_company === "string" && sender_company) || (prev.default_sender_company as string | undefined) || (campaign.default_sender_company as string | undefined) || null,
        default_sender_offer: (typeof sender_offer === "string" && sender_offer) || (prev.default_sender_offer as string | undefined) || (campaign.default_sender_offer as string | undefined) || null,
        default_framework: fw,
        default_sequence_total: 4,
      });
      return { ok: true, data: rec };
    } catch (err) {
      if (err instanceof GeminiError) {
        const status = err.kind === "daily_quota" || err.kind === "rate_limited" ? 429 : err.kind === "unavailable" ? 503 : err.kind === "timeout" ? 504 : 502;
        return draftFail(status, err.message, err.kind, err.retryAfterS);
      }
      const msg = err instanceof Error ? err.message : "Draft failed";
      return draftFail(/add a free asset/.test(msg) ? 400 : 500, msg, /add a free asset/.test(msg) ? "settings_missing" : undefined);
    }
  }

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
    const firstOnes = existingEmails.filter((e) => (e.sequence_position ?? 1) === 1);
    // Drafts made earlier in this run may not be listed yet (reads lag): remember them here too.
    const seenIds = new Set(firstOnes.map((e) => e.id));
    const priorFirst = [...firstOnes.map((e) => ({ subject: e.subject ?? "", body: e.body_text ?? "" })), ...(firstDraftMemo.get(campaign_id) ?? []).filter((m) => !seenIds.has(m.id))].filter((o) => o.body);
    if (!isSeq) {
      // First email: the code picks the one confident fact and angle, a small model writes it.
      const others = priorFirst;
      const sameStep = Math.max(firstOnes.length, others.length);
      const first = await generateFirstEmail(
        { ...(lead as FirstEmailLead), site_check: (lead.site_check as Record<string, unknown> | null | undefined) ?? null },
        { sender_offer: typeof sender_offer === "string" ? sender_offer : undefined },
        { draftsSoFar: sameStep, any_trade: campaign.any_trade !== false, query: String(campaign.query ?? ""), others },
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
          hours_summary: (lead.site_check as { hours_usable?: boolean } | undefined)?.hours_usable === false ? null : leadHours(lead as Parameters<typeof leadHours>[0])?.summary ?? null,
        },
        {
          sender_name: typeof sender_name === "string" ? sender_name : undefined,
          sender_company: typeof sender_company === "string" ? sender_company : undefined,
          sender_offer: typeof sender_offer === "string" ? sender_offer : undefined,
          campaign_query: campaign.query as string,
          any_trade: campaign.any_trade !== false,
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
      const outcome = await reviewDraft(record as unknown as ReviewableEmail, lead as ReviewLead & Record<string, unknown>, p.ai ?? {}, { offer: (typeof sender_offer === "string" && sender_offer.trim()) || DEFAULT_OFFER, others: priorFirst });
      Object.assign(record, reviewFields(outcome));
    } else {
      Object.assign(record, { review_status: "check", review_reasons: ["Not reviewed yet"], reviewed_by: null, reviewed_at: null });
    }
    await writeJson(es, `${campaign_id}/${createdAt}-${emailId}`, record);
    if (stepNum === 1) firstDraftMemo.set(campaign_id, [...(firstDraftMemo.get(campaign_id) ?? []), { id: emailId, subject: draft.subject, body: draft.body_text }].slice(-60));
    // Remember the sender context + default framework (runtime state; campaign settings are not touched).
    const prev = await readState(campaign_id);
    await patchState(campaign_id, {
      default_sender_name: (typeof sender_name === "string" && sender_name) || (prev.default_sender_name as string | undefined) || (campaign.default_sender_name as string | undefined) || null,
      default_sender_company: (typeof sender_company === "string" && sender_company) || (prev.default_sender_company as string | undefined) || (campaign.default_sender_company as string | undefined) || null,
      default_sender_offer: (typeof sender_offer === "string" && sender_offer) || (prev.default_sender_offer as string | undefined) || (campaign.default_sender_offer as string | undefined) || null,
      default_framework: fw,
      default_sequence_total: totalNum,
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
async function planDraftPairs(campaign_id: string, framework: unknown, hints?: unknown): Promise<{ pairs: PlannedPair[]; totalSteps: number; fw: "one-off" | "pas" | "aida" | "sdr" | "four-step" }> {
  const campaign = await readCampaign<CampaignRecord>(campaign_id);
  if (!campaign) throw new Error("campaign not found");
  const fw = typeof framework === "string" && ["pas", "aida", "sdr", "four-step"].includes(framework) ? (framework as "pas" | "aida" | "sdr" | "four-step") : "one-off";
  const totalSteps = fw === "one-off" ? 1 : fw === "four-step" ? 4 : 3;
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
    if (fw === "four-step") {
      // ONE writer call per lead writes all four emails: one pair per lead that still lacks any of them.
      const first = [1, 2, 3, 4].find((st) => !have.has(`${l.id}__${st}`));
      if (first) pairs.push({ lead: l, step: first });
      continue;
    }
    for (let step = 1; step <= totalSteps; step++) if (!have.has(`${l.id}__${step}`)) pairs.push({ lead: l, step });
  }
  // All step 1 first, then step 2, then step 3 (PAS, AIDA, SDR): later steps refer back to earlier ones.
  pairs.sort((a, b) => a.step - b.step || a.lead.id.localeCompare(b.lead.id));
  return { pairs, totalSteps, fw };
}

// ── Campaign runtime state (batch 7) ──────────────────────────────────
// Background jobs used to read the WHOLE campaign record and write it back. With Blobs reads up to a
// minute stale, that undid recent settings changes (e.g. "Home services, any trade"). Now the running
// job, the browser-checked ids and the sender defaults live in their own record per campaign; jobs
// only write that record, and campaign settings are only written by campaign.update.
const STATE_KEYS = ["job", "browser_checked_ids", "default_sender_name", "default_sender_company", "default_sender_offer", "default_framework", "default_sequence_total"] as const;

async function readState(campaign_id: string): Promise<Record<string, unknown>> {
  return (await readJson<Record<string, unknown>>(store(OUTREACH_STATE), campaign_id)) ?? {};
}

/** Merge a patch into the campaign's state record (read, merge, write). */
async function patchState(campaign_id: string, patch: Record<string, unknown>): Promise<void> {
  const cur = await readState(campaign_id);
  await writeJson(store(OUTREACH_STATE), campaign_id, { ...cur, ...patch, updated_at: new Date().toISOString() });
}

/** A campaign record with its runtime state laid over it (state wins; old records that still hold the fields inline keep working). */
function withState<T extends Record<string, unknown>>(c: T, st: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...c };
  for (const k of STATE_KEYS) if (k in st) out[k] = st[k];
  return out as T;
}

async function readCampaign<T extends Record<string, unknown> = CampaignRecord & Record<string, unknown>>(campaign_id: string): Promise<T | null> {
  const c = await readJson<T>(store(OUTREACH_CAMPAIGNS), campaign_id);
  if (!c) return null;
  return withState(c, await readState(campaign_id));
}

// What this run has already written to the job. Blobs reads can be a little stale, so a patch
// is merged onto this memory too; otherwise a stale read could wipe the run's earlier progress.
const jobMemo = new Map<string, Record<string, unknown>>();

async function patchJob(campaign_id: string, patch: Record<string, unknown>): Promise<void> {
  const st = await readState(campaign_id);
  const memo = { ...(jobMemo.get(campaign_id) ?? {}), ...patch };
  jobMemo.set(campaign_id, memo);
  await writeJson(store(OUTREACH_STATE), campaign_id, { ...st, job: { ...(st.job as object | undefined), ...memo, progress_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
}

/**
 * The page records the job and then calls the background function straight away, so the function can
 * read the campaign before the new job is visible (Blobs reads are eventually consistent) and used to
 * exit without doing anything. Wait up to ~30 s for the matching running job to appear.
 */
async function waitForJob(campaign_id: string, kind: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const c = await readCampaign<CampaignRecord & { job?: { status?: string; kind?: string } }>(campaign_id);
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

/** Pause a job that hit Gemini's daily limit: keep the place, say when it resumes (next midnight Pacific). */
async function pauseJobForQuota(campaign_id: string, resumeParams: Record<string, unknown>, extra: Record<string, unknown>): Promise<void> {
  const at = resumeAtFor();
  await patchJob(campaign_id, {
    ...extra,
    status: "paused",
    paused_reason: "gemini_daily_limit",
    resume_at: at.toISOString(),
    resume_params: resumeParams,
    message: `Paused: Gemini daily limit reached. Resumes automatically at ${istText(at)} India time (or press Resume now).`,
  });
}

/**
 * Reviews saved drafts of one campaign: free code checks first, then the AI in groups of up to 5 per call.
 * A draft sent back to the writer gets exactly one call. A daily Gemini limit throws (the caller pauses).
 */
async function reviewRows(campaign_id: string, todo: Array<{ key: string; row: Record<string, unknown> & { id: string } }>, ai: GeminiAiOpts, onDone: (n: number) => Promise<void> | void): Promise<void> {
  if (todo.length === 0) return;
  let onDoneBase = 0;
  // Alcance 4-step rows are checked per lead (all four emails together) by their own reviewer.
  const a3 = todo.filter((t) => t.row.framework === "four-step");
  if (a3.length > 0) {
    let a3done = 0;
    await reviewFourStepRows(campaign_id, a3, ai, async (n) => { a3done = n; await onDone(n); });
    todo = todo.filter((t) => t.row.framework !== "four-step");
    if (todo.length === 0) return;
    onDoneBase = a3done;
  }
  const es = store(OUTREACH_EMAILS);
  const campaign = await readCampaign<CampaignRecord & Record<string, unknown>>(campaign_id);
  const offer = ((await readState(campaign_id)).default_sender_offer as string | undefined)?.trim() || (await readOutreachSettings()).default_sender_offer?.trim() || DEFAULT_OFFER;
  const allFirst = (await listJson<{ id: string; created_at?: string; sequence_position?: number; subject?: string; body_text?: string }>(es, `${campaign_id}/`)).filter((e) => (e.sequence_position ?? 1) === 1 && e.body_text).sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const byId = new Map(todo.map((t) => [t.row.id, t]));
  const items: ReviewItem[] = [];
  let skipped = 0;
  for (const { row } of todo) {
    const found = await findLeadRow(campaign_id, String(row.lead_id));
    if (!found) { skipped++; continue; }
    const earlier = allFirst.filter((e) => String(e.created_at ?? "") < String(row.created_at ?? "") && e.id !== row.id).map((e) => ({ subject: e.subject ?? "", body: e.body_text ?? "" }));
    const lead = found.lead as ReviewLead & Record<string, unknown>;
    const oneOff = !row.framework || row.framework === "one-off";
    const redraft = oneOff && (Number(row.sequence_position ?? 1) <= 1)
      ? async (failures: string[]) => {
          const g = await generateFirstEmail({ ...(lead as FirstEmailLead), site_check: (lead.site_check as Record<string, unknown> | null | undefined) ?? null }, { sender_offer: offer }, { draftsSoFar: earlier.length, any_trade: campaign?.any_trade !== false, query: String(campaign?.query ?? ""), others: earlier, priorFailures: failures }, ai);
          return { subject: g.draft.subject, body: g.draft.body_text };
        }
      : undefined;
    items.push({ id: row.id, email: row as unknown as ReviewableEmail, lead, rctx: { offer, others: earlier, redraft } });
  }
  let done = onDoneBase + skipped;
  if (skipped) await onDone(done);
  await reviewMany(items, ai, async (id, outcome) => {
    const t = byId.get(id);
    if (!t) return;
    // Re-read: if the draft was edited or sent while the reviewer worked, the verdict no longer applies.
    const fresh = await readJson<Record<string, unknown>>(es, t.key);
    if (fresh && fresh.status === "drafted" && fresh.updated_at === t.row.updated_at) {
      await writeJson(es, t.key, { ...fresh, ...reviewFields(outcome, fresh.review_history), updated_at: new Date().toISOString() });
    }
    done++;
    await onDone(done);
  });
}

/** The drafting job: one email at a time with a pause between (free Gemini tier), reviewed in groups of up to 5, progress written as it goes. */
export async function runDraftJob(p: DraftJobParams & { resume?: boolean }): Promise<void> {
  const { campaign_id } = p;
  if (!(await waitForJob(campaign_id, "generate"))) return; // nothing was started
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const stats = newStats();
  const ai: GeminiAiOpts = { ...BACKGROUND_AI, stats };
  let done = 0;
  let made = 0;
  let stopped: string | null = null;
  let paused = false;
  const failures: Array<{ name: string; error: string }> = [];
  const pending: Array<{ key: string; row: Record<string, unknown> & { id: string } }> = [];
  const resumeParams = { campaign_id, sender_name: p.sender_name, sender_company: p.sender_company, sender_offer: p.sender_offer, framework: p.framework, resume: true };
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      await reviewRows(campaign_id, batch, ai, () => undefined);
    } catch (err) {
      if (err instanceof GeminiError && err.kind === "daily_quota") { paused = true; return; }
      throw err;
    }
  };
  try {
    // A resumed run first reviews the drafts that were written before the pause but never reviewed.
    if (p.resume) pending.push(...(await planReview(campaign_id, undefined, { onlyUnreviewed: true })));
    const { pairs, totalSteps, fw } = await planDraftPairs(campaign_id, p.framework, p.leads);
    const contacts = await loadContacts();
    for (let i = 0; i < pairs.length && !stopped && !paused; i++) {
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
          ai,
          contacts,
          review: false, // reviewed in groups below
        });
        if (r.ok) {
          const rec = r.data as Record<string, unknown> & { id: string; created_at?: string; status?: string; skipped?: boolean; framework?: string };
          made += fw === "four-step" ? (rec.skipped ? 0 : 4) : 1; // for 4-step, "made" counts emails (4 per lead)
          if (rec && !rec.skipped && rec.created_at && rec.framework !== "four-step") pending.push({ key: `${campaign_id}/${rec.created_at}-${rec.id}`, row: rec });
          break;
        }
        if (r.code === "daily_quota") { paused = true; break; }
        if ((r.code === "rate_limited" || r.code === "unavailable") && attempt < 4) { await sleep(Math.min(60, r.retry_after ?? 10) * 1000 + 500); continue; }
        failures.push({ name: String(lead.name ?? lead.id), error: r.error });
        break;
      }
      if (!paused) { done++; await patchJob(campaign_id, { done, made, calls: stats }); }
      if (!paused && pending.length >= REVIEW_BATCH) await flush();
    }
    if (!paused) await flush();
  } catch (err) {
    stopped = err instanceof Error ? err.message : "Drafting failed";
  }
  if (paused) {
    await pauseJobForQuota(campaign_id, resumeParams, { done, made, calls: stats });
    return;
  }
  await patchJob(campaign_id, {
    status: stopped ? "stopped" : "done",
    done,
    made,
    calls: stats,
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
  const campaign = await readCampaign<CampaignRecord & { browser_checked_ids?: string[] }>(campaign_id);
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

/** Why a lead is marked "Not a fit" (stored as excluded_reason on the lead). */
/** Gap scores under this get a "Low gap" hint and are left out of the bulk social run. */
const LOW_GAP = 30;
const NOT_FIT_REASONS = ["wholesaler", "lead_gen", "not_home_service", "has_chat_booking", "chain", "other"];

/**
 * The reason HQ itself would skip or flag this lead, in the same words as the Not a fit dropdown; null when nothing is off.
 * `hide` = the Prospects page hides it; false = it stays visible with a "check" flag. Lead-gen follows the batch 8c rule
 * (under 10 reviews, a sign, not contacted); every other rule hides only a lead nobody has contacted.
 */
function autoNotFit(lead: Record<string, unknown>, ctx: ReturnType<typeof campaignSkipCtx>, contacted = false): { code: string; detail: string; hide: boolean; why: "contacted" | "reviews" | null } | null {
  if (lead.not_fit_kept === true) return null;
  const other = (code: string, detail: string) => ({ code, detail, ...otherRuleDecision({ code, detail }, contacted) });
  const why = leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], { ...ctx });
  if (why && why.code !== "excluded") return other(why.code === "chain" ? "chain" : "other", why.message.replace(/^Skipped: /, ""));
  const sc = (lead.site_check ?? {}) as { not_home_service?: string | null; lead_gen_listing?: string | null };
  if (sc.not_home_service) return other(/wholesal|distribut|supplier/i.test(sc.not_home_service) ? "wholesaler" : "not_home_service", sc.not_home_service);
  const lg = leadGenDecision(lead as Parameters<typeof leadGenDecision>[0], contacted);
  if (lg) return { code: "lead_gen", detail: lg.reasons.join("; "), hide: lg.hide, why: lg.why };
  const cf = categoryFitFlag(typeof lead.category === "string" ? lead.category : null);
  if (cf) return other("not_home_service", cf);
  return null;
}

async function patchLeadFields(campaign_id: string, lead_id: string, patch: Record<string, unknown>): Promise<void> {
  const found = await findLeadRow(campaign_id, lead_id);
  if (!found) return;
  await writeJson(store(OUTREACH_LEADS), found.key, { ...found.lead, ...patch, updated_at: new Date().toISOString() });
}

export async function runBrowserJob(p: { campaign_id: string; lead_ids: string[] }): Promise<void> {
  const { campaign_id } = p;
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
    const shots = screenshotsByLead(items);
    const shotErrors = screenshotErrorsByLead(items);
    const checkedIds = new Set(((await readState(campaign_id)).browser_checked_ids as string[] | undefined) ?? (await readCampaign<{ browser_checked_ids?: string[] }>(campaign_id))?.browser_checked_ids ?? []);
    for (const lead of leads) {
      const pages = byLead.get(lead.id);
      const nowIso = new Date().toISOString();
      if (pages && pages.length > 0) {
        const res = await analyzeSite(lead, pages, "browser");
        const shot = shots.get(lead.id);
        // No picture: say why (a failed screenshot, or the homepage did not load in the browser), so it is never a silent gap.
        if (!shot) (res.fields.site_check as Record<string, unknown>).screenshot_error = shotErrors.get(lead.id) ?? "The browser did not load the homepage, so there is no picture.";
        if (shot) {
          try {
            const bytes = Math.floor((shot.length * 3) / 4);
            await writeJson(store(LEAD_SCREENSHOTS), `${campaign_id}/${lead.id}`, { jpeg_base64: shot, saved_at: nowIso, bytes });
            (res.fields.site_check as Record<string, unknown>).screenshot = { saved_at: nowIso, bytes };
          } catch { /* the check still counts without the picture */ }
        }
        await patchLeadFields(campaign_id, lead.id, { ...res.fields, browser_checked_at: nowIso });
        checkedIds.add(lead.id);
      } else {
        // Keep the plain result, but say it is still uncertain so drafting and the reviewer do not trust gaps.
        const sc = (lead.site_check ?? {}) as Record<string, unknown>;
        await patchLeadFields(campaign_id, lead.id, { site_check: { ...sc, needs_browser: true, needs_browser_reason: "The browser check could not open this site", browser_error: "no pages loaded", browser_attempted_at: nowIso } });
      }
    }
    await patchState(campaign_id, { browser_checked_ids: [...checkedIds] });
    if (status !== "SUCCEEDED") stopped = `The browser run ended early (${status}${runMessage ? `: ${runMessage}` : ""}). Leads without results stay marked "needs browser check".`;
    else if (leads.every((l) => !byLead.get(l.id)?.length)) stopped = `The browser could not open the websites (run ${status}${runMessage ? `: ${runMessage}` : ""}). Leads stay marked "needs browser check"; drafting still works.`;
  } catch (err) {
    stopped = err instanceof Error ? err.message : "Browser check failed";
  }
  await patchJob(campaign_id, { status: stopped ? "stopped" : "done", done, finished_at: new Date().toISOString(), message: stopped ?? undefined });
}

// ── Social messages (Facebook, Instagram, LinkedIn) ───────────────────
// The user copies and sends these by hand. Same order as emails: free code checks, one writer retry at most,
// then the AI reviewer in groups of up to 5, then at most ONE rewrite in total.

type SocialRecord = {
  id: string; // `${lead_id}-${channel}`
  campaign_id: string;
  lead_id: string;
  channel: SocialChannel;
  url: string;
  parts: SocialPart[];
  status: "drafted" | "sent";
  review_status: ReviewStatus | null;
  review_reasons: string[];
  reviewed_by: string | null;
  reviewed_at?: string;
  rewrites_used: number;
  fact_used: number | null;
  draft_facts: Fact[];
  angle: string;
  written_by: string;
  review_history?: Array<{ at: string; status: string; reasons: string[] }>;
  created_at: string;
  updated_at: string;
  sent_at?: string | null;
  type?: SocialType;
  mentions_email?: boolean;
  email_date?: string | null;
};

const socialKey = (campaign_id: string, lead_id: string, channel: string) => `${campaign_id}/${lead_id}/${channel}`;
const writeTouch = (t: Touch) => writeJson(store(OUTREACH_TOUCHES), `${t.lead_id}/${t.sent_at}-${t.id}`, t);
/** A message marked sent before batch 8b sits in the draft slot. Before a new message overwrites it, keep it as a touch of its own (same id, so it never counts twice). */
async function archiveLegacySent(campaign_id: string, lead_id: string, channel: string): Promise<void> {
  const rec = await readJson<SocialRecord>(store(OUTREACH_SOCIAL), socialKey(campaign_id, lead_id, channel));
  if (!rec || rec.status !== "sent" || !rec.sent_at) return;
  const ref = legacySocialRef(campaign_id, lead_id, channel);
  await writeTouch(touchFromSent({ id: ref, lead_id, campaign_id, channel: channel as TouchChannel, kind: rec.type && rec.type !== "first" ? "follow_up" : "first", sent_at: rec.sent_at, text: rec.parts.map((p) => p.text).filter(Boolean).join("\n\n"), source: "hq", ref }));
}
const partsMap = (parts: SocialPart[]): Record<string, string> => Object.fromEntries(parts.map((p) => [p.key, p.text]));

type SocialPlanItem = { lead: Record<string, unknown> & { id: string }; channel: SocialChannel; url: string; type: SocialType; sentOnChannel: boolean; emailDate?: string | null; earlier?: string | null; earlierList?: EarlierMessage[]; emailList?: EarlierEmail[] };
type SocialSkip = { lead_id: string; name: string; reason: string; channel?: string };

const OUTREACH_FOLLOWUPS = "agent-hq-outreach-followups"; // key: `<lead_id>/<channel>` and `<lead_id>/all` (batch 8c): skips, notes, moved dates, LinkedIn accepted/withdrawn, "they replied"
const OUTREACH_TOUCHES = "agent-hq-outreach-touches"; // contact history entries: key `<lead_id>/<sent_at>-<id>` (batch 8b)

/** Stored touches (those added by "Mark as sent" and "Record a message sent by hand"), grouped by lead. */
async function storedTouchesByLead(leadIds?: Set<string>): Promise<Map<string, Touch[]>> {
  const all = await listJson<Touch>(store(OUTREACH_TOUCHES), "");
  const m = new Map<string, Touch[]>();
  for (const t of all) { if (leadIds && !leadIds.has(t.lead_id)) continue; (m.get(t.lead_id) ?? m.set(t.lead_id, []).get(t.lead_id)!).push(t); }
  return m;
}

/**
 * Which (lead, channel) pairs get a message, and what is skipped and why.
 * A sent email no longer blocks a social message; a reply, do-not-contact, not-fit and a missing page do.
 * With no lead ids (the bulk run) every lead with a saved page qualifies, emailed or not; a lead on its own may start by hand
 * without a finished website check (manualStart), which the bulk run never does.
 */
async function planSocial(campaign_id: string, leadIds?: string[], channels?: string[], opts: { regenerate?: boolean; type?: string; manualStart?: boolean; since?: string } = {}): Promise<{ items: SocialPlanItem[]; skipped: SocialSkip[] }> {
  const campaign = await readCampaign<CampaignRecord>(campaign_id);
  if (!campaign) throw new Error("campaign not found");
  const ctx = campaignSkipCtx(campaign);
  const leads = await listJson<Record<string, unknown> & { id: string }>(store(OUTREACH_LEADS), `${campaign_id}/`);
  const emails = await listJson<{ id: string; lead_id: string; status?: string; sent_at?: string; created_at?: string; sequence_position?: number; subject?: string; body_text?: string }>(store(OUTREACH_EMAILS), `${campaign_id}/`);
  const replies = await listJson<{ lead_id?: string | null; original_email_id?: string | null; is_test?: boolean; from?: string | null }>(store(OUTREACH_REPLIES), "");
  const ownOnly = ownReplyEmailIds(replies.filter((r) => r.original_email_id));
  const repliedLeads = new Set<string>([
    ...emails.filter((e) => e.status === "replied" && !ownOnly.has(e.id)).map((e) => e.lead_id),
    ...replies.filter((r) => r.lead_id && !isTestReply(r)).map((r) => String(r.lead_id)),
  ]);
  const socials = await listJson<SocialRecord>(store(OUTREACH_SOCIAL), `${campaign_id}/`);
  const existing = new Map(socials.map((r) => [`${r.lead_id}/${r.channel}`, r]));
  const stored = await storedTouchesByLead();
  const want = leadIds && leadIds.length ? new Set(leadIds) : null;
  const wantChannels = channels && channels.length ? new Set(channels) : null;
  const items: SocialPlanItem[] = [];
  const skipped: SocialSkip[] = [];
  for (const lead of leads) {
    if (want && !want.has(lead.id)) continue;
    const name = String(lead.name ?? lead.id);
    const links = channelsFor(lead as Parameters<typeof channelsFor>[0]);
    const chans = links.filter((c) => !wantChannels || wantChannels.has(c.channel));
    if (chans.length === 0) { if (want) skipped.push({ lead_id: lead.id, name, reason: wantChannels ? "No saved page on that channel" : "No saved Facebook, Instagram or LinkedIn page" }); continue; }
    const touches = deriveTouches({ lead_id: lead.id, campaign_id, emails, socials, stored: stored.get(lead.id) ?? [] });
    const contacted = isContacted({ emailSent: touches.some((t) => t.channel === "email"), emailDraft: emails.some((e) => e.lead_id === lead.id && (e.status ?? "drafted") === "drafted"), touches: touches.length, replied: repliedLeads.has(lead.id) });
    const reason = socialSkipReason(lead as Parameters<typeof socialSkipReason>[0], ctx, { replied: repliedLeads.has(lead.id), manualStart: !!want && opts.manualStart === true, contacted });
    if (reason) { skipped.push({ lead_id: lead.id, name, reason }); continue; }
    // The bulk run leaves out low-gap leads (a hint, not a rule: writing for one lead on its own still works).
    if (!want && typeof lead.gap_score === "number" && lead.gap_score < LOW_GAP) { skipped.push({ lead_id: lead.id, name, reason: `low gap (${lead.gap_score}, under ${LOW_GAP})` }); continue; }
    const hasEmailSent = touches.some((t) => t.channel === "email");
    for (const c of chans) {
      const have = existing.get(`${lead.id}/${c.channel}`);
      if (have && have.status !== "sent" && !opts.regenerate) { skipped.push({ lead_id: lead.id, name, channel: c.channel, reason: "Already has a message ready" }); continue; }
      // A continued "Rewrite existing" run leaves out the messages it already rewrote before it paused.
      if (have && have.status !== "sent" && opts.since && have.created_at >= opts.since) { skipped.push({ lead_id: lead.id, name, channel: c.channel, reason: "Already rewritten in this run" }); continue; }
      const sentOnChannel = touches.some((t) => t.channel === c.channel) || have?.status === "sent";
      const type = socialTypeFor(opts.type ?? "sequence", sentOnChannel); // no type given = the full written run (batch 8c); "first" still writes the older single message
      if (type === "follow_up_email" && !hasEmailSent) { skipped.push({ lead_id: lead.id, name, channel: c.channel, reason: "No email has been sent to this lead yet" }); continue; }
      const lastEmail = [...touches].reverse().find((t) => t.channel === "email");
      const lastOnChannel = [...touches].reverse().find((t) => t.channel === c.channel);
      const earlierList = touches.filter((t) => t.channel === c.channel && t.text).map((t) => ({ at: t.sent_at, text: t.text }));
      const emailList = touches.filter((t) => t.channel === "email").map((t) => ({ at: t.sent_at, subject: t.subject ?? null }));
      items.push({ lead, channel: c.channel, url: c.url, type, sentOnChannel, emailDate: lastEmail?.sent_at ?? null, earlier: lastOnChannel?.text ? lastOnChannel.text.slice(0, 600) : null, earlierList, emailList });
    }
  }
  return { items, skipped };
}

type SocialWriteCtx = { offer: string; anyTrade: boolean; query: string; others: string[]; draftsSoFar: number };

/**
 * Writes EVERY step of one channel in one call (Facebook/Instagram: first, follow-up, last; LinkedIn: note, first, follow-up, last), runs the free code
 * checks (ONE retry that lists the exact failures), then ONE AI review. Each step keeps its own status. Settings supplies the free asset and proof line.
 */
async function writeSocialSequence(campaign_id: string, item: SocialPlanItem, ctx: SocialWriteCtx, ai: GeminiAiOpts): Promise<SocialRecord> {
  const settings = await readOutreachSettings();
  const inp = resolveInputs(settings, String(item.lead.name ?? ""));
  if (!inp.freeAsset1) throw new Error("Check this: add a free asset in Settings");
  const lead = item.lead as Record<string, unknown>;
  const c = a3Context(lead);
  const li: SeqLeadInfo = { name: typeof lead.name === "string" ? lead.name : undefined, greeting: item.channel === "facebook" && !(lead.owner_confidence === "high" && lead.owner_name) ? "Hi there" : c.greeting, city: c.city, trade: c.trade, details: c.details.map((d) => d.text), facts: c.plan.facts.map((f) => ({ n: f.n, text: f.text })) };
  let hint = "";
  let texts: Record<string, string> = {};
  let checks: SocialStepCheck[] = [];
  let factUsed: number | null = null;
  let model = "";
  let calls = 0;
  const ratingElsewhere = await leadRatingUsed(String(lead.campaign_id ?? ""), String(lead.id ?? ""), { channel: item.channel }); // an email or another channel already states it
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const ans = await aiJson("draft", { system: SOCIAL_SEQ_SYSTEM_PROMPT, user: socialSeqUserPrompt(item.channel, li, inp, ctx.offer, hint || undefined, ratingElsewhere), temperature: 0.5 }, ai);
    model = ans.model;
    const parsed = parseSocialSeq(item.channel, ans.json);
    if (!parsed) { hint = "the answer did not contain every message in the JSON shape"; debugLog("social", { lead: lead.name, channel: item.channel, attempt: attempt + 1, code_failures: [hint] }); continue; }
    texts = parsed.texts;
    for (const k of Object.keys(texts)) if (k !== "note" && (k === "message" || k === "dm") && !texts[k].toLowerCase().startsWith(li.greeting.toLowerCase())) texts[k] = `${li.greeting},\n\n${texts[k].replace(/^hi[^,\n]*,\s*/i, "")}`;
    factUsed = parsed.fact_used;
    checks = checkSocialSeq(item.channel, texts, inp, { ratingElsewhere });
    const fails = socialFailureLines(checks);
    debugLog("social", { lead: lead.name, channel: item.channel, attempt: attempt + 1, parts: texts, code_failures: fails });
    if (fails.length === 0) break;
    hint = fails.join("; ");
  }
  if (checks.length === 0) throw new Error("The writer did not return the messages");
  let verdicts: ReturnType<typeof parseSocialReview> = [];
  try {
    const evidence = { business: lead.name ?? null, city: c.city, greeting_expected: li.greeting, google_rating: typeof lead.rating === "number" ? lead.rating : null, google_reviews: typeof lead.reviews_count === "number" ? lead.reviews_count : null, true_details: li.details, facts: li.facts.map((f) => f.text) };
    const rv = await aiJson("review", { system: SOCIAL_SEQ_REVIEW_PROMPT, user: JSON.stringify({ CHANNEL: item.channel, LEAD: lead.name ?? "", SAVED_EVIDENCE: evidence, MESSAGES: checks.map((k) => ({ step: k.key, text: texts[k.key] })), CODE_FINDINGS: checks.map((k) => ({ step: k.key, problems: k.reasons })) }), temperature: 0.1 }, ai);
    verdicts = parseSocialReview(rv.json);
  } catch (err) {
    if (err instanceof GeminiError && (err.kind === "daily_quota" || err.kind === "rate_limited")) throw err;
  }
  const RANKS = { ready: 0, check: 1, blocked: 2 } as const;
  const merged = checks.map((k) => ({ key: k.key, ...mergeSocial(k, verdicts) }));
  const worst = merged.reduce((w, m) => (RANKS[m.status] > RANKS[w] ? m.status : w), "ready" as "ready" | "check" | "blocked");
  const now = new Date().toISOString();
  return {
    id: `${item.lead.id}-${item.channel}`, campaign_id, lead_id: item.lead.id, channel: item.channel, url: item.url,
    parts: partsToList(item.channel, texts, "sequence").map((p) => { const m = merged.find((x) => x.key === p.key)!; return { ...p, sent_at: null, review_status: m.status, review_reasons: m.reasons }; }),
    status: "drafted", type: "sequence", review_status: worst, review_reasons: merged.flatMap((m) => m.reasons.map((r) => `${m.key === "message" ? "first" : m.key}: ${r}`)).slice(0, 6),
    reviewed_by: verdicts.length ? model : "code checks", rewrites_used: calls > 1 ? 1 : 0, fact_used: factUsed, draft_facts: c.plan.facts, angle: c.plan.angle.code, written_by: model,
    created_at: now, updated_at: now, sent_at: null,
  };
}

/** Writes one message: first answer plus, if the code checks fail, ONE retry listing the exact failures. Never reviewed here. */
async function writeSocialOne(campaign_id: string, item: SocialPlanItem, ctx: SocialWriteCtx, ai: GeminiAiOpts): Promise<SocialRecord> {
  if (item.type === "sequence") return writeSocialSequence(campaign_id, item, ctx, ai);
  const lead = item.lead as ReviewLead & Record<string, unknown>;
  const plan = pickAngle(lead as Parameters<typeof pickAngle>[0]);
  const details = leadDetails(lead as Parameters<typeof leadDetails>[0]);
  const greeting = greetingFor(lead as Parameters<typeof greetingFor>[0]) ?? "Hi there";
  const realTradeNow = ((lead.site_check as { real_trade?: string | null } | null | undefined)?.real_trade) ?? realTrade(lead.category as string | null, lead.name as string | null);
  const trade = realTradeNow ?? (ctx.anyTrade ? "home services" : (String(lead.category ?? "") || ctx.query || "home services")).slice(0, 60);
  const user = [
    `CHANNEL: ${item.channel}`,
    `MESSAGE_TYPE: ${item.type}`,
    ...(item.type === "follow_up_email" && item.emailDate && !(item.emailList ?? []).length ? [`EMAIL SENT ON: ${item.emailDate.slice(0, 10)} (mention it naturally; never write \"following up\")`] : []),
    ...socialContextLines(item.type, item.earlierList ?? (item.earlier ? [{ at: "", text: item.earlier }] : []), item.emailList ?? [], new Date().toISOString()),
    `LIMITS: ${limitsText(item.channel, item.type)}`,
    `BUSINESS: ${lead.name ?? "the business"}`,
    `GREETING: ${greeting}`,
    `CITY: ${cityOf(lead.address as string | null) || "(unknown)"}`,
    `TRADE: ${trade}`,
    details.length ? `TRUE DETAILS ABOUT THEM:\n${details.map((d, i) => `${i + 1}. ${d.text}`).join("\n")}` : "TRUE DETAILS ABOUT THEM:\n(none)",
    plan.facts.length ? `FACTS YOU MAY USE:\n${plan.facts.map((f) => `${f.n}. ${f.text}`).join("\n")}` : "FACTS YOU MAY USE:\n(none: claim nothing about their business)",
    `ANGLE: ${plan.angle.line}`,
    `OFFER (background only, rewrite in your own words, never paste it): "${ctx.offer}"`,
  ].join("\n");
  const checks = { type: item.type, phoneOnlyOk: plan.angle.code === "phone_only", callsOnly: plan.calls_only ?? callsOnly(plan.angle.code), noHours: plan.no_hours === true, trade: realTradeNow, copySources: [ctx.offer, ...EXAMPLE_BODIES] }; // short messages may share a plain offer sentence, so they are not compared with each other
  let failures: string[] = [];
  let ans: AiJsonResult | null = null;
  let parts: Record<string, string> = {};
  let factUsed: number | null = null;
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const prompt = failures.length === 0 ? user : `${user}\n\nYOUR LAST ANSWER FAILED THESE CHECKS: ${failures.join("; ")}. Write it again and fix them. Output JSON only.`;
    ans = await aiJson("draft", { system: SOCIAL_SYSTEM_PROMPT, user: prompt, temperature: 0.5 }, ai);
    const o = (ans.json && typeof ans.json === "object" ? ans.json : {}) as Record<string, unknown>;
    parts = partsFromAnswer(item.channel, o, item.type);
    factUsed = normalizeFactUsed(o.fact_used, plan.facts.length);
    failures = precheckSocial(item.channel, parts, { ...checks, factCount: plan.facts.length, factUsed });
    for (const k of Object.keys(parts)) if (k !== "note" && parts[k] && !parts[k].toLowerCase().startsWith(greeting.toLowerCase())) failures.push(`${k === "dm" ? "the first message" : "the message"} must start with "${greeting},"`);
    debugLog("social", { lead: lead.name, channel: item.channel, attempt: attempt + 1, parts, code_failures: failures });
    if (failures.length === 0) break;
  }
  const now = new Date().toISOString();
  return {
    id: `${item.lead.id}-${item.channel}`, campaign_id, lead_id: item.lead.id, channel: item.channel, url: item.url,
    parts: partsToList(item.channel, parts, item.type), status: "drafted", type: item.type, mentions_email: item.type === "follow_up_email", email_date: item.emailDate ?? null,
    review_status: failures.length ? "check" : null,
    review_reasons: failures.map((f) => `Code check: ${f}`).slice(0, 6),
    reviewed_by: failures.length ? "code checks" : null,
    rewrites_used: calls > 1 ? 1 : 0, fact_used: factUsed, draft_facts: plan.facts, angle: plan.angle.code, written_by: ans?.model ?? "",
    created_at: now, updated_at: now, sent_at: null,
  };
}

type SocialVerdict = { verdict: ReviewStatus; problem: string; reasons: string[]; rewrite: Record<string, string> | null; model: string };

/** One reviewer call for up to 5 social messages; entries the model skipped are asked again on their own, once. */
async function askSocialBatch(entries: Array<{ rec: SocialRecord; lead: ReviewLead & Record<string, unknown> }>, ai: GeminiAiOpts, offer: string, retry = true): Promise<Map<string, SocialVerdict | null>> {
  const out = new Map<string, SocialVerdict | null>();
  if (entries.length === 0) return out;
  ai.stats?.drafts_per_reviewer_call.push(entries.length);
  const payload = entries.map(({ rec, lead }) => ({
    ID: rec.id,
    CHANNEL: rec.channel,
    MESSAGE_TYPE: rec.type ?? "first",
    LIMITS: limitsText(rec.channel, rec.type ?? "first"),
    MESSAGES: partsMap(rec.parts),
    GREETING_EXPECTED: `${greetingFor(lead as Parameters<typeof greetingFor>[0]) ?? "Hi there"},`,
    FACTS_GIVEN_TO_WRITER: rec.draft_facts ?? [],
    SAVED_EVIDENCE: evidenceFor({ ...lead, hours_summary: leadHours(lead as Parameters<typeof leadHours>[0])?.summary ?? null } as ReviewLead),
    WEBSITE_FACTS: factsForReviewer((lead.site_check as { facts?: Array<{ key: string; value: unknown; evidence: { text: string }; no_autolink?: boolean }> } | null | undefined)?.facts),
    CODE_FINDINGS: [],
  }));
  const r = await aiJson("review", { system: SOCIAL_REVIEW_SYSTEM_PROMPT, user: JSON.stringify({ DRAFTS: payload, SENDER_OFFER: offer.trim() || null }), temperature: 0 }, ai)
    .catch((e) => { if (e instanceof GeminiError) throw e; return { json: null, model: "", provider: "gemini" as const, fell_back: false } as AiJsonResult; });
  const j = r.json as unknown;
  const arr: unknown[] = Array.isArray(j) ? j : Array.isArray((j as { results?: unknown })?.results) ? (j as { results: unknown[] }).results : j && typeof j === "object" && entries.length === 1 && "verdict" in (j as object) ? [{ ...(j as object), id: entries[0].rec.id }] : [];
  for (const raw of arr) {
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o.id !== "string" || typeof o.verdict !== "string" || !VERDICTS.includes(o.verdict.toLowerCase())) continue;
    const e = entries.find((x) => x.rec.id === o.id);
    if (!e || out.has(o.id)) continue;
    const rw = o.rewrite && typeof o.rewrite === "object" ? (o.rewrite as Record<string, unknown>) : null;
    const rewrite = rw ? partsFromAnswer(e.rec.channel, rw, e.rec.type ?? "first") : null;
    out.set(o.id, {
      verdict: o.verdict.toLowerCase() as ReviewStatus,
      problem: String(o.problem ?? "none"),
      reasons: Array.isArray(o.reasons) ? o.reasons.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 5) : [],
      rewrite: rewrite && Object.values(rewrite).every(Boolean) ? rewrite : null,
      model: r.model,
    });
  }
  for (const e of entries.filter((x) => !out.has(x.rec.id))) {
    if (retry) out.set(e.rec.id, (await askSocialBatch([e], ai, offer, false)).get(e.rec.id) ?? null);
    else out.set(e.rec.id, null);
  }
  return out;
}

/**
 * Reviews saved social messages: batches of up to 5. At most ONE rewrite per message in total (the writer retry counts):
 * a reviewer rewrite is code-checked and reviewed once more, and never rewritten again; if it still fails it is "Check this".
 * A daily Gemini limit throws (the caller pauses).
 */
async function reviewSocialRecords(campaign_id: string, recs: SocialRecord[], ai: GeminiAiOpts, offer: string, onDone: (n: number) => Promise<void> | void): Promise<void> {
  if (recs.length === 0) return;
  const ss = store(OUTREACH_SOCIAL);
  const leadById = new Map<string, ReviewLead & Record<string, unknown>>();
  for (const r of recs) { if (!leadById.has(r.lead_id)) { const f = await findLeadRow(campaign_id, r.lead_id); if (f) leadById.set(r.lead_id, f.lead as ReviewLead & Record<string, unknown>); } }
  let done = 0;
  const save = async (rec: SocialRecord, patch: Partial<SocialRecord>, history: { status: string; reasons: string[] }) => {
    const key = socialKey(campaign_id, rec.lead_id, rec.channel);
    const fresh = await readJson<SocialRecord>(ss, key);
    // If the message was edited or sent while the reviewer worked, the verdict no longer applies.
    if (fresh && fresh.status === "drafted" && fresh.updated_at === rec.updated_at) {
      const now = new Date().toISOString();
      await writeJson(ss, key, { ...fresh, ...patch, reviewed_at: now, review_history: [...(fresh.review_history ?? []), { at: now, status: history.status, reasons: history.reasons }].slice(-6), updated_at: now });
    }
    debugLog("social-review", { lead_id: rec.lead_id, channel: rec.channel, status: history.status, reasons: history.reasons });
    done++;
    await onDone(done);
  };
  const usable = recs.filter((r) => leadById.has(r.lead_id));
  done = recs.length - usable.length;
  for (let i = 0; i < usable.length; i += REVIEW_BATCH) {
    const chunk = usable.slice(i, i + REVIEW_BATCH);
    const answers = await askSocialBatch(chunk.map((rec) => ({ rec, lead: leadById.get(rec.lead_id)! })), ai, offer);
    const second: Array<{ rec: SocialRecord; lead: ReviewLead & Record<string, unknown>; prior: SocialVerdict }> = [];
    for (const rec of chunk) {
      const lead = leadById.get(rec.lead_id)!;
      const a = answers.get(rec.id) ?? null;
      if (!a) { await save(rec, { review_status: "check", review_reasons: ["Not reviewed: the AI reviewer gave no usable answer."], reviewed_by: null }, { status: "check", reasons: ["no usable answer"] }); continue; }
      if (a.verdict === "check" && a.rewrite && rec.rewrites_used < 1) {
        const plan = pickAngle(lead as Parameters<typeof pickAngle>[0]);
        const found = precheckSocial(rec.channel, a.rewrite, { type: rec.type ?? "first", phoneOnlyOk: plan.angle.code === "phone_only", callsOnly: plan.calls_only ?? callsOnly(plan.angle.code), noHours: plan.no_hours === true, trade: ((lead.site_check as { real_trade?: string | null } | null | undefined)?.real_trade) ?? null, copySources: [DEFAULT_OFFER, ...EXAMPLE_BODIES], factCount: rec.draft_facts.length, factUsed: rec.fact_used });
        if (found.length > 0) {
          await save(rec, { review_status: "check", review_reasons: dedupeReasons([...a.reasons, ...found.map((f) => `Rewrite failed code check: ${f}`)]), reviewed_by: a.model, rewrites_used: 1 }, { status: "check", reasons: a.reasons });
          continue;
        }
        second.push({ rec: { ...rec, parts: partsToList(rec.channel, a.rewrite, rec.type ?? "first"), rewrites_used: 1 }, lead, prior: a });
        continue;
      }
      await save(rec, { review_status: a.verdict, review_reasons: a.reasons, reviewed_by: a.model }, { status: a.verdict, reasons: a.reasons });
    }
    if (second.length > 0) {
      const again = await askSocialBatch(second.map((x) => ({ rec: x.rec, lead: x.lead })), ai, offer);
      for (const x of second) {
        const a2 = again.get(x.rec.id) ?? null;
        const orig = chunk.find((c) => c.id === x.rec.id)!;
        const ready = a2?.verdict === "ready";
        await save(orig, {
          parts: x.rec.parts,
          rewrites_used: 1,
          review_status: ready ? "ready" : "check",
          review_reasons: ready ? ["Reworded once by the reviewer (the rewrite passed the checks)."] : [...x.prior.reasons, ...(a2?.reasons ?? ["The reworded message was not confirmed."])].slice(0, 6),
          reviewed_by: a2?.model ?? x.prior.model,
        }, { status: ready ? "ready" : "check", reasons: x.prior.reasons });
      }
    }
  }
}

export type SocialJobParams = { until?: number; campaign_id: string; lead_ids?: string[]; channels?: string[]; regenerate?: boolean; resume?: boolean; type?: string; manual_start?: boolean; since?: string };

/** The social job: one message at a time with a pause (free Gemini tier), reviewed in groups of up to 5, pausing on Gemini's daily limit. */
export async function runSocialJob(p: SocialJobParams): Promise<void> {
  const { campaign_id } = p;
  if (!(await waitForJob(campaign_id, "social"))) return;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const stats = newStats();
  const ai: GeminiAiOpts = { ...BACKGROUND_AI, stats };
  const ss = store(OUTREACH_SOCIAL);
  let done = 0;
  let made = 0;
  let stopped: string | null = null;
  let paused = false;
  const failures: Array<{ name: string; error: string }> = [];
  const pending: SocialRecord[] = [];
  let offerText = DEFAULT_OFFER; // set from the campaign/settings below; the reviewer gets the same offer text as the email reviewer
  const resumeParams = { campaign_id, lead_ids: p.lead_ids, channels: p.channels, regenerate: false, resume: true, type: p.type, manual_start: p.manual_start, since: p.since };
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try { await reviewSocialRecords(campaign_id, batch, ai, offerText, () => undefined); } catch (err) {
      if (err instanceof GeminiError && err.kind === "daily_quota") { paused = true; return; }
      throw err;
    }
  };
  try {
    const offer = ((await readState(campaign_id)).default_sender_offer as string | undefined)?.trim() || (await readOutreachSettings()).default_sender_offer?.trim() || DEFAULT_OFFER;
    offerText = offer;
    const campaign = await readCampaign<CampaignRecord & Record<string, unknown>>(campaign_id);
    const cctx = campaignSkipCtx(campaign);
    // A resumed run first reviews the messages written before the pause but never reviewed.
    if (p.resume) pending.push(...(await listJson<SocialRecord>(ss, `${campaign_id}/`)).filter((r) => r.status === "drafted" && r.review_status === null));
    const { items } = await planSocial(campaign_id, p.lead_ids, p.channels, { regenerate: p.regenerate, type: p.type, manualStart: p.manual_start, since: p.since });
    const others = (await listJson<SocialRecord>(ss, `${campaign_id}/`)).flatMap((r) => r.parts.map((x) => x.text)).filter(Boolean);
    for (let i = 0; i < items.length && !stopped && !paused; i++) {
      if (Date.now() - t0 > JOB_MAX_MS || (p.until && Date.now() > p.until)) { stopped = `Time limit reached after ${made} message${made === 1 ? "" : "s"}. Click Write social messages again to continue.`; break; }
      if (i > 0) await sleep(4500);
      const item = items[i];
      for (let attempt = 1; ; attempt++) {
        try {
          const rec = await writeSocialOne(campaign_id, item, { offer, anyTrade: cctx.anyTrade, query: cctx.query, others, draftsSoFar: made }, ai);
          await archiveLegacySent(campaign_id, rec.lead_id, rec.channel);
          await writeJson(ss, socialKey(campaign_id, rec.lead_id, rec.channel), rec);
          others.push(...rec.parts.map((x) => x.text));
          made++;
          if (rec.review_status === null) pending.push(rec);
          break;
        } catch (e) {
          if (e instanceof GeminiError && e.kind === "daily_quota") { paused = true; break; }
          if (e instanceof GeminiError && (e.kind === "rate_limited" || e.kind === "unavailable") && attempt < 4) { await sleep(Math.min(60, e.retryAfterS ?? 10) * 1000 + 500); continue; }
          failures.push({ name: String(item.lead.name ?? item.lead.id), error: e instanceof Error ? e.message : "failed" });
          break;
        }
      }
      if (!paused) { done++; await patchJob(campaign_id, { done, made, calls: stats }); }
      if (!paused && pending.length >= REVIEW_BATCH) await flush();
    }
    if (!paused) await flush();
  } catch (err) {
    stopped = err instanceof Error ? err.message : "Writing social messages failed";
  }
  if (paused) { await pauseJobForQuota(campaign_id, resumeParams, { done, made, calls: stats }); return; }
  await patchJob(campaign_id, {
    status: stopped ? "stopped" : "done", done, made, calls: stats, finished_at: new Date().toISOString(),
    message: stopped ?? (failures.length ? `${failures.length} failed. Click Write social messages again to retry just those.` : undefined),
    failures: failures.length ? failures : undefined,
  });
}


const SOCIAL_BATCH_KEY = "social-batch"; // global job record in the state store: one cross-campaign social-writing run at a time

/** A lead's full contact history (oldest first) and summary. */
async function leadTouchState(campaign_id: string, lead_id: string): Promise<{ touches: Touch[]; summary: ReturnType<typeof summarizeTouches> }> {
  const [emailsAll, socials, stored, replies] = await Promise.all([
    listJson<{ id: string; lead_id: string; status?: string; sent_at?: string; created_at?: string; sequence_position?: number; subject?: string; body_text?: string }>(store(OUTREACH_EMAILS), `${campaign_id}/`),
    listJson<SocialRecord>(store(OUTREACH_SOCIAL), `${campaign_id}/${lead_id}/`),
    listJson<Touch>(store(OUTREACH_TOUCHES), `${lead_id}/`),
    listJson<{ lead_id?: string | null; original_email_id?: string | null; is_test?: boolean; received_at?: string; from?: string | null }>(store(OUTREACH_REPLIES), ""),
  ]);
  const emails = emailsAll.filter((e) => e.lead_id === lead_id);
  const ownOnly = ownReplyEmailIds(replies.filter((r) => r.original_email_id));
  const replied = emails.some((e) => e.status === "replied" && !ownOnly.has(e.id)) || replies.some((r) => r.lead_id === lead_id && !isTestReply(r));
  const touches = deriveTouches({ lead_id, campaign_id, emails, socials, stored });
  const lastReply = replies.filter((r) => r.lead_id === lead_id && !isTestReply(r) && r.received_at).map((r) => r.received_at as string).sort().pop() ?? null;
  return { touches: touches.map(({ ...t }) => { delete (t as { snapshot?: unknown }).snapshot; return t; }), summary: summarizeTouches(touches, replied, { at: lastReply, via: "email" }) };
}

function groupByCampaign(leads: Array<{ campaign_id?: string; lead_id?: string }> | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const l of Array.isArray(leads) ? leads : []) { if (typeof l?.campaign_id === "string" && typeof l?.lead_id === "string") m.set(l.campaign_id, [...(m.get(l.campaign_id) ?? []), l.lead_id]); }
  return m;
}

async function planSocialGroups(groups: Map<string, string[]>, channels: string[] | undefined, regenerate: boolean, type: string | undefined): Promise<{ items: SocialPlanItem[]; skipped: SocialSkip[] }> {
  const items: SocialPlanItem[] = [];
  const skipped: SocialSkip[] = [];
  for (const [cid, ids] of groups) {
    const p = await planSocial(cid, ids, channels, { regenerate, type });
    items.push(...p.items);
    skipped.push(...p.skipped);
  }
  return { items, skipped };
}

/** The cross-campaign run: leads grouped by campaign, each group run by the ordinary social job. Pauses on Gemini's daily limit. */
export async function runSocialBatchJob(): Promise<void> {
  const bs = store(OUTREACH_STATE);
  const rec0 = await readJson<Record<string, unknown> & { groups?: Array<{ campaign_id: string; lead_ids: string[] }>; params?: { channels?: string[] | null; regenerate?: boolean; type?: string | null; since?: string }; status?: string }>(bs, SOCIAL_BATCH_KEY);
  if (!rec0 || rec0.status !== "running") return;
  const until = Date.now() + JOB_MAX_MS;
  let done = Number(rec0.done ?? 0);
  let made = Number(rec0.made ?? 0);
  const failures: Array<{ name: string; error: string }> = [];
  let status = "done";
  let message: string | undefined;
  let resume_at: string | undefined;
  const patch = async (extra: Record<string, unknown>) => { const cur = (await readJson<Record<string, unknown>>(bs, SOCIAL_BATCH_KEY)) ?? {}; await writeJson(bs, SOCIAL_BATCH_KEY, { ...cur, ...extra, progress_at: new Date().toISOString() }); };
  try {
    for (const g of rec0.groups ?? []) {
      if (Date.now() > until) { status = "stopped"; message = `Time limit reached after ${made} message${made === 1 ? "" : "s"}. Select the leads and write again to continue.`; break; }
      const now = new Date().toISOString();
      const plan = await planSocial(g.campaign_id, g.lead_ids, rec0.params?.channels ?? undefined, { regenerate: rec0.params?.regenerate === true, type: rec0.params?.type ?? undefined, since: rec0.params?.since });
      if (plan.items.length === 0) continue;
      jobMemo.delete(g.campaign_id);
      await patchState(g.campaign_id, { job: { kind: "social", status: "running", total: plan.items.length, done: 0, made: 0, started_at: now, progress_at: now } });
      await runSocialJob({ campaign_id: g.campaign_id, lead_ids: g.lead_ids, channels: rec0.params?.channels ?? undefined, regenerate: rec0.params?.regenerate === true, type: rec0.params?.type ?? undefined, since: rec0.params?.since, until });
      const job = ((await readState(g.campaign_id)).job ?? {}) as { status?: string; done?: number; made?: number; message?: string; failures?: Array<{ name: string; error: string }>; resume_at?: string };
      done += Number(job.done ?? 0);
      made += Number(job.made ?? 0);
      failures.push(...(job.failures ?? []));
      await patch({ done, made });
      if (job.status === "paused") { status = "paused"; message = job.message; resume_at = job.resume_at; break; }
      if (job.status === "stopped") { status = "stopped"; message = job.message; break; }
    }
  } catch (err) {
    status = "stopped";
    message = err instanceof Error ? err.message : "Writing social messages failed";
  }
  await patch({ status, done, made, finished_at: status === "done" ? new Date().toISOString() : undefined, message: message ?? (failures.length ? `${failures.length} failed. Select them and write again to retry.` : undefined), failures: failures.length ? failures : undefined, resume_at });
}

/** Which drafts a review run covers: the ticked ones, else every draft that is not already "ready". */
async function planReview(campaign_id: string, emailIds?: string[], opts: { onlyUnreviewed?: boolean; skipReviewedSince?: string } = {}): Promise<Array<{ key: string; row: Record<string, unknown> & { id: string } }>> {
  const es = store(OUTREACH_EMAILS);
  const { blobs } = await es.list({ prefix: `${campaign_id}/` });
  const out: Array<{ key: string; row: Record<string, unknown> & { id: string } }> = [];
  const want = emailIds && emailIds.length ? new Set(emailIds) : null;
  for (const b of blobs) {
    const row = await readJson<Record<string, unknown> & { id: string }>(es, b.key);
    if (!row || row.status !== "drafted") continue;
    if (want ? !want.has(row.id) : row.review_status === "ready") continue;
    if (opts.onlyUnreviewed && (row.reviewed_at || row.review_status === "ready")) continue;
    if (opts.skipReviewedSince && typeof row.reviewed_at === "string" && row.reviewed_at >= opts.skipReviewedSince) continue;
    out.push({ key: b.key, row });
  }
  return out;
}

/** The review job: code checks first, then the AI in groups of up to 5 drafts per call (runs in ai-background). */
export async function runReviewJob(p: { campaign_id: string; email_ids?: string[]; skip_reviewed_since?: string }): Promise<void> {
  const { campaign_id } = p;
  if (!(await waitForJob(campaign_id, "review"))) return;
  const stats = newStats();
  const ai: GeminiAiOpts = { ...BACKGROUND_AI, stats };
  let done = 0;
  let stopped: string | null = null;
  let paused = false;
  const startedAt = String((jobMemo.get(campaign_id) as { started_at?: string } | undefined)?.started_at ?? new Date().toISOString());
  try {
    const todo = await planReview(campaign_id, p.email_ids, { skipReviewedSince: p.skip_reviewed_since });
    await reviewRows(campaign_id, todo, ai, async (n) => { done = n; await patchJob(campaign_id, { done, calls: stats }); });
  } catch (err) {
    if (err instanceof GeminiError && err.kind === "daily_quota") paused = true;
    else stopped = err instanceof Error ? err.message : "Review failed";
  }
  if (paused) {
    await pauseJobForQuota(campaign_id, { campaign_id, email_ids: p.email_ids, skip_reviewed_since: p.skip_reviewed_since ?? startedAt, resume: true }, { done, calls: stats });
    return;
  }
  await patchJob(campaign_id, { status: stopped ? "stopped" : "done", done, calls: stats, finished_at: new Date().toISOString(), message: stopped ?? undefined });
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

      case "outreach.social.write": {
        // Records a "social" job for the given leads (or every lead with no usable email but a Facebook, Instagram or LinkedIn page);
        // the page then POSTs { task: "social", params } to the ai-background function. Same skip rules as emails.
        const { campaign_id, lead_ids, lead_id, channels, regenerate, type, manual_start } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (!(await aiAvailable())) return fail(400, "No AI provider is set up. Add the Gemini key in Settings.");
        const campaign = await readCampaign<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const ids = Array.isArray(lead_ids) ? (lead_ids as unknown[]).filter((x): x is string => typeof x === "string") : typeof lead_id === "string" ? [lead_id] : undefined;
        const chans = Array.isArray(channels) ? (channels as unknown[]).filter((x): x is string => typeof x === "string") : typeof channels === "string" ? [channels] : undefined;
        const stype = typeof type === "string" ? type : undefined;
        const plan = await planSocial(campaign_id, ids, chans, { regenerate: regenerate === true, type: stype, manualStart: manual_start === true });
        if (plan.items.length === 0) {
          const why = plan.skipped.length ? ` Skipped: ${plan.skipped.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join("; ")}.` : "";
          return fail(400, `No social messages to write.${why}`);
        }
        const now = new Date().toISOString();
        await patchState(campaign_id, { job: { kind: "social", status: "running", total: plan.items.length, done: 0, made: 0, started_at: now, progress_at: now } });
        return ok({ total: plan.items.length, started_at: now, skipped: plan.skipped, params: { campaign_id, lead_ids: ids, channels: chans, regenerate: regenerate === true, type: stype, manual_start: manual_start === true } });
      }

      case "outreach.social.list": {
        const { campaign_id, lead_id } = params as Record<string, string>;
        if (!campaign_id) return fail(400, "campaign_id required");
        const rows = (await listJson<SocialRecord>(store(OUTREACH_SOCIAL), lead_id ? `${campaign_id}/${lead_id}/` : `${campaign_id}/`));
        const fresh: SocialRecord[] = [];
        for (const r of rows) fresh.push((r as { rules_version?: number }).rules_version === RULES_VERSION ? r : (await verifySocialRecord(r, { stamp: true })).rec);
        return ok(fresh);
      }

      case "outreach.social.update": {
        // The user edited a message: saved as written, code-checked, never re-reviewed by the AI automatically.
        const { campaign_id, lead_id, channel, parts } = params as { campaign_id?: string; lead_id?: string; channel?: string; parts?: Record<string, string> };
        if (!campaign_id || !lead_id || !channel || !parts) return fail(400, "campaign_id, lead_id, channel and parts required");
        if (!["facebook", "instagram", "linkedin"].includes(channel)) return fail(400, "unknown channel");
        const ss = store(OUTREACH_SOCIAL);
        const rec = await readJson<SocialRecord>(ss, socialKey(campaign_id, lead_id, channel));
        if (!rec) return fail(404, "message not found");
        if (rec.type === "sequence") {
          // Each step is edited on its own: saved as written, code-checked, never re-reviewed by the AI automatically.
          const inp = resolveInputs(await readOutreachSettings(), "");
          const texts = { ...partsMap(rec.parts), ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, String(v ?? "")])) };
          const checks = checkSocialSeq(rec.channel, texts, inp, { ratingElsewhere: await leadRatingUsed(campaign_id, lead_id, { channel: rec.channel }) });
          const nowS = new Date().toISOString();
          const nextParts: SocialPart[] = rec.parts.map((p0) => {
            if (!(p0.key in parts)) return p0;
            if (p0.sent_at) return p0; // a step already sent by hand is history and is not rewritten
            const ck = checks.find((x) => x.key === p0.key)!;
            const st = ck.status === "ready" ? "check" : ck.status;
            return { ...p0, text: String(parts[p0.key] ?? "").trim(), review_status: st, review_reasons: dedupeReasons(["Edited by you: not reviewed by the AI.", ...ck.reasons]) };
          });
          const RK = { ready: 0, check: 1, blocked: 2 } as const;
          const openParts = nextParts.filter((x) => !x.sent_at);
          const worstS = openParts.reduce((w, x) => (x.review_status && RK[x.review_status] > RK[w] ? x.review_status : w), "ready" as "ready" | "check" | "blocked");
          const savedSeq: SocialRecord = { ...rec, parts: nextParts, review_status: worstS, review_reasons: nextParts.filter((x) => x.review_reasons?.length && !x.sent_at).flatMap((x) => x.review_reasons!.map((r) => `${x.key === "message" ? "first" : x.key}: ${r}`)), reviewed_by: "you", updated_at: nowS };
          await writeJson(ss, socialKey(campaign_id, lead_id, channel), savedSeq);
          return ok(savedSeq);
        }
        const next = partsToList(rec.channel, { ...partsMap(rec.parts), ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, String(v ?? "")])) }, rec.type ?? "first");
        const found = precheckSocial(rec.channel, partsMap(next), { type: rec.type ?? "first", factCount: rec.draft_facts?.length ?? 0, factUsed: rec.fact_used });
        const now = new Date().toISOString();
        const saved: SocialRecord = { ...rec, parts: next, review_status: "check", review_reasons: dedupeReasons(["Edited by you: not reviewed by the AI.", ...found.map((f) => `Code check: ${f}`)]), reviewed_by: "you", updated_at: now };
        await writeJson(ss, socialKey(campaign_id, lead_id, channel), saved);
        return ok(saved);
      }

      case "outreach.social.verify": {
        // Runs the free code checks again on one saved message right before it is copied or marked as sent. Blocked = do not copy.
        const { campaign_id, lead_id, channel, part } = params as { campaign_id?: string; lead_id?: string; channel?: string; part?: string };
        if (!campaign_id || !lead_id || !channel) return fail(400, "campaign_id, lead_id and channel required");
        const rec = await readJson<SocialRecord>(store(OUTREACH_SOCIAL), socialKey(campaign_id, lead_id, channel));
        if (!rec) return fail(404, "message not found");
        const v = await verifySocialRecord(rec);
        const hit = part ? v.blocked.find((b) => b.key === part) : v.blocked[0];
        return ok({ blocked: !!hit, reasons: hit?.reasons ?? [], label: hit?.label ?? null });
      }

      case "outreach.social.mark_sent": {
        // "I sent this by hand" (sent_on = the day it was sent, earlier days allowed) or Undo (sent:false). The message becomes a touch of its
        // own and the draft slot is cleared, so the next message on that channel can be written as a follow-up. The app never sends anything.
        const { campaign_id, lead_id, channel, sent, sent_on, touch_id, part } = params as { campaign_id?: string; lead_id?: string; channel?: string; sent?: boolean; sent_on?: string; touch_id?: string; part?: string };
        if (!campaign_id || !lead_id || !channel) return fail(400, "campaign_id, lead_id and channel required");
        if (!["facebook", "instagram", "linkedin"].includes(channel)) return fail(400, "unknown channel");
        const ss = store(OUTREACH_SOCIAL);
        const key = socialKey(campaign_id, lead_id, channel);
        const rec = await readJson<SocialRecord>(ss, key);
        const now = new Date().toISOString();
        if (part) {
          // One step of a written run: it becomes a touch of its own and the rest of the run stays. The app never sends anything.
          const base = rec ?? (touch_id ? (await listJson<Touch & { snapshot?: SocialRecord }>(store(OUTREACH_TOUCHES), `${lead_id}/`)).find((t) => t.id === touch_id)?.snapshot ?? null : null);
          if (!base || base.type !== "sequence") return fail(404, "message not found");
          const idx = base.parts.findIndex((x) => x.key === part);
          if (idx < 0) return fail(400, "unknown step");
          if (sent === false) {
            const tid = touch_id ?? base.parts[idx].touch_id ?? null;
            if (tid) { const tb = (await listJson<Touch>(store(OUTREACH_TOUCHES), `${lead_id}/`)).find((t) => t.id === tid); if (tb) await store(OUTREACH_TOUCHES).delete(`${lead_id}/${tb.sent_at}-${tb.id}`); }
            const parts2 = base.parts.map((x, i) => (i === idx ? { ...x, sent_at: null, touch_id: null } : x));
            await writeJson(ss, key, { ...base, parts: parts2, status: "drafted", updated_at: now });
            return ok({ undone: true, ...(await leadTouchState(campaign_id, lead_id)) });
          }
          if (!rec) return fail(404, "message not found");
          if (!rec.parts[idx].sent_at) {
            const gate = await verifySocialRecord(rec);
            const bad = gate.blocked.find((b) => b.key === part);
            if (bad) return fail(400, `Cannot mark this as sent: it is Blocked by the free checks (${bad.reasons.join(" | ")}). Edit it first.`);
          }
          if (rec.parts[idx].sent_at) return ok({ already: true, ...(await leadTouchState(campaign_id, lead_id)) });
          const atP = parseSentOn(sent_on);
          if (!atP) return fail(400, "That date is not valid or is in the future.");
          const before = await leadTouchState(campaign_id, lead_id);
          const had = before.touches.some((t) => t.channel === channel && t.sent_at < atP);
          const tp = { ...touchFromSent({ id: nanoid(10), lead_id, campaign_id, channel: channel as TouchChannel, kind: had ? "follow_up" : "first", sent_at: atP, text: rec.parts[idx].text, source: "hq" }), snapshot: rec };
          await writeTouch(tp);
          const parts3 = rec.parts.map((x, i) => (i === idx ? { ...x, sent_at: atP, touch_id: tp.id } : x));
          const allDone = parts3.every((x) => x.sent_at || x.skipped);
          if (allDone) await ss.delete(key); else await writeJson(ss, key, { ...rec, parts: parts3, updated_at: now });
          await logActivity({ category: "outreach", summary: `Marked ${channel} ${part} as sent (${atP.slice(0, 10)}) for lead ${lead_id}` });
          return ok({ touch_id: tp.id, ...(await leadTouchState(campaign_id, lead_id)) });
        }
        if (sent === false) {
          const tb = touch_id ? (await listJson<Touch & { snapshot?: SocialRecord }>(store(OUTREACH_TOUCHES), `${lead_id}/`)).find((t) => t.id === touch_id) : null;
          if (tb) {
            await store(OUTREACH_TOUCHES).delete(`${lead_id}/${tb.sent_at}-${tb.id}`);
            let restored = false;
            if (!rec && tb.snapshot) { await writeJson(ss, key, { ...tb.snapshot, status: "drafted", sent_at: null, updated_at: now }); restored = true; }
            await logActivity({ category: "outreach", summary: `Undid a ${channel} message marked as sent for lead ${lead_id}` });
            return ok({ undone: true, restored, ...(await leadTouchState(campaign_id, lead_id)) });
          }
          if (!rec) return fail(404, "message not found");
          await writeJson(ss, key, { ...rec, status: "drafted", sent_at: null, updated_at: now });
          return ok({ undone: true, restored: true, ...(await leadTouchState(campaign_id, lead_id)) });
        }
        if (!rec) return fail(404, "message not found");
        if (rec.status === "sent") return ok({ already: true, ...(await leadTouchState(campaign_id, lead_id)) });
        const at = parseSentOn(sent_on);
        if (!at) return fail(400, "That date is not valid or is in the future.");
        const text = rec.parts.map((p) => p.text).filter(Boolean).join("\n\n");
        const touch = { ...touchFromSent({ id: nanoid(10), lead_id, campaign_id, channel: channel as TouchChannel, kind: rec.type && rec.type !== "first" ? "follow_up" : "first", sent_at: at, text, source: "hq" }), snapshot: rec };
        await writeTouch(touch);
        await ss.delete(key);
        await logActivity({ category: "outreach", summary: `Marked ${channel} message as sent (${at.slice(0, 10)}) for lead ${lead_id}` });
        return ok({ touch_id: touch.id, ...(await leadTouchState(campaign_id, lead_id)) });
      }

      case "outreach.social.record_hand": {
        // A message sent by hand that HQ never wrote (or an old one): recorded as a touch with its date and text.
        const { campaign_id, lead_id, channel, text, sent_on, kind } = params as { campaign_id?: string; lead_id?: string; channel?: string; text?: string; sent_on?: string; kind?: string };
        if (!campaign_id || !lead_id || !channel) return fail(400, "campaign_id, lead_id and channel required");
        if (!["email", "facebook", "instagram", "linkedin"].includes(channel)) return fail(400, "unknown channel");
        const body = String(text ?? "").trim();
        if (!body) return fail(400, "Paste or type what you sent.");
        if (body.length > 5000) return fail(400, "That message is too long (5000 characters at most).");
        const at = parseSentOn(sent_on);
        if (!at) return fail(400, "That date is not valid or is in the future.");
        const before = await leadTouchState(campaign_id, lead_id);
        const had = before.touches.some((t) => t.channel === channel && t.sent_at < at); // earlier touches decide first or follow-up
        const k = kind === "first" || kind === "follow_up" ? kind : had ? "follow_up" : "first";
        const touch = touchFromSent({ id: nanoid(10), lead_id, campaign_id, channel: channel as TouchChannel, kind: k, sent_at: at, text: body, source: "manual" });
        await writeTouch(touch);
        await logActivity({ category: "outreach", summary: `Recorded a ${channel} message sent by hand (${at.slice(0, 10)}) for lead ${lead_id}` });
        return ok({ touch_id: touch.id, ...(await leadTouchState(campaign_id, lead_id)) });
      }

      case "outreach.touch.delete": {
        // Removes a touch that was recorded by hand (HQ's own emails and derived touches are history and stay).
        const { lead_id, touch_id } = params as { lead_id?: string; touch_id?: string };
        if (!lead_id || !touch_id) return fail(400, "lead_id and touch_id required");
        const tb = (await listJson<Touch>(store(OUTREACH_TOUCHES), `${lead_id}/`)).find((t) => t.id === touch_id);
        if (!tb) return fail(404, "touch not found");
        await store(OUTREACH_TOUCHES).delete(`${lead_id}/${tb.sent_at}-${tb.id}`);
        return ok({ deleted: true, ...(tb.campaign_id ? await leadTouchState(tb.campaign_id, lead_id) : {}) });
      }

      case "outreach.lead.touches": {
        const { campaign_id, lead_id } = params as { campaign_id?: string; lead_id?: string };
        if (!campaign_id || !lead_id) return fail(400, "campaign_id and lead_id required");
        return ok(await leadTouchState(campaign_id, lead_id));
      }

      case "outreach.lead.fb_checked": {
        // "I looked at this Facebook page": date, what I found and a note. Only this field changes. result null clears it.
        const { campaign_id, lead_id, result, note } = params as { campaign_id?: string; lead_id?: string; result?: string | null; note?: string };
        if (!campaign_id || !lead_id) return fail(400, "campaign_id and lead_id required");
        if (!(await findLeadRow(campaign_id, lead_id))) return fail(404, "lead not found");
        if (result === null || result === undefined || result === "") { await patchLeadFields(campaign_id, lead_id, { fb_checked: null }); return ok({ fb_checked: null }); }
        if (!["real", "gone", "not_fit"].includes(result)) return fail(400, "result must be real, gone or not_fit");
        const rec = { at: new Date().toISOString(), result: result as "real" | "gone" | "not_fit", note: String(note ?? "").trim().slice(0, 300) };
        await patchLeadFields(campaign_id, lead_id, { fb_checked: rec });
        return ok({ fb_checked: rec });
      }

      case "outreach.social.plan": {
        // What a bulk "Write social messages" run would do, for the confirm box. Writes nothing and calls no AI.
        const { leads, channels, regenerate, type } = params as { leads?: Array<{ campaign_id?: string; lead_id?: string }>; channels?: string[]; regenerate?: boolean; type?: string };
        const groups = groupByCampaign(leads);
        if (groups.size === 0) return fail(400, "Select at least one lead.");
        const out = await planSocialGroups(groups, channels, regenerate === true, type);
        const by: Record<string, number> = {};
        for (const it of out.items) by[it.channel] = (by[it.channel] ?? 0) + 1;
        const reasons: Record<string, number> = {};
        for (const s of out.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
        const n = out.items.length;
        return ok({ total: n, by_channel: by, leads: new Set(out.items.map((i) => i.lead.id)).size, skipped: out.skipped.length, skip_reasons: reasons, gemini_calls: { writing: n, reviewing: Math.ceil(n / REVIEW_BATCH), rough_total: n + Math.ceil(n / REVIEW_BATCH) }, rewrite_existing: regenerate === true });
      }

      case "outreach.social.batch.start": {
        const { leads, channels, regenerate, type } = params as { leads?: Array<{ campaign_id?: string; lead_id?: string }>; channels?: string[]; regenerate?: boolean; type?: string };
        if (!(await aiAvailable())) return fail(400, "No AI provider is set up. Add the Gemini key in Settings.");
        const groups = groupByCampaign(leads);
        if (groups.size === 0) return fail(400, "Select at least one lead.");
        const cur = (await readJson<Record<string, unknown>>(store(OUTREACH_STATE), SOCIAL_BATCH_KEY)) ?? {};
        const last = Date.parse(String(cur.progress_at ?? cur.started_at ?? ""));
        if (cur.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) return failCode(409, "A social-message run is already going. Wait for it to finish.", "job_running");
        for (const cid of groups.keys()) {
          const c = await readCampaign<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(cid);
          const l = Date.parse(c?.job?.progress_at ?? c?.job?.started_at ?? "");
          if (c?.job?.status === "running" && Number.isFinite(l) && Date.now() - l < JOB_STALE_MS) return failCode(409, `A job is already running for the campaign "${c?.name ?? cid}". Wait for it to finish.`, "job_running");
        }
        const out = await planSocialGroups(groups, channels, regenerate === true, type);
        if (out.items.length === 0) return fail(400, `No social messages to write.${out.skipped.length ? ` Skipped: ${out.skipped.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join("; ")}.` : ""}`);
        const now = new Date().toISOString();
        const doing = new Map<string, string[]>();
        for (const it of out.items) doing.set(String(it.lead.campaign_id), [...new Set([...(doing.get(String(it.lead.campaign_id)) ?? []), it.lead.id])]);
        const rec = { kind: "social_batch", status: "running", total: out.items.length, done: 0, made: 0, started_at: now, progress_at: now, skipped: out.skipped.length, groups: [...doing].map(([campaign_id, lead_ids]) => ({ campaign_id, lead_ids })), params: { channels: channels ?? null, regenerate: regenerate === true, type: type ?? null, since: now } };
        await writeJson(store(OUTREACH_STATE), SOCIAL_BATCH_KEY, rec);
        return ok({ total: rec.total, skipped: out.skipped, started_at: now });
      }

      case "outreach.social.batch.status": {
        const rec = await readJson<Record<string, unknown>>(store(OUTREACH_STATE), SOCIAL_BATCH_KEY);
        if (!rec) return ok({ status: "none" });
        const last = Date.parse(String(rec.progress_at ?? rec.started_at ?? ""));
        const stale = rec.status === "running" && Number.isFinite(last) && Date.now() - last > JOB_STALE_MS;
        return ok({ ...rec, groups: undefined, status: stale ? "stopped" : rec.status, message: stale ? "The run stopped without finishing. Select the leads and write again to continue; messages already made are kept." : rec.message });
      }

      case "outreach.social.batch.resume": {
        const rec = await readJson<Record<string, unknown> & { groups?: Array<{ campaign_id: string; lead_ids: string[] }>; params?: Record<string, unknown> }>(store(OUTREACH_STATE), SOCIAL_BATCH_KEY);
        if (!rec || !["paused", "stopped"].includes(String(rec.status))) return failCode(409, "There is no paused run to continue.", "not_paused");
        const now = new Date().toISOString();
        await writeJson(store(OUTREACH_STATE), SOCIAL_BATCH_KEY, { ...rec, status: "running", progress_at: now, message: undefined, resume_at: undefined, params: rec.params ?? {} });
        return ok({ resumed: true });
      }

      case "outreach.social.delete": {
        const { campaign_id, lead_id, channel } = params as { campaign_id?: string; lead_id?: string; channel?: string };
        if (!campaign_id || !lead_id || !channel) return fail(400, "campaign_id, lead_id and channel required");
        await store(OUTREACH_SOCIAL).delete(socialKey(campaign_id, lead_id, channel));
        return ok({ deleted: true });
      }

      case "outreach.job.resume": {
        // Continues a job that paused on Gemini's daily limit. Returns what the page must send to the background
        // function. Drafts already made are never made twice (planning skips leads that have a draft).
        const { campaign_id, force } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        const st = await readState(campaign_id);
        const job = (st.job ?? null) as Record<string, unknown> | null;
        if (!job || job.status !== "paused") return failCode(409, "There is no paused job to resume.", "not_paused");
        const at = Date.parse(String(job.resume_at ?? ""));
        if (!force && Number.isFinite(at) && at > Date.now()) return failCode(409, "Gemini's limit has not reset yet. Use Resume now to try anyway.", "not_due");
        const now = new Date().toISOString();
        const task = job.kind === "generate" ? "draft" : job.kind === "social" ? "social" : "review";
        const resumeParams = (job.resume_params ?? {}) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...job, status: "running", resumed_at: now, progress_at: now, resumes: Number(job.resumes ?? 0) + 1 };
        for (const k of ["paused_reason", "resume_at", "resume_params", "message"]) delete next[k];
        await patchState(campaign_id, { job: next });
        jobMemo.delete(campaign_id);
        return ok({ kind: job.kind, task, params: resumeParams });
      }

      case "outreach.job.resume_due": {
        // Paused jobs whose reset time has passed (the dashboard calls this when it is opened and resumes them).
        const ss = store(OUTREACH_STATE);
        const { blobs } = await ss.list();
        const due: Array<{ campaign_id: string; kind: string; resume_at: string }> = [];
        for (const b of blobs) {
          const rec = await readJson<Record<string, unknown>>(ss, b.key);
          const job = (rec?.job ?? null) as Record<string, unknown> | null;
          if (job?.status === "paused" && Date.parse(String(job.resume_at ?? "")) <= Date.now()) due.push({ campaign_id: b.key, kind: String(job.kind), resume_at: String(job.resume_at) });
        }
        return ok({ due });
      }

      case "outreach.emails.review.start": {
        // Records a review job (all unreviewed/"check"/blocked drafts, or the given email_ids); the page then
        // POSTs { task: "review", params: { campaign_id, email_ids } } to the ai-background function.
        const { campaign_id, email_ids } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (!(await aiAvailable())) return fail(400, "No AI provider is set up. Add the Gemini key in Settings.");
        const campaign = await readCampaign<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const ids = Array.isArray(email_ids) ? (email_ids as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
        const todo = await planReview(campaign_id, ids);
        if (todo.length === 0) return fail(400, "No drafts to review.");
        const now = new Date().toISOString();
        await patchState(campaign_id, { job: { kind: "review", status: "running", total: todo.length, done: 0, started_at: now, progress_at: now } });
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
        const campaign = await readCampaign<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const plan = await planBrowserCheck(campaign_id, typeof lead_id === "string" ? lead_id : undefined);
        if (plan.leads === 0) return fail(400, plan.remaining <= 0 && plan.used > 0 ? `The browser check limit for this campaign (${plan.cap} leads) is reached. You can raise it in Settings.` : "No lead needs a browser check right now.");
        const now = new Date().toISOString();
        await patchState(campaign_id, { job: { kind: "browsercheck", status: "running", total: plan.leads, done: 0, started_at: now, progress_at: now, message: "Starting the browser…" } });
        return ok({ ...plan, started_at: now });
      }

      case "outreach.draft.start": {
        // Validates and records a drafting job; the page then POSTs the same parameters to the
        // ai-background function, which does the slow work and writes progress to campaign.job.
        const { campaign_id, framework, leads } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id) return fail(400, "campaign_id required");
        if (!(await aiAvailable())) return fail(400, "Gemini key not configured");
        const campaign = await readCampaign<CampaignRecord & { job?: { status?: string; progress_at?: string; started_at?: string } }>(campaign_id);
        if (!campaign) return fail(404, "campaign not found");
        const last = Date.parse(campaign.job?.progress_at ?? campaign.job?.started_at ?? "");
        if (campaign.job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) {
          return failCode(409, "A job is already running for this campaign. Wait for it to finish.", "job_running");
        }
        const plan = await planDraftPairs(campaign_id, framework, leads);
        if (plan.pairs.length === 0) return fail(400, "Nothing to draft: every eligible lead already has a draft, or all were skipped.");
        const now = new Date().toISOString();
        await patchState(campaign_id, { job: { kind: "generate", status: "running", total: plan.pairs.length, done: 0, made: 0, started_at: now, progress_at: now, ...(plan.fw === "four-step" ? { unit: "leads", emails_per_lead: 4 } : {}) } });
        return ok({ total: plan.pairs.length, started_at: now });
      }

      case "outreach.campaign.create": {
        if (sqlBackend()) return sqlCampaignCase("outreach.campaign.create", params, identity);
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
          any_trade: true, // "Home services, any trade" is on for new campaigns (batch 7)
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
        if (sqlBackend()) return sqlCampaignCase("outreach.campaign.list", params, identity);
        const all = await listJsonFast<{ id: string; created_at: string }>(store(OUTREACH_CAMPAIGNS));
        all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return ok(await Promise.all(all.map(async (c) => deriveCampaign(await withLeadCount(withState(c as Record<string, unknown>, await readState(c.id))), await campaignEmails(c.id)))));
      }

      case "outreach.campaign.get": {
        if (sqlBackend()) return sqlCampaignCase("outreach.campaign.get", params, identity);
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const record = await readCampaign<Record<string, unknown>>(id);
        if (!record) return fail(404, "campaign not found");
        return ok(deriveCampaign(await withLeadCount(record), await campaignEmails(id)));
      }

      case "outreach.campaign.update": {
        if (sqlBackend()) return sqlCampaignCase("outreach.campaign.update", params, identity);
        // Settings (name, any_trade, ...) go to the campaign record; the running job and sender defaults go to the
        // campaign's state record, so a job and a settings change can never overwrite each other (batch 7).
        const { id, ...patch } = params as Record<string, unknown>;
        if (!id || typeof id !== "string") return fail(400, "id required");
        const s = store(OUTREACH_CAMPAIGNS);
        const first = await readJson<Record<string, unknown>>(s, id);
        if (!first) return fail(404, "campaign not found");
        const now = new Date().toISOString();
        const statePatch: Record<string, unknown> = {};
        const settingsPatch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) (STATE_KEYS as readonly string[]).includes(k) ? (statePatch[k] = v) : (settingsPatch[k] = v);
        if ("job" in statePatch) {
          // A job that starts running is stamped with the SERVER clock, so the UI can count "drafts created
          // since the job started" without clock-skew errors; a finishing update keeps the ORIGINAL start time.
          const cur = ((await readState(id)).job ?? first.job) as { started_at?: string } | null | undefined;
          const job = statePatch.job as Record<string, unknown> | null;
          if (job) {
            const resuming = job.resume === true && typeof cur?.started_at === "string";
            if (job.status === "running" && resuming) job.started_at = cur!.started_at;
            else if (job.status === "running") job.started_at = now;
            else if (cur?.started_at) job.started_at = cur.started_at;
          }
        }
        if (Object.keys(statePatch).length) await patchState(id, statePatch);
        let record = first;
        if (Object.keys(settingsPatch).length) {
          // Re-read right before writing so only the changed fields are replaced.
          const latest = (await readJson<Record<string, unknown>>(s, id)) ?? first;
          record = { ...latest, ...settingsPatch, id, updated_at: now };
          await writeJson(s, id, record);
        }
        return ok(withState(record, await readState(id)));
      }

      case "outreach.campaign.delete": {
        if (sqlBackend()) return sqlCampaignCase("outreach.campaign.delete", params, identity);
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
        try { await store(OUTREACH_STATE).delete(id); } catch { /* none */ }
        try { const ss = store(LEAD_SCREENSHOTS); for (const b of (await ss.list({ prefix: `${id}/` })).blobs) await ss.delete(b.key); } catch { /* none */ }
        try { const so = store(OUTREACH_SOCIAL); for (const b of (await so.list({ prefix: `${id}/` })).blobs) await so.delete(b.key); } catch { /* none */ }
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
        const rows = await listJsonFast<{ created_at?: string; name?: string; email?: string | null; website?: string | null; address?: string | null; category?: string | null; excluded?: boolean; is_test?: boolean; raw?: unknown }>(
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

      case "outreach.lead.set_email": {
        // Edit email (Prospects detail panel): the address you type is saved on the lead itself (source "manual" + date), so the
        // campaign page, CSV and drafting use it. Only the email fields change. A website re-check never replaces it. Unsent drafts
        // for the lead get the new To address. The already-contacted / bounced checks still run on the new address (a warning is returned).
        const { campaign_id, lead_id, email } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id || typeof lead_id !== "string" || !lead_id) return fail(400, "campaign_id and lead_id required");
        if (typeof email !== "string") return fail(400, "email required");
        if (email.trim() === "") {
          // Clearing: the address was wrong (a placeholder, a typo). The lead keeps everything else; its unsent drafts have no
          // address to go to, so they are removed (sent emails are history and stay).
          const f0 = await findLeadRow(campaign_id, lead_id);
          if (!f0) return fail(404, "lead not found");
          const nowC = new Date().toISOString();
          const cur = (await findLeadRow(campaign_id, lead_id))?.lead ?? f0.lead;
          const prevC = (cur.email as string | null | undefined) ?? null;
          await writeJson(store(OUTREACH_LEADS), f0.key, { ...cur, email: null, email_source: "manual", email_manual_at: nowC, junk_email: null, ...(prevC ? { previous_email: prevC } : {}), updated_at: nowC });
          let removed = 0;
          const esC = store(OUTREACH_EMAILS);
          for (const eb of (await esC.list({ prefix: `${campaign_id}/` })).blobs) {
            const em = await readJson<Record<string, unknown>>(esC, eb.key);
            if (em?.lead_id === lead_id && em.status === "drafted") { await esC.delete(eb.key); removed++; }
          }
          return ok({ email: null, email_source: "manual", email_manual_at: nowC, drafts_updated: 0, drafts_removed: removed, warning: removed > 0 ? `${removed} unsent draft${removed === 1 ? "" : "s"} for this lead were removed because there is no address to send to.` : null });
        }
        const next = cleanEmail(email);
        if (!next || isJunkEmail(next)) return fail(400, "That is not a valid email address.");
        if (isGovEduEmail(next)) return fail(400, "A .gov or .edu address is never used as a sales contact.");
        const found = await findLeadRow(campaign_id, lead_id);
        if (!found) return fail(404, "lead not found");
        const now = new Date().toISOString();
        const fresh = (await findLeadRow(campaign_id, lead_id))?.lead ?? found.lead; // re-read right before writing
        const prev = (fresh.email as string | null | undefined) ?? null;
        await writeJson(store(OUTREACH_LEADS), found.key, { ...fresh, email: next, email_source: "manual", email_manual_at: now, junk_email: null, ...(prev && prev !== next ? { previous_email: prev } : {}), updated_at: now });
        // Unsent drafts for this lead go to the new address (sent emails are history and stay as they were).
        let draftsUpdated = 0;
        const es = store(OUTREACH_EMAILS);
        const { blobs } = await es.list({ prefix: `${campaign_id}/` });
        for (const eb of blobs) {
          const em = await readJson<Record<string, unknown>>(es, eb.key);
          if (em?.lead_id === lead_id && em.status === "drafted" && em.to_email !== next) {
            await writeJson(es, eb.key, { ...em, to_email: next, original_to_email: (em.original_to_email as string | undefined) ?? em.to_email, updated_at: now });
            draftsUpdated++;
          }
        }
        const block = contactBlock(await loadContacts(), next, campaign_id, { isTest: fresh.is_test === true });
        return ok({ email: next, email_source: "manual", email_manual_at: now, drafts_updated: draftsUpdated, warning: block ? `${block.message.replace(/^Skipped: /, "")}: drafting and sending will skip this address.` : null });
      }

      case "outreach.leads.update": {
        // Per-lead things you control (send only the ones you want to change):
        //   excluded (true = never draft this lead), trade_override (true = include although
        //   it looks like a different trade), owner_name (your own entry; "" clears it).
        const { campaign_id, lead_id, excluded, trade_override, owner_name, delete_drafts, excluded_reason, excluded_note, not_fit_kept } = params as Record<string, unknown>;
        if (typeof campaign_id !== "string" || !campaign_id || typeof lead_id !== "string" || !lead_id) return fail(400, "campaign_id and lead_id required");
        if (excluded !== undefined && typeof excluded !== "boolean") return fail(400, "excluded must be true or false");
        if (trade_override !== undefined && typeof trade_override !== "boolean") return fail(400, "trade_override must be true or false");
        if (owner_name !== undefined && typeof owner_name !== "string") return fail(400, "owner_name must be text");
        if (not_fit_kept !== undefined && typeof not_fit_kept !== "boolean") return fail(400, "not_fit_kept must be true or false");
        if (excluded_reason !== undefined && excluded_reason !== null && !NOT_FIT_REASONS.includes(excluded_reason as string)) return fail(400, `excluded_reason must be one of: ${NOT_FIT_REASONS.join(", ")}`);
        if (excluded_note !== undefined && excluded_note !== null && typeof excluded_note !== "string") return fail(400, "excluded_note must be text");
        if (excluded === undefined && trade_override === undefined && owner_name === undefined && excluded_reason === undefined && excluded_note === undefined && not_fit_kept === undefined) return fail(400, "nothing to update");
        const found = await findLeadRow(campaign_id, lead_id);
        if (!found) return fail(404, "lead not found");
        const now = new Date().toISOString();
        const updated: Record<string, unknown> = { ...found.lead, updated_at: now };
        if (excluded !== undefined) Object.assign(updated, { excluded, excluded_at: excluded ? now : null });
        // The reason and note are kept when a lead is brought back (nothing is deleted); they only show while it is flagged.
        // "Kept by me": HQ's own flags (chain, lead-gen, wholesaler, not home service) stop hiding or skipping this lead, even after the next website check.
        if (not_fit_kept !== undefined) updated.not_fit_kept = not_fit_kept;
        if (excluded_reason !== undefined) updated.excluded_reason = excluded_reason;
        if (excluded_note !== undefined) updated.excluded_note = typeof excluded_note === "string" ? excluded_note.replace(/\s+/g, " ").trim().slice(0, 200) : null;
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
        const [leads, emails, campaigns, socials, replyRows, storedTouches] = await Promise.all([
          listJsonFast<Record<string, unknown>>(store(OUTREACH_LEADS)),
          listJsonFast<{ id?: string; lead_id?: string; status?: string; sent_at?: string; created_at?: string; review_status?: string }>(store(OUTREACH_EMAILS)),
          listJsonFast<{ id: string; name?: string; query?: string }>(store(OUTREACH_CAMPAIGNS)),
          listJsonFast<{ lead_id?: string; campaign_id?: string; channel?: string; status?: string; sent_at?: string | null; type?: string; review_status?: string | null; parts?: Array<{ text?: string }> }>(store(OUTREACH_SOCIAL)),
          listJsonFast<{ lead_id?: string | null; original_email_id?: string | null; is_test?: boolean; received_at?: string; from?: string | null }>(store(OUTREACH_REPLIES)),
          listJsonFast<Touch>(store(OUTREACH_TOUCHES)),
        ]);
        await recheckDraftRows(emails as unknown as Array<Record<string, unknown>>);
        const repliedByReply = new Set(replyRows.filter((r) => r.lead_id && !isTestReply(r)).map((r) => String(r.lead_id)));
        const repliedAtByLead = new Map<string, string>(); // latest reply per lead (replies arrive by email)
        for (const r of replyRows) if (r.lead_id && !isTestReply(r) && r.received_at && r.received_at > (repliedAtByLead.get(String(r.lead_id)) ?? "")) repliedAtByLead.set(String(r.lead_id), r.received_at);
        const emailsByLead = new Map<string, typeof emails>();
        for (const e of emails) if (e.lead_id) (emailsByLead.get(e.lead_id) ?? emailsByLead.set(e.lead_id, []).get(e.lead_id)!).push(e);
        const socialsByLead = new Map<string, typeof socials>();
        for (const x of socials) if (x.lead_id) (socialsByLead.get(x.lead_id) ?? socialsByLead.set(x.lead_id, []).get(x.lead_id)!).push(x);
        const touchesByLead = new Map<string, Touch[]>();
        for (const t of storedTouches) (touchesByLead.get(t.lead_id) ?? touchesByLead.set(t.lead_id, []).get(t.lead_id)!).push(t);
        const ownOnlyReplies = ownReplyEmailIds(replyRows); // emails whose only reply is Lakshmi's own test
        const socialByLead = new Map<string, Array<{ channel: string; sent_at: string }>>();
        for (const x of socials) if (x.lead_id && x.channel && x.status === "sent" && x.sent_at) socialByLead.set(x.lead_id, [...(socialByLead.get(x.lead_id) ?? []), { channel: x.channel, sent_at: x.sent_at }]);
        const campName = new Map(campaigns.map((c) => [c.id, c.name ?? c.query ?? c.id]));
        const campCtx = new Map(campaigns.map((c) => [c.id, campaignSkipCtx(c as unknown as CampaignRecord)]));
        // Per lead: strongest email state and when we last emailed it.
        const byLead = new Map<string, { replied: boolean; bounced: boolean; sent: boolean; sent_at: string | null; review: string | null; review_at: string }>();
        for (const e of emails) {
          if (!e.lead_id) continue;
          const cur = byLead.get(e.lead_id) ?? { replied: false, bounced: false, sent: false, sent_at: null, review: null, review_at: "" };
          const st = e.status ?? "drafted";
          // The review status of the lead's newest unsent draft (older drafts without one count as "check").
          if (st === "drafted" && (e.created_at ?? "") >= cur.review_at) { cur.review = e.review_status === "ready" || e.review_status === "blocked" ? e.review_status : "check"; cur.review_at = e.created_at ?? ""; }
          if (st === "replied" && !(e.id && ownOnlyReplies.has(e.id))) cur.replied = true;
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
          const h = leadHours(l as Parameters<typeof leadHours>[0]);
          const social = (l.social as Record<string, string | null> | undefined) ?? {};
          const lid = l.id as string;
          const tl = deriveTouches({ lead_id: lid, campaign_id: (l.campaign_id as string | undefined) ?? null, emails: emailsByLead.get(lid) ?? [], socials: socialsByLead.get(lid) ?? [], stored: touchesByLead.get(lid) ?? [] });
          const touches = summarizeTouches(tl, email_status === "replied" || repliedByReply.has(lid), { at: repliedAtByLead.get(lid) ?? null, via: "email" });
          const social_drafts = (socialsByLead.get(lid) ?? []).filter((x) => x.status === "drafted").map((x) => ({ channel: x.channel, review_status: x.review_status ?? null, type: x.type ?? "first" }));
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
            social_sent: socialByLead.get(l.id as string) ?? [],
            touches, social_drafts, fb_checked: l.fb_checked ?? null,
            excluded: l.excluded === true, excluded_reason: (l.excluded_reason as string | undefined) ?? null, excluded_note: (l.excluded_note as string | undefined) ?? null,
            email_source: (l.email_source as string | undefined) ?? null, email_manual_at: (l.email_manual_at as string | undefined) ?? null,
            not_fit_kept: l.not_fit_kept === true,
            email_typo: possibleTypoDomain(l.email as string | null | undefined),
            ...autoFitFields(l.excluded === true ? null : autoNotFit(l, campCtx.get(l.campaign_id as string) ?? { location: null, query: "", anyTrade: true }, isContacted({ emailSent: !!(em?.sent || contactedAt), emailDraft: em?.review != null, touches: touches.total, replied: touches.replied }))),
          };
        });
        rows.sort((a, b) => (b.gap_score ?? -1) - (a.gap_score ?? -1) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
        return ok(rows);
      }

      case "outreach.lead.screenshot.get": {
        const { campaign_id, lead_id } = params as Record<string, string>;
        if (!campaign_id || !lead_id) return fail(400, "campaign_id and lead_id required");
        const rec = await readJson<{ jpeg_base64: string; saved_at: string; bytes: number }>(store(LEAD_SCREENSHOTS), `${campaign_id}/${lead_id}`);
        if (!rec) return ok({ found: false });
        return ok({ found: true, data_url: `data:image/jpeg;base64,${rec.jpeg_base64}`, saved_at: rec.saved_at, bytes: rec.bytes });
      }

      case "outreach.leads.count": {
        if (sqlBackend()) return sqlCampaignCase("outreach.leads.count", params, identity);
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
            try { await store(LEAD_SCREENSHOTS).delete(`${campaign_id}/${lead_id}`); } catch { /* none */ }
            try { const so = store(OUTREACH_SOCIAL); for (const b of (await so.list({ prefix: `${campaign_id}/${lead_id}/` })).blobs) await so.delete(b.key); } catch { /* none */ }
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
        const manualEmail = lead.email_source === "manual"; // typed by you: never replaced by a website check
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
          const skipEmail = (!!skip && skip.code === "gov_edu_email") || manualEmail || fresh.email_source === "manual";
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
        const fw = typeof framework === "string" && ["pas", "aida", "sdr", "four-step", "one-off"].includes(framework) ? framework : "one-off";
        const totalNum = typeof sequence_total === "number" && sequence_total >= 1 ? Math.floor(sequence_total) : fw === "four-step" ? 4 : stepNum;

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
        // The same free code checks as a generated draft run at once: a hard hit is Blocked without anyone pressing Review.
        const createCheck = await codeCheckSavedEmail(record, campaign_id);
        if (createCheck.status === "blocked") Object.assign(record, { review_status: "blocked", review_reasons: createCheck.reasons, reviewed_by: "code checks", reviewed_at: createdAt });
        await writeJson(es, `${campaign_id}/${createdAt}-${emailId}`, record);
        await patchState(campaign_id, {
          default_sender_name: (typeof sender_name === "string" && sender_name) || (campaign.default_sender_name as string | undefined) || null,
          default_framework: fw,
          default_sequence_total: totalNum,
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
        // Speed (8c): the drafts and the leads store are read in parallel, many blobs at a time, and the campaign's leads come out of the one
        // all-leads read instead of a second, serial read of the same blobs.
        const [rows, allLeads] = await Promise.all([
          listJsonFast<{ created_at?: string; status?: string; lead_id?: string; to_email?: string }>(store(OUTREACH_EMAILS), `${campaign_id}/`),
          listJsonFast<{ id: string; campaign_id?: string; email?: string | null; do_not_contact?: boolean; excluded?: boolean; is_test?: boolean }>(store(OUTREACH_LEADS)),
        ]);
        await recheckDraftRows(rows as unknown as Array<Record<string, unknown>>); // old drafts are re-checked once per rules change
        rows.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1));
        // Flag drafts that will never be sent because the recipient said no
        // (any lead, in any campaign, with that email or lead id is do-not-contact).
        const dncLeads = allLeads.filter((l) => l.do_not_contact);
        const dncIds = new Set(dncLeads.map((l) => l.id));
        const dncMail = new Set(dncLeads.map((l) => emailKey(l.email)).filter((e): e is string => !!e));
        const campLeads = allLeads.filter((l) => l.campaign_id === campaign_id);
        const skippedLeadIds = new Set(campLeads.filter((l) => l.excluded).map((l) => l.id));
        const testLeadIds = new Set(campLeads.filter((l) => l.is_test).map((l) => l.id));
        const contactsIdx = await loadContacts();
        const annotated = rows.map((r0) => {
          // Drafts from before the reviewer existed count as "check" (not reviewed yet).
          const rv = r0 as { review_status?: string; review_reasons?: string[] };
          const r1 = r0.status === "drafted" && !rv.review_status ? { ...r0, review_status: "check", review_reasons: ["Not reviewed yet"] } : r0;
          // A listed reason always means check: "ready" with reasons (old rows) is shown as check.
          const r = (r1 as { review_status?: string }).review_status === "ready" && (rv.review_reasons ?? []).length > 0 && (r1 as { reviewed_by?: string | null }).reviewed_by !== "you" ? { ...r1, review_status: "check" } : r1;
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
            if (changed) {
              // Every edit is code-checked at once: a hard hit is Blocked; otherwise it is "check" until reviewed or marked ready.
              const ck = await codeCheckSavedEmail(updated, campaign_id);
              Object.assign(updated, ck.status === "blocked"
                ? { review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: new Date().toISOString() }
                : { review_status: "check", review_reasons: dedupeReasons(["You edited this draft. Review it again, or mark it ready yourself.", ...ck.reasons]), reviewed_by: null, reviewed_at: null });
            }
            if (review_status === "ready") {
              // Mark ready is refused while any hard code hit remains (a stored status can be older than the rules).
              const ck = await codeCheckSavedEmail(updated, campaign_id);
              if (ck.hard.length) {
                await writeJson(es, b.key, { ...updated, review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: new Date().toISOString() });
                return fail(400, `Cannot mark this ready: ${ck.hard.join(" | ")}`);
              }
              if (!changed && row.review_status === "blocked") return fail(400, `Cannot mark this ready: it is Blocked${Array.isArray(row.review_reasons) && row.review_reasons.length ? ` (${(row.review_reasons as string[]).join(" | ")})` : ""}. Edit it to fix the problem, or run Review again.`);
              Object.assign(updated, { review_status: "ready", review_reasons: [], reviewed_by: "you", reviewed_at: new Date().toISOString() });
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
        const campaign = await readCampaign<Record<string, unknown>>(campaign_id);
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
        for (const [k, max] of [["postal_address", 300], ["default_sender_name", 120], ["default_sender_company", 120], ["default_sender_offer", 600], ["free_asset_1", 400], ["free_asset_2", 400], ["proof_line", 500], ["named_sources", 400]] as const) {
          const v = text(k, max);
          if (v === null) return fail(400, `${k} must be a string`);
          if (v !== undefined) next[k] = v;
        }
        const booking = text("booking_link", 300);
        if (booking === null) return fail(400, "booking_link must be text");
        if (booking !== undefined) {
          if (booking && !/^https?:\/\/[^\s]+$/i.test(booking)) return fail(400, "The booking link must start with https://");
          next.booking_link = booking;
        }
        const tz = text("time_zone", 60);
        if (tz === null) return fail(400, "time_zone must be text");
        if (tz !== undefined) {
          if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return fail(400, `"${tz}" is not a time zone name (for example America/Chicago).`); } }
          next.time_zone = tz;
        }
        if (p.daily_send_limit !== undefined) {
          const n = Number(p.daily_send_limit);
          if (!Number.isInteger(n) || n < 1 || n > 10000) return fail(400, "Daily send limit must be a whole number from 1 to 10000.");
          next.daily_send_limit = n;
        }
        for (const k of ["follow_up_gaps_email", "follow_up_gaps_social"] as const) {
          if (p[k] === undefined) continue;
          const g = parseGaps(p[k]);
          const raw = Array.isArray(p[k]) ? (p[k] as unknown[]).map(Number) : String(p[k]).split(/[,\s]+/).filter(Boolean).map(Number);
          if (raw.length === 0 || raw.some((x) => !Number.isInteger(x) || x < 1 || x > 120)) return fail(400, `${k === "follow_up_gaps_email" ? "Email" : "Social"} follow-up days: use whole days from 1 to 120, like 3, 8, 15.`);
          if (raw.some((x, i) => i > 0 && x <= raw[i - 1])) return fail(400, `${k === "follow_up_gaps_email" ? "Email" : "Social"} follow-up days must go up, each later than the one before (for example 3, 8, 15), not "${raw.join(", ")}".`);
          next[k] = g;
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
          const chosen = v || (role === "review" ? DEFAULT_REVIEW_MODEL : role === "draft" ? DEFAULT_DRAFT_MODEL : DEFAULT_GEMINI_MODEL);
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
        const allEmails = await listJson<{ id: string; campaign_id: string; lead_id: string; to_email: string; subject: string; body_text: string; body_html: string; status: string; sender_name?: string | null; sequence_position?: number; created_at?: string; review_status?: string; framework?: string; sent_at?: string; agentmail_message_id?: string | null; agentmail_inbox_id?: string | null }>(
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
        // Why a draft does NOT go out (null = it can). Every explicit id and every in-scope draft gets a reason; nothing is silently dropped.
        const notSent: Array<{ email_id: string; to_email?: string; step?: number; reason: string; code: string }> = [];
        const whyNot = (e: (typeof allEmails)[number]): { code: string; reason: string } | null => {
          if (e.status !== "drafted") return { code: "not_draft", reason: `Not a draft any more (status: ${e.status})` };
          if (isDnc(e)) return { code: "do_not_contact", reason: "Do not contact: this lead or address asked not to be emailed" };
          if (excludedLeadIds.has(e.lead_id)) return { code: "lead_skipped", reason: "This lead was skipped (not a fit)" };
          const cb = contactBlocked(e);
          if (cb) return { code: "contacted", reason: cb.message.replace(/^Skipped: /, "") };
          if (!passesReview(e)) return reviewOf(e) === "blocked" ? { code: "blocked", reason: `Blocked: ${(Array.isArray((e as { review_reasons?: string[] }).review_reasons) ? (e as { review_reasons?: string[] }).review_reasons! : []).join(" | ") || "fix it first"}` } : { code: "not_ready", reason: "Check this: mark it ready or confirm sending it" };
          if ((e.sequence_position ?? 1) > 1 && repliedLeadIds.has(e.lead_id)) return { code: "replied", reason: "This lead already replied, so later emails are not sent" };
          return null;
        };
        const candidates = allEmails.filter((e) => (selectedIds ? selectedIds.has(e.id) : targetStep !== null ? (e.sequence_position ?? 1) === targetStep : true) && e.status === "drafted");
        if (selectedIds) for (const id of selectedIds) if (!allEmails.some((e) => e.id === id)) notSent.push({ email_id: id, reason: "No draft with this id in this campaign", code: "not_found" });
        if (selectedIds) for (const e of allEmails.filter((x) => selectedIds.has(x.id) && x.status !== "drafted")) notSent.push({ email_id: e.id, to_email: e.to_email, step: e.sequence_position ?? 1, ...whyNot(e)! });
        const eligible = candidates.filter((e) => {
          const w = whyNot(e);
          if (w) { if (selectedIds || w.code === "replied" || w.code === "blocked") notSent.push({ email_id: e.id, to_email: e.to_email, step: e.sequence_position ?? 1, ...w }); return false; }
          return true;
        });
        // Oldest first, then cap to the requested batch size.
        eligible.sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : (a.created_at ?? "") > (b.created_at ?? "") ? 1 : 0));
        // Send-time gate: the free code checks run again on each draft right before it goes out (an old Ready draft can break newer rules).
        const toSend: typeof eligible = [];
        let gateBlocked = 0;
        for (const e of eligible) {
          if (batchLimit && toSend.length >= batchLimit) break;
          const ck = await codeCheckSavedEmail(e as unknown as Record<string, unknown>, campaign_id);
          if (ck.hard.length) {
            gateBlocked++;
            await saveDraftPatch(e as unknown as Record<string, unknown>, { review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: new Date().toISOString(), rules_version: RULES_VERSION });
            notSent.push({ email_id: e.id, to_email: e.to_email, step: e.sequence_position ?? 1, code: "blocked", reason: `Blocked by the free checks: ${ck.hard.join(" | ")}` });
            continue;
          }
          toSend.push(e);
        }
        const overLimit = batchLimit ? eligible.length - gateBlocked - toSend.length : 0;
        const queuedBefore = allEmails.filter((e) => e.status === "drafted" && !isDnc(e) && !excludedLeadIds.has(e.lead_id) && !contactBlocked(e) && reviewOf(e) === "ready").length;
        const draftedInScope = allEmails.filter((e) => e.status === "drafted" && inScope(e) && !isDnc(e) && !contactBlocked(e));
        const skippedExcluded = draftedInScope.filter((e) => excludedLeadIds.has(e.lead_id)).length;
        const skippedBlocked = draftedInScope.filter((e) => !excludedLeadIds.has(e.lead_id) && reviewOf(e) === "blocked").length + gateBlocked;
        const skippedNotReady = draftedInScope.filter((e) => !excludedLeadIds.has(e.lead_id) && reviewOf(e) === "check" && !passesReview(e)).length;
        const skipInfo = { skipped_excluded: skippedExcluded, skipped_blocked: skippedBlocked, skipped_not_ready: skippedNotReady, skipped_over_limit: overLimit, not_sent: notSent };
        const skippedContacted = allEmails.filter((e) => e.status === "drafted" && !isDnc(e) && contactBlocked(e) && (!selectedIds || selectedIds.has(e.id))).map((e) => ({ email_id: e.id, to_email: e.to_email, reason: contactBlocked(e)!.message.replace(/^Skipped: /, "") }));

        if (toSend.length === 0) {
          // Never "0 sent" without a reason.
          const first = notSent.slice(0, 3).map((x) => `${x.to_email ?? x.email_id}${x.step ? ` (email ${x.step})` : ""}: ${x.reason}`).join("; ");
          const reason = notSent.length ? `Nothing was sent. ${first.replace(/\.$/, "")}${notSent.length > 3 ? `; and ${notSent.length - 3} more` : ""}.` : candidates.length === 0 ? (selectedIds ? "Nothing was sent: none of the chosen emails is a draft." : targetStep !== null ? `Nothing was sent: there are no drafts at step ${targetStep}.` : "Nothing was sent: there are no drafts to send.") : "Nothing was sent: no draft passed the send checks.";
          return ok({ sent: 0, total: 0, queued: queuedBefore, errors: [], ...skipInfo, reason, skipped_do_not_contact: allEmails.filter((e) => e.status === "drafted" && isDnc(e)).length, skipped_contacted: skippedContacted });
        }

        const settings = await readJson<{ postal_address?: string }>(store(OUTREACH_SETTINGS), "settings");
        const postalAddress = settings?.postal_address ?? "";

        await writeJson(cs, campaign_id, { ...campaign, status: "sending", updated_at: new Date().toISOString() });

        const inbox = await getOrCreateCampaignInbox(agentmailKey, campaign.name as string, (await readOutreachSettings()).sending_inbox_id || undefined);

        // Sender display name — per-email overrides campaign-level.
        const campaignSenderName = ((await readState(campaign_id)).default_sender_name as string | undefined) ?? (campaign.default_sender_name as string | undefined) ?? "";
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
            let sendBody: Record<string, unknown> = {
              to: [em.to_email],
              subject: em.subject,
              text: withFooter.text,
              html: withFooter.html,
            };
            let sendPath = `/inboxes/${inbox.inbox_id}/messages/send`;
            // Alcance 4-step emails 2 to 4 go as a real reply under email 1 in the same thread (no made-up "Re:" subject).
            const pos = em.sequence_position ?? 1;
            if (em.framework === "four-step" && pos > 1) {
              const before = allEmails
                .filter((x) => x.lead_id === em.lead_id && x.status !== "drafted" && x.agentmail_message_id && (x.sequence_position ?? 1) === 1)
                .sort((a, b) => String(b.sent_at ?? "").localeCompare(String(a.sent_at ?? "")))[0];
              if (!before) { errors.push({ email_id: em.id, error: "Send email 1 first: this one goes as a reply in the same thread." }); continue; }
              sendPath = `/inboxes/${encodeURIComponent(before.agentmail_inbox_id || inbox.inbox_id)}/messages/${encodeURIComponent(String(before.agentmail_message_id))}/reply`;
              sendBody = { text: withFooter.text, html: withFooter.html };
            }
            const r = await agentmailFetch(agentmailKey, sendPath, {
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
        const rows = await listJson<{ received_at?: string; text?: string | null; html?: string | null; is_test?: boolean; from?: string | null; subject?: string | null }>(s, prefix);
        // A broken record (no sender, no date and no text: nothing a person could read or answer) is left out on read, never shown as "Unknown".
        for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].from && !rows[i].received_at && !(rows[i].text ?? "").trim() && !(rows[i].html ?? "").trim()) rows.splice(i, 1);
        rows.sort((a, b) => ((a.received_at ?? "") < (b.received_at ?? "") ? 1 : -1));
        // Replies stored before the HTML fallback have an empty text: fill it from the html when read (no data rewrite).
        return ok(rows.slice(0, typeof limit === "number" ? limit : 200).map((r0) => { const r = { ...r0, is_test: isTestReply(r0), system: isSystemReply(r0 as { from?: string | null; subject?: string | null; to?: string[] | null }) }; return r.text && r.text.trim() ? r : { ...r, text: replyBodyText(r) || r.text || null }; }));
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

      // ── Follow-up reminders (batch 8c). Read-time: due dates come from what was sent and the Settings gaps; nothing here sends. ──
      case "outreach.send.today": {
        // Real emails sent today (all campaigns; the day is in the Settings time zone, India when blank; mock, test-lead and own-address sends excluded) and the daily limit. Read-only; used by the send confirm boxes.
        const st = await readOutreachSettings();
        const tzs = (st.time_zone ?? "").trim();
        const [rows, leadRows] = await Promise.all([listJsonFast<SentRow>(store(OUTREACH_EMAILS)), listJsonFast<{ id?: string; is_test?: boolean }>(store(OUTREACH_LEADS))]);
        const testLeadIds = new Set(leadRows.filter((l) => l.is_test && l.id).map((l) => String(l.id)));
        return ok({ sent_today: countSentToday(rows, tzs && validTimeZone(tzs) ? tzs : DEFAULT_COUNT_TZ, new Date(), { testLeadIds, isOwn: (a) => isOwnAddress(a) }), limit: limitOrDefault(st.daily_send_limit) });
      }

      case "followups.list": {
        const t0 = Date.now();
        const settings = await readOutreachSettings();
        const tzName = (settings.time_zone ?? "").trim();
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: tzName && validTimeZone(tzName) ? tzName : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const [emails, socials, leads, replies, states] = await Promise.all([
          listJsonFast<Record<string, unknown> & { id: string; lead_id: string; campaign_id: string; status?: string; sent_at?: string; sequence_position?: number; framework?: string; subject?: string; body_text?: string; review_status?: string | null }>(store(OUTREACH_EMAILS)),
          listJsonFast<SocialRecord>(store(OUTREACH_SOCIAL)),
          listJsonFast<Record<string, unknown> & { id: string; campaign_id?: string; name?: string; do_not_contact?: boolean; excluded?: boolean }>(store(OUTREACH_LEADS)),
          listJsonFast<{ lead_id?: string | null; original_email_id?: string | null; is_test?: boolean; from?: string | null; opt_out?: boolean }>(store(OUTREACH_REPLIES)),
          listJsonFast<FollowState>(store(OUTREACH_FOLLOWUPS)),
        ]);
        await recheckDraftRows(emails as unknown as Array<Record<string, unknown>>);
        for (const rec of socials) { if (rec.type === "sequence" && (rec as { rules_version?: number }).rules_version !== RULES_VERSION) Object.assign(rec, (await verifySocialRecord(rec, { stamp: true })).rec); }
        const stateOf = new Map(states.map((x) => [`${x.lead_id}/${x.channel}`, x]));
        const leadBy = new Map(leads.map((l) => [`${l.campaign_id}/${l.id}`, l]));
        const ownOnly = ownReplyEmailIds(replies.filter((r) => r.original_email_id));
        const repliedIds = new Set<string>([...emails.filter((e) => e.status === "replied" && !ownOnly.has(e.id)).map((e) => e.lead_id), ...replies.filter((r) => r.lead_id && !isTestReply(r)).map((r) => String(r.lead_id)), ...states.filter((x) => x.channel === "all" && x.replied_by_hand).map((x) => x.lead_id)]);
        const optOutIds = new Set(replies.filter((r) => r.opt_out && r.lead_id).map((r) => String(r.lead_id)));
        const stoppedFor = (lead: { id: string; do_not_contact?: boolean } | undefined, leadId: string): StoppedReason | null => (optOutIds.has(leadId) ? "opt_out" : lead?.do_not_contact ? "do_not_contact" : repliedIds.has(leadId) ? "replied" : null);
        const gE = gapsOrDefault(settings.follow_up_gaps_email), gS = gapsOrDefault(settings.follow_up_gaps_social);
        const rows: FollowRow[] = [];
        const byLead = new Map<string, typeof emails>();
        for (const e of emails) { if (e.framework !== "four-step") continue; const k = `${e.campaign_id}/${e.lead_id}`; (byLead.get(k) ?? byLead.set(k, []).get(k)!).push(e); }
        for (const [k, list] of byLead) {
          const lead = leadBy.get(k);
          if (!lead || lead.excluded) continue;
          list.sort((a, b) => (a.sequence_position ?? 1) - (b.sequence_position ?? 1));
          const steps: FollowStepIn[] = list.map((e) => ({ key: String(e.sequence_position ?? 1), label: `Email ${e.sequence_position ?? 1}`, text: String(e.body_text ?? ""), sent_at: e.status && e.status !== "drafted" && e.status !== "failed" ? (e.sent_at ?? null) : null, status: (e.review_status as FollowStepIn["status"]) ?? null, id: e.id }));
          const r = nextFollowUp({ lead_id: lead.id, campaign_id: String(lead.campaign_id), name: String(lead.name ?? lead.id), channel: "email", steps, state: stateOf.get(`${lead.id}/email`), gaps: gE, stopped: stoppedFor(lead, lead.id), today });
          if (r) rows.push(r);
        }
        const extra = new Map<string, { url: string; subject?: string }>();
        for (const rec of socials) {
          if (rec.type !== "sequence") continue;
          const lead = leadBy.get(`${rec.campaign_id}/${rec.lead_id}`);
          if (!lead || lead.excluded) continue;
          const steps: FollowStepIn[] = rec.parts.map((p) => ({ key: p.key, label: p.label, text: p.text, sent_at: p.sent_at ?? null, status: p.review_status ?? null }));
          const r = nextFollowUp({ lead_id: lead.id, campaign_id: String(lead.campaign_id), name: String(lead.name ?? lead.id), channel: rec.channel, steps, state: stateOf.get(`${lead.id}/${rec.channel}`), gaps: gS, stopped: stoppedFor(lead, lead.id), today });
          if (r) {
            rows.push(r);
            // The page link is the lead's own saved page for this channel, never one built from an id; hidden when there is none.
            const own = channelsFor(lead as Parameters<typeof channelsFor>[0]).find((c) => c.channel === rec.channel)?.url ?? "";
            extra.set(`${r.lead_id}/${r.channel}`, { url: /^https?:\/\//i.test(own.trim()) ? own.trim() : "" });
          }
        }
        const live = rows.filter((r) => r.bucket !== "stopped");
        live.sort((a, b) => (a.bucket === "waiting" ? 1 : 0) - (b.bucket === "waiting" ? 1 : 0) || String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")));
        const campNames = new Map((await listJson<{ id: string; name?: string }>(store(OUTREACH_CAMPAIGNS))).map((c) => [c.id, c.name ?? c.id]));
        const handIds = new Set(states.filter((x) => x.channel === "all" && x.replied_by_hand).map((x) => x.lead_id));
        const out = [...live, ...rows.filter((r) => r.bucket === "stopped")].map((r) => ({ ...r, by_hand: handIds.has(r.lead_id), campaign_name: campNames.get(r.campaign_id) ?? r.campaign_id, page_url: extra.get(`${r.lead_id}/${r.channel}`)?.url || null }));
        return ok({ today, rows: out, counts: countDue(rows), postal_address_set: !!(await readOutreachSettings()).postal_address?.trim(), ms: Date.now() - t0 });
      }

      case "followups.update": {
        // One small note per lead, channel and step: skip, move the date, note. Only this store changes.
        const { lead_id, channel, step_key, op, value } = params as { lead_id?: string; channel?: string; step_key?: string; op?: string; value?: unknown };
        if (!lead_id || !channel || !step_key || !op) return fail(400, "lead_id, channel, step_key and op required");
        if (!["email", "facebook", "instagram", "linkedin"].includes(channel)) return fail(400, "unknown channel");
        const fs2 = store(OUTREACH_FOLLOWUPS);
        const key = `${lead_id}/${channel}`;
        const cur = (await readJson<FollowState>(fs2, key)) ?? { lead_id, channel, steps: {} };
        const stepNow = { ...(cur.steps?.[step_key] ?? {}) };
        if (op === "skip") stepNow.skipped = true;
        else if (op === "unskip") delete stepNow.skipped;
        else if (op === "note") stepNow.note = String(value ?? "").slice(0, 300);
        else if (op === "move") {
          const d = String(value ?? "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) return fail(400, "That date is not valid.");
          stepNow.moved_to = d;
        } else if (op === "unmove") delete stepNow.moved_to;
        else return fail(400, "unknown op");
        const next: FollowState = { ...cur, steps: { ...(cur.steps ?? {}), [step_key]: stepNow }, updated_at: new Date().toISOString() };
        await writeJson(fs2, key, next);
        return ok(next);
      }

      case "followups.replied": {
        // "They replied" by hand (a reply that came on Facebook, LinkedIn and so on): stops every channel for this lead. undo:true clears it.
        const { lead_id, undo } = params as { lead_id?: string; undo?: boolean };
        if (!lead_id) return fail(400, "lead_id required");
        const next: FollowState = { lead_id, channel: "all", replied_by_hand: undo ? null : new Date().toISOString(), updated_at: new Date().toISOString() };
        await writeJson(store(OUTREACH_FOLLOWUPS), `${lead_id}/all`, next);
        await logActivity({ category: "outreach", summary: `${undo ? "Cleared" : "Marked"} a hand-recorded reply for lead ${lead_id}` });
        return ok(next);
      }

      case "followups.linkedin": {
        const { lead_id, op } = params as { lead_id?: string; op?: string };
        if (!lead_id || !op) return fail(400, "lead_id and op required");
        const fs2 = store(OUTREACH_FOLLOWUPS);
        const key = `${lead_id}/linkedin`;
        const cur = (await readJson<FollowState>(fs2, key)) ?? { lead_id, channel: "linkedin", steps: {} };
        const now = new Date().toISOString();
        const next: FollowState = op === "accepted" ? { ...cur, accepted_at: now, withdrawn_at: null } : op === "withdrawn" ? { ...cur, withdrawn_at: now } : op === "undo" ? { ...cur, accepted_at: null, withdrawn_at: null } : cur;
        if (!["accepted", "withdrawn", "undo"].includes(op)) return fail(400, "unknown op");
        await writeJson(fs2, key, { ...next, updated_at: now });
        return ok(next);
      }

      // Draft a reply to an inbound answer: the AI writes two short parts, code adds three call times and the booking link. Never sent.
      case "outreach.reply.draft": {
        const { id } = params as Record<string, string>;
        if (!id) return fail(400, "id required");
        const settings = await readOutreachSettings();
        const bookingLink = (settings.booking_link ?? "").trim();
        const tz = (settings.time_zone ?? "").trim();
        if (!bookingLink || !tz) return fail(400, `Check this: add ${!bookingLink && !tz ? "a booking link and your time zone" : !bookingLink ? "a booking link" : "your time zone"} in Settings, then try again.`);
        if (!validTimeZone(tz)) return fail(400, "Check this: the time zone in Settings is not a valid one (for example America/Chicago).");
        const rs = store(OUTREACH_REPLIES);
        const reply = (await listJson<{ id: string; text?: string | null; html?: string | null; subject?: string | null; from?: string | null; lead_id?: string | null; campaign_id?: string | null; original_email_id?: string | null }>(rs)).find((r) => r.id === id);
        if (!reply) return fail(404, "reply not found");
        const text = (reply.text && reply.text.trim()) || replyBodyText(reply as never) || "";
        if (!text) return fail(400, "This reply has no text to answer.");
        const leads = reply.campaign_id ? await listJson<Record<string, unknown>>(store(OUTREACH_LEADS), `${reply.campaign_id}/`) : [];
        const lead = leads.find((l) => l.id === reply.lead_id) ?? {};
        const emails = reply.campaign_id ? await listJson<{ id: string; lead_id: string; sequence_position?: number; body_text?: string; sender_name?: string }>(store(OUTREACH_EMAILS), `${reply.campaign_id}/`) : [];
        const first = emails.find((e) => e.id === reply.original_email_id) ?? emails.filter((e) => e.lead_id === reply.lead_id).sort((a, b) => (a.sequence_position ?? 1) - (b.sequence_position ?? 1))[0];
        const camp = reply.campaign_id ? await readJson<{ default_sender_name?: string }>(store("agent-hq-outreach-campaigns"), reply.campaign_id) : null;
        const senderName = (first?.sender_name || camp?.default_sender_name || "Lakshmi Devaraj").trim();
        const st = stateFromAddress(lead.address);
        const prospectTz = st ? STATE_TZ[st] : tz;
        const slots = proposeSlots(new Date(), tz, prospectTz);
        const c = a3Context(lead);
        let answer = "", whyCall = "", hint = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          const ans = await aiJson("draft", { system: REPLY_SYSTEM_PROMPT, user: replyUserPrompt({ from: reply.from, subject: reply.subject, text }, { name: typeof lead.name === "string" ? lead.name : undefined, city: c.city, owner: typeof lead.owner_name === "string" ? lead.owner_name : undefined }, first?.body_text) + hint, temperature: 0.4 }, {});
          const j = ans.json as { answer?: unknown; why_call?: unknown };
          answer = typeof j?.answer === "string" ? j.answer : "";
          whyCall = typeof j?.why_call === "string" ? j.why_call : "";
          const hits = scanBanned(`${answer} ${whyCall}`).filter((h) => h.level === "hard");
          const long = sentenceCount(answer) > 2 || sentenceCount(whyCall) > 1;
          // The times are listed below the text, so the answer never names a day, date or clock time itself.
          const namesTime = TIME_WORDS_RE.test(`${answer} ${whyCall}`);
          if (answer && whyCall && hits.length === 0 && !long && !namesTime) { hint = ""; break; }
          hint = `\nFix these problems and answer again: ${namesTime ? "do not name any weekday, date or clock time, the times are listed separately; " : ""}${!answer || !whyCall ? "both parts are needed; " : ""}${long ? "answer is one or two sentences and why_call is exactly one sentence; " : ""}${hits.map((h) => h.label).join("; ")}`;
          if (attempt === 1 && namesTime) { answer = (answer.match(/[^.?!]+[.?!]+/g) ?? [answer]).filter((x) => !TIME_WORDS_RE.test(x)).join(" ").trim() || "Yes, happy to set up a call."; whyCall = (whyCall.match(/[^.?!]+[.?!]+/g) ?? [whyCall]).filter((x) => !TIME_WORDS_RE.test(x)).join(" ").trim() || whyCall.replace(TIME_WORDS_RE, ""); }
          if (attempt === 1 && answer && whyCall && long) { answer = firstSentences(answer, 2); whyCall = firstSentences(whyCall, 1); } // the second try ran long again: keep the allowed length
        }
        if (!answer || !whyCall) return fail(502, "The writer did not return a usable draft. Try again.");
        // Greet by name when it is known: the saved owner, else the first name on the sender line of their reply.
        const fromName = /^hi there$/i.test(c.greeting) ? firstNameFromSender(reply.from) : null;
        const draft = assembleReply({ greeting: `${fromName ? `Hi ${fromName}` : c.greeting},`, answer, whyCall, slots, bookingLink, senderName });
        return ok({ draft, slots, sender_time_zone: tz, prospect_time_zone: prospectTz, assumed_zone: !st, note: "These times are proposals from your Settings time zone: check them against your real calendar before sending. Nothing was sent." });
      }

      case "outreach.reply.send": {
        // Sends the edited reply draft through AgentMail as a reply in the SAME thread, from the inbox the original email went out from.
        // Never automatic: the Inbox asks first (recipient, subject and the full text). `preview: true` returns exactly what would go out and sends nothing.
        const { id, text: rawText, preview, resend } = params as { id?: string; text?: string; preview?: boolean; resend?: boolean };
        if (!id) return fail(400, "id required");
        const body = String(rawText ?? "").replace(/\r/g, "").trim();
        if (!body) return fail(400, "The reply is empty.");
        const rs = store(OUTREACH_REPLIES);
        const { blobs: rblobs } = await rs.list();
        let replyKey = "";
        type ReplyRow = Record<string, unknown> & { id: string; campaign_id?: string | null; lead_id?: string | null; original_email_id?: string | null; agentmail_message_id?: string | null; agentmail_thread_id?: string | null; from?: string | null; subject?: string | null; opt_out?: boolean; our_reply?: unknown };
        let reply = null as ReplyRow | null;
        for (const b of rblobs) { const r = await readJson<ReplyRow>(rs, b.key); if (r?.id === id) { reply = r; replyKey = b.key; break; } }
        if (!reply) return fail(404, "reply not found");
        if (reply.opt_out) return fail(400, "This person asked us to stop. Nothing is sent.");
        const to = extractEmailAddress(reply.from ?? "");
        if (!to) return fail(400, "This reply has no sender address to answer.");
        if (!reply.agentmail_message_id) return fail(400, "This reply has no AgentMail message id, so it cannot be answered in its thread. Copy the text and send it by hand.");
        // The lead must not be do-not-contact, and the original email gives the inbox it went out from.
        const leadRows = reply.campaign_id ? await listJson<{ id?: string; do_not_contact?: boolean }>(store(OUTREACH_LEADS), `${reply.campaign_id}/`) : [];
        if (leadRows.find((l) => l.id === reply!.lead_id)?.do_not_contact) return fail(400, "This lead is marked do-not-contact. Nothing is sent.");
        const emailRows = reply.campaign_id ? await listJson<{ id: string; lead_id: string; agentmail_inbox_id?: string | null; sender_name?: string | null; subject?: string; sequence_position?: number }>(store(OUTREACH_EMAILS), `${reply.campaign_id}/`) : [];
        const original = emailRows.find((e) => e.id === reply!.original_email_id) ?? emailRows.filter((e) => e.lead_id === reply!.lead_id && e.agentmail_inbox_id).sort((a, b) => (a.sequence_position ?? 1) - (b.sequence_position ?? 1))[0];
        const inboxId = (original?.agentmail_inbox_id ?? "").trim();
        if (!inboxId) return fail(400, "Could not find the inbox the original email was sent from, so the reply cannot be sent in the same thread.");
        if (reply.our_reply && !resend) return fail(400, "You already sent a reply to this message. Send again only if you mean to.");
        const hard = scanBanned(body).filter((h) => h.level === "hard" && h.id !== "dash");
        if (hard.length) return fail(400, `Fix this before sending: ${hard.map((h) => `${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}`).join("; ")}`);
        const settings = await readOutreachSettings();
        const camp = reply.campaign_id ? await readJson<{ default_sender_name?: string }>(store(OUTREACH_CAMPAIGNS), reply.campaign_id) : null;
        const senderName = (original?.sender_name || camp?.default_sender_name || "Lakshmi Devaraj").trim();
        // The footer rules apply to a reply too: signature, opt-out line and the postal address when one is saved.
        const withFooter = appendFooter(body, textToHtml(body), settings.postal_address ?? "", senderName);
        const subject = /^re:/i.test(reply.subject ?? "") ? String(reply.subject) : `Re: ${reply.subject ?? original?.subject ?? ""}`.trim();
        const view = { to, subject, text: withFooter.text, inbox_id: inboxId, thread_id: reply.agentmail_thread_id ?? null, postal_address_set: !!(settings.postal_address ?? "").trim() };
        if (preview) return ok({ preview: true, ...view });
        const key = await readServiceKey("agentmail");
        if (!key) return fail(400, "AgentMail key not configured");
        const r = await agentmailFetch(key, `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(String(reply.agentmail_message_id))}/reply`, { method: "POST", body: JSON.stringify({ text: withFooter.text, html: withFooter.html }) });
        if (!r.ok) return fail(502, `AgentMail reply ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const resp = (await r.json()) as { message_id?: string; thread_id?: string };
        const sentAt = new Date().toISOString();
        await writeJson(rs, replyKey, { ...reply, handled: true, our_reply: { sent_at: sentAt, message_id: resp.message_id ?? null, thread_id: resp.thread_id ?? reply.agentmail_thread_id ?? null, inbox_id: inboxId, to, subject, text: withFooter.text } });
        await logActivity({ agent_id: identity?.kind === "agent" ? identity.agent_id : null, category: "email", summary: `Replied to ${to} in the same thread (${subject.slice(0, 60)})`, details: { reply_id: id, campaign_id: reply.campaign_id ?? null, message_id: resp.message_id ?? null } });
        return ok({ sent: true, message_id: resp.message_id ?? null, ...view, thread_id: resp.thread_id ?? view.thread_id });
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
          const emails = await campaignEmails(c.id);
          const sent = emails.filter((e) => e.status && e.status !== "drafted").length;
          const delivered = emails.filter((e) => ["delivered", "clicked", "replied"].includes(e.status ?? "")).length;
          const clicked = emails.filter((e) => e.status === "clicked" || (e.click_count ?? 0) > 0).length;
          const replied = emails.filter((e) => e.status === "replied" && !e.own_reply_only).length;
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

      // ── MISSED REPLIES (read-only toward AgentMail) ───────────────
      case "outreach.replies.sync": {
        // Reads the last N days of messages from every AgentMail inbox and stores the inbound ones HQ does not have yet
        // (same record, flag and opt-out rules as the webhook). Never sends, deletes or changes anything in AgentMail.
        const { days = 14, max_new = 40 } = params as { days?: number; max_new?: number };
        const agentmailKey = await readServiceKey("agentmail");
        if (!agentmailKey) return fail(400, "AgentMail key not configured");
        const cutoff = Date.now() - Math.max(1, Math.min(60, Number(days) || 14)) * 86_400_000;
        const inboxes: AgentMailInbox[] = [];
        let tok: string | undefined;
        for (let i = 0; i < 5; i++) {
          const r = await agentmailFetch(agentmailKey, `/inboxes?limit=100${tok ? `&page_token=${encodeURIComponent(tok)}` : ""}`);
          if (!r.ok) return fail(502, `AgentMail inbox list failed (${r.status})`);
          const body = (await r.json()) as { inboxes?: AgentMailInbox[]; next_page_token?: string };
          inboxes.push(...(body.inboxes ?? []));
          tok = body.next_page_token;
          if (!tok) break;
        }
        const own = await ownAddressList(inboxes.map((i) => i.email ?? i.inbox_id));
        const have = new Set((await listJsonFast<{ agentmail_message_id?: string | null }>(store(OUTREACH_REPLIES))).map((r) => r.agentmail_message_id).filter((x): x is string => !!x));
        const skipped = { already_have: 0, own_sent: 0, bounce_reports: 0, health_checks: 0, too_old: 0 };
        const candidates: Array<{ inbox: AgentMailInbox; m: ListedMessage }> = [];
        let scanned = 0;
        for (const inbox of inboxes) {
          let pt: string | undefined;
          for (let page = 0; page < 10; page++) {
            const r = await agentmailFetch(agentmailKey, `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages?${listMessagesQuery(pt)}`);
            if (!r.ok) return fail(502, `AgentMail message list failed for ${inbox.inbox_id} (${r.status})`);
            const body = (await r.json()) as { messages?: ListedMessage[]; next_page_token?: string };
            for (const m of body.messages ?? []) {
              scanned++;
              if (!isListedInbound(m)) { skipped.own_sent++; continue; }
              if (Date.parse(m.timestamp ?? "") < cutoff) { skipped.too_old++; continue; }
              if (isHealthCheckMessage(m.subject)) { skipped.health_checks++; continue; }
              if (isBounceReport(m.from, m.subject)) { skipped.bounce_reports++; continue; }
              if (m.message_id && have.has(m.message_id)) { skipped.already_have++; continue; }
              candidates.push({ inbox, m: { ...m, inbox_id: m.inbox_id ?? inbox.inbox_id } });
            }
            pt = body.next_page_token;
            if (!pt) break;
          }
        }
        candidates.sort((x, y) => (x.m.timestamp ?? "") < (y.m.timestamp ?? "") ? -1 : 1);
        const added: Array<{ from: string | null; subject: string | null; flag: string | null; campaign_id: string | null; received_at: string; test: boolean }> = [];
        let flagged = 0;
        const limit = Math.max(1, Math.min(100, Number(max_new) || 40));
        for (const { inbox, m } of candidates.slice(0, limit)) {
          let full: ListedMessage = m;
          try {
            const r = await agentmailFetch(agentmailKey, `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(m.message_id ?? "")}`);
            if (r.ok) full = { ...m, ...((await r.json()) as ListedMessage), labels: m.labels };
          } catch { /* the list item (with its preview) is enough */ }
          const msg = listedToMessage(full);
          const flag = flagFor("message.received", msg.labels);
          const res = await ingestInboundReply({ eventType: flag ? `message.received.${flag}` : "message.received", message: msg, alert: false, source: "sync" });
          if (res.stored && res.reply) {
            if (res.reply.flag) flagged++;
            added.push({ from: res.reply.from, subject: res.reply.subject, flag: res.reply.flag, campaign_id: res.reply.campaign_id, received_at: res.reply.received_at, test: res.reply.is_test });
          }
        }
        // A reply the sync added also moves the email to replied, so the campaign counters stay right (own test replies excluded).
        console.log(`[replies.sync] inboxes=${inboxes.length} scanned=${scanned} added=${added.length} flagged=${flagged}`);
        return ok({ added: added.length, flagged, scanned, skipped, more: Math.max(0, candidates.length - limit), items: added, inboxes: inboxes.map((i) => i.email ?? i.inbox_id), own_checked: own.length });
      }

      // ── WEBHOOK SUBSCRIPTION (HQ cannot create the AgentMail webhook; it can list it and update its event list) ──
      case "outreach.webhook.events": {
        // Default is a dry run: GET only, shows the event list now and the one that WOULD be sent.
        // apply:true sends it (refused on a local dev server unless ALLOW_WEBHOOK_PATCH=1: local testing is read-only).
        const { apply = false, url_contains } = params as { apply?: boolean; url_contains?: string };
        const agentmailKey = await readServiceKey("agentmail");
        if (!agentmailKey) return fail(400, "AgentMail key not configured");
        const w = await agentmailFetch(agentmailKey, "/webhooks");
        if (!w.ok) return fail(502, `AgentMail webhook list failed (${w.status})`);
        const wb = (await w.json()) as { webhooks?: Array<{ webhook_id?: string; id?: string; url?: string; enabled?: boolean; event_types?: string[] }> };
        const hooks = (wb.webhooks ?? []).filter((h) => !url_contains || (h.url ?? "").includes(url_contains));
        const out = [] as Array<ReturnType<typeof dryRunWebhookPatch> & { url: string; applied: boolean; message: string }>;
        for (const h of hooks) {
          const id = h.webhook_id ?? h.id ?? "";
          const d = dryRunWebhookPatch({ webhook_id: id, event_types: h.event_types ?? [] });
          let applied = false;
          let message = d.needs_change ? `Missing: ${d.added.join(", ")}` : "Already subscribed to every event Alcance handles.";
          if (apply && d.needs_change && id) {
            if (process.env.NETLIFY_DEV === "true" && process.env.ALLOW_WEBHOOK_PATCH !== "1") {
              message = "Not sent: this is a local dev server (local testing never changes the real AgentMail webhook).";
            } else {
              let r = await agentmailFetch(agentmailKey, `/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ event_types: d.after }) });
              if (!r.ok && (r.status === 400 || r.status === 422)) r = await agentmailFetch(agentmailKey, `/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ add_event_types: d.added }) });
              applied = r.ok;
              message = r.ok ? "Updated. Replies from domains without email authentication now reach Alcance." : `AgentMail would not update it (${r.status}). Tick "${d.added.join(", ")}" in the AgentMail console, Webhooks.`;
            }
          }
          out.push({ ...d, url: h.url ?? "", applied, message });
        }
        return ok({ dry_run: !apply, webhooks: out });
      }

      // ── WEBHOOK HEALTH TEST ───────────────────────────────────────
      case "outreach.webhook.test": {
        // The "Run test" button. First call sends a closed-loop email (AgentMail inbox -> same inbox) and watches the
        // webhook's event log for ~8 s; the page repeats the call with check_only (no new email) until 45 s have passed.
        // Events have been seen arriving about 20 s late, so one short wait is not enough.
        const { webhook_id, check_only, before_count, wait_s } = params as { webhook_id?: string; check_only?: boolean; before_count?: number; wait_s?: number };
        if (!webhook_id) return fail(400, "webhook_id required");
        const waitMs = Math.max(2, Math.min(12, Number(wait_s) || 8)) * 1000;
        let beforeCount = typeof before_count === "number" ? before_count : 0;
        let testMessageId: string | null = null;
        let address: string | null = null;
        if (!check_only) {
          const agentmailKey = await readServiceKey("agentmail");
          if (!agentmailKey) return fail(400, "AgentMail key not configured");
          const inbox = await getOrCreateCampaignInbox(agentmailKey, "ShiftForge HQ Health Check", (await readOutreachSettings()).sending_inbox_id || undefined);
          address = inbox.email ?? null;
          if (!address) return fail(500, "AgentMail returned an inbox without an email field. Check your AgentMail account setup.");
          beforeCount = (await store(WEBHOOK_EVENTS).list({ prefix: `${webhook_id}/` })).blobs.length;
          const sendR = await agentmailFetch(agentmailKey, `/inboxes/${inbox.inbox_id}/messages/send`, {
            method: "POST",
            body: JSON.stringify({
              to: [address],
              subject: "ShiftForge HQ webhook health check",
              text: "This is an automated test from your Alcance dashboard. If you see event counters tick on the Webhooks page, your integration is wired correctly.",
              html: "<p>This is an automated test from your Alcance dashboard.</p><p>If you see event counters tick on the Webhooks page, your integration is wired correctly.</p>",
            }),
          });
          if (!sendR.ok) return fail(500, `Test send failed (${sendR.status}): ${(await sendR.text()).slice(0, 200)}`);
          testMessageId = ((await sendR.json()) as { message_id?: string }).message_id ?? null;
        }
        const deadline = Date.now() + waitMs;
        let newEvents = 0;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          newEvents = Math.max(0, (await store(WEBHOOK_EVENTS).list({ prefix: `${webhook_id}/` })).blobs.length - beforeCount);
          if (newEvents > 0) break;
        }
        return ok({
          ok: newEvents > 0,
          waiting: newEvents === 0,
          before_count: beforeCount,
          test_message_id: testMessageId,
          test_address: address,
          new_events: newEvents,
          hint:
            newEvents > 0
              ? `Received ${newEvents} webhook event(s) — your integration is live.`
              : "No events yet. Events can take up to a minute to arrive. If none come: (a) the webhook URL is pasted into AgentMail → Webhooks, (b) every event type is ticked (use Fix webhook events), (c) your AgentMail key has webhook permissions.",
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
