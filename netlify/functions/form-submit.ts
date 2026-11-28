import type { Handler } from "@netlify/functions";
import { connectLambda } from "@netlify/blobs";
import { nanoid } from "nanoid";
import { store, readJson, writeJson } from "./lib/blobs";

const FORMS = "agent-hq-forms";
const SUBMISSIONS = "agent-hq-submissions";
const ACTIVITY = "agent-hq-activity";

export const handler: Handler = async (event) => {
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
  if (process.env.DATA_BACKEND === "sql") return sqlFormSubmit(event); // P2 chunk 10 (A2): spam trap, rate limit, personal links, below
  // URL shape: /api/form/:slug  →  function receives /:slug via splat
  const slug = (event.path.split("/").pop() ?? "").trim();
  if (!slug) return { statusCode: 400, body: "Missing form slug" };

  if (event.httpMethod === "GET") {
    const config = await readJson(store(FORMS), slug);
    if (!config) return { statusCode: 404, body: "Form not found" };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const config = await readJson(store(FORMS), slug);
  if (!config) return { statusCode: 404, body: "Form not found" };

  let data: Record<string, string> = {};
  try {
    data = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const id = nanoid(12);
  const received_at = new Date().toISOString();
  const submission = { id, form_slug: slug, data, received_at };
  await writeJson(store(SUBMISSIONS), `${slug}/${received_at}-${id}`, submission);

  const activityId = nanoid(12);
  await writeJson(store(ACTIVITY), `${received_at}-${activityId}`, {
    id: activityId,
    agent_id: null,
    category: "system",
    summary: `Form "${slug}" received a submission`,
    details: { submission_id: id, data },
    created_at: received_at,
  });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, submission_id: id }),
  };
};

// P2 chunk 10: forms on Postgres (only when DATA_BACKEND=sql): lib/sql/forms.ts. The address is used only as a SHA-256 for
// the rate limit; Netlify's own client-address header is trusted first (x-forwarded-for can be set by the sender).
async function sqlFormSubmit(event: Parameters<Handler>[0]) {
  const [{ withTx }, forms] = await Promise.all([import("./lib/db/client.ts"), import("./lib/sql/forms.ts")]);
  const h = (event.headers ?? {}) as Record<string, string | undefined>;
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  const ip = h["x-nf-client-connection-ip"] ?? (h["x-forwarded-for"] ?? "").split(",")[0].trim() ?? null;
  const r = await withTx((tx) => forms.submit(tx, {
    slug: (event.path.split("/").pop() ?? "").trim(), method: event.httpMethod, token: event.queryStringParameters?.l ?? null,
    body, contentType: h["content-type"] ?? h["Content-Type"] ?? null, ip, userAgent: h["user-agent"] ?? null,
  }, { newId: () => nanoid(12) }));
  return { statusCode: r.statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(r.body) };
}
