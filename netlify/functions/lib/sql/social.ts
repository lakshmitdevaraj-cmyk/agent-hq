// P2 chunk 8: social messages and touches on Postgres (used when DATA_BACKEND=sql; the Blobs code in command.ts stays
// the default until P5). Same answers as the old cases, built with the same lib/ helpers. Intended differences are
// listed in scripts/db/test/social-equiv.test.mjs:
//   - One social record is its steps in `social_messages` (one row per step); a write locks them, rebuilds the old
//     record, applies the old rule and writes the steps back, in one transaction.
//   - No re-check or re-stamp on read (F44 is P4): a list returns the stored verdict. Verify still runs the free checks.
//   - F30: a do-not-contact lead's open steps are skipped by the database (migration 0015); verify answers Blocked and
//     mark_sent refuses. F11: Facebook page gone (fb_checked = gone) closes the Facebook channel the same way.
//   - F15: record_hand takes an optional `part`: that open step of a written run is marked sent with her own text.
//   - F34: touch.delete removes only hand-recorded touches (`source = 'manual'`).
//   - The AI writer stays on Blobs until P4: social.write, social.plan and the batch actions answer 501.
//   - F41: offerText gives the social reviewer the same offer text as the email reviewer (for the P4 writer).
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";
import { checkSocialSeq } from "../socialseq.ts";
import { precheckSocial, partsToList, type SocialChannel, type SocialPart, type SocialType } from "../social.ts";
import { deriveTouches, summarizeTouches, touchFromSent, parseSentOn, type Touch, type TouchChannel } from "../touches.ts";
import { resolveInputs } from "../fourstep.ts";
import { dedupeReasons, mentionsRating } from "../messagerules.ts";
import { isTestReply, ownReplyEmailIds } from "../replies.ts";

type Row = Record<string, unknown>;
type Rec = Row & { id: string; campaign_id: string; lead_id: string; channel: SocialChannel; parts: SocialPart[]; type?: string; status?: string };

export type SocialAction = "outreach.social.list" | "outreach.social.update" | "outreach.social.verify" | "outreach.social.mark_sent"
  | "outreach.social.record_hand" | "outreach.social.delete" | "outreach.touch.delete" | "outreach.lead.touches" | "outreach.social.plan"
  | "outreach.social.write" | "outreach.social.batch.start" | "outreach.social.batch.status" | "outreach.social.batch.resume";
export const SOCIAL_ACTIONS: SocialAction[] = ["outreach.social.list", "outreach.social.update", "outreach.social.verify", "outreach.social.mark_sent",
  "outreach.social.record_hand", "outreach.social.delete", "outreach.touch.delete", "outreach.lead.touches", "outreach.social.plan",
  "outreach.social.write", "outreach.social.batch.start", "outreach.social.batch.status", "outreach.social.batch.resume"];
/** The actions that start or follow the AI writer in ai-background (Blobs until P4). */
export const AI_ACTIONS: SocialAction[] = ["outreach.social.write", "outreach.social.plan", "outreach.social.batch.start", "outreach.social.batch.status", "outreach.social.batch.resume"];
export const AI_501 = "Writing social messages moves to the runners in P4; on the SQL path this action is not available yet.";
export type SocialDeps = { newId: () => string; now?: () => Date };

/** The same text as command.ts DEFAULT_OFFER (a test checks they match). */
export const DEFAULT_OFFER = "We set up AI assistants that answer phone calls for home-service businesses, take the details and pass every enquiry to the owner.";

const CHANNELS = ["facebook", "instagram", "linkedin"];
const STEP: Record<string, Record<string, number>> = { facebook: { message: 1, follow_up: 2, last: 3 }, instagram: { message: 1, follow_up: 2, last: 3 }, linkedin: { note: 1, dm: 2, follow_up: 3, last: 4 } };
const RK = { ready: 0, check: 1, blocked: 2 } as const;
type RS = keyof typeof RK;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : undefined); };
const str = (v: unknown) => (typeof v === "string" ? v : "");

// ── Records ────────────────────────────────────────────────────────────────

/** Fields kept in columns (record or step); everything else of the record lives in each step's `data`. */
const COLUMN_FIELDS = new Set(["id", "campaign_id", "lead_id", "channel", "url", "parts", "status", "type", "review_status", "review_reasons", "written_by", "created_at", "updated_at", "sent_at"]);

/** The rows of one record (one per step) put back into the old record. */
export function socialRecord(rows: Row[]): Rec {
  const steps = [...rows].sort((a, b) => Number(a.step) - Number(b.step));
  const first = steps[0];
  const seq = first.type === "sequence";
  const allSent = steps.every((x) => x.status === "sent");
  const parts: SocialPart[] = steps.map((x) => {
    const p: SocialPart = { key: x.step_key as SocialPart["key"], label: str(x.label), text: str(x.body) };
    if (x.sent_at) p.sent_at = iso(x.sent_at);
    if (x.skipped) p.skipped = true;
    if (seq && x.review_status) p.review_status = x.review_status as RS;
    if (seq && Array.isArray(x.review_reasons)) p.review_reasons = x.review_reasons as string[];
    if (x.touch_id) p.touch_id = x.touch_id as string;
    return p;
  });
  const open = parts.filter((p) => !p.sent_at && !p.skipped);
  const review = seq
    ? (["blocked", "check", "ready"] as RS[]).find((s) => steps.some((x) => x.review_status === s)) ?? null
    : ((first.review_status as RS | null) ?? null);
  const reasons = seq
    ? open.filter((x) => x.review_reasons?.length).flatMap((x) => x.review_reasons!.map((r) => `${x.key === "message" ? "first" : x.key}: ${r}`))
    : ((first.review_reasons as string[] | null) ?? []);
  const data = (first.data as Row) ?? {};
  const rec: Rec = {
    ...data,
    id: first.record_id as string, campaign_id: first.campaign_id as string, lead_id: first.lead_id as string, channel: first.channel as SocialChannel,
    url: first.url ?? "", parts, status: !seq && allSent ? "sent" : "drafted", type: (first.type as string) ?? undefined,
    review_status: review, review_reasons: (data.review_reasons_saved as string[] | undefined) ?? reasons,
    written_by: first.written_model ?? first.written_by ?? data.written_by ?? null,
    created_at: iso(first.created_at), updated_at: iso(first.updated_at),
  };
  delete (rec as Row).review_reasons_saved;
  if (!seq && allSent) rec.sent_at = parts.map((p) => p.sent_at).filter(Boolean).sort().at(-1) ?? null;
  if (rec.type === undefined) delete (rec as Row).type;
  return rec;
}

/** The steps of one lead's message on one channel (not duplicates), locked when `lock` is set. */
async function stepRows(q: Q, cid: string, lid: string, channel: string, lock = false): Promise<Row[]> {
  return lock
    ? q`select * from social_messages where campaign_id = ${cid} and lead_id = ${lid} and channel = ${channel} and not is_duplicate order by step for update`
    : q`select * from social_messages where campaign_id = ${cid} and lead_id = ${lid} and channel = ${channel} and not is_duplicate order by step`;
}

/** Writes a whole record back as its steps (replacing what was there), in the caller's transaction. */
async function saveRecord(q: Q, rec: Rec): Promise<void> {
  const writer = (m: unknown) => (/^gemini/i.test(str(m)) ? "gemini" : /^claude/i.test(str(m)) ? "claude" : str(m) === "lakshmi" || str(m) === "you" ? "lakshmi" : null);
  const extra: Row = Object.fromEntries(Object.entries(rec).filter(([k]) => !COLUMN_FIELDS.has(k)));
  if (rec.type !== "sequence") extra.review_reasons_saved = rec.review_reasons ?? [];
  await q`delete from social_messages where campaign_id = ${rec.campaign_id} and lead_id = ${rec.lead_id} and channel = ${rec.channel} and not is_duplicate`;
  const seq = rec.type === "sequence";
  for (const [i, p] of rec.parts.entries()) {
    const sent = !!p.sent_at || (!seq && rec.status === "sent");
    const row = {
      id: `${rec.id}:${p.key}`, record_id: rec.id, blob_key: `${rec.campaign_id}/${rec.lead_id}/${rec.channel}`, campaign_id: rec.campaign_id, lead_id: rec.lead_id,
      channel: rec.channel, step_key: p.key, step: STEP[rec.channel]?.[p.key] ?? i + 1, url: str(rec.url) || null, label: p.label ?? null, body: p.text ?? null,
      status: sent ? "sent" : p.skipped ? "skipped" : "drafted", type: rec.type ?? null,
      review_status: (seq ? p.review_status : (rec.review_status as RS | null)) ?? null,
      review_reasons: q.json((seq ? p.review_reasons : (rec.review_reasons as string[])) ?? null),
      written_by: writer(rec.written_by), written_model: str(rec.written_by) || null,
      sent_at: p.sent_at ?? (sent ? (rec.sent_at as string | null) ?? null : null), skipped: p.skipped === true, touch_id: p.touch_id ?? null, is_duplicate: false,
      created_at: (rec.created_at as string | null) ?? null, updated_at: (rec.updated_at as string | null) ?? null,
      data: q.json({ ...extra, ...((p as Row).sent_text_differs ? { sent_text_differs: true } : {}) }),
    };
    await q`insert into social_messages ${q(row)}`;
  }
}

async function readRecord(q: Q, cid: string, lid: string, channel: string, lock = false): Promise<Rec | null> {
  const rows = await stepRows(q, cid, lid, channel, lock);
  return rows.length ? socialRecord(rows) : null;
}

async function settings(q: Q): Promise<Row> {
  const [s] = await q`select data from outreach_settings where key = 'settings'`;
  return (s?.data as Row) ?? {};
}

// ── Stops (F30, F11) ───────────────────────────────────────────────────────

export type SocialStop = { code: "do_not_contact" | "page_gone"; reason: string };
/** Why a lead's channel is closed for social messages, or null. A bounce stops email only (F7), never a social channel. */
export function socialStop(lead: Row | null | undefined, channel: string): SocialStop | null {
  if (!lead) return null;
  if (lead.stop_state === "do_not_contact" || lead.do_not_contact === true) return { code: "do_not_contact", reason: "Do not contact: this lead asked not to be contacted." };
  const fb = ((lead.data as Row | null)?.fb_checked as Row | null | undefined) ?? null;
  if (channel === "facebook" && fb?.result === "gone") return { code: "page_gone", reason: "Facebook page gone: this channel is closed for this lead." };
  return null;
}

async function leadRow(q: Q, cid: string, lid: string): Promise<Row | null> {
  const [l] = await q`select id, campaign_id, name, stop_state, do_not_contact, merged_into, data from leads where id = ${lid} and campaign_id = ${cid}`;
  return l ?? null;
}

// ── Free checks (the twin of verifySocialRecord) ───────────────────────────

/** An email to this lead or a message on another channel already states the rating (as leadRatingUsed). */
async function ratingElsewhere(q: Q, cid: string, lid: string, channel: string): Promise<boolean> {
  const rows = await q`select body_text as t from emails where campaign_id = ${cid} and lead_id = ${lid}
                       union all select body as t from social_messages where campaign_id = ${cid} and lead_id = ${lid} and channel <> ${channel} and not is_duplicate`;
  return rows.some((r) => mentionsRating(str(r.t)));
}

const partsMap = (parts: SocialPart[]): Record<string, string> => Object.fromEntries(parts.map((p) => [p.key, p.text]));
const worst = (parts: SocialPart[]): RS => parts.filter((x) => !x.sent_at && !x.skipped).reduce((w, x) => (x.review_status && RK[x.review_status] > RK[w] ? x.review_status : w), "ready" as RS);

async function freeChecks(q: Q, rec: Rec): Promise<Array<{ key: string; label: string; reasons: string[] }>> {
  if (rec.type !== "sequence" || rec.status === "sent") return [];
  const inp = resolveInputs((await settings(q)) as Parameters<typeof resolveInputs>[0], "");
  const checks = checkSocialSeq(rec.channel, partsMap(rec.parts), inp, { ratingElsewhere: await ratingElsewhere(q, rec.campaign_id, rec.lead_id, rec.channel) });
  const out: Array<{ key: string; label: string; reasons: string[] }> = [];
  for (const p of rec.parts) {
    if (p.sent_at || p.skipped) continue;
    const ck = checks.find((x) => x.key === p.key);
    if (ck && ck.hits.some((h) => h.level === "hard")) out.push({ key: p.key, label: p.label, reasons: ck.reasons });
  }
  return out;
}

/** Marks the steps the free checks block as Blocked and saves the record when that changes it (as verifySocialRecord). */
async function verifyAndSave(q: Q, rec: Rec): Promise<{ rec: Rec; blocked: Array<{ key: string; label: string; reasons: string[] }> }> {
  const blocked = await freeChecks(q, rec);
  const hit = new Map(blocked.map((b) => [b.key, b]));
  let changed = false;
  const parts = rec.parts.map((p) => {
    const b = hit.get(p.key);
    if (!b || p.review_status === "blocked") return p;
    changed = true;
    return { ...p, review_status: "blocked" as const, review_reasons: b.reasons };
  });
  if (!changed) return { rec, blocked };
  const next = { ...rec, parts, review_status: worst(parts) } as Rec;
  await saveRecord(q, next);
  return { rec: socialRecord(await stepRows(q, rec.campaign_id, rec.lead_id, rec.channel)), blocked };
}

// ── Touches ────────────────────────────────────────────────────────────────

const touchOf = (t: Row): Touch & { snapshot?: Rec } => ({ ...((t.data as Row) ?? {}), id: t.id as string, lead_id: t.lead_id as string, campaign_id: (t.campaign_id as string | null) ?? null, channel: t.channel as TouchChannel,
  kind: t.kind as Touch["kind"], sent_at: iso(t.sent_at)!, text: str(t.body), subject: (t.subject as string | null) ?? null, source: t.source as Touch["source"], ...(t.ref ? { ref: t.ref as string } : {}) });

async function storedTouches(q: Q, lid: string): Promise<Array<Touch & { snapshot?: Rec }>> {
  return (await q`select * from touches where lead_id = ${lid} order by sent_at, id`).map(touchOf);
}

async function writeTouch(q: Q, t: Touch & { snapshot?: Rec }): Promise<void> {
  const { id, lead_id, campaign_id, channel, kind, sent_at, text, subject, source, ref, snapshot } = t;
  await q`insert into touches (id, blob_key, lead_id, campaign_id, channel, kind, sent_at, subject, body, source, ref, data)
          values (${id}, ${`${lead_id}/${sent_at}-${id}`}, ${lead_id}, ${campaign_id}, ${channel}, ${kind}, ${sent_at}, ${subject ?? null}, ${text}, ${source}, ${ref ?? null}, ${q.json(snapshot ? { snapshot } : {})})`;
}

/** A lead's full contact history (oldest first) and summary: the twin of leadTouchState. */
export async function leadTouchState(q: Q, cid: string, lid: string): Promise<{ touches: Touch[]; summary: ReturnType<typeof summarizeTouches> }> {
  const [r] = await q`select
      (select coalesce(json_agg(x), '[]') from (select id, lead_id, status, sent_at, created_at, step as sequence_position, subject, body_text from emails where campaign_id = ${cid} and lead_id = ${lid} and not is_duplicate) x) as emails,
      (select coalesce(json_agg(x), '[]') from (select * from social_messages where campaign_id = ${cid} and lead_id = ${lid} and not is_duplicate) x) as steps,
      (select coalesce(json_agg(x), '[]') from (select * from touches where lead_id = ${lid}) x) as touches,
      (select coalesce(json_agg(x), '[]') from (select lead_id, original_email_id, is_test, received_at, from_address as "from" from replies
         where lead_id = ${lid} or original_email_id in (select id from emails where lead_id = ${lid})) x) as replies`;
  const t = (v: unknown) => (typeof v === "string" ? new Date(v).toISOString() : (v as string | undefined));
  const emails = (r.emails as Row[]).map((e) => ({ ...e, sent_at: t(e.sent_at) ?? undefined, created_at: t(e.created_at) ?? undefined, subject: (e.subject as string) ?? undefined, body_text: (e.body_text as string) ?? undefined })) as Parameters<typeof deriveTouches>[0]["emails"];
  const groups = new Map<string, Row[]>();
  for (const s of r.steps as Row[]) (groups.get(s.record_id as string) ?? groups.set(s.record_id as string, []).get(s.record_id as string)!).push({ ...s, sent_at: t(s.sent_at) ?? null });
  const socials = [...groups.values()].map(socialRecord) as unknown as Parameters<typeof deriveTouches>[0]["socials"];
  const stored = (r.touches as Row[]).map((x) => touchOf({ ...x, sent_at: t(x.sent_at) }));
  const replies = (r.replies as Row[]).map((x) => ({ ...x, received_at: t(x.received_at) })) as Array<{ lead_id?: string | null; original_email_id?: string | null; is_test?: boolean; received_at?: string; from?: string | null }>;
  const ownOnly = ownReplyEmailIds(replies.filter((x) => x.original_email_id));
  const replied = (emails as Row[]).some((e) => e.status === "replied" && !ownOnly.has(e.id as string)) || replies.some((x) => x.lead_id === lid && !isTestReply(x));
  const touches = deriveTouches({ lead_id: lid, campaign_id: cid, emails, socials, stored });
  const lastReply = replies.filter((x) => x.lead_id === lid && !isTestReply(x) && x.received_at).map((x) => x.received_at as string).sort().pop() ?? null;
  return { touches: touches.map((x) => { const c = { ...x }; delete (c as { snapshot?: unknown }).snapshot; return c; }), summary: summarizeTouches(touches, replied, { at: lastReply, via: "email" }) };
}

// ── F41 ────────────────────────────────────────────────────────────────────

/** The offer text the reviewer gets: the campaign's, else the Settings one, else the default (as command.ts ~2948). */
export async function offerText(q: Q, cid: string): Promise<string> {
  const [r] = await q`select c.data->>'default_sender_offer' as c_offer, (select data->>'default_sender_offer' from outreach_settings where key = 'settings') as s_offer from campaigns c where c.id = ${cid}`;
  return str(r?.c_offer).trim() || str(r?.s_offer).trim() || DEFAULT_OFFER;
}

// ── Actions ────────────────────────────────────────────────────────────────

function need(p: Row, keys: string[], message: string): void {
  if (keys.some((k) => !p[k])) fail(400, message);
}

export async function runSocialAction(q: Q, action: SocialAction, p: Row, deps: SocialDeps): Promise<unknown> {
  const nowD = deps.now?.() ?? new Date();
  const now = nowD.toISOString();
  if (AI_ACTIONS.includes(action)) return fail(501, AI_501, "moves_to_p4");
  switch (action) {
    case "outreach.social.list": {
      if (!p.campaign_id) fail(400, "campaign_id required");
      const rows = p.lead_id
        ? await q`select s.* from social_messages s join leads l on l.id = s.lead_id where s.campaign_id = ${p.campaign_id as string} and s.lead_id = ${p.lead_id as string} and l.merged_into is null and not s.is_duplicate order by s.lead_id, s.channel, s.step`
        : await q`select s.* from social_messages s join leads l on l.id = s.lead_id where s.campaign_id = ${p.campaign_id as string} and l.merged_into is null and not s.is_duplicate order by s.lead_id, s.channel, s.step`;
      const by = new Map<string, Row[]>();
      for (const r of rows) (by.get(r.record_id as string) ?? by.set(r.record_id as string, []).get(r.record_id as string)!).push(r);
      return [...by.values()].map(socialRecord);
    }

    case "outreach.social.update": {
      const parts = p.parts as Record<string, unknown> | undefined;
      if (!p.campaign_id || !p.lead_id || !p.channel || !parts) fail(400, "campaign_id, lead_id, channel and parts required");
      if (!CHANNELS.includes(p.channel as string)) fail(400, "unknown channel");
      const rec = await readRecord(q, p.campaign_id as string, p.lead_id as string, p.channel as string, true);
      if (!rec) return fail(404, "message not found");
      const given = Object.fromEntries(Object.entries(parts!).map(([k, v]) => [k, String(v ?? "")]));
      if (rec.type === "sequence") {
        const inp = resolveInputs((await settings(q)) as Parameters<typeof resolveInputs>[0], "");
        const texts = { ...partsMap(rec.parts), ...given };
        const checks = checkSocialSeq(rec.channel, texts, inp, { ratingElsewhere: await ratingElsewhere(q, rec.campaign_id, rec.lead_id, rec.channel) });
        const nextParts: SocialPart[] = rec.parts.map((p0) => {
          if (!(p0.key in given) || p0.sent_at) return p0; // a step already sent by hand is history and is not rewritten
          const ck = checks.find((x) => x.key === p0.key)!;
          const st = ck.status === "ready" ? "check" : ck.status;
          return { ...p0, text: String(given[p0.key] ?? "").trim(), review_status: st, review_reasons: dedupeReasons(["Edited by you: not reviewed by the AI.", ...ck.reasons]) };
        });
        const saved = { ...rec, parts: nextParts, review_status: worst(nextParts), reviewed_by: "you", updated_at: now } as Rec;
        await saveRecord(q, saved);
        return socialRecord(await stepRows(q, rec.campaign_id, rec.lead_id, rec.channel));
      }
      const type = (rec.type ?? "first") as SocialType;
      const next = partsToList(rec.channel, { ...partsMap(rec.parts), ...given }, type);
      const found = precheckSocial(rec.channel, partsMap(next), { type, factCount: (rec.draft_facts as unknown[] | undefined)?.length ?? 0, factUsed: rec.fact_used as number | null | undefined } as Parameters<typeof precheckSocial>[2]);
      const saved = { ...rec, parts: next, review_status: "check", review_reasons: dedupeReasons(["Edited by you: not reviewed by the AI.", ...found.map((f) => `Code check: ${f}`)]), reviewed_by: "you", updated_at: now } as Rec;
      await saveRecord(q, saved);
      return socialRecord(await stepRows(q, rec.campaign_id, rec.lead_id, rec.channel));
    }

    case "outreach.social.verify": {
      need(p, ["campaign_id", "lead_id", "channel"], "campaign_id, lead_id and channel required");
      const rec = await readRecord(q, p.campaign_id as string, p.lead_id as string, p.channel as string, true);
      if (!rec) return fail(404, "message not found");
      const stop = socialStop(await leadRow(q, rec.campaign_id, rec.lead_id), rec.channel);
      if (stop) return { blocked: true, reasons: [stop.reason], label: (p.part ? rec.parts.find((x) => x.key === p.part)?.label : rec.parts[0]?.label) ?? null };
      const v = await verifyAndSave(q, rec);
      const hit = p.part ? v.blocked.find((b) => b.key === p.part) : v.blocked[0];
      return { blocked: !!hit, reasons: hit?.reasons ?? [], label: hit?.label ?? null };
    }

    case "outreach.social.mark_sent": {
      need(p, ["campaign_id", "lead_id", "channel"], "campaign_id, lead_id and channel required");
      const cid = p.campaign_id as string, lid = p.lead_id as string, channel = p.channel as string;
      if (!CHANNELS.includes(channel)) fail(400, "unknown channel");
      const rec = await readRecord(q, cid, lid, channel, true);
      const part = p.part as string | undefined, touchId = p.touch_id as string | undefined;
      if (p.sent !== false) {
        const stop = socialStop(await leadRow(q, cid, lid), channel);
        if (stop) fail(409, `Cannot mark this as sent. ${stop.reason}`, stop.code);
      }
      const stored = await storedTouches(q, lid);
      if (part) {
        const base = rec ?? (touchId ? stored.find((t) => t.id === touchId)?.snapshot ?? null : null);
        if (!base || base.type !== "sequence") return fail(404, "message not found");
        const idx = base.parts.findIndex((x) => x.key === part);
        if (idx < 0) fail(400, "unknown step");
        if (p.sent === false) {
          const tid = touchId ?? base.parts[idx].touch_id ?? null;
          if (tid) await q`delete from touches where id = ${tid} and lead_id = ${lid}`;
          const parts2 = base.parts.map((x, i) => (i === idx ? { ...x, sent_at: null, touch_id: null } : x));
          await saveRecord(q, { ...base, parts: parts2, status: "drafted", updated_at: now } as Rec);
          return { undone: true, ...(await leadTouchState(q, cid, lid)) };
        }
        if (!rec) return fail(404, "message not found");
        if (rec.parts[idx].sent_at) return { already: true, ...(await leadTouchState(q, cid, lid)) };
        const bad = (await freeChecks(q, rec)).find((b) => b.key === part);
        if (bad) fail(400, `Cannot mark this as sent: it is Blocked by the free checks (${bad.reasons.join(" | ")}). Edit it first.`);
        const atP = parseSentOn(p.sent_on as string | undefined, nowD);
        if (!atP) return fail(400, "That date is not valid or is in the future.");
        const before = await leadTouchState(q, cid, lid);
        const had = before.touches.some((t) => t.channel === channel && t.sent_at < atP);
        const tp = { ...touchFromSent({ id: deps.newId(), lead_id: lid, campaign_id: cid, channel: channel as TouchChannel, kind: had ? "follow_up" : "first", sent_at: atP, text: rec.parts[idx].text, source: "hq" }), snapshot: rec };
        await writeTouch(q, tp);
        const parts3 = rec.parts.map((x, i) => (i === idx ? { ...x, sent_at: atP, touch_id: tp.id } : x));
        if (parts3.every((x) => x.sent_at || x.skipped)) await q`delete from social_messages where campaign_id = ${cid} and lead_id = ${lid} and channel = ${channel} and not is_duplicate`;
        else await saveRecord(q, { ...rec, parts: parts3, updated_at: now } as Rec);
        await logActivity(q, `Marked ${channel} ${part} as sent (${atP.slice(0, 10)}) for lead ${lid}`, deps);
        return { touch_id: tp.id, ...(await leadTouchState(q, cid, lid)) };
      }
      if (p.sent === false) {
        const tb = touchId ? stored.find((t) => t.id === touchId) : null;
        if (tb) {
          await q`delete from touches where id = ${tb.id} and lead_id = ${lid}`;
          let restored = false;
          if (!rec && tb.snapshot) { await saveRecord(q, { ...tb.snapshot, status: "drafted", sent_at: null, updated_at: now } as Rec); restored = true; }
          await logActivity(q, `Undid a ${channel} message marked as sent for lead ${lid}`, deps);
          return { undone: true, restored, ...(await leadTouchState(q, cid, lid)) };
        }
        if (!rec) return fail(404, "message not found");
        await saveRecord(q, { ...rec, status: "drafted", sent_at: null, parts: rec.parts.map((x) => ({ ...x, sent_at: null })), updated_at: now } as Rec);
        return { undone: true, restored: true, ...(await leadTouchState(q, cid, lid)) };
      }
      if (!rec) return fail(404, "message not found");
      if (rec.status === "sent") return { already: true, ...(await leadTouchState(q, cid, lid)) };
      const at = parseSentOn(p.sent_on as string | undefined, nowD);
      if (!at) return fail(400, "That date is not valid or is in the future.");
      const text = rec.parts.map((x) => x.text).filter(Boolean).join("\n\n");
      const touch = { ...touchFromSent({ id: deps.newId(), lead_id: lid, campaign_id: cid, channel: channel as TouchChannel, kind: rec.type && rec.type !== "first" ? "follow_up" : "first", sent_at: at, text, source: "hq" }), snapshot: rec };
      await writeTouch(q, touch);
      await q`delete from social_messages where campaign_id = ${cid} and lead_id = ${lid} and channel = ${channel} and not is_duplicate`;
      await logActivity(q, `Marked ${channel} message as sent (${at.slice(0, 10)}) for lead ${lid}`, deps);
      return { touch_id: touch.id, ...(await leadTouchState(q, cid, lid)) };
    }

    case "outreach.social.record_hand": {
      need(p, ["campaign_id", "lead_id", "channel"], "campaign_id, lead_id and channel required");
      const cid = p.campaign_id as string, lid = p.lead_id as string, channel = p.channel as string;
      if (!["email", ...CHANNELS].includes(channel)) fail(400, "unknown channel");
      const body = String(p.text ?? "").trim();
      if (!body) fail(400, "Paste or type what you sent.");
      if (body.length > 5000) fail(400, "That message is too long (5000 characters at most).");
      const at = parseSentOn(p.sent_on as string | undefined, nowD);
      if (!at) return fail(400, "That date is not valid or is in the future.");
      const before = await leadTouchState(q, cid, lid);
      const had = before.touches.some((t) => t.channel === channel && t.sent_at < at); // earlier touches decide first or follow-up
      const k = p.kind === "first" || p.kind === "follow_up" ? p.kind : had ? "follow_up" : "first";
      const touch = touchFromSent({ id: deps.newId(), lead_id: lid, campaign_id: cid, channel: channel as TouchChannel, kind: k as Touch["kind"], sent_at: at, text: body, source: "manual" });
      await writeTouch(q, touch);
      // F15: "sent, different text" against an open step of a written run: that step is done, the touch keeps her own text.
      if (typeof p.part === "string" && channel !== "email") {
        const rec = await readRecord(q, cid, lid, channel, true);
        const idx = rec?.type === "sequence" ? rec.parts.findIndex((x) => x.key === p.part && !x.sent_at) : -1;
        if (rec && idx >= 0) {
          const parts = rec.parts.map((x, i) => (i === idx ? { ...x, sent_at: at, touch_id: touch.id, sent_text_differs: true } : x));
          if (parts.every((x) => x.sent_at || x.skipped)) await q`delete from social_messages where campaign_id = ${cid} and lead_id = ${lid} and channel = ${channel} and not is_duplicate`;
          else await saveRecord(q, { ...rec, parts, updated_at: now } as Rec);
        }
      }
      await logActivity(q, `Recorded a ${channel} message sent by hand (${at.slice(0, 10)}) for lead ${lid}`, deps);
      return { touch_id: touch.id, ...(await leadTouchState(q, cid, lid)) };
    }

    case "outreach.social.delete": {
      need(p, ["campaign_id", "lead_id", "channel"], "campaign_id, lead_id and channel required");
      await q`delete from social_messages where campaign_id = ${p.campaign_id as string} and lead_id = ${p.lead_id as string} and channel = ${p.channel as string} and sent_at is null and status <> 'sent'`;
      return { deleted: true };
    }

    case "outreach.touch.delete": {
      need(p, ["lead_id", "touch_id"], "lead_id and touch_id required");
      const lid = p.lead_id as string, tid = p.touch_id as string;
      const [t] = await q`select id, campaign_id, source from touches where id = ${tid} and lead_id = ${lid}`;
      if (!t) {
        // An email or a sent social step is history worked out from its own row: it is never deleted here.
        const [e] = /^email-/.test(tid) ? await q`select 1 from emails where id = ${tid.slice(6)} and lead_id = ${lid}` : [];
        if (e || /^social-/.test(tid)) fail(409, "Only a message you recorded by hand can be deleted. Emails and messages HQ wrote stay in the history.", "not_hand_recorded");
        return fail(404, "touch not found");
      }
      if (t.source !== "manual") fail(409, "Only a message you recorded by hand can be deleted. Use Undo on the message to take back \"I sent this\".", "not_hand_recorded");
      await q`delete from touches where id = ${tid} and lead_id = ${lid}`;
      return { deleted: true, ...(t.campaign_id ? await leadTouchState(q, t.campaign_id as string, lid) : {}) };
    }

    case "outreach.lead.touches": {
      need(p, ["campaign_id", "lead_id"], "campaign_id and lead_id required");
      return leadTouchState(q, p.campaign_id as string, p.lead_id as string);
    }
  }
  return fail(400, `Unknown action: ${action}`);
}

/** A History entry, as logActivity writes it (category outreach). */
async function logActivity(q: Q, summary: string, deps: SocialDeps): Promise<void> {
  const id = deps.newId(), at = (deps.now?.() ?? new Date()).toISOString();
  await q`insert into activity (id, blob_key, agent_id, category, summary, details, created_at) values (${id}, ${`${at}-${id}`}, null, 'outreach', ${summary}, '{}', ${at})`;
}
