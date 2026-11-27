// P2 chunk 3: the lead actions on Postgres (used when DATA_BACKEND=sql; the Blobs code in command.ts stays the default
// until P5). Every function takes `sql`, a client or a transaction. Answers have the same shape as the old actions; the
// intended differences are listed in the equivalence cases (scripts/db/equiv/cases/leads.mjs):
//   - F17: merged leads (`merged_into` set) are never listed, and are "not found" for every write.
//   - F8: a lead record carries its `stop_state`.
//   - F16: one email edit. `update` takes `email` too, and it and `setEmail` share `writeEmail`, which sends every
//     unsent draft of the lead (in any campaign) to the new address. Sent emails are never touched.
//   - F18: facts typed by hand live in `lead_facts` with their source.
// No write here reads a whole record and writes it back: each change sets only its own columns (`data` merged with ||).
import type { Sql, Tx } from "../db/client.ts";
import { CampaignError } from "./campaigns.ts";
import { leadSkipReason, cleanEmail, isJunkEmail, isGovEduEmail, emailKey } from "../outreach.ts";
import { contactBlock, emptyContacts, type Contacts } from "../contacts.ts";
import { campaignSkipCtx, withoutJunkEmail, NOT_FIT_REASONS } from "./leadrules.ts";

export type Q = Sql | Tx;
type Row = Record<string, unknown>;

const iso = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v ?? null);
const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };

// ── The lead record ────────────────────────────────────────────────────────

/** Columns that hold a field of the old lead record under the same name. */
const LEAD_COLUMNS = [
  "id", "campaign_id", "name", "owner_name", "contact_name", "email", "email_source", "phone", "website", "address", "category",
  "rating", "reviews_count", "status", "is_test", "excluded", "excluded_at", "excluded_reason", "excluded_note", "not_fit_kept",
  "do_not_contact", "do_not_contact_at", "do_not_contact_reason", "gap_score", "site_check", "enriched_at", "browser_checked_at",
  "contacted_at", "created_at", "updated_at",
];
const NUMERIC = new Set(["rating", "gap_score"]); // numeric columns come back as text from the driver

/** The old Blobs lead record, put back together from its columns and `data`, plus `stop_state` (F8). */
export function leadRecord(r: Row): Row {
  const out: Row = { ...((r.data as Row) ?? {}) };
  for (const c of LEAD_COLUMNS) {
    const v = r[c];
    out[c] = NUMERIC.has(c) ? (v === null || v === undefined ? null : Number(v)) : c.endsWith("_at") ? iso(v) : v ?? null;
  }
  out.stop_state = r.stop_state;
  return out;
}

/** One live (not merged) lead of a campaign, locked for the change that follows; 404 when there is none. */
async function lockedLead(sql: Q, campaignId: string, leadId: string): Promise<Row> {
  const [row] = await sql`select * from leads where id = ${leadId} and campaign_id = ${campaignId} and merged_into is null for update`;
  return row ?? fail(404, "lead not found");
}

/** The contacts index (already emailed / bounced), only for the given addresses: one query on contacts_email. */
export async function contactsFor(sql: Q, emails: Array<string | null | undefined>): Promise<Contacts> {
  const keys = [...new Set(emails.map((e) => emailKey(e)).filter((k): k is string => !!k))];
  const c = emptyContacts();
  if (!keys.length) return c;
  for (const r of await sql`select kind, email, campaign_id from contacts where kind in ('sent', 'bounced') and email = any(${keys})`) {
    if (r.kind === "bounced") c.bounced.add(r.email);
    else c.sent.set(r.email, (c.sent.get(r.email) ?? new Set<string>()).add(r.campaign_id));
  }
  return c;
}

/** The campaign fields campaignSkipCtx reads, in the old record's names. */
export async function campaignCtxRecord(sql: Q, campaignId: string): Promise<Row | null> {
  const [c] = await sql`select niche as query, data->'structured_query' as structured_query, any_trade from campaigns where id = ${campaignId}`;
  return c ?? null;
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** outreach.leads.list: the campaign's leads, newest first, with the same skip reasons as today. */
export async function list(sql: Q, params: Row): Promise<Row[]> {
  const { campaign_id, limit = 500 } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  const cid = campaign_id as string;
  const [rows, camp] = await Promise.all([
    sql`select * from leads where campaign_id = ${cid} and merged_into is null order by created_at desc, id`,
    campaignCtxRecord(sql, cid),
  ]);
  const ctx = campaignSkipCtx(camp);
  const leads = rows.map(leadRecord);
  const contacts = await contactsFor(sql, leads.map((l) => l.email as string | null));
  const annotated = leads.map((r0) => {
    const r = withoutJunkEmail(r0 as Row & { email?: string | null });
    const why = leadSkipReason(r as Parameters<typeof leadSkipReason>[0], ctx) ?? (r.email ? contactBlock(contacts, r.email, cid, { isTest: r.is_test === true }) : null);
    return why ? { ...r, skip_reason: why.message, skip_code: why.code } : r;
  });
  return annotated.slice(0, typeof limit === "number" ? limit : 500);
}

/** outreach.lead.screenshot.get */
export async function screenshot(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, lead_id } = params as Record<string, string>;
  if (!campaign_id || !lead_id) fail(400, "campaign_id and lead_id required");
  const [r] = await sql`select jpeg, saved_at, bytes from lead_screenshots where campaign_id = ${campaign_id} and lead_id = ${lead_id}`;
  if (!r) return { found: false };
  return { found: true, data_url: `data:image/jpeg;base64,${Buffer.from(r.jpeg as Uint8Array).toString("base64")}`, saved_at: iso(r.saved_at), bytes: r.bytes };
}

// ── One email edit (F16) ───────────────────────────────────────────────────

type EmailResult = { email: string | null; email_source: "manual"; email_manual_at: string; drafts_updated: number; drafts_removed?: number; warning: string | null };

/** Checks an address the way lead.set_email does; "" means clear. Throws the same refusals. */
function checkedEmail(email: unknown): string {
  if (typeof email !== "string") fail(400, "email required");
  if ((email as string).trim() === "") return "";
  const next = cleanEmail(email as string);
  if (!next || isJunkEmail(next)) fail(400, "That is not a valid email address.");
  if (isGovEduEmail(next)) fail(400, "A .gov or .edu address is never used as a sales contact.");
  return next as string;
}

/**
 * Saves a hand-typed address on the lead (source "manual" + date, so no check ever replaces it: 0007 trigger) and sends
 * every unsent draft of the lead, in any campaign, to it. Clearing ("") removes the unsent drafts instead: they have no
 * address to go to. Sent emails are history and are never touched. `next` is already checked (checkedEmail).
 */
async function writeEmail(sql: Q, lead: Row, next: string, now: Date): Promise<EmailResult> {
  const at = now.toISOString();
  const prev = (lead.email as string | null) ?? null;
  if (next === "") {
    await sql`
      update leads set email = null, email_key = null, email_source = 'manual', updated_at = ${now},
        data = data || ${sql.json({ email_manual_at: at, junk_email: null, ...(prev ? { previous_email: prev } : {}) })}
      where id = ${lead.id as string}`;
    const gone = await sql`delete from emails where lead_id = ${lead.id as string} and status = 'drafted' returning 1`;
    const removed = gone.length;
    return { email: null, email_source: "manual", email_manual_at: at, drafts_updated: 0, drafts_removed: removed, warning: removed > 0 ? `${removed} unsent draft${removed === 1 ? "" : "s"} for this lead were removed because there is no address to send to.` : null };
  }
  await sql`
    update leads set email = ${next}, email_key = ${emailKey(next)}, email_source = 'manual', updated_at = ${now},
      data = data || ${sql.json({ email_manual_at: at, junk_email: null, ...(prev && prev !== next ? { previous_email: prev } : {}) })}
    where id = ${lead.id as string}`;
  const moved = await sql`
    update emails set to_email = ${next}, to_key = ${emailKey(next)}, updated_at = ${now},
      data = case when data->>'original_to_email' is not null then data else data || jsonb_build_object('original_to_email', to_email) end
    where lead_id = ${lead.id as string} and status = 'drafted' and to_email is distinct from ${next}
    returning 1`;
  const block = contactBlock(await contactsFor(sql, [next]), next, lead.campaign_id as string, { isTest: lead.is_test === true });
  return { email: next, email_source: "manual", email_manual_at: at, drafts_updated: moved.length, warning: block ? `${block.message.replace(/^Skipped: /, "")}: drafting and sending will skip this address.` : null };
}

/** outreach.lead.set_email: the same path as `update` with `email` (F16). */
export async function setEmail(sql: Q, params: Row): Promise<EmailResult> {
  const { campaign_id, lead_id, email } = params;
  if (typeof campaign_id !== "string" || !campaign_id || typeof lead_id !== "string" || !lead_id) fail(400, "campaign_id and lead_id required");
  const next = checkedEmail(email);
  const lead = await lockedLead(sql, campaign_id as string, lead_id as string);
  return writeEmail(sql, lead, next, new Date());
}

// ── Writes ─────────────────────────────────────────────────────────────────

/** outreach.leads.update: the per-lead things you control, plus `email` (F16). Only the given fields change. */
export async function update(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, lead_id, excluded, trade_override, owner_name, delete_drafts, excluded_reason, excluded_note, not_fit_kept, email } = params;
  if (typeof campaign_id !== "string" || !campaign_id || typeof lead_id !== "string" || !lead_id) fail(400, "campaign_id and lead_id required");
  if (excluded !== undefined && typeof excluded !== "boolean") fail(400, "excluded must be true or false");
  if (trade_override !== undefined && typeof trade_override !== "boolean") fail(400, "trade_override must be true or false");
  if (owner_name !== undefined && typeof owner_name !== "string") fail(400, "owner_name must be text");
  if (not_fit_kept !== undefined && typeof not_fit_kept !== "boolean") fail(400, "not_fit_kept must be true or false");
  if (excluded_reason !== undefined && excluded_reason !== null && !NOT_FIT_REASONS.includes(excluded_reason as string)) fail(400, `excluded_reason must be one of: ${NOT_FIT_REASONS.join(", ")}`);
  if (excluded_note !== undefined && excluded_note !== null && typeof excluded_note !== "string") fail(400, "excluded_note must be text");
  if (excluded === undefined && trade_override === undefined && owner_name === undefined && excluded_reason === undefined && excluded_note === undefined && not_fit_kept === undefined && email === undefined) fail(400, "nothing to update");
  const next = email === undefined ? undefined : checkedEmail(email);
  const lead = await lockedLead(sql, campaign_id as string, lead_id as string);
  const now = new Date();
  const cols: Row = { updated_at: now };
  const data: Row = {};
  if (excluded !== undefined) Object.assign(cols, { excluded, excluded_at: excluded ? now : null });
  if (not_fit_kept !== undefined) cols.not_fit_kept = not_fit_kept;
  if (excluded_reason !== undefined) cols.excluded_reason = excluded_reason;
  if (excluded_note !== undefined) cols.excluded_note = typeof excluded_note === "string" ? excluded_note.replace(/\s+/g, " ").trim().slice(0, 200) : null;
  if (trade_override !== undefined) data.trade_override = trade_override;
  if (owner_name !== undefined) {
    const n = (owner_name as string).replace(/\s+/g, " ").trim().slice(0, 80);
    // A name you type is trusted: it is used in greetings and never overwritten by a re-check.
    Object.assign(cols, { owner_name: n || null, contact_name: n || null });
    Object.assign(data, n ? { owner_confidence: "high", owner_source: "manual", owner_source_url: null } : { owner_confidence: null, owner_source: null, owner_source_url: null });
  }
  await sql`update leads set ${sql(cols)}${Object.keys(data).length ? sql`, data = data || ${sql.json(data as never)}` : sql``} where id = ${lead_id as string}`;
  const emailResult = next === undefined ? null : await writeEmail(sql, lead, next, now);
  // Skipping a lead can also remove its unsent drafts (sent emails stay as history).
  let draftsDeleted = 0;
  if (excluded === true && delete_drafts === true) draftsDeleted = (await sql`delete from emails where lead_id = ${lead_id as string} and status = 'drafted' returning 1`).length;
  const [row] = await sql`select * from leads where id = ${lead_id as string}`;
  const extra = emailResult ? { drafts_updated: emailResult.drafts_updated, ...(emailResult.drafts_removed !== undefined ? { drafts_removed: emailResult.drafts_removed } : {}), warning: emailResult.warning } : {};
  return { ...leadRecord(row), drafts_deleted: draftsDeleted, ...extra };
}

/** outreach.leads.delete: the lead, its screenshot, social steps, unsent drafts and follow-up rows. Sent emails stay. */
export async function remove(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, lead_id } = params as Record<string, string>;
  if (!campaign_id || !lead_id) fail(400, "campaign_id and lead_id required");
  const [r] = await sql`
    with l as (delete from leads where id = ${lead_id} and campaign_id = ${campaign_id} and merged_into is null returning id),
      s as (delete from lead_screenshots where campaign_id = ${campaign_id} and lead_id in (select id from l) returning 1),
      m as (delete from social_messages where campaign_id = ${campaign_id} and lead_id in (select id from l) returning 1),
      d as (delete from emails where lead_id in (select id from l) and status = 'drafted' returning 1),
      f as (delete from follow_ups where lead_id in (select id from l) returning 1)
    select (select count(*) from l)::int as leads, (select count(*) from d)::int as drafts,
      (select count(*) from s) + (select count(*) from m) + (select count(*) from f) as others`;
  if (!r.leads) fail(404, "lead not found");
  return { deleted: true, drafts_deleted: r.drafts };
}

/** outreach.lead.fb_checked: "I looked at this Facebook page". Only this field changes; result null clears it. */
export async function fbChecked(sql: Q, params: Row): Promise<Row> {
  const { campaign_id, lead_id, result, note } = params as { campaign_id?: string; lead_id?: string; result?: string | null; note?: string };
  if (!campaign_id || !lead_id) fail(400, "campaign_id and lead_id required");
  await lockedLead(sql, campaign_id as string, lead_id as string);
  const set = (v: Row | null) => sql`update leads set updated_at = ${new Date()}, data = data || jsonb_build_object('fb_checked', ${sql.json(v as never)}::jsonb) where id = ${lead_id as string}`;
  if (result === null || result === undefined || result === "") { await set(null); return { fb_checked: null }; }
  if (!["real", "gone", "not_fit"].includes(result)) fail(400, "result must be real, gone or not_fit");
  const rec = { at: new Date().toISOString(), result, note: String(note ?? "").trim().slice(0, 300) };
  await set(rec);
  return { fb_checked: rec };
}

// ── Facts typed by hand (F18) ──────────────────────────────────────────────

export const FACT_SOURCES = ["manual", "site_check", "google", "browser"] as const;
const factRow = (r: Row): Row => ({
  id: String(r.id), lead_id: r.lead_id, fact: r.fact, source: r.source,
  noted_on: r.noted_on instanceof Date ? r.noted_on.toISOString().slice(0, 10) : r.noted_on, created_at: iso(r.created_at),
});

async function liveLead(sql: Q, leadId: unknown): Promise<string> {
  if (typeof leadId !== "string" || !leadId) fail(400, "lead_id required");
  const [l] = await sql`select id from leads where id = ${leadId as string} and merged_into is null`;
  return (l?.id as string) ?? fail(404, "lead not found");
}

/** outreach.lead.facts.list: newest first. */
export async function listFacts(sql: Q, params: Row): Promise<Row[]> {
  const id = await liveLead(sql, params.lead_id);
  return (await sql`select * from lead_facts where lead_id = ${id} order by created_at desc, id desc`).map(factRow);
}

/** outreach.lead.facts.add: a fact about the lead, with where it came from (default: typed by hand). */
export async function addFact(sql: Q, params: Row): Promise<Row> {
  const { fact, source = "manual", noted_on } = params;
  const text = typeof fact === "string" ? fact.replace(/\s+/g, " ").trim() : "";
  if (!text) fail(400, "fact required");
  if (text.length > 500) fail(400, "fact is too long (500 characters at most)");
  if (!(FACT_SOURCES as readonly unknown[]).includes(source)) fail(400, `source must be one of: ${FACT_SOURCES.join(", ")}`);
  if (noted_on !== undefined && !(typeof noted_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(noted_on) && !Number.isNaN(Date.parse(noted_on)))) fail(400, "noted_on must be a date (YYYY-MM-DD)");
  const id = await liveLead(sql, params.lead_id);
  const [r] = noted_on
    ? await sql`insert into lead_facts (lead_id, fact, source, noted_on) values (${id}, ${text}, ${source as string}, ${noted_on as string}::date) returning *`
    : await sql`insert into lead_facts (lead_id, fact, source) values (${id}, ${text}, ${source as string}) returning *`;
  return factRow(r);
}

/** outreach.lead.facts.delete: only a fact typed by hand can be removed here. */
export async function removeFact(sql: Q, params: Row): Promise<Row> {
  const lead = await liveLead(sql, params.lead_id);
  const id = String(params.id ?? "");
  if (!/^\d+$/.test(id)) fail(400, "id required");
  const [f] = await sql`select source from lead_facts where id = ${id} and lead_id = ${lead}`;
  if (!f) fail(404, "fact not found");
  if (f.source !== "manual") fail(400, "only facts typed by hand can be removed");
  await sql`delete from lead_facts where id = ${id}`;
  return { id, deleted: true };
}

// ── The actions, for command.ts ────────────────────────────────────────────

export const LEAD_ACTIONS = [
  "outreach.leads.list", "outreach.lead.set_email", "outreach.leads.update", "outreach.prospects.list", "outreach.lead.screenshot.get",
  "outreach.leads.delete", "outreach.lead.fb_checked", "outreach.lead.facts.list", "outreach.lead.facts.add", "outreach.lead.facts.delete",
  "outreach.search",
] as const;
export type LeadAction = (typeof LEAD_ACTIONS)[number];

/** Runs one action. Refusals are thrown as CampaignError (status + message), as the Blobs code answers them. */
export async function runLeadAction(sql: Q, action: LeadAction, params: Row): Promise<unknown> {
  const search = await import("./search.ts");
  switch (action) {
    case "outreach.leads.list": return list(sql, params);
    case "outreach.lead.set_email": return setEmail(sql, params);
    case "outreach.leads.update": return update(sql, params);
    case "outreach.prospects.list": return search.prospects(sql, params);
    case "outreach.lead.screenshot.get": return screenshot(sql, params);
    case "outreach.leads.delete": return remove(sql, params);
    case "outreach.lead.fb_checked": return fbChecked(sql, params);
    case "outreach.lead.facts.list": return listFacts(sql, params);
    case "outreach.lead.facts.add": return addFact(sql, params);
    case "outreach.lead.facts.delete": return removeFact(sql, params);
    case "outreach.search": return search.searchAll(sql, params);
  }
}
