// P2 chunk 3: the Prospects list and the global search on Postgres (S0 / S6b). The Prospects row is built by the same
// code as today's outreach.prospects.list (the lib/ helpers and the copies in leadrules.ts); the data comes from one
// page query on `leads` and then one query per related table for that page's leads only, so no store is ever read
// whole (F4). Merged leads are never shown (F17). Differences from the old answer are listed in cases/leads.mjs.
import { CampaignError } from "./campaigns.ts";
import { leadRecord, type Q } from "./leads.ts";
import { campaignSkipCtx, autoNotFit } from "./leadrules.ts";
import { leadFlags } from "./fitflags.ts";
import { isJunkEmail } from "../outreach.ts";
import { deriveTouches, summarizeTouches, type Touch } from "../touches.ts";
import { leadHours } from "../sitecheck.ts";
import { autoFitFields, isContacted } from "../leadgen.ts";
import { possibleTypoDomain } from "../leadflags.ts";
import { isTestReply, ownReplyEmailIds } from "../replies.ts";

type Row = Record<string, unknown>;
const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ── The page query ─────────────────────────────────────────────────────────

export type PageOptions = { q?: unknown; campaign_id?: unknown; limit?: unknown; cursor?: unknown };
type Cursor = [number | null, string, string];

const encodeCursor = (r: Row): string => Buffer.from(JSON.stringify([r.gap_score === null ? null : Number(r.gap_score), iso(r.created_at), r.id])).toString("base64url");
function decodeCursor(c: unknown): Cursor {
  try {
    const v = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 3 && (v[0] === null || typeof v[0] === "number") && typeof v[1] === "string" && !Number.isNaN(Date.parse(v[1])) && typeof v[2] === "string") return v as Cursor;
  } catch { /* falls through */ }
  return fail(400, "cursor is not one this list gave");
}

function checked(o: PageOptions) {
  const q = typeof o.q === "string" ? o.q.trim() : o.q == null ? "" : String(o.q).trim();
  if (q.length > 200) fail(400, "q is too long (200 characters at most)");
  const campaign = o.campaign_id == null || o.campaign_id === "" ? null : typeof o.campaign_id === "string" ? o.campaign_id : fail(400, "campaign_id must be text");
  const limit = o.limit ?? null;
  if (limit !== null && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 500)) fail(400, "limit must be a whole number from 1 to 500");
  if (o.cursor != null && limit === null) fail(400, "cursor needs a limit");
  return { q, campaign: campaign as string | null, limit: limit as number | null, cursor: o.cursor == null ? null : decodeCursor(o.cursor) };
}

/**
 * The page query as text and values (so a test can `explain` the very statement the list runs). Order: gap score
 * (highest first, none last), then newest, then id: the `leads_order` index. The cursor is a keyset position, so pages
 * never repeat or skip a lead. `q` uses the `leads_search` trigram index (name, owner, email, phone, website, city).
 */
export function pageSql(opts: PageOptions): { text: string; values: unknown[] } {
  const { q, campaign, limit, cursor } = checked(opts);
  const values: unknown[] = [];
  const p = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const where = ["merged_into is null"];
  if (q) where.push(`search ilike ${p(likePattern(q.toLowerCase()))}`);
  if (campaign) where.push(`campaign_id = ${p(campaign)}`);
  if (cursor) {
    const [g, c, id] = cursor;
    const after = `(created_at < ${p(c)}::timestamptz or (created_at = ${p(c)}::timestamptz and id > ${p(id)}))`;
    where.push(g === null ? `(gap_score is null and ${after})` : `(gap_score < ${p(g)} or gap_score is null or (gap_score = ${p(g)} and ${after}))`);
  }
  const text = `select * from leads where ${where.join(" and ")} order by gap_score desc nulls last, created_at desc, id${limit ? ` limit ${p(limit + 1)}` : ""}`;
  return { text, values };
}

// ── The related rows, for one page of leads ────────────────────────────────

/** The old social record again, from its steps (one row per step today; the old record kept them in `parts`). */
function socialRecords(steps: Row[]): Row[] {
  const by = new Map<string, Row[]>();
  for (const s of steps) (by.get(s.record_id as string) ?? by.set(s.record_id as string, []).get(s.record_id as string)!).push(s);
  return [...by.values()].map((parts) => {
    parts.sort((a, b) => (a.step as number) - (b.step as number));
    const sent = parts.every((x) => x.status === "sent");
    const open = parts.find((x) => x.status !== "sent" && x.status !== "skipped");
    const first = parts[0];
    // The record's review status was the worst of its steps (blocked, then check, then ready): every drafted record
    // in the P1 export follows this rule.
    const review = ["blocked", "check", "ready"].find((s) => parts.some((x) => x.review_status === s)) ?? null;
    return {
      lead_id: first.lead_id, campaign_id: first.campaign_id, channel: first.channel, type: first.type, review_status: review,
      status: sent ? "sent" : (open?.status as string) ?? "drafted",
      sent_at: sent ? parts.map((x) => iso(x.sent_at)).filter(Boolean).sort().at(-1) ?? null : null,
      parts: parts.map((x) => ({ key: x.step_key, text: x.body, sent_at: iso(x.sent_at), touch_id: x.touch_id })),
    };
  });
}

/**
 * Everything a page of Prospects rows needs besides the leads, in ONE statement (one round trip): each table is read
 * only for the page's lead ids, through its lead index (emails_lead, social_lead, touches_lead, replies_lead,
 * lead_facts_lead, the links primary key). Times come back as JSON text and are turned into ISO strings below.
 */
async function related(sql: Q, ids: string[], campaignIds: string[]) {
  const [r] = await sql`
    select
      (select coalesce(json_agg(x), '[]') from (select id, lead_id, campaign_id, status, sent_at, created_at, review_status, step, subject, body_text from emails where lead_id = any(${ids})) x) as emails,
      (select coalesce(json_agg(x), '[]') from (select record_id, lead_id, campaign_id, channel, step, step_key, body, status, type, review_status, sent_at, touch_id from social_messages where lead_id = any(${ids})) x) as steps,
      (select coalesce(json_agg(x), '[]') from (select * from touches where lead_id = any(${ids})) x) as touches,
      (select coalesce(json_agg(x), '[]') from (select lead_id, original_email_id, is_test, received_at, from_address from replies
        where lead_id = any(${ids}) or original_email_id in (select id from emails where lead_id = any(${ids}))) x) as replies,
      (select coalesce(json_agg(x), '[]') from (select lead_id, kind, url from lead_social_links where lead_id = any(${ids})) x) as links,
      (select coalesce(json_agg(x order by x.created_at desc, x.id desc), '[]') from (select * from lead_facts where lead_id = any(${ids})) x) as facts,
      (select coalesce(json_agg(x), '[]') from (select id, name, niche as query, data->'structured_query' as structured_query, any_trade from campaigns where id = any(${campaignIds})) x) as campaigns`;
  const times = (rows: Row[], keys: string[]) => rows.map((x) => { for (const k of keys) if (typeof x[k] === "string") x[k] = new Date(x[k] as string).toISOString(); return x; });
  const emails = times(r.emails as Row[], ["sent_at", "created_at"]);
  const steps = times(r.steps as Row[], ["sent_at"]);
  const touches = times(r.touches as Row[], ["sent_at"]);
  const replies = times(r.replies as Row[], ["received_at"]);
  const links = r.links as Row[], facts = r.facts as Row[], campaigns = r.campaigns as Row[];
  return {
    emails: emails.map((e) => ({ id: e.id, lead_id: e.lead_id, campaign_id: e.campaign_id, status: e.status, sent_at: iso(e.sent_at) ?? undefined, created_at: iso(e.created_at) ?? undefined, review_status: e.review_status ?? undefined, sequence_position: e.step, subject: e.subject, body_text: e.body_text })),
    socials: socialRecords(steps),
    touches: touches.map((t) => ({ ...(t.data as Row), id: t.id, lead_id: t.lead_id, campaign_id: t.campaign_id, channel: t.channel, kind: t.kind, sent_at: iso(t.sent_at), text: t.body ?? "", subject: t.subject, source: t.source, ref: t.ref ?? undefined }) as unknown as Touch),
    replies: replies.map((r) => ({ lead_id: (r.lead_id as string | null) ?? null, original_email_id: (r.original_email_id as string | null) ?? null, is_test: r.is_test === true, received_at: (iso(r.received_at) ?? undefined) as string | undefined, from: (r.from_address as string | null) ?? null })),
    links, facts, campaigns,
  };
}

const group = <T extends Row>(rows: T[], key: (r: T) => unknown) => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (k) (m.get(String(k)) ?? m.set(String(k), []).get(String(k))!).push(r); }
  return m;
};

/** The Prospects rows for some leads, built exactly as outreach.prospects.list builds them today. */
async function prospectRows(sql: Q, leadRows: Row[]): Promise<Row[]> {
  if (!leadRows.length) return [];
  const leads = leadRows.map(leadRecord);
  const ids = leads.map((l) => l.id as string);
  const r = await related(sql, ids, [...new Set(leads.map((l) => l.campaign_id as string).filter(Boolean))]);
  const { emails, socials, touches: storedTouches } = r;
  const replyRows = r.replies;
  const linksByLead = group(r.links as Row[], (x) => x.lead_id);
  const factsByLead = group(r.facts as Row[], (x) => x.lead_id);
  const repliedByReply = new Set(replyRows.filter((x) => x.lead_id && !isTestReply(x)).map((x) => String(x.lead_id)));
  const repliedAtByLead = new Map<string, string>();
  for (const x of replyRows) if (x.lead_id && !isTestReply(x) && x.received_at && x.received_at > (repliedAtByLead.get(String(x.lead_id)) ?? "")) repliedAtByLead.set(String(x.lead_id), x.received_at);
  const emailsByLead = group(emails as Row[], (e) => e.lead_id);
  const socialsByLead = group(socials, (x) => x.lead_id);
  const touchesByLead = group(storedTouches as unknown as Row[], (t) => t.lead_id);
  const ownOnlyReplies = ownReplyEmailIds(replyRows);
  const socialByLead = new Map<string, Array<{ channel: string; sent_at: string }>>();
  for (const x of socials) if (x.lead_id && x.channel && x.status === "sent" && x.sent_at) socialByLead.set(x.lead_id as string, [...(socialByLead.get(x.lead_id as string) ?? []), { channel: x.channel as string, sent_at: x.sent_at as string }]);
  const campName = new Map((r.campaigns as Row[]).map((c) => [c.id as string, (c.name as string | null) ?? (c.query as string | null) ?? (c.id as string)]));
  const campCtx = new Map((r.campaigns as Row[]).map((c) => [c.id as string, campaignSkipCtx(c)]));
  const byLead = new Map<string, { replied: boolean; bounced: boolean; sent: boolean; sent_at: string | null; review: string | null; review_at: string }>();
  for (const e of emails) {
    if (!e.lead_id) continue;
    const cur = byLead.get(e.lead_id as string) ?? { replied: false, bounced: false, sent: false, sent_at: null, review: null, review_at: "" };
    const st = (e.status as string) ?? "drafted";
    if (st === "drafted" && (e.created_at ?? "") >= cur.review_at) { cur.review = e.review_status === "ready" || e.review_status === "blocked" ? e.review_status : "check"; cur.review_at = e.created_at ?? ""; }
    if (st === "replied" && !(e.id && ownOnlyReplies.has(e.id as string))) cur.replied = true;
    if (["bounced", "complained", "failed"].includes(st)) cur.bounced = true;
    if (st !== "drafted") {
      cur.sent = true;
      const at = e.sent_at ?? e.created_at ?? null;
      if (at && (!cur.sent_at || at > cur.sent_at)) cur.sent_at = at;
    }
    byLead.set(e.lead_id as string, cur);
  }
  return leads.map((l) => {
    const lid = l.id as string;
    const em = byLead.get(lid);
    const contactedAt = (l.contacted_at as string | undefined) ?? null;
    const email_status = l.do_not_contact ? "do_not_contact" : em?.bounced ? "bounced" : em?.replied ? "replied" : em?.sent || contactedAt ? "emailed" : "not_emailed";
    const h = leadHours(l as Parameters<typeof leadHours>[0]);
    const social = Object.fromEntries((linksByLead.get(lid) ?? []).map((k) => [k.kind as string, k.url as string]));
    const tl = deriveTouches({ lead_id: lid, campaign_id: (l.campaign_id as string | undefined) ?? null, emails: (emailsByLead.get(lid) ?? []) as never, socials: (socialsByLead.get(lid) ?? []) as never, stored: (touchesByLead.get(lid) ?? []) as unknown as Touch[] });
    const touches = summarizeTouches(tl, email_status === "replied" || repliedByReply.has(lid), { at: repliedAtByLead.get(lid) ?? null, via: "email" });
    const social_drafts = (socialsByLead.get(lid) ?? []).filter((x) => x.status === "drafted").map((x) => ({ channel: x.channel, review_status: x.review_status ?? null, type: x.type ?? "first" }));
    const sc = (l.site_check as Row | undefined) ?? {};
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
      social_sent: socialByLead.get(lid) ?? [],
      touches, social_drafts, fb_checked: l.fb_checked ?? null,
      excluded: l.excluded === true, excluded_reason: (l.excluded_reason as string | undefined) ?? null, excluded_note: (l.excluded_note as string | undefined) ?? null,
      email_source: (l.email_source as string | undefined) ?? null, email_manual_at: (l.email_manual_at as string | undefined) ?? null,
      not_fit_kept: l.not_fit_kept === true,
      email_typo: possibleTypoDomain(l.email as string | null | undefined),
      ...autoFitFields(l.excluded === true ? null : autoNotFit(l, campCtx.get(l.campaign_id as string) ?? { location: null, query: "", anyTrade: true }, isContacted({ emailSent: !!(em?.sent || contactedAt), emailDraft: em?.review != null, touches: touches.total, replied: touches.replied }))),
      stop_state: l.stop_state,
      fit_flags: leadFlags(l),
      facts: (factsByLead.get(lid) ?? []).map((f) => ({ id: String(f.id), fact: f.fact, source: f.source, noted_on: f.noted_on instanceof Date ? f.noted_on.toISOString().slice(0, 10) : f.noted_on })),
    };
  });
}

/**
 * outreach.prospects.list. No `limit`: every lead, as an array (today's shape). With `limit` (1–500): one page,
 * `{ rows, next_cursor }`; pass `next_cursor` back as `cursor` for the next page (null after the last one).
 */
export async function prospects(sql: Q, opts: PageOptions = {}): Promise<Row[] | { rows: Row[]; next_cursor: string | null }> {
  const { text, values } = pageSql(opts);
  const limit = (opts.limit as number | undefined) ?? null;
  const found = await sql.unsafe(text, values as never[]);
  if (!limit) return prospectRows(sql, [...found]);
  const page = found.slice(0, limit);
  return { rows: await prospectRows(sql, page), next_cursor: found.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

// ── Global search (S6b) ────────────────────────────────────────────────────

/** outreach.search: campaigns (name, niche, area) and leads (name, owner, email, phone, website, city), merged leads left out. */
export async function searchAll(sql: Q, params: Row): Promise<{ campaigns: Row[]; leads: Row[] }> {
  const q = typeof params.q === "string" ? params.q.trim() : "";
  if (q.length < 2) fail(400, "q must be at least 2 characters");
  if (q.length > 200) fail(400, "q is too long (200 characters at most)");
  const limit = params.limit ?? 10;
  if (!(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 50)) fail(400, "limit must be a whole number from 1 to 50");
  const pattern = likePattern(q.toLowerCase());
  const [campaigns, leads] = await Promise.all([
    sql`select id, name, niche, area, created_at from campaigns where search ilike ${pattern} order by created_at desc nulls last, id limit ${limit as number}`,
    sql`select l.id, l.name, l.campaign_id, c.name as campaign_name, l.email, l.phone, l.website, l.stop_state from leads l left join campaigns c on c.id = l.campaign_id
        where l.merged_into is null and l.search ilike ${pattern} order by l.gap_score desc nulls last, l.created_at desc, l.id limit ${limit as number}`,
  ]);
  return { campaigns: campaigns.map((c) => ({ ...c, created_at: iso(c.created_at) })), leads: [...leads] };
}
