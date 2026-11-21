import type { Handler } from "@netlify/functions";
import { connectLambda } from "@netlify/blobs";
import { identifyApiKey } from "./lib/auth";
import { runDraftJob, runPreviewJob, runBrowserJob, runReviewJob, runSocialJob } from "./command";

/**
 * Netlify "background function" (the -background suffix is what makes it one): the caller gets
 * 202 immediately and this keeps running for up to 15 minutes. It does the slow Gemini work
 * that would be cut off at about 26 s in a normal function:
 *   task "draft"   -> runDraftJob  (progress is written to campaign.job)
 *   task "browsercheck" -> runBrowserJob (Apify browser run for sites whose widgets load with JavaScript)
 *   task "review" -> runReviewJob (AI reviewer for drafts)
 *   task "social" -> runSocialJob (Facebook / Instagram / LinkedIn messages)
 *   task "preview" -> runPreviewJob (result is written to the settings store, polled by the page)
 * The jobs are started (and validated) by the outreach.draft.start / outreach.preview.start
 * actions in command.ts; a call without a valid API key does nothing.
 */
export const handler: Handler = async (event) => {
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
  const rawKey = event.headers["x-api-key"] ?? event.headers["X-API-Key"];
  const identity = await identifyApiKey(typeof rawKey === "string" ? rawKey : null);
  if (!identity) return { statusCode: 401, body: "unauthorized" };
  let body: { task?: string; params?: Record<string, unknown> } = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: "bad json" };
  }
  const params = body.params ?? {};
  if (body.task === "draft" && typeof params.campaign_id === "string") {
    await runDraftJob(params as unknown as Parameters<typeof runDraftJob>[0]);
  } else if (body.task === "browsercheck" && typeof params.campaign_id === "string" && Array.isArray(params.lead_ids)) {
    await runBrowserJob({ campaign_id: params.campaign_id, lead_ids: (params.lead_ids as unknown[]).filter((x): x is string => typeof x === "string") });
  } else if (body.task === "review" && typeof params.campaign_id === "string") {
    await runReviewJob(params as unknown as Parameters<typeof runReviewJob>[0]);
  } else if (body.task === "social" && typeof params.campaign_id === "string") {
    await runSocialJob(params as unknown as Parameters<typeof runSocialJob>[0]);
  } else if (body.task === "preview" && typeof params.id === "string" && typeof params.query === "string") {
    await runPreviewJob(params as unknown as Parameters<typeof runPreviewJob>[0]);
  }
  return { statusCode: 202, body: "" };
};
