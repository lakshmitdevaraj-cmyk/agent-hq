// P2 chunk 11 (C1): Lakshmi's say-so as a record (migration 0018). `approval.create` is master only (lib/sql/access.ts),
// so only her own key, in the app, can make one. The Alcance client spends an approval with useApproval(): the right
// kind, not used, not expired, and covering every email asked for; it is marked used in the same statement, so it can
// never be spent twice.
import { CampaignError } from "../sql/campaigns.ts";
import type { Q } from "../sql/leads.ts";

type Row = Record<string, unknown>;
export type ApprovalKind = "send_plan" | "mark_ready";
export const APPROVAL_KINDS: ApprovalKind[] = ["send_plan", "mark_ready"];
const fail = (status: number, message: string, code: string): never => { throw new CampaignError(status, message, { code }); };
const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))] : []);

/** approval.create (master only): her say-so for exactly these emails, for 24 hours (or `hours`, 1 to 72). */
export async function createApproval(q: Q, p: Row, deps: { newId: () => string; approvedBy: string }): Promise<Row> {
  const kind = p.kind as ApprovalKind;
  if (!APPROVAL_KINDS.includes(kind)) fail(400, "kind must be send_plan or mark_ready", "bad_kind");
  const items = ids(p.email_ids);
  if (!items.length || items.length > 500) fail(400, "email_ids must list 1 to 500 emails", "bad_items");
  const hours = p.hours === undefined ? 24 : Number(p.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) fail(400, "hours must be a whole number from 1 to 72", "bad_hours");
  const found = await q`select count(*)::int as n from emails where id = any(${items})`;
  if (Number(found[0].n) !== items.length) fail(404, "Some of these emails do not exist", "unknown_email");
  const [r] = await q`insert into approvals (id, kind, items, note, approved_by, expires_at)
                      values (${deps.newId()}, ${kind}, ${q.json(items as never)}, ${p.note ? String(p.note).slice(0, 500) : null}, ${deps.approvedBy}, now() + make_interval(hours => ${hours}))
                      returning id, kind, items, approved_by, approved_at, expires_at`;
  return { ...r, approved_at: new Date(r.approved_at as string).toISOString(), expires_at: new Date(r.expires_at as string).toISOString() };
}

/**
 * Spends approval `approvalId` for `emailIds`: refused (409 not_approved) unless it is of `kind`, unused, not expired,
 * and lists every one of them. Marked used in the same statement.
 */
export async function useApproval(q: Q, kind: ApprovalKind, emailIds: string[], approvalId: unknown, usedBy: string | null): Promise<Row> {
  const want = ids(emailIds);
  if (!want.length) fail(400, "Nothing to do", "nothing");
  if (typeof approvalId !== "string" || !approvalId) fail(409, "This needs Lakshmi's approval first (approval.create in the app).", "not_approved");
  const [r] = await q`update approvals set used_at = now(), used_by = ${usedBy}
                      where id = ${approvalId as string} and kind = ${kind} and used_at is null and expires_at > now()
                        and items @> ${q.json(want as never)}
                      returning id, items`;
  if (!r) {
    const [why] = await q`select kind, used_at, expires_at > now() as live, items @> ${q.json(want as never)} as covers from approvals where id = ${approvalId as string}`;
    const reason = !why ? "there is no such approval" : why.kind !== kind ? `it is a ${String(why.kind)} approval` : why.used_at ? "it was already used"
      : !why.live ? "it has expired" : !why.covers ? "it does not cover every email asked for" : "it could not be used";
    fail(409, `Not approved: ${reason}. Ask Lakshmi to approve these emails.`, "not_approved");
  }
  return r;
}
