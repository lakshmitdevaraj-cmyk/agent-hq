// Prospects list. The per-lead row is built by the same code as production (command.ts:4406-4482), from the real
// helpers in netlify/functions/lib. Only the way the records are fetched changes.
import { deriveTouches, summarizeTouches, type Touch } from "../../../netlify/functions/lib/touches";
import { isJunkEmail, leadSkipReason } from "../../../netlify/functions/lib/outreach";
import { possibleTypoDomain, categoryFitFlag } from "../../../netlify/functions/lib/leadflags";
import { leadGenDecision, otherRuleDecision, isContacted, autoFitFields } from "../../../netlify/functions/lib/leadgen";
import { leadHours } from "../../../netlify/functions/lib/sitecheck";
import { isTestReply, ownReplyEmailIds } from "../../../netlify/functions/lib/replies";
import type { Sql } from "./db";

type Rec = Record<string, any>;

// copy of command.ts:1770
export function campaignSkipCtx(c: Rec | null | undefined): { location: string | null; query: string; anyTrade: boolean } {
  const sq = c?.structured_query;
  return { location: sq?.location ?? null, query: [c?.query ?? "", ...(Array.isArray(sq?.searchTerms) ? sq!.searchTerms! : [])].join(" "), anyTrade: c?.any_trade !== false };
}

// copy of command.ts:2377
function autoNotFit(lead: Rec, ctx: ReturnType<typeof campaignSkipCtx>, contacted = false): { code: string; detail: string; hide: boolean; why: "contacted" | "reviews" | null } | null {
  if (lead.not_fit_kept === true) return null;
  const other = (code: string, detail: string) => ({ code, detail, ...otherRuleDecision({ code, detail } as any, contacted) });
  const why = leadSkipReason(lead as any, { ...ctx });
  if (why && why.code !== "excluded") return other(why.code === "chain" ? "chain" : "other", why.message.replace(/^Skipped: /, ""));
  const sc = (lead.site_check ?? {}) as { not_home_service?: string | null; lead_gen_listing?: string | null };
  if (sc.not_home_service) return other(/wholesal|distribut|supplier/i.test(sc.not_home_service) ? "wholesaler" : "not_home_service", sc.not_home_service);
  const lg = leadGenDecision(lead as any, contacted);
  if (lg) return { code: "lead_gen", detail: lg.reasons.join("; "), hide: lg.hide, why: lg.why };
  const cf = categoryFitFlag(typeof lead.category === "string" ? lead.category : null);
  if (cf) return other("not_home_service", cf);
  return null;
}

export type Related = { campaigns: Rec[]; emails: Rec[]; socials: Rec[]; replies: Rec[]; touches: Touch[] };

/** Rows for these leads, in the order given. */
export function buildRows(leads: Rec[], { campaigns, emails, socials, replies: replyRows, touches: storedTouches }: Related) {
  const repliedByReply = new Set(replyRows.filter((r) => r.lead_id && !isTestReply(r)).map((r) => String(r.lead_id)));
  const repliedAtByLead = new Map<string, string>();
  for (const r of replyRows) if (r.lead_id && !isTestReply(r) && r.received_at && r.received_at > (repliedAtByLead.get(String(r.lead_id)) ?? "")) repliedAtByLead.set(String(r.lead_id), r.received_at);
  const group = <T extends Rec>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of rows) if (x.lead_id) (m.get(x.lead_id) ?? m.set(x.lead_id, []).get(x.lead_id)!).push(x);
    return m;
  };
  const emailsByLead = group(emails);
  const socialsByLead = group(socials);
  const touchesByLead = group(storedTouches as any) as unknown as Map<string, Touch[]>;
  const ownOnlyReplies = ownReplyEmailIds(replyRows as any);
  const socialByLead = new Map<string, Array<{ channel: string; sent_at: string }>>();
  for (const x of socials) if (x.lead_id && x.channel && x.status === "sent" && x.sent_at) socialByLead.set(x.lead_id, [...(socialByLead.get(x.lead_id) ?? []), { channel: x.channel, sent_at: x.sent_at }]);
  const campName = new Map(campaigns.map((c) => [c.id, c.name ?? c.query ?? c.id]));
  const campCtx = new Map(campaigns.map((c) => [c.id, campaignSkipCtx(c)]));
  const byLead = new Map<string, { replied: boolean; bounced: boolean; sent: boolean; sent_at: string | null; review: string | null; review_at: string }>();
  for (const e of emails) {
    if (!e.lead_id) continue;
    const cur = byLead.get(e.lead_id) ?? { replied: false, bounced: false, sent: false, sent_at: null, review: null, review_at: "" };
    const st = e.status ?? "drafted";
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
  return leads.map((l) => {
    const em = byLead.get(l.id);
    const contactedAt = (l.contacted_at as string | undefined) ?? null;
    const email_status = l.do_not_contact ? "do_not_contact" : em?.bounced ? "bounced" : em?.replied ? "replied" : em?.sent || contactedAt ? "emailed" : "not_emailed";
    const h = leadHours(l as any);
    const social = (l.social as Record<string, string | null> | undefined) ?? {};
    const lid = l.id as string;
    const tl = deriveTouches({ lead_id: lid, campaign_id: (l.campaign_id as string | undefined) ?? null, emails: emailsByLead.get(lid) ?? [], socials: socialsByLead.get(lid) ?? [], stored: touchesByLead.get(lid) ?? [] });
    const touches = summarizeTouches(tl, email_status === "replied" || repliedByReply.has(lid), { at: repliedAtByLead.get(lid) ?? null, via: "email" });
    const social_drafts = (socialsByLead.get(lid) ?? []).filter((x) => x.status === "drafted").map((x) => ({ channel: x.channel, review_status: x.review_status ?? null, type: x.type ?? "first" }));
    const sc = (l.site_check as Rec | undefined) ?? {};
    return {
      id: l.id, campaign_id: l.campaign_id ?? null, campaign_name: campName.get(l.campaign_id) ?? null,
      name: l.name, category: l.category ?? null, address: l.address ?? null, email: l.email && !isJunkEmail(l.email) ? l.email : null,
      phone: l.phone ?? null, website: l.website ?? null, maps_url: l.maps_url ?? null, rating: l.rating ?? null, reviews_count: l.reviews_count ?? null,
      is_test: l.is_test === true, created_at: l.created_at ?? null,
      owner_name: l.owner_name ?? null, owner_confidence: l.owner_confidence ?? null, owner_source: l.owner_source ?? null, owner_source_url: l.owner_source_url ?? null,
      gap_score: typeof l.gap_score === "number" ? l.gap_score : null, gap_reasons: Array.isArray(l.gap_reasons) ? l.gap_reasons : [],
      checked_at: sc.checked_at ?? null, site_error: sc.error ?? null,
      site_check: l.site_check ?? null, social, hours_summary: h?.summary ?? null,
      email_status, emailed_at: em?.sent_at ?? contactedAt,
      review_status: em?.review ?? null,
      owner_evidence: l.owner_evidence ?? null,
      social_sent: socialByLead.get(l.id) ?? [],
      touches, social_drafts, fb_checked: l.fb_checked ?? null,
      excluded: l.excluded === true, excluded_reason: l.excluded_reason ?? null, excluded_note: l.excluded_note ?? null,
      email_source: l.email_source ?? null, email_manual_at: l.email_manual_at ?? null,
      not_fit_kept: l.not_fit_kept === true,
      email_typo: possibleTypoDomain(l.email),
      ...autoFitFields(l.excluded === true ? null : autoNotFit(l, campCtx.get(l.campaign_id) ?? { location: null, query: "", anyTrade: true }, isContacted({ emailSent: !!(em?.sent || contactedAt), emailDraft: em?.review != null, touches: touches.total, replied: touches.replied }))),
    };
  });
}

/** Only the fields the row uses, so long email texts never leave the database. */
export async function related(sql: Sql, ds: string, leadIds: string[] | null): Promise<Related> {
  const only = leadIds ? sql`and lead_id in ${sql(leadIds.length ? leadIds : [""])}` : sql``;
  const [campaigns, emails, socials, replies, touches] = await Promise.all([
    sql`select data from spike.s75_campaigns where ds = ${ds}`,
    sql`select id, lead_id, status, data->>'sent_at' as sent_at, created_at, data->>'review_status' as review_status, step as sequence_position from spike.s75_emails where ds = ${ds} ${only} order by key`,
    sql`select data from spike.s75_social where ds = ${ds} ${only} order by key`,
    sql`select lead_id, data->>'original_email_id' as original_email_id, (data->>'is_test')::boolean as is_test, data->>'received_at' as received_at, data->>'from' as "from" from spike.s75_replies where ds = ${ds} ${only} order by key`,
    sql`select data from spike.s75_touches where ds = ${ds} ${only} order by key`,
  ]);
  // A column that is null stands for a field that is absent in the stored record.
  const strip = (r: Rec) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null));
  return {
    campaigns: campaigns.map((r) => r.data), emails: emails.map(strip), socials: socials.map((r) => r.data),
    replies: replies.map(strip), touches: touches.map((r) => r.data),
  };
}

/** A: every lead, built in the Worker. Same response as production. */
export async function listA(sql: Sql, ds: string) {
  const [leads, rel] = await Promise.all([
    sql`select data from spike.s75_leads where ds = ${ds} order by gap_score desc, created_at desc, key`,
    related(sql, ds, null),
  ]);
  return buildRows(leads.map((r) => r.data), rel);
}

/** B: each row was built when the lead was last written; Postgres joins them into the finished answer. */
export async function listB(sql: Sql, ds: string): Promise<string> {
  const [r] = await sql`select '{"ok":true,"data":[' || coalesce(string_agg(row_json, ',' order by gap_score desc, created_at desc, key), '') || ']}' as body from spike.s75_leads where ds = ${ds}`;
  return r.body as string;
}

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;

/** C: 50 rows, optional search. Needs a page change. */
export async function listC(sql: Sql, ds: string, page: number, q: string) {
  const where = q ? sql`and search like ${like(q)}` : sql``;
  const found = await sql`select id, data, count(*) over ()::int as total from spike.s75_leads where ds = ${ds} ${where}
    order by gap_score desc, created_at desc, key limit 50 offset ${Math.max(0, page - 1) * 50}`;
  const rel = await related(sql, ds, found.map((r) => r.id as string));
  return { total: (found[0]?.total as number) ?? 0, rows: buildRows(found.map((r) => r.data), rel) };
}
