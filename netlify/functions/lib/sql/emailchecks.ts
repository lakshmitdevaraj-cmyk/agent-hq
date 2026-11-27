// P2 chunk 5 (5b: lead-aware checks, business name for the rating rule, stale code blocks lifted): the free code checks on a saved email, on Postgres. The SQL twins of codeCheckSavedEmail,
// leadRatingUsed and recheckDraftRows in command.ts (copies of the logic, so the old Blobs code is not touched; when
// the Blobs code is removed this file is the only copy). The pure rules come from lib/messagerules.ts and
// lib/fourstep.ts and are imported, not copied.
//   - Settings come from `outreach_settings` ('settings'), the lead's earlier four-step emails from `emails`, and
//     "the rating was already used" from the lead's `social_messages` plus those earlier emails (as today: the lead's
//     other emails are NOT read, only the earlier steps).
//   - recheckStaleDrafts changes only drafted rows whose rules_version is not RULES_VERSION: a hard hit makes the
//     draft Blocked (reasons saved, reviewed_by "code checks"); otherwise the row is only stamped with the version.
import type { Sql, Tx } from "../db/client.ts";
import { scanBanned, checkStep, checkSubject, statusOf, mentionsRating, RULES_VERSION, type Hit } from "../messagerules.ts";
import { resolveInputs } from "../fourstep.ts";
import { messageChecks, type MsgLead } from "./messagechecks.ts";

type Q = Sql | Tx;
type Row = Record<string, unknown>;

export type CheckResult = { status: "ready" | "check" | "blocked"; reasons: string[]; hard: string[]; hits: Hit[] };
export type Downgrade = { id: string; campaign_id: string; lead_id?: string; step: number; name?: string; was: string; reasons: string[] };

/** The Settings record (outreach_settings 'settings'); {} when none was saved. */
export async function readSettings(sql: Q): Promise<Row> {
  const [r] = await sql`select data from outreach_settings where key = 'settings'`;
  return (r?.data as Row | undefined) ?? {};
}

/** copy of hitLine in command.ts */
const hitLine = (h: Hit): string => `${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}. ${h.because}`.slice(0, 240);

/**
 * Has another message to this lead on a social channel already stated the rating or review count? (SQL twin of
 * leadRatingUsed with `skip.emails`, which is the only way codeCheckSavedEmail calls it.)
 */
async function socialRatingUsed(sql: Q, campaignId: string, leadId: string, businessName?: string | null): Promise<boolean> {
  const rows = await sql`select body from social_messages where lead_id = ${leadId} and campaign_id = ${campaignId} and not is_duplicate`;
  return rows.some((r) => mentionsRating(String(r.body ?? ""), businessName));
}

/**
 * The free code checks for ONE saved email, with the same rules as generation (position decides the rules; later steps
 * are measured against the lead's earlier emails; the rating is stated at most once across email and social).
 * Hard hits mean "blocked". `row` is the email in the old record's shape (`sequence_position`) or a table row (`step`).
 * Pass `settings` when checking many rows, so Settings is read once.
 */
export async function codeCheckDraft(sql: Q, row: Row, settings?: Row): Promise<CheckResult> {
  const inp = resolveInputs((settings ?? (await readSettings(sql))) as Parameters<typeof resolveInputs>[0], String(row.to_name ?? ""));
  const four = row.framework === "four-step";
  const pos = Math.min(4, Math.max(1, Number(row.sequence_position ?? row.step ?? 1)));
  const campaignId = String(row.campaign_id ?? "");
  const leadId = String(row.lead_id ?? "");
  const earlier = four && row.lead_id
    ? await sql`select body_text from emails
                where campaign_id = ${campaignId} and lead_id = ${leadId} and framework = 'four-step' and step < ${pos} and id <> ${String(row.id ?? "")} and not is_duplicate
                order by step, created_at`
    : [];
  const body = String(row.body_text ?? "");
  const subject = String(row.subject ?? "");
  // 5b: the lead, for the business name (F38) and the lead-aware checks (F35–F37, F40).
  const [lead] = row.lead_id ? await sql`select name, email, website, owner_name, contact_name, site_check, data->'raw' as raw from leads where id = ${leadId}` : [];
  const businessName = (lead?.name as string | null | undefined) ?? (row.to_name as string | null | undefined) ?? null;
  const earlierTexts = earlier.map((e) => String(e.body_text ?? ""));
  const ratingAlready = (row.lead_id ? await socialRatingUsed(sql, campaignId, leadId, businessName) : false) || earlierTexts.some((t) => mentionsRating(t, businessName));
  const kinds = ["email1", "email2", "email3", "email4"] as const;
  let hits = checkStep(four ? kinds[pos - 1] : "email1", body, { channel: "email", earlierChars: earlierTexts.map((t) => t.length), ratingAlready, freeAsset: pos === 2 ? inp.freeAsset2 : inp.freeAsset1, proofLine: inp.proofLine, earlierTexts, namedSources: inp.namedSources, businessName });
  // Older frameworks have no length or structure rules: only hard hits count for them.
  if (!four) hits = hits.filter((h) => h.level === "hard");
  const subjectHits = four && pos === 1 ? checkSubject(subject) : [...scanBanned(subject).filter((h) => h.level === "hard" && h.id !== "dash"), ...checkSubject(subject).filter((h) => h.id === "fake-re" || h.id === "empty-subject")];
  hits = [...hits, ...subjectHits.filter((h) => !hits.some((x) => x.id === h.id))];
  // 5b: every framework gets the lead-aware checks (a wrong recipient matters for any email).
  if (lead) hits = [...hits, ...messageChecks(kinds[four ? pos - 1 : 0], body, lead as MsgLead, (row.to_email as string | null | undefined) ?? null)];
  const st = statusOf(hits);
  return { status: st.status, reasons: st.reasons, hard: hits.filter((h) => h.level === "hard").map(hitLine), hits };
}

const isDbError = (e: unknown): boolean => typeof (e as { code?: unknown })?.code === "string" && /^[0-9A-Z]{5}$/.test((e as { code: string }).code);

/**
 * Re-checks every UNSENT draft whose last code check is older than RULES_VERSION and saves the result (an UPDATE per
 * row; updated_at is left alone, as the old code did). A hard hit makes it Blocked (reasons saved); otherwise it is only
 * stamped with the version, so this runs once per rules change, not on every load. Mutates the rows it is given, so the
 * caller's list is already current. Returns the drafts that were downgraded.
 */
export async function recheckStaleDrafts(sql: Q, rows: Row[]): Promise<Downgrade[]> {
  const out: Downgrade[] = [];
  let settings: Row | undefined;
  for (const r of rows) {
    if (!r || r.status !== "drafted" || r.rules_version === RULES_VERSION || !r.campaign_id || !r.id) continue;
    try {
      settings ??= await readSettings(sql);
      const ck = await codeCheckDraft(sql, r, settings);
      if (ck.hard.length) {
        const was = String(r.review_status ?? "check");
        const patch = { review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: new Date().toISOString(), rules_version: RULES_VERSION };
        await sql`update emails set review_status = 'blocked', review_reasons = ${sql.json(ck.reasons as never)}, reviewed_by = 'code checks', reviewed_at = ${patch.reviewed_at}::timestamptz, rules_version = ${RULES_VERSION}
                  where id = ${String(r.id)} and status = 'drafted'`;
        Object.assign(r, patch);
        out.push({ id: String(r.id), campaign_id: String(r.campaign_id), lead_id: String(r.lead_id ?? ""), step: Number(r.sequence_position ?? r.step ?? 1), name: String(r.to_name ?? ""), was, reasons: ck.reasons });
      } else if (r.review_status === "blocked" && r.reviewed_by === "code checks") {
        // A block the code checks made, which the current rules no longer find (F38, F39): it needs a fresh look, not a send.
        const reasons = ["The rules changed and this draft no longer breaks a hard rule. Review it again, or mark it ready yourself.", ...ck.reasons];
        await sql`update emails set review_status = 'check', review_reasons = ${sql.json(reasons as never)}, reviewed_by = null, reviewed_at = null, rules_version = ${RULES_VERSION}
                  where id = ${String(r.id)} and status = 'drafted'`;
        Object.assign(r, { review_status: "check", review_reasons: reasons, reviewed_by: null, reviewed_at: null, rules_version: RULES_VERSION });
      } else {
        await sql`update emails set rules_version = ${RULES_VERSION} where id = ${String(r.id)} and status = 'drafted'`;
        r.rules_version = RULES_VERSION;
      }
    } catch (e) { if (isDbError(e)) throw e; /* one odd draft must not stop the list (a database error would have aborted the transaction anyway) */ }
  }
  return out;
}
