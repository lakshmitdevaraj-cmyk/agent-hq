// P2 chunk 5: the email (draft) actions on Postgres (used when DATA_BACKEND=sql; the Blobs code in command.ts stays the
// default until P5). Every function takes `sql`, a client or a transaction. Nothing here reaches a network: the AI
// writer, the pause between calls and the clock are passed in as `deps` (the guarded helper in command.ts passes the
// existing functions; tests pass stand-ins). Answers have the same shape as the old actions (an email row is mapped back
// to the old record: step → sequence_position, the `data` fields laid over it); the intended differences are listed in
// scripts/db/equiv/cases/emails.mjs.
//   - A4/F46: `create` (writing by hand, or from an agent) never touches `deps`.
//   - F9: one draft per lead and step. `create` on a drafted step updates that draft (replaced: true); on any other
//     non-failed step it refuses with 409 draft_exists and the email id, also when the unique index decides (a race).
//   - F32/F33: a flagged lead is refused (generate_one, and create from an agent key) or left out (generate, draft.start)
//     with code fit_flagged, unless she kept it ("kept by me"). Writing by hand herself is allowed; the flags come back.
//   - R9: footer.preview adds postal_address_missing and a warning when the country needs a postal address and none is saved.
//   - F17: emails of merged leads and the duplicate rows the P1 import kept as history are left out of the list.
//   - emails_generated is counted from the emails (campaigns.ts), so create and delete need no counter.
import { CampaignError, writeJob } from "./campaigns.ts";
import { leadRecord, contactsFor, type Q } from "./leads.ts";
import { campaignSkipCtx } from "./leadrules.ts";
import { draftAllowed } from "./fitflags.ts";
import { codeCheckDraft, recheckStaleDrafts, readSettings, type CheckResult } from "./emailchecks.ts";
import { appendFooter, textToHtml, cleanEmail, isJunkEmail, emailKey, leadSkipReason } from "../outreach.ts";
import { contactBlock } from "../contacts.ts";
import { dedupeReasons, RULES_VERSION } from "../messagerules.ts";

type Row = Record<string, unknown>;

/** A refusal that also carries the id of the email that is in the way (409 draft_exists) and answer extras (retry_after). */
export class EmailError extends CampaignError {
  email_id?: string;
  extra: Row;
  constructor(status: number, message: string, opts: { code?: string; keep?: boolean; email_id?: string; extra?: Row } = {}) {
    super(status, message, opts);
    this.name = "EmailError";
    this.email_id = opts.email_id;
    this.extra = opts.extra ?? {};
  }
}
const fail = (status: number, message: string, opts?: { code?: string; keep?: boolean }): never => { throw new CampaignError(status, message, opts); };

// ── What the caller passes in ──────────────────────────────────────────────

/** What the AI writer is given. `kind` "legacy" is the older paced run (one email per lead, step 1). */
export type WriteInput = {
  kind: "draft" | "legacy";
  campaign: Row;
  lead: Row;
  framework: "one-off" | "pas" | "aida" | "sdr" | "four-step";
  step: number;
  total_steps: number;
  sender_name?: unknown;
  sender_company?: unknown;
  sender_offer?: unknown;
  /** The lead's earlier steps (steps below this one), for sequences. */
  previous_steps: Array<{ step: number; subject: string; body_text: string }>;
  /** Other first emails of this campaign (so the writer does not repeat itself). */
  others: Array<{ subject: string; body: string }>;
  drafts_so_far: number;
  /** Steps this lead already has a draft for (four-step: the writer only needs the rest). */
  have: number[];
};
export type Written = {
  subject: string;
  body_text: string;
  body_html?: string;
  /** The exact model name. */
  model?: string | null;
  /** Extra fields to keep with the draft (fact used, angle, ...). Stored in `data`. */
  meta?: Row;
  /** Four-step: all four emails from one call (step 1..4). The ones the lead lacks are saved now. */
  steps?: Array<{ step: number; subject?: string; body_text: string; body_html?: string }>;
};
export type EmailDeps = {
  aiAvailable?: () => Promise<boolean>;
  writeDraft?: (input: WriteInput) => Promise<Written>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};
export type EmailCtx = { newId: () => string; isAgent?: boolean; createdBy?: string | null };
const need = <K extends keyof EmailDeps>(deps: EmailDeps, k: K): NonNullable<EmailDeps[K]> => deps[k] ?? fail(500, `drafting is missing ${String(k)}`);

// ── The email record ───────────────────────────────────────────────────────

/** Columns that are not fields of the old record (or are put back under another name below). */
const NOT_FIELDS = new Set(["blob_key", "to_key", "is_duplicate", "step", "written_by", "written_model", "data"]);

/** The old Blobs email record, put back together from its columns and `data`. Empty columns are left out, as the old record left unset fields out. */
export function emailRecord(r: Row): Row {
  const out: Row = { ...((r.data as Row | null) ?? {}) };
  for (const [k, v] of Object.entries(r)) {
    if (NOT_FIELDS.has(k) || v === null || v === undefined) continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  out.sequence_position = r.step;
  // The old record's written_by held the model name; rows made here by Lakshmi or an agent have only the writer.
  const writer = r.written_model ?? r.written_by;
  if (writer !== null && writer !== undefined) out.written_by = writer;
  return out;
}

/** Fields of the old record that have their own column (anything else goes to `data`). */
const COLUMN_FIELDS = new Set(["id", "campaign_id", "lead_id", "to_email", "to_name", "subject", "body_text", "body_html", "sender_name", "sequence_total", "framework", "status", "error", "review_status", "review_reasons", "reviewed_by", "reviewed_at", "rules_version", "source", "edited", "created_at", "updated_at"]);

type NewEmail = {
  id: string; campaign_id: string; lead_id: string; to_email: string; to_name: string | null; subject: string; body_text: string; body_html: string;
  sender_name: string | null; step: number; sequence_total: number | null; framework: string | null; review_status: string; review_reasons: string[];
  reviewed_by: string | null; reviewed_at: string | null; written_by: "lakshmi" | "claude" | "gemini"; written_model: string | null; source: string | null;
  created_at: Date; data: Row;
};

/** Inserts one draft; null when the unique index (one live draft per lead and step) already has one. */
async function insertEmail(sql: Q, e: NewEmail): Promise<string | null> {
  const cols = {
    id: e.id, blob_key: `${e.campaign_id}/${e.created_at.toISOString()}-${e.id}`, campaign_id: e.campaign_id, lead_id: e.lead_id, to_email: e.to_email, to_key: emailKey(e.to_email),
    to_name: e.to_name, subject: e.subject, body_text: e.body_text, body_html: e.body_html, sender_name: e.sender_name, step: e.step, sequence_total: e.sequence_total, framework: e.framework,
    status: "drafted", review_status: e.review_status, review_reasons: sql.json(e.review_reasons as never), reviewed_by: e.reviewed_by, reviewed_at: e.reviewed_at ? new Date(e.reviewed_at) : null,
    rules_version: RULES_VERSION, written_by: e.written_by, written_model: e.written_model, source: e.source, edited: false, created_at: e.created_at, updated_at: e.created_at, data: sql.json(e.data as never),
  };
  try {
    const rows = await sql`insert into emails ${sql(cols)} on conflict (lead_id, step) where status <> 'failed' and not is_duplicate do nothing returning id`;
    return rows.length ? (rows[0].id as string) : null;
  } catch (err) {
    // Another unique key (the id) is the only other way in; answer it as a clash rather than a 500.
    if ((err as { code?: string })?.code === "23505") return null;
    throw err;
  }
}

/** The review fields a fresh or re-checked draft gets from its code check: a hard hit is Blocked by "code checks", else "check", not reviewed yet. */
const reviewFields = (ck: CheckResult, at: string) =>
  ck.status === "blocked"
    ? { review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks" as string | null, reviewed_at: at as string | null }
    : { review_status: "check", review_reasons: ["Not reviewed yet"], reviewed_by: null, reviewed_at: null };

/** Saves a patch of old-record fields onto one stored email (only the given columns; `data` merged with ||). */
async function savePatch(sql: Q, id: string, patch: Row): Promise<void> {
  const cols: Row = {};
  const data: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "review_reasons") cols[k] = v === null || v === undefined ? null : sql.json(v as never);
    else if (k === "reviewed_at" || k === "updated_at" || k === "created_at") cols[k] = v ? new Date(v as string) : null;
    else if (k === "to_email") { cols.to_email = v; cols.to_key = emailKey(v as string); }
    else if (k === "sequence_position") cols.step = v;
    else if (COLUMN_FIELDS.has(k)) cols[k] = v ?? null;
    else data[k] = v;
  }
  if (!Object.keys(cols).length && !Object.keys(data).length) return;
  await sql`update emails set ${sql(cols)}${Object.keys(data).length ? sql`${Object.keys(cols).length ? sql`, ` : sql``}data = data || ${sql.json(data as never)}` : sql``} where id = ${id}`;
}

const emailById = async (sql: Q, id: string): Promise<Row> => {
  const [r] = await sql`select * from emails where id = ${id}`;
  return emailRecord(r);
};

// ── Small lookups ──────────────────────────────────────────────────────────

/** The campaign as the old record, with the fields the drafting code reads. */
async function campaignOf(sql: Q, id: string): Promise<Row | null> {
  const [c] = await sql`select id, name, niche, country, any_trade, default_sender_name, default_sender_company, default_sender_offer, default_framework, default_sequence_total, data from campaigns where id = ${id}`;
  if (!c) return null;
  return { ...((c.data as Row) ?? {}), id: c.id, name: c.name, query: c.niche, country: c.country, any_trade: c.any_trade, default_sender_name: c.default_sender_name, default_sender_company: c.default_sender_company, default_sender_offer: c.default_sender_offer, default_framework: c.default_framework, default_sequence_total: c.default_sequence_total };
}

async function liveLead(sql: Q, campaignId: string, leadId: string): Promise<Row | null> {
  const [r] = await sql`select * from leads where id = ${leadId} and campaign_id = ${campaignId} and merged_into is null`;
  return r ?? null;
}

/** copy of logActivity in leadgen.ts (private there) */
async function logActivity(sql: Q, ctx: EmailCtx, category: string, summary: string, details: Row): Promise<void> {
  const id = ctx.newId(), now = new Date();
  await sql`insert into activity (id, blob_key, agent_id, category, summary, details, created_at)
            values (${id}, ${`${now.toISOString()}-${id}`}, ${ctx.createdBy ?? null}, ${category}, ${summary}, ${sql.json(details as never)}, ${now})`;
}

/**
 * Remembers the sender defaults and framework on the campaign (the old "runtime state": campaigns.updated_at is not
 * touched, and only these columns are written, so a setting changed meanwhile is never undone).
 */
async function rememberDefaults(sql: Q, campaignId: string, camp: Row, p: { sender_name?: unknown; sender_company?: unknown; sender_offer?: unknown; framework: string; total: number }, only: Array<"company" | "offer"> = ["company", "offer"]): Promise<void> {
  const pick = (given: unknown, cur: unknown) => (typeof given === "string" && given) || (cur as string | null) || null;
  const cols: Row = { default_sender_name: pick(p.sender_name, camp.default_sender_name), default_framework: p.framework, default_sequence_total: p.total };
  if (only.includes("company")) cols.default_sender_company = pick(p.sender_company, camp.default_sender_company);
  if (only.includes("offer")) cols.default_sender_offer = pick(p.sender_offer, camp.default_sender_offer);
  await sql`update campaigns set ${sql(cols)} where id = ${campaignId}`;
}

const FRAMEWORKS = ["pas", "aida", "sdr", "four-step"] as const;
type Framework = "one-off" | (typeof FRAMEWORKS)[number];

// ── outreach.emails.list ───────────────────────────────────────────────────

/** outreach.emails.list: the campaign's emails, newest first, with the same annotations as today. */
export async function list(sql: Q, params: Row): Promise<Row[]> {
  const { campaign_id, limit = 500 } = params;
  if (typeof campaign_id !== "string") fail(400, "campaign_id required");
  const cid = campaign_id as string;
  const max = typeof limit === "number" ? Math.max(0, Math.floor(limit)) : 500;
  // Old drafts are re-checked once per rules change (the stale rows only, one query).
  const stale = await sql`select * from emails where campaign_id = ${cid} and status = 'drafted' and not is_duplicate and rules_version is distinct from ${RULES_VERSION}`;
  if (stale.length) await recheckStaleDrafts(sql, stale.map(emailRecord));
  const rows = await sql`
    select e.*, l.excluded as lead_excluded, l.is_test as lead_is_test
    from emails e left join leads l on l.id = e.lead_id and l.campaign_id = e.campaign_id
    where e.campaign_id = ${cid} and not e.is_duplicate and l.merged_into is null
    order by e.created_at desc nulls last, e.id
    limit ${max}`;
  const drafts = rows.filter((r) => r.status === "drafted");
  const ids = [...new Set(drafts.map((r) => r.lead_id as string | null).filter((x): x is string => !!x))];
  const keys = [...new Set(drafts.map((r) => emailKey(r.to_email as string | null)).filter((x): x is string => !!x))];
  // Drafts that will never be sent because the recipient said no: any lead, in any campaign, with that lead id or address.
  const dnc = drafts.length
    ? await sql`select id, email_key from leads where (do_not_contact or stop_state = 'do_not_contact') and (id = any(${ids.length ? ids : [""]}) or email_key = any(${keys.length ? keys : [""]}))`
    : [];
  const dncIds = new Set(dnc.map((l) => l.id as string));
  const dncMail = new Set(dnc.map((l) => l.email_key as string | null).filter((x): x is string => !!x));
  const contacts = await contactsFor(sql, drafts.map((r) => r.to_email as string | null));
  return rows.map((joined) => {
    const { lead_excluded, lead_is_test, ...row } = joined;
    const r0 = emailRecord(row);
    // Drafts from before the reviewer existed count as "check" (not reviewed yet).
    const r1 = r0.status === "drafted" && !r0.review_status ? { ...r0, review_status: "check", review_reasons: ["Not reviewed yet"] } : r0;
    // A listed reason always means check: "ready" with reasons (old rows) is shown as check.
    const r = r1.review_status === "ready" && ((r1.review_reasons as string[] | undefined) ?? []).length > 0 && r1.reviewed_by !== "you" ? { ...r1, review_status: "check" } : r1;
    if (r.status !== "drafted") return r;
    if (lead_excluded === true) return { ...r, blocked_lead_skipped: true };
    if ((r.lead_id && dncIds.has(r.lead_id as string)) || dncMail.has(emailKey(r.to_email as string) ?? "")) return { ...r, blocked_do_not_contact: true };
    const block = contactBlock(contacts, r.to_email as string, cid, { isTest: lead_is_test === true });
    return block ? { ...r, blocked_contact: block.message.replace(/^Skipped: /, "") } : r;
  });
}

// ── outreach.emails.create (A4, F46, F9) ───────────────────────────────────

/** outreach.emails.create: an email written by hand (Lakshmi) or by an agent. Never calls AI. */
export async function create(sql: Q, params: Row, ctx: EmailCtx): Promise<Row> {
  const { campaign_id, lead_id, subject, body_text, body_html, sender_name, sequence_position, sequence_total, framework } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  if (typeof lead_id !== "string" || !lead_id) fail(400, "lead_id required");
  if (typeof subject !== "string" || !subject.trim()) fail(400, "subject required");
  if (typeof body_text !== "string" || !body_text.trim()) fail(400, "body_text required");
  const cid = campaign_id as string, lid = lead_id as string, subj = (subject as string).trim(), text = (body_text as string).trim();
  const campaign = (await campaignOf(sql, cid)) ?? fail(404, "campaign not found");
  const leadRow = (await liveLead(sql, cid, lid)) ?? fail(404, "lead not found");
  if (!leadRow.email) fail(400, "lead has no email address");
  if (leadRow.do_not_contact === true || leadRow.stop_state === "do_not_contact") fail(400, "lead is marked do-not-contact: no email will be drafted", { code: "do_not_contact" });
  const lead = leadRecord(leadRow);
  const verdict = draftAllowed(lead);
  if (ctx.isAgent && !verdict.ok) fail(400, verdict.reason as string, { code: "fit_flagged" });

  const stepNum = typeof sequence_position === "number" && sequence_position >= 1 ? Math.floor(sequence_position) : 1;
  const fwGiven = typeof framework === "string" && ["pas", "aida", "sdr", "four-step", "one-off"].includes(framework) ? (framework as string) : null;
  const html = typeof body_html === "string" && body_html.trim() ? body_html : textToHtml(text);
  const writer = ctx.isAgent ? "claude" : "lakshmi";
  const source = ctx.isAgent ? "agent_drafted" : "hand_written";
  const now = new Date();
  const at = now.toISOString();
  const fit_flags = verdict.flags;

  // F9: one draft per lead and step.
  const [existing] = await sql`select * from emails where lead_id = ${lid} and step = ${stepNum} and status <> 'failed' and not is_duplicate for update`;
  const clash = (e: Row): never => { throw new EmailError(409, `This lead already has an email for step ${stepNum} (${String(e.status)}). email_id: ${String(e.id)}`, { code: "draft_exists", email_id: String(e.id) }); };
  if (existing) {
    if (existing.status !== "drafted") clash(existing);
    const fw = fwGiven ?? (existing.framework as string | null) ?? "one-off";
    const total = typeof sequence_total === "number" && sequence_total >= 1 ? Math.floor(sequence_total) : fwGiven ? (fw === "four-step" ? 4 : stepNum) : (existing.sequence_total as number | null) ?? stepNum;
    const ck = await codeCheckDraft(sql, { ...emailRecord(existing), subject: subj, body_text: text, framework: fw, sequence_position: stepNum });
    await savePatch(sql, existing.id as string, {
      subject: subj, body_text: text, body_html: html, framework: fw, sequence_total: total, edited: true, updated_at: at, source, rules_version: RULES_VERSION,
      ...(typeof sender_name === "string" ? { sender_name } : {}), ...reviewFields(ck, at),
    });
    await sql`update emails set written_by = ${writer}, written_model = null where id = ${existing.id as string}`;
    await rememberDefaults(sql, cid, campaign, { sender_name, framework: fw, total }, []);
    await logActivity(sql, ctx, "content", `${ctx.isAgent ? "Agent" : "You"} rewrote the draft (${fw} step ${stepNum}/${total}) for ${String(lead.name)}`, { campaign_id: cid, lead_id: lid, email_id: existing.id, framework: fw, step: stepNum, replaced: true });
    return { ...(await emailById(sql, existing.id as string)), replaced: true, fit_flags };
  }

  const fw = fwGiven ?? "one-off";
  const total = typeof sequence_total === "number" && sequence_total >= 1 ? Math.floor(sequence_total) : fw === "four-step" ? 4 : stepNum;
  const id = ctx.newId();
  // The same free code checks as a generated draft run at once: a hard hit is Blocked without anyone pressing Review.
  const ck = await codeCheckDraft(sql, { id, campaign_id: cid, lead_id: lid, to_name: lead.name, framework: fw, sequence_position: stepNum, subject: subj, body_text: text });
  const made = await insertEmail(sql, {
    id, campaign_id: cid, lead_id: lid, to_email: lead.email as string, to_name: (lead.name as string | null) ?? null, subject: subj, body_text: text, body_html: html,
    sender_name: typeof sender_name === "string" ? sender_name : null, step: stepNum, sequence_total: total, framework: fw, ...reviewFields(ck, at),
    written_by: writer, written_model: null, source, created_at: now, data: {},
  });
  if (!made) {
    // The unique index decided (another request wrote this step between the check above and the insert).
    const [other] = await sql`select id, status from emails where lead_id = ${lid} and step = ${stepNum} and status <> 'failed' and not is_duplicate`;
    if (other) clash(other);
    fail(409, "This lead already has an email for this step.", { code: "draft_exists" });
  }
  await rememberDefaults(sql, cid, campaign, { sender_name, framework: fw, total }, []);
  await logActivity(sql, ctx, "content", `${ctx.isAgent ? "Agent drafted" : "You wrote"} an email (${fw} step ${stepNum}/${total}) for ${String(lead.name)}`, { campaign_id: cid, lead_id: lid, email_id: id, framework: fw, step: stepNum });
  return { ...(await emailById(sql, id)), fit_flags };
}

// ── outreach.emails.update / delete ────────────────────────────────────────

/** outreach.emails.update: tweak a drafted email before it is sent. Only drafts are editable. */
export async function update(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, email_id, subject, body_text, body_html, to_email, review_status } = params;
  if (!campaign_id || !email_id || typeof campaign_id !== "string" || typeof email_id !== "string") fail(400, "campaign_id and email_id required");
  if (review_status !== undefined && review_status !== "ready") fail(400, 'review_status can only be set to "ready" by hand');
  const newTo = to_email === undefined ? undefined : typeof to_email === "string" ? cleanEmail(to_email) : null;
  if (to_email !== undefined && (!newTo || isJunkEmail(newTo))) fail(400, "that is not a valid email address");
  if (subject !== undefined && !String(subject).trim()) fail(400, "subject cannot be empty");
  if (body_text !== undefined && !String(body_text).trim()) fail(400, "body cannot be empty");
  const [stored] = await sql`select * from emails where id = ${email_id as string} and campaign_id = ${campaign_id as string} for update`;
  if (!stored) fail(404, "email not found");
  if (stored.status !== "drafted") fail(400, `only drafted emails can be edited (this one is ${String(stored.status)})`);
  const row = emailRecord(stored);
  const id = email_id as string;
  const now = new Date().toISOString();
  // If the plain-text body changed and no explicit html came with it, rebuild the html from the text: send uses html
  // when present, so a stale html body would silently send the OLD text.
  const nextHtml = body_html ? (body_html as string) : body_text ? textToHtml(body_text as string) : undefined;
  const patch: Row = {
    ...(subject ? { subject: String(subject).trim() } : {}),
    ...(newTo && newTo !== row.to_email ? { to_email: newTo, original_to_email: (row.original_to_email as string | undefined) ?? row.to_email } : {}),
    ...(body_text ? { body_text } : {}),
    ...(nextHtml ? { body_html: nextHtml } : {}),
    edited: true,
    updated_at: now,
  };
  const changed = !!(subject || body_text || body_html || (newTo && newTo !== row.to_email));
  if (changed) {
    // Every edit is code-checked at once: a hard hit is Blocked; otherwise it is "check" until reviewed or marked ready.
    const ck = await codeCheckDraft(sql, { ...row, ...patch });
    Object.assign(patch, ck.status === "blocked"
      ? { review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: now }
      : { review_status: "check", review_reasons: dedupeReasons(["You edited this draft. Review it again, or mark it ready yourself.", ...ck.reasons]), reviewed_by: null, reviewed_at: null });
  }
  if (review_status === "ready") {
    // Mark ready is refused while any hard code hit remains (a stored status can be older than the rules).
    const ck = await codeCheckDraft(sql, { ...row, ...patch });
    if (ck.hard.length) {
      await savePatch(sql, id, { ...patch, review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: now });
      fail(400, `Cannot mark this ready: ${ck.hard.join(" | ")}`, { keep: true });
    }
    if (!changed && row.review_status === "blocked") {
      fail(400, `Cannot mark this ready: it is Blocked${Array.isArray(row.review_reasons) && row.review_reasons.length ? ` (${(row.review_reasons as string[]).join(" | ")})` : ""}. Edit it to fix the problem, or run Review again.`);
    }
    Object.assign(patch, { review_status: "ready", review_reasons: [], reviewed_by: "you", reviewed_at: now });
  }
  await savePatch(sql, id, patch);
  return emailById(sql, id);
}

/** outreach.emails.delete: one drafted email. Sent emails are kept as history. The campaign's emails_generated is counted, so it drops by itself. */
export async function remove(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, email_id } = params;
  if (!campaign_id || !email_id || typeof campaign_id !== "string" || typeof email_id !== "string") fail(400, "campaign_id and email_id required");
  const [row] = await sql`select id, status from emails where id = ${email_id as string} and campaign_id = ${campaign_id as string} for update`;
  if (!row) fail(404, "email not found");
  if (row.status !== "drafted") fail(400, `only drafted emails can be deleted (this one is ${String(row.status)})`);
  await sql`delete from emails where id = ${email_id as string} and status = 'drafted'`;
  return { deleted: true };
}

// ── outreach.footer.preview (R9) ───────────────────────────────────────────

/** outreach.footer.preview: exactly what send will append (same function as the sender), plus the postal-address warning. */
export async function footerPreview(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, email_id } = params as Record<string, string>;
  if (!campaign_id || !email_id) fail(400, "campaign_id and email_id required");
  const [row] = await sql`select body_text, sender_name from emails where id = ${email_id} and campaign_id = ${campaign_id}`;
  if (!row) fail(404, "email not found");
  const campaign = await campaignOf(sql, campaign_id);
  const settings = await readSettings(sql);
  const postal = typeof settings.postal_address === "string" ? settings.postal_address : "";
  const body = (row.body_text as string | null) ?? "";
  const full = appendFooter(body, "", postal, (row.sender_name as string | null) || (campaign?.default_sender_name as string | undefined) || "");
  const out: Row = { footer_text: full.text.slice(body.trimEnd().length).trim() };
  // R9: where the country needs a postal address in the footer and none is saved, say so (a campaign with no country counts as US).
  const [profile] = await sql`select postal_address_required from country_profiles where code = ${(campaign?.country as string | null) ?? "US"}`;
  if (profile?.postal_address_required === true && !postal.trim()) {
    out.postal_address_missing = true;
    out.warning = "No postal address is saved in Settings. Emails to this country need one in the footer, so add it before sending.";
  }
  return out;
}

// ── Drafting with the AI writer (deps.writeDraft) ──────────────────────────

/** Maps what the writer threw to the answer the old code gave (GeminiError kinds). */
function writerFailure(err: unknown): never {
  if (err instanceof CampaignError) throw err;
  const message = err instanceof Error ? err.message : "Draft failed";
  const kind = (err as { kind?: unknown })?.kind;
  if (typeof kind === "string") {
    const status = kind === "daily_quota" || kind === "rate_limited" ? 429 : kind === "unavailable" ? 503 : kind === "timeout" ? 504 : 502;
    const retry = (err as { retryAfterS?: unknown }).retryAfterS;
    throw new EmailError(status, message, { code: kind, extra: typeof retry === "number" ? { retry_after: retry } : {} });
  }
  if (/add a free asset/.test(message)) throw new CampaignError(400, message, { code: "settings_missing" });
  throw new CampaignError(500, message);
}

/** The lead rules every drafting action applies before the AI is asked (draftOne's checks, then the F32/F33 flags). */
async function leadRefusal(sql: Q, campaign: Row, cid: string, lead: Row, contacts?: Awaited<ReturnType<typeof contactsFor>>): Promise<{ status: number; message: string; code?: string } | null> {
  if (!lead.email) return { status: 400, message: "lead has no email address — cannot draft" };
  if (lead.do_not_contact || lead.stop_state === "do_not_contact") return { status: 400, message: "lead is marked do-not-contact — no email will be drafted" };
  const skip = leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], campaignSkipCtx(campaign));
  if (skip) return { status: 400, message: `${skip.message} — no draft created`, code: skip.code === "excluded" ? "excluded" : "skipped_lead" };
  const block = contactBlock(contacts ?? (await contactsFor(sql, [lead.email as string])), lead.email as string, cid, { isTest: lead.is_test === true });
  if (block) return { status: 400, message: `${block.message} — no draft created`, code: block.code };
  const mail = emailKey(lead.email as string);
  if (mail) {
    const [flagged] = await sql`select 1 as x from leads where (do_not_contact or stop_state = 'do_not_contact') and email_key = ${mail} limit 1`;
    if (flagged) return { status: 400, message: "this email address asked not to be contacted — no draft created" };
  }
  return null;
}

/** outreach.emails.generate_one: one email for one lead at one step, written through deps.writeDraft. */
export async function generateOne(sql: Q, params: Row, deps: EmailDeps, ctx: EmailCtx): Promise<Row> {
  const { campaign_id, lead_id, sender_name, sender_company, sender_offer, framework, step, total_steps } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  if (typeof lead_id !== "string" || !lead_id) fail(400, "lead_id required");
  const cid = campaign_id as string, lid = lead_id as string;
  if (!(await need(deps, "aiAvailable")())) fail(400, "Gemini key not configured");
  const campaign = (await campaignOf(sql, cid)) ?? fail(404, "campaign not found");
  const fw: Framework = typeof framework === "string" && (FRAMEWORKS as readonly string[]).includes(framework) ? (framework as Framework) : "one-off";
  const stepNum = typeof step === "number" && step >= 1 && step <= 5 ? Math.floor(step) : 1;
  const totalNum = fw === "four-step" ? 4 : typeof total_steps === "number" && total_steps >= 1 && total_steps <= 5 ? Math.floor(total_steps) : fw === "one-off" ? 1 : 3;
  const leadRow = (await liveLead(sql, cid, lid)) ?? fail(404, "lead not found");
  const lead = leadRecord(leadRow);
  const refusal = await leadRefusal(sql, campaign, cid, lead);
  if (refusal) fail(refusal.status, refusal.message, { code: refusal.code });

  // A draft for this (lead, step) already exists: return it (sequences need one per step). A failed row does not count.
  const live = await sql`select * from emails where lead_id = ${lid} and campaign_id = ${cid} and status <> 'failed' and not is_duplicate`;
  const existing = live.find((e) => e.step === stepNum);
  if (existing) return { ...emailRecord(existing), skipped: true };
  // F32/F33: a flagged lead is drafted only after Lakshmi kept it.
  const verdict = draftAllowed(lead);
  if (!verdict.ok) fail(400, verdict.reason as string, { code: "fit_flagged" });

  const have = live.map((e) => e.step as number);
  const previous = live.filter((e) => (e.step as number) < stepNum).sort((a, b) => (a.step as number) - (b.step as number)).map((e) => ({ step: e.step as number, subject: String(e.subject ?? ""), body_text: String(e.body_text ?? "") }));
  const firsts = fw === "one-off" ? await sql`select subject, body_text from emails where campaign_id = ${cid} and step = 1 and status <> 'failed' and not is_duplicate and body_text is not null order by created_at desc, id` : [];
  let written: Written;
  try {
    written = await need(deps, "writeDraft")({
      kind: "draft", campaign, lead, framework: fw, step: stepNum, total_steps: totalNum, sender_name, sender_company, sender_offer,
      previous_steps: previous, others: firsts.map((f) => ({ subject: String(f.subject ?? ""), body: String(f.body_text ?? "") })), drafts_so_far: firsts.length, have,
    });
  } catch (err) { return writerFailure(err); }

  const now = new Date();
  const at = now.toISOString();
  const senderName = typeof sender_name === "string" ? sender_name : null;
  const { written_by: _modelName, ...meta } = (written.meta ?? {}) as Row;
  const items = fw === "four-step" && written.steps?.length ? written.steps.filter((s) => !have.includes(s.step) && s.step >= 1 && s.step <= 4) : [{ step: stepNum, subject: written.subject, body_text: written.body_text, body_html: written.body_html }];
  let rec: Row | null = null;
  for (const it of items) {
    const subject = it.subject ?? (it.step === stepNum ? written.subject : "");
    const html = it.body_html || textToHtml(it.body_text);
    const id = ctx.newId();
    const ck = await codeCheckDraft(sql, { id, campaign_id: cid, lead_id: lid, to_name: lead.name, framework: fw, sequence_position: it.step, subject, body_text: it.body_text });
    const made = await insertEmail(sql, {
      id, campaign_id: cid, lead_id: lid, to_email: lead.email as string, to_name: (lead.name as string | null) ?? null, subject, body_text: it.body_text, body_html: html,
      sender_name: senderName, step: it.step, sequence_total: totalNum, framework: fw, ...reviewFields(ck, at), written_by: "gemini", written_model: written.model ?? null,
      source: null, created_at: new Date(now.getTime() + it.step), data: meta,
    });
    if (made && (it.step === stepNum || !rec)) rec = await emailById(sql, made);
  }
  if (!rec) {
    // Another request drafted this step meanwhile: return that draft, as for an existing one.
    const [other] = await sql`select * from emails where lead_id = ${lid} and campaign_id = ${cid} and step = ${stepNum} and status <> 'failed' and not is_duplicate`;
    if (other) return { ...emailRecord(other), skipped: true };
    return fail(500, "No email was written");
  }
  await rememberDefaults(sql, cid, campaign, { sender_name, sender_company, sender_offer, framework: fw, total: totalNum });
  return rec;
}

// ── outreach.emails.generate (the older paced run) ─────────────────────────

const PACE_MS = 4500;
const BUDGET_MS = 18_000;

/** outreach.emails.generate: one email per lead that has none, paced inside a time budget; whatever does not fit is `remaining`. */
export async function generate(sql: Q, params: Row, deps: EmailDeps, ctx: EmailCtx): Promise<Row> {
  const { campaign_id, sender_name, sender_company, sender_offer } = params as Record<string, string>;
  if (!campaign_id) fail(400, "campaign_id required");
  if (!(await need(deps, "aiAvailable")())) fail(400, "Gemini key not configured");
  const campaign = (await campaignOf(sql, campaign_id)) ?? fail(404, "campaign not found");
  const leadRows = await sql`select * from leads where campaign_id = ${campaign_id} and merged_into is null order by created_at, id`;
  const contacts = await contactsFor(sql, leadRows.map((l) => l.email as string | null));
  const already = new Set((await sql`select distinct lead_id from emails where campaign_id = ${campaign_id} and status <> 'failed' and not is_duplicate`).map((e) => e.lead_id as string));
  const sendable: Row[] = [];
  let skippedFlagged = 0;
  for (const row of leadRows) {
    const lead = leadRecord(row);
    if (!lead.email || already.has(lead.id as string)) continue;
    if (await leadRefusal(sql, campaign, campaign_id, lead, contacts)) continue;
    if (!draftAllowed(lead).ok) { skippedFlagged++; continue; }
    sendable.push(lead);
  }
  if (sendable.length === 0) {
    if (skippedFlagged > 0) return { generated: 0, errors: [], remaining: 0, stopped: null, skipped_flagged: skippedFlagged };
    fail(400, "No leads with email addresses that still need a draft");
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + BUDGET_MS;
  let generated = 0;
  let stopped: { code: string; message: string } | null = null;
  const errors: Array<{ lead_id: string; error: string }> = [];
  let remaining = 0;
  for (let i = 0; i < sendable.length; i++) {
    const lead = sendable[i];
    if (now() + PACE_MS + 8000 > deadline) { remaining = sendable.length - i; break; }
    if (i > 0) await sleep(PACE_MS);
    try {
      const w = await need(deps, "writeDraft")({
        kind: "legacy", campaign, lead, framework: "one-off", step: 1, total_steps: 1, sender_name, sender_company, sender_offer, previous_steps: [], others: [], drafts_so_far: 0, have: [],
      });
      const at = new Date();
      const id = ctx.newId();
      const html = w.body_html || textToHtml(w.body_text);
      const ck = await codeCheckDraft(sql, { id, campaign_id, lead_id: lead.id, to_name: lead.name, framework: null, sequence_position: 1, subject: w.subject, body_text: w.body_text });
      const made = await insertEmail(sql, {
        id, campaign_id, lead_id: lead.id as string, to_email: lead.email as string, to_name: (lead.name as string | null) ?? null, subject: w.subject, body_text: w.body_text, body_html: html,
        sender_name: sender_name ?? null, step: 1, sequence_total: null, framework: null, ...reviewFields(ck, at.toISOString()), written_by: "gemini", written_model: w.model ?? null, source: null, created_at: at, data: {},
      });
      if (made) generated++;
    } catch (err) {
      const kind = (err as { kind?: unknown })?.kind;
      if (kind === "daily_quota") { stopped = { code: kind, message: (err as Error).message }; remaining = sendable.length - i; break; }
      if ((err as { code?: unknown })?.code && /^[0-9A-Z]{5}$/.test(String((err as { code: unknown }).code))) throw err; // a database error has aborted the transaction
      errors.push({ lead_id: lead.id as string, error: err instanceof Error ? err.message : "unknown" });
    }
  }
  await logActivity(sql, ctx, "content", `Drafted ${generated} emails for "${String(campaign.name)}"`, { campaign_id, generated, errors: errors.length });
  return { generated, errors, remaining, stopped, skipped_flagged: skippedFlagged };
}

// ── Background jobs: draft.start and review.start ──────────────────────────

/** copy of JOB_STALE_MS in command.ts: no progress for this long and a running job counts as interrupted */
const JOB_STALE_MS = 4 * 60_000;

export type PlannedPair = { lead: Row & { id: string; name?: string }; step: number };

/**
 * Which (lead, step) drafts a run would create: leads with a real address that are not skipped, excluded, contacted
 * elsewhere, do-not-contact, flagged (F32/F33, unless kept by her) or already drafted. SQL twin of planDraftPairs.
 */
export async function planDraftPairs(sql: Q, campaignId: string, framework: unknown): Promise<{ pairs: PlannedPair[]; totalSteps: number; fw: Framework }> {
  const campaign = (await campaignOf(sql, campaignId)) ?? fail(404, "campaign not found");
  const fw: Framework = typeof framework === "string" && (FRAMEWORKS as readonly string[]).includes(framework) ? (framework as Framework) : "one-off";
  const totalSteps = fw === "one-off" ? 1 : fw === "four-step" ? 4 : 3;
  const leads = (await sql`select * from leads where campaign_id = ${campaignId} and merged_into is null order by created_at, id`).map(leadRecord);
  const have = new Set((await sql`select lead_id, step from emails where campaign_id = ${campaignId} and status <> 'failed' and not is_duplicate`).map((e) => `${e.lead_id}__${e.step}`));
  const ctx = campaignSkipCtx(campaign);
  const contacts = await contactsFor(sql, leads.map((l) => l.email as string | null));
  const pairs: PlannedPair[] = [];
  for (const l of leads) {
    const email = l.email as string | null | undefined;
    if (!email || isJunkEmail(email) || l.do_not_contact || l.stop_state === "do_not_contact") continue;
    if (leadSkipReason(l as Parameters<typeof leadSkipReason>[0], ctx) || contactBlock(contacts, email, campaignId, { isTest: l.is_test === true })) continue;
    if (!draftAllowed(l).ok) continue;
    if (fw === "four-step") {
      // ONE writer call per lead writes all four emails: one pair per lead that still lacks any of them.
      const first = [1, 2, 3, 4].find((st) => !have.has(`${l.id}__${st}`));
      if (first) pairs.push({ lead: l as PlannedPair["lead"], step: first });
      continue;
    }
    for (let step = 1; step <= totalSteps; step++) if (!have.has(`${l.id}__${step}`)) pairs.push({ lead: l as PlannedPair["lead"], step });
  }
  // All step 1 first, then step 2, then step 3 (PAS, AIDA, SDR): later steps refer back to earlier ones.
  pairs.sort((a, b) => a.step - b.step || a.lead.id.localeCompare(b.lead.id));
  return { pairs, totalSteps, fw };
}

/** Which drafts a review run covers: the ticked ones, else every draft that is not already "ready". SQL twin of planReview. */
export async function planReview(sql: Q, campaignId: string, emailIds?: string[], opts: { onlyUnreviewed?: boolean; skipReviewedSince?: string } = {}): Promise<Row[]> {
  const rows = await sql`select * from emails where campaign_id = ${campaignId} and status = 'drafted' and not is_duplicate order by created_at, id`;
  const want = emailIds && emailIds.length ? new Set(emailIds) : null;
  return rows.map(emailRecord).filter((row) => {
    if (want ? !want.has(row.id as string) : row.review_status === "ready") return false;
    if (opts.onlyUnreviewed && (row.reviewed_at || row.review_status === "ready")) return false;
    if (opts.skipReviewedSince && typeof row.reviewed_at === "string" && row.reviewed_at >= opts.skipReviewedSince) return false;
    return true;
  });
}

/** 409 job_running when a job of this campaign (any kind but the lead search) made progress in the last 4 minutes. */
async function refuseIfJobRunning(sql: Q, campaignId: string): Promise<void> {
  const [j] = await sql`
    select 1 as x from campaign_jobs
    where campaign_id = ${campaignId} and kind not in ('leads', 'browser_check') and status = 'running' and coalesce(progress_at, started_at) > ${new Date(Date.now() - JOB_STALE_MS)}
    limit 1`;
  if (j) fail(409, "A job is already running for this campaign. Wait for it to finish.", { code: "job_running" });
}

/** Records a new running job (the same kind's old row, with its message and failures, is replaced). */
async function startJob(sql: Q, campaignId: string, kind: string, patch: Row): Promise<string> {
  const startedAt = new Date().toISOString();
  await sql`delete from campaign_jobs where campaign_id = ${campaignId} and kind = ${kind}`;
  await writeJob(sql, campaignId, kind, { status: "running", done: 0, started_at: startedAt, ...patch });
  return startedAt;
}

/** outreach.draft.start: validates and records a drafting job (the page then starts the background function). */
export async function draftStart(sql: Q, params: Row, deps: EmailDeps): Promise<Row> {
  const { campaign_id, framework } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  if (!(await need(deps, "aiAvailable")())) fail(400, "Gemini key not configured");
  if (!(await campaignOf(sql, campaign_id as string))) fail(404, "campaign not found");
  await refuseIfJobRunning(sql, campaign_id as string);
  const plan = await planDraftPairs(sql, campaign_id as string, framework);
  if (plan.pairs.length === 0) fail(400, "Nothing to draft: every eligible lead already has a draft, or all were skipped.");
  const started_at = await startJob(sql, campaign_id as string, "generate", { total: plan.pairs.length, made: 0, ...(plan.fw === "four-step" ? { unit: "leads", emails_per_lead: 4 } : {}) });
  return { total: plan.pairs.length, started_at };
}

/** outreach.emails.review.start: records a review job (all drafts that are not ready, or the given email_ids). */
export async function reviewStart(sql: Q, params: Row, deps: EmailDeps): Promise<Row> {
  const { campaign_id, email_ids } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  if (!(await need(deps, "aiAvailable")())) fail(400, "No AI provider is set up. Add the Gemini key in Settings.");
  if (!(await campaignOf(sql, campaign_id as string))) fail(404, "campaign not found");
  await refuseIfJobRunning(sql, campaign_id as string);
  const ids = Array.isArray(email_ids) ? (email_ids as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  const todo = await planReview(sql, campaign_id as string, ids);
  if (todo.length === 0) fail(400, "No drafts to review.");
  const started_at = await startJob(sql, campaign_id as string, "review", { total: todo.length });
  return { total: todo.length, started_at };
}

// ── The nine actions, for command.ts ───────────────────────────────────────

export const EMAIL_ACTIONS = [
  "outreach.emails.list", "outreach.emails.create", "outreach.emails.update", "outreach.emails.delete", "outreach.footer.preview",
  "outreach.emails.generate_one", "outreach.emails.generate", "outreach.draft.start", "outreach.emails.review.start",
] as const;
export type EmailAction = (typeof EMAIL_ACTIONS)[number];

/** Runs one action. Refusals are thrown as CampaignError (status + message, optional code), as the Blobs code answers them. */
export async function runEmailAction(sql: Q, action: EmailAction, params: Row, deps: EmailDeps, ctx: EmailCtx): Promise<unknown> {
  switch (action) {
    case "outreach.emails.list": return list(sql, params);
    case "outreach.emails.create": return create(sql, params, ctx); // deps are never passed: writing by hand never calls AI
    case "outreach.emails.update": return update(sql, params);
    case "outreach.emails.delete": return remove(sql, params);
    case "outreach.footer.preview": return footerPreview(sql, params);
    case "outreach.emails.generate_one": return generateOne(sql, params, deps, ctx);
    case "outreach.emails.generate": return generate(sql, params, deps, ctx);
    case "outreach.draft.start": return draftStart(sql, params, deps);
    case "outreach.emails.review.start": return reviewStart(sql, params, deps);
    default: return fail(400, `unknown email action: ${String(action)}`);
  }
}
