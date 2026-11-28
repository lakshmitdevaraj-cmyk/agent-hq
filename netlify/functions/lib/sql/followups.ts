// P2 chunk 8: follow-ups on Postgres (dueFollowUps; used when DATA_BACKEND=sql, the Blobs code in command.ts stays the
// default until P5). Rows are worked out by the same nextFollowUp as today. Intended differences (listed in
// scripts/db/test/social-equiv.test.mjs):
//   - F8: a lead's stop comes from its `stop_state` (do-not-contact, replied; an opt-out is do-not-contact). F7: bounced
//     stops email only. F11: Facebook page gone (fb_checked = gone) leaves the Facebook row out.
//   - F10: a worked-out due date goes through next_working_day(date, the campaign's country) in one statement, so it never
//     falls on a weekend, a holiday or a blackout date. A date she moved by hand is kept as she typed it.
//   - No re-check of drafts on read (F44 is P4).
//   - The worked-out rows are written to `follow_ups` (the campaign list's followups_due filter reads it), by the list and
//     by every write here for its lead.
//   - F3: followups.update changes only its own step (one jsonb_set), takes an optional `if_updated_at` (a newer stored
//     change wins: 409 stale) and never touches the lead's stop.
//   - followups.replied also sets the lead's stop_state (replied by hand) and Undo puts the old one back.
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";
import { nextFollowUp, countDue, gapsOrDefault, bucketOf, daysBetween, type FollowRow, type FollowStepIn, type FollowState, type StoppedReason } from "../followups.ts";
import { channelsFor } from "../social.ts";

type Row = Record<string, unknown>;
export type FollowupAction = "followups.list" | "followups.update" | "followups.replied" | "followups.linkedin";
export const FOLLOWUP_ACTIONS: FollowupAction[] = ["followups.list", "followups.update", "followups.replied", "followups.linkedin"];
export type FollowDeps = { now?: () => Date };

const CHANNELS = ["email", "facebook", "instagram", "linkedin"];
const iso = (v: unknown): string | null => (typeof v === "string" ? new Date(v).toISOString() : v instanceof Date ? v.toISOString() : null);
const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : undefined); };
const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
const dayIn = (tz: string, d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz && validTz(tz) ? tz : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function stateOf(r: Row | undefined): FollowState | undefined {
  if (!r) return undefined;
  return { ...((r.data as Row) ?? {}), lead_id: r.lead_id as string, channel: r.channel as string, steps: (r.steps as FollowState["steps"]) ?? {}, accepted_at: iso(r.accepted_at), withdrawn_at: iso(r.withdrawn_at), replied_by_hand: iso(r.replied_by_hand), updated_at: iso(r.updated_at) ?? undefined };
}

/** The follow-up rows, worked out from SQL. `leadIds` limits them to some leads (for a write's refresh). */
async function workOut(q: Q, now: Date, leadIds?: string[]): Promise<{ today: string; rows: Array<FollowRow & Row>; settings: Row }> {
  const all = !leadIds;
  const ids = leadIds ?? [];
  const [r] = await q`select
      (select data from outreach_settings where key = 'settings') as settings,
      (select coalesce(json_agg(x), '[]') from (select l.id, l.campaign_id, l.name, l.stop_state, l.data->'fb_checked'->>'result' as fb, c.country, c.name as campaign_name
         from leads l left join campaigns c on c.id = l.campaign_id where l.merged_into is null and not l.excluded and (${all} or l.id = any(${ids}))) x) as leads,
      (select coalesce(json_agg(x order by x.lead_id, x.step), '[]') from (select id, lead_id, campaign_id, step, status, sent_at, body_text, review_status from emails
         where framework = 'four-step' and not is_duplicate and (${all} or lead_id = any(${ids}))) x) as emails,
      (select coalesce(json_agg(x order by x.lead_id, x.channel, x.step), '[]') from (select lead_id, campaign_id, channel, step, step_key, label, body, sent_at, review_status from social_messages
         where type = 'sequence' and not is_duplicate and (${all} or lead_id = any(${ids}))) x) as steps,
      (select coalesce(json_agg(x), '[]') from (select * from follow_up_state where ${all} or lead_id = any(${ids})) x) as states,
      (select coalesce(json_agg(x), '[]') from (select lead_id, kind, url from lead_social_links where ${all} or lead_id = any(${ids})) x) as links`;
  const settings = (r.settings as Row) ?? {};
  const today = dayIn(String(settings.time_zone ?? "").trim(), now);
  const leads = new Map((r.leads as Row[]).map((l) => [l.id as string, l]));
  const states = new Map((r.states as Row[]).map((s) => [`${s.lead_id}/${s.channel}`, s]));
  const links = new Map<string, Row>();
  for (const k of r.links as Row[]) links.set(k.lead_id as string, { ...(links.get(k.lead_id as string) ?? {}), [k.kind as string]: k.url });
  const stopped = (l: Row, channel: string): StoppedReason | null => {
    const s = l.stop_state as string;
    if (s === "do_not_contact" || s === "replied") return s;
    if (s === "bounced" && channel === "email") return "bounced" as StoppedReason; // F7: a bounce stops email only
    return null;
  };
  const gE = gapsOrDefault(settings.follow_up_gaps_email), gS = gapsOrDefault(settings.follow_up_gaps_social);
  const rows: Array<FollowRow & Row> = [];
  const byLead = new Map<string, Row[]>();
  for (const e of r.emails as Row[]) (byLead.get(e.lead_id as string) ?? byLead.set(e.lead_id as string, []).get(e.lead_id as string)!).push(e);
  for (const [lid, list] of byLead) {
    const lead = leads.get(lid);
    if (!lead) continue;
    const steps: FollowStepIn[] = list.map((e) => ({ key: String(e.step), label: `Email ${e.step}`, text: String(e.body_text ?? ""), sent_at: e.status && e.status !== "drafted" && e.status !== "failed" ? iso(e.sent_at) : null, status: (e.review_status as FollowStepIn["status"]) ?? null, id: e.id as string }));
    const x = nextFollowUp({ lead_id: lid, campaign_id: String(lead.campaign_id), name: String(lead.name ?? lid), channel: "email", steps, state: stateOf(states.get(`${lid}/email`)), gaps: gE, stopped: stopped(lead, "email"), today });
    if (x) rows.push({ ...x, country: lead.country });
  }
  const bySeq = new Map<string, Row[]>();
  for (const s of r.steps as Row[]) { const k = `${s.lead_id}/${s.channel}`; (bySeq.get(k) ?? bySeq.set(k, []).get(k)!).push(s); }
  for (const [k, list] of bySeq) {
    const [lid, channel] = k.split("/");
    const lead = leads.get(lid);
    if (!lead) continue;
    if (channel === "facebook" && lead.fb === "gone") continue; // F11: the page is gone, so no Facebook due date
    const steps: FollowStepIn[] = list.map((s) => ({ key: s.step_key as string, label: (s.label as string) ?? (s.step_key as string), text: String(s.body ?? ""), sent_at: iso(s.sent_at), status: (s.review_status as FollowStepIn["status"]) ?? null }));
    const x = nextFollowUp({ lead_id: lid, campaign_id: String(lead.campaign_id), name: String(lead.name ?? lid), channel: channel as FollowRow["channel"], steps, state: stateOf(states.get(k)), gaps: gS, stopped: stopped(lead, channel), today });
    if (!x) continue;
    // The page link is the lead's own saved page for this channel, never one built from an id; hidden when there is none.
    const own = channelsFor({ social: (links.get(lid) ?? {}) as never }).find((c) => c.channel === channel)?.url ?? "";
    rows.push({ ...x, country: lead.country, page_url: /^https?:\/\//i.test(own.trim()) ? own.trim() : "" });
  }
  // F10: worked-out due dates skip weekends, holidays and blackout dates (one statement for every row).
  const toRoll = rows.filter((x) => x.due_date && !x.moved);
  if (toRoll.length) {
    const days = toRoll.map((x) => x.due_date as string), countries = toRoll.map((x) => String(x.country ?? "US"));
    const rolled = await q`select d::text as d, c, next_working_day(d, known_country(c))::text as w from unnest(${days}::date[], ${countries}::text[]) as t(d, c)`;
    const m = new Map(rolled.map((x) => [`${x.d}/${x.c}`, x.w as string]));
    for (const x of toRoll) {
      const w = m.get(`${x.due_date}/${String(x.country ?? "US")}`);
      if (w && w !== x.due_date) { x.due_date = w; x.bucket = bucketOf(w, today); x.days_late = Math.max(0, daysBetween(w, today)); }
    }
  }
  const handIds = new Set((r.states as Row[]).filter((s) => s.channel === "all" && s.replied_by_hand).map((s) => s.lead_id as string));
  for (const x of rows) { x.by_hand = handIds.has(x.lead_id); x.campaign_name = (leads.get(x.lead_id)?.campaign_name as string) ?? x.campaign_id; x.page_url = (x.page_url as string) || null; delete x.country; }
  return { today, rows, settings };
}

/** Rewrites `follow_ups` for these leads (all when omitted) from the worked-out rows. */
export async function refreshFollowUps(q: Q, leadIds?: string[], now: Date = new Date(), worked?: Array<FollowRow & Row>): Promise<number> {
  const rows = worked ?? (await workOut(q, now, leadIds)).rows;
  if (leadIds) await q`delete from follow_ups where lead_id = any(${leadIds})`;
  else await q`delete from follow_ups`;
  const ins = rows.map((x) => ({ lead_id: x.lead_id, channel: x.channel, campaign_id: x.campaign_id, step_key: x.step_key, position: x.position, due_date: x.due_date, stopped_reason: x.stopped_reason ?? null, email_id: x.email_id ?? null, computed_at: now }));
  for (let i = 0; i < ins.length; i += 500) await q`insert into follow_ups ${q(ins.slice(i, i + 500))}`;
  return ins.length;
}

/**
 * Run E (chunk 8 open point): refreshes `follow_ups` for the leads a send, reply, bounce, complaint or form post just
 * changed, so the campaign list's follow-up filter is current without opening the follow-ups list. `emailKeys` adds
 * every lead whose current address is one of them (a bounce or opt-out stops the address, not only one lead).
 */
export async function refreshForLeads(q: Q, o: { leadIds?: Array<string | null | undefined>; emailKeys?: Array<string | null | undefined> }, now: Date = new Date()): Promise<number> {
  const ids = new Set((o.leadIds ?? []).filter((x): x is string => typeof x === "string" && x !== ""));
  const keys = [...new Set((o.emailKeys ?? []).filter((x): x is string => typeof x === "string" && x !== "").map((x) => x.trim().toLowerCase()))];
  if (keys.length) for (const r of await q`select id from leads where email_key = any(${keys})`) ids.add(String(r.id));
  if (!ids.size) return 0;
  return refreshFollowUps(q, [...ids], now);
}

async function list(q: Q, now: Date): Promise<Row> {
  const t0 = Date.now();
  const { today, rows, settings } = await workOut(q, now);
  await refreshFollowUps(q, undefined, now, rows);
  const live = rows.filter((x) => x.bucket !== "stopped");
  live.sort((a, b) => (a.bucket === "waiting" ? 1 : 0) - (b.bucket === "waiting" ? 1 : 0) || String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")));
  const out = [...live, ...rows.filter((x) => x.bucket === "stopped")];
  return { today, rows: out, counts: countDue(rows), postal_address_set: !!String(settings.postal_address ?? "").trim(), ms: Date.now() - t0 };
}

export async function runFollowupAction(q: Q, action: FollowupAction, p: Row, deps: FollowDeps): Promise<unknown> {
  const nowD = deps.now?.() ?? new Date();
  const now = nowD.toISOString();
  switch (action) {
    case "followups.list":
      return list(q, nowD);

    case "followups.update": {
      const { lead_id, channel, step_key, op, value } = p as { lead_id?: string; channel?: string; step_key?: string; op?: string; value?: unknown };
      if (!lead_id || !channel || !step_key || !op) return fail(400, "lead_id, channel, step_key and op required");
      if (!CHANNELS.includes(channel)) fail(400, "unknown channel");
      let warn: Row = {};
      const [cur] = await q`select steps, updated_at from follow_up_state where lead_id = ${lead_id} and channel = ${channel} for update`;
      if (p.if_updated_at && cur?.updated_at && new Date(cur.updated_at as string) > new Date(String(p.if_updated_at))) fail(409, "This follow-up was changed since you opened it. Reload and try again.", "stale");
      const stepNow: Row = { ...(((cur?.steps as Row) ?? {})[step_key] as Row ?? {}) };
      if (op === "skip") stepNow.skipped = true;
      else if (op === "unskip") delete stepNow.skipped;
      else if (op === "note") stepNow.note = String(value ?? "").slice(0, 300);
      else if (op === "move") {
        const d = String(value ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) return fail(400, "That date is not valid.");
        stepNow.moved_to = d;
        const [w] = await q`select next_working_day(${d}::date, known_country((select c.country from leads l join campaigns c on c.id = l.campaign_id where l.id = ${lead_id})))::text as w`;
        if (w.w !== d) warn = { warning: "not_working_day", next_working_day: w.w };
      } else if (op === "unmove") delete stepNow.moved_to;
      else return fail(400, "unknown op");
      // F3: only this step's entry changes; another step's change made meanwhile is kept.
      const [row] = await q`insert into follow_up_state (lead_id, channel, blob_key, steps, updated_at) values (${lead_id}, ${channel}, ${`${lead_id}/${channel}`}, ${q.json({ [step_key]: stepNow } as never)}, ${now})
        on conflict (lead_id, channel) do update set steps = jsonb_set(coalesce(follow_up_state.steps, '{}'), ${[step_key]}::text[], ${q.json(stepNow as never)}), updated_at = ${now}
        returning *`;
      await refreshFollowUps(q, [lead_id], nowD);
      return { ...stateOf(row), ...warn };
    }

    case "followups.replied": {
      const { lead_id, undo } = p as { lead_id?: string; undo?: boolean };
      if (!lead_id) return fail(400, "lead_id required");
      const at = undo ? null : now;
      const [row] = await q`insert into follow_up_state (lead_id, channel, blob_key, replied_by_hand, updated_at) values (${lead_id}, 'all', ${`${lead_id}/all`}, ${at}, ${now})
        on conflict (lead_id, channel) do update set replied_by_hand = ${at}, updated_at = ${now} returning *`;
      if (undo) {
        await q`update leads set stop_state = coalesce(data->>'stop_before_hand', 'none'), stop_reason = nullif(data->>'stop_reason_before_hand', ''),
                  stopped_at = case when coalesce(data->>'stop_before_hand', 'none') = 'none' then null else stopped_at end,
                  data = data - 'stop_before_hand' - 'stop_reason_before_hand', updated_at = now()
                where id = ${lead_id} and stop_state = 'replied' and stop_reason = 'replied by hand'`;
      } else {
        await q`update leads set data = data || jsonb_build_object('stop_before_hand', stop_state, 'stop_reason_before_hand', coalesce(stop_reason, '')),
                  stop_state = 'replied', stop_reason = 'replied by hand', stopped_at = coalesce(stopped_at, ${now}::timestamptz), updated_at = now()
                where id = ${lead_id} and stop_state in ('none', 'bounced')`;
      }
      await q`insert into activity (id, blob_key, agent_id, category, summary, details, created_at) values (${`fu-${lead_id}-${Date.now()}`}, ${`${now}-fu-${lead_id}`}, null, 'outreach', ${`${undo ? "Cleared" : "Marked"} a hand-recorded reply for lead ${lead_id}`}, '{}', ${now})`;
      await refreshFollowUps(q, [lead_id], nowD);
      return { lead_id, channel: "all", replied_by_hand: at, updated_at: iso(row.updated_at) };
    }

    case "followups.linkedin": {
      const { lead_id, op } = p as { lead_id?: string; op?: string };
      if (!lead_id || !op) return fail(400, "lead_id and op required");
      if (!["accepted", "withdrawn", "undo"].includes(op)) return fail(400, "unknown op");
      const [row] = op === "accepted"
        ? await q`insert into follow_up_state (lead_id, channel, blob_key, accepted_at, withdrawn_at, updated_at) values (${lead_id}, 'linkedin', ${`${lead_id}/linkedin`}, ${now}, null, ${now})
                  on conflict (lead_id, channel) do update set accepted_at = ${now}, withdrawn_at = null, updated_at = ${now} returning *`
        : op === "withdrawn"
          ? await q`insert into follow_up_state (lead_id, channel, blob_key, withdrawn_at, updated_at) values (${lead_id}, 'linkedin', ${`${lead_id}/linkedin`}, ${now}, ${now})
                    on conflict (lead_id, channel) do update set withdrawn_at = ${now}, updated_at = ${now} returning *`
          : await q`insert into follow_up_state (lead_id, channel, blob_key, updated_at) values (${lead_id}, 'linkedin', ${`${lead_id}/linkedin`}, ${now})
                    on conflict (lead_id, channel) do update set accepted_at = null, withdrawn_at = null, updated_at = ${now} returning *`;
      await refreshFollowUps(q, [lead_id], nowD);
      const s = stateOf(row)!;
      return { ...s, updated_at: undefined };
    }
  }
  return fail(400, `Unknown action: ${action}`);
}
