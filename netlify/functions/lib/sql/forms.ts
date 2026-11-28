// P2 chunk 10: forms on Postgres (A2; used when DATA_BACKEND=sql, the Blobs code in command.ts and form-submit.ts stays
// the default until P5).
//   - Form builder data in lead_forms; a personal link per lead and form in form_links (random 22-character token).
//   - A submission (form-submit.ts): size limit, spam trap (hidden field `_trap`: stored as spam, answered like a success),
//     rate limit (per address per form, per address over all forms, per personal link; the address is kept only as a
//     SHA-256), only the form's own fields kept. With a valid personal link the lead is marked interested and stopped
//     (stop_state replied, "form submission"; never over do-not-contact), its follow-ups are refreshed, and one outbox
//     row goes to the CRM handoff (R12). The activity row never copies the form text.
//   - The old April forms (`forms` / `submissions`) are gone (chunk 12, X8: archived, tables dropped in migration 0019).
import { createHash } from "node:crypto";
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";
import { enqueue } from "./outbox.ts";
import { refreshForLeads } from "./followups.ts";
import { TOKEN_RE, newClickToken } from "./clicks.ts";

type Row = Record<string, unknown>;
export type FormAction = "form.create" | "form.list" | "form.submissions" | "form.update" | "form.delete" | "form.link";
export const FORM_ACTIONS: FormAction[] = ["form.create", "form.list", "form.submissions", "form.update", "form.delete", "form.link"];
export type FormDeps = { newId: () => string; baseUrl?: string; newToken?: () => string };

export const TRAP_FIELD = "_trap";
export const LIMITS = {
  maxBody: 10_240,
  maxValue: 2000,
  perIpForm: { n: 5, minutes: 10 },
  perIpAll: { n: 20, minutes: 60 },
  perLink: { n: 3, minutes: 24 * 60 },
};
const FIELD_TYPES = new Set(["text", "email", "textarea", "tel", "url", "number", "date"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : {}); };
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const str = (v: unknown, max: number, what: string): string => {
  const s = v == null ? "" : String(v).trim();
  if (s.length > max) fail(400, `${what} is too long (at most ${max} characters)`);
  return s;
};

export type Field = { name: string; label: string; type: string; required: boolean };
export function normaliseFields(fields: unknown): Field[] {
  if (!Array.isArray(fields) || fields.length === 0) fail(400, "A form needs at least one field");
  if ((fields as unknown[]).length > 30) fail(400, "A form can have at most 30 fields");
  const seen = new Set<string>();
  return (fields as Row[]).map((f) => {
    const raw = String(f?.name ?? "").trim();
    if (raw.startsWith("_")) fail(400, `A field name may not start with "_" (${TRAP_FIELD} is the spam trap)`);
    const name = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!name) fail(400, "Every field needs a name");
    if (seen.has(name)) fail(400, `Two fields are called "${name}"`);
    seen.add(name);
    const type = FIELD_TYPES.has(String(f?.type)) ? String(f.type) : "text";
    return { name, label: str(f?.label ?? name, 200, "A field label") || name, type, required: f?.required === true };
  });
}

function formRecord(r: Row, count?: number): Row {
  return {
    slug: r.slug, title: r.title, description: r.description ?? "", fields: r.fields ?? [], thank_you: r.thank_you ?? "", campaign_id: r.campaign_id ?? null,
    active: r.active !== false, created_at: iso(r.created_at), updated_at: iso(r.updated_at), legacy: false, ...(count !== undefined ? { submissions: count } : {}),
  };
}

export async function runFormAction(q: Q, action: FormAction, p: Row, deps: FormDeps): Promise<unknown> {
  switch (action) {
    case "form.create": {
      const slug = String(p.slug ?? "").trim().toLowerCase();
      if (!SLUG_RE.test(slug)) fail(400, "slug must be 2–60 lower-case letters, digits or dashes");
      const title = str(p.title, 200, "title");
      if (!title) fail(400, "slug, title, fields required");
      const fields = normaliseFields(p.fields);
      const [clash] = await q`select 1 as x from lead_forms where slug = ${slug}`;
      if (clash) fail(409, `A form called "${slug}" already exists`, "slug_taken");
      const [r] = await q`insert into lead_forms ${q({
        slug, title, description: str(p.description, 2000, "description"), fields: q.json(fields as never), thank_you: str(p.thank_you, 1000, "thank_you"),
        campaign_id: p.campaign_id ? String(p.campaign_id) : null,
      } as never)} returning *`;
      return formRecord(r);
    }
    case "form.list": {
      const mine = await q`select f.*, (select count(*)::int from form_submissions s where s.form_slug = f.slug and not s.spam) as n from lead_forms f order by f.created_at desc, f.slug`;
      return mine.map((r) => formRecord(r, Number(r.n)));
    }
    case "form.update": {
      const slug = String(p.slug ?? "");
      const set: Row = {};
      if (p.title !== undefined) { set.title = str(p.title, 200, "title"); if (!set.title) fail(400, "title may not be empty"); }
      if (p.description !== undefined) set.description = str(p.description, 2000, "description");
      if (p.thank_you !== undefined) set.thank_you = str(p.thank_you, 1000, "thank_you");
      if (p.fields !== undefined) set.fields = q.json(normaliseFields(p.fields) as never);
      if (p.campaign_id !== undefined) set.campaign_id = p.campaign_id ? String(p.campaign_id) : null;
      if (p.active !== undefined) set.active = p.active === true;
      const [r] = Object.keys(set).length
        ? await q`update lead_forms set ${q(set as never)}, updated_at = clock_timestamp() where slug = ${slug} returning *`
        : await q`select * from lead_forms where slug = ${slug}`;
      if (!r) fail(404, "Form not found");
      return formRecord(r);
    }
    case "form.delete": {
      const [r] = await q`delete from lead_forms where slug = ${String(p.slug ?? "")} returning slug`;
      if (!r) fail(404, "Form not found");
      return { deleted: true, slug: r.slug };
    }
    case "form.link": {
      const slug = String(p.slug ?? "");
      const leadId = String(p.lead_id ?? "");
      const [f] = await q`select slug from lead_forms where slug = ${slug} and active`;
      if (!f) fail(404, "Form not found");
      const [l] = await q`select id from leads where id = ${leadId} and merged_into is null`;
      if (!l) fail(404, "Lead not found");
      await q`insert into form_links (token, form_slug, lead_id) values (${(deps.newToken ?? newClickToken)()}, ${slug}, ${leadId}) on conflict (form_slug, lead_id) do nothing`;
      const [t] = await q`select token from form_links where form_slug = ${slug} and lead_id = ${leadId}`;
      const base = deps.baseUrl ?? "";
      return { slug, lead_id: leadId, token: t.token, url: `${base}/form/${slug}?l=${t.token}`, api_url: `${base}/api/form/${slug}?l=${t.token}` };
    }
    case "form.submissions": {
      const slug = String(p.slug ?? "");
      if (!slug) fail(400, "slug required");
      const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 1000);
      const spam = p.include_spam === true;
      const rows = await q`
        select id, form_slug, lead_id, data, spam, received_at from form_submissions where form_slug = ${slug} and (${spam} or not spam)
        order by received_at desc, id limit ${limit}`;
      return rows.map((r) => ({ id: r.id, form_slug: r.form_slug, lead_id: r.lead_id ?? null, data: r.data, spam: r.spam, received_at: iso(r.received_at) }));
    }
  }
  return fail(400, `Unknown action: ${action}`);
}

// ── the public endpoint (form-submit.ts) ─────────────────────────────────

export type SubmitRequest = { slug: string; method: string; token: string | null; body: string; contentType?: string | null; ip?: string | null; userAgent?: string | null };
export type SubmitResult = { statusCode: number; body: Row };
const answer = (statusCode: number, body: Row): SubmitResult => ({ statusCode, body });
export const hashIp = (ip: string | null | undefined): string => createHash("sha256").update(`alcance-form:${String(ip ?? "").trim() || "unknown"}`).digest("hex");

function parseBody(body: string, contentType: string): Row | null {
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return Object.fromEntries(new URLSearchParams(body));
  try {
    const v = JSON.parse(body || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
  } catch { return null; }
}

/** Seconds until a post is allowed again, or 0. Spam posts count too. */
async function limited(q: Q, where: "ip_form" | "ip_all" | "link", key: string, slug: string): Promise<number> {
  const lim = where === "ip_form" ? LIMITS.perIpForm : where === "ip_all" ? LIMITS.perIpAll : LIMITS.perLink;
  const since = `${lim.minutes} minutes`;
  const [r] = where === "ip_form"
    ? await q`select count(*)::int as n, min(received_at) as first from form_submissions where ip_hash = ${key} and form_slug = ${slug} and received_at > now() - ${since}::interval`
    : where === "ip_all"
      ? await q`select count(*)::int as n, min(received_at) as first from form_submissions where ip_hash = ${key} and received_at > now() - ${since}::interval`
      : await q`select count(*)::int as n, min(received_at) as first from form_submissions where link_token = ${key} and received_at > now() - ${since}::interval`;
  if (Number(r.n) < lim.n) return 0;
  const first = r.first instanceof Date ? r.first.getTime() : Date.parse(String(r.first));
  return Math.max(1, Math.ceil((first + lim.minutes * 60_000 - Date.now()) / 1000));
}

export async function submit(q: Q, req: SubmitRequest, deps: FormDeps): Promise<SubmitResult> {
  const slug = String(req.slug ?? "").trim().toLowerCase();
  const [mine] = SLUG_RE.test(slug) ? await q`select * from lead_forms where slug = ${slug} and active` : [];
  if (!mine) return answer(404, { error: "Form not found" });
  const form = formRecord(mine);
  const fields = (Array.isArray(form.fields) ? form.fields : []) as Field[];

  if (req.method === "GET") return answer(200, { slug: form.slug, title: form.title, description: form.description, fields, thank_you: form.thank_you });
  if (req.method !== "POST") return answer(405, { error: "Method not allowed" });
  if (Buffer.byteLength(req.body ?? "", "utf8") > LIMITS.maxBody) return answer(413, { error: "Too much data" });
  const data = parseBody(req.body ?? "", String(req.contentType ?? ""));
  if (!data) return answer(400, { error: "Invalid JSON" });

  const ipHash = hashIp(req.ip);
  const token = req.token && TOKEN_RE.test(req.token) ? req.token : null;
  for (const [where, key] of [["ip_form", ipHash], ["ip_all", ipHash], ...(token ? [["link", token]] : [])] as Array<["ip_form" | "ip_all" | "link", string]>) {
    const wait = await limited(q, where, key, String(form.slug));
    if (wait) return answer(429, { error: "Too many submissions. Please try again later.", retry_after: wait });
  }

  const id = deps.newId();
  const thank = { ok: true, submission_id: id, thank_you: form.thank_you || "Thank you." };
  const kept: Row = {};
  for (const f of fields) {
    const raw = data[f.name];
    const v = raw == null ? "" : typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw).trim() : "";
    if (v) kept[f.name] = v;
  }

  // The spam trap: stored as spam, answered like a success, nothing else happens.
  if (String(data[TRAP_FIELD] ?? "").trim()) {
    for (const k of Object.keys(kept)) kept[k] = String(kept[k]).slice(0, LIMITS.maxValue);
    await q`insert into form_submissions ${q({ id, form_slug: form.slug, lead_id: null, data: q.json(kept as never), spam: true, spam_reason: "trap", ip_hash: ipHash, link_token: token } as never)}`;
    return answer(200, thank);
  }

  for (const f of fields) {
    const v = String(kept[f.name] ?? "");
    if (v.length > LIMITS.maxValue) return answer(400, { error: `"${f.label}" is too long (at most ${LIMITS.maxValue} characters)`, field: f.name });
    if (v && f.type === "email" && !EMAIL_RE.test(v)) return answer(400, { error: `"${f.label}" is not an email address`, field: f.name });
  }
  const missing = fields.filter((f) => f.required && !kept[f.name]).map((f) => f.name);
  if (missing.length) return answer(400, { error: "Missing required fields", missing });

  const [link] = token ? await q`select k.lead_id from form_links k join leads l on l.id = k.lead_id and l.merged_into is null where k.token = ${token} and k.form_slug = ${form.slug as string}` : [];
  const leadId = (link?.lead_id as string | undefined) ?? null;
  await q`insert into form_submissions ${q({ id, form_slug: form.slug, lead_id: leadId, data: q.json(kept as never), spam: false, ip_hash: ipHash, link_token: token } as never)}`;

  if (leadId) {
    await q`update leads set data = data || ${q.json({ interested: true, interested_at: new Date().toISOString(), interested_form: form.slug, interested_submission: id } as never)},
                             stop_reason = case when stop_state in ('none', 'bounced') then 'form submission' else stop_reason end,
                             stopped_at = case when stop_state in ('none', 'bounced') then coalesce(stopped_at, now()) else stopped_at end,
                             stop_state = case when stop_state in ('none', 'bounced') then 'replied' else stop_state end,
                             updated_at = now()
            where id = ${leadId}`;
    await refreshForLeads(q, { leadIds: [leadId] });
    await enqueue(q, "crm.form_submitted", { submission_id: id, form_slug: form.slug, lead_id: leadId, received_at: new Date().toISOString() });
  }
  await q`insert into activity (id, agent_id, category, summary, details, created_at, data) values (${deps.newId()}, null, 'outreach',
            ${`Form "${String(form.title ?? form.slug)}" received a submission${leadId ? " from a lead's personal link" : ""}`},
            ${q.json({ submission_id: id, form_slug: form.slug, lead_id: leadId } as never)}, now(), '{}')`;
  return answer(200, thank);
}
