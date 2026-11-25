// "Delivered" webhook and tracking link. Production: webhook-receive.ts, track-click.ts.
// Variant a = one statement per step; variant b = the same writes in one combined statement.
import { rid, type Sql } from "./db";

type Rec = Record<string, any>;

const OUTBOUND: Record<string, string> = { "message.sent": "sent", "message.delivered": "delivered", "message.bounced": "bounced", "message.complained": "complained", "message.rejected": "failed" };
const RANK: Record<string, number> = { drafted: 0, sent: 1, delivered: 2, clicked: 3, replied: 4 };
const BAD = ["bounced", "complained", "failed"];

export async function webhook(sql: Sql, ds: string, hookId: string, body: Rec, headers: Rec, variant: "a" | "b"): Promise<{ status: number; body: Rec | string }> {
  const id = rid(), received_at = new Date().toISOString();
  const eventKey = `${hookId}/${received_at}-${id}`;
  const event = { id, webhook_id: hookId, headers, body, received_at };
  const status = OUTBOUND[body?.event_type] ?? null;
  const carrier = body?.send ?? body?.delivery ?? body?.bounce ?? body?.complaint ?? body?.rejection ?? {};
  const messageId: string | null = carrier.message_id ?? null, threadId: string | null = carrier.thread_id ?? null;
  const activityId = rid();
  const activity = (name: string, service: string) => ({ id: activityId, agent_id: null, category: "system", summary: `Webhook "${name}" received an event`, details: { event_id: id, service }, created_at: received_at });
  const patch = status ? { status, [`${status}_at`]: received_at, updated_at: received_at } : {};
  const minRank = status ? RANK[status] ?? 0 : 0;
  const always = !!status && BAD.includes(status);
  const rankSql = sql`case status when 'drafted' then 0 when 'sent' then 1 when 'delivered' then 2 when 'clicked' then 3 when 'replied' then 4 else 0 end`;

  if (variant === "a") {
    const [hook] = await sql`select data from spike.s75_webhooks where ds = ${ds} and id = ${hookId}`;
    if (!hook) return { status: 404, body: "Webhook not found" };
    await sql`insert into spike.s75_webhook_events (ds, key, data) values (${ds}, ${eventKey}, ${sql.json(event as any)})`;
    await sql`update spike.s75_webhooks set data = jsonb_set(data, '{event_count}', to_jsonb(coalesce((data->>'event_count')::int, 0) + 1)) where ds = ${ds} and id = ${hookId}`;
    if (status && (messageId || threadId)) {
      let [match] = messageId ? await sql`select id, email_key, status from spike.s75_emails where ds = ${ds} and message_id = ${messageId} limit 1` : [];
      if (!match && threadId) [match] = await sql`select id, email_key, status from spike.s75_emails where ds = ${ds} and thread_id = ${threadId} order by key limit 1`;
      if (match && (always || minRank >= (RANK[match.status] ?? 0))) {
        await sql`update spike.s75_emails set data = data || ${sql.json(patch)} where ds = ${ds} and id = ${match.id}`;
        if (always && match.email_key) await sql`insert into spike.s75_contacts (ds, kind, email) values (${ds}, 'bounced', ${match.email_key}) on conflict do nothing`;
      }
    }
    await sql`insert into spike.s75_activity (ds, key, data) values (${ds}, ${`${received_at}-${activityId}`}, ${sql.json(activity(hook.data.name, hook.data.service ?? "generic"))})`;
  } else {
    const rows = await sql`
      with hook as (
        update spike.s75_webhooks set data = jsonb_set(data, '{event_count}', to_jsonb(coalesce((data->>'event_count')::int, 0) + 1))
        where ds = ${ds} and id = ${hookId} returning data),
      ev as (insert into spike.s75_webhook_events (ds, key, data) select ${ds}, ${eventKey}, ${sql.json(event as any)} from hook),
      match as (
        select id from (
          (select id, 1 as pref from spike.s75_emails where ds = ${ds} and message_id = ${messageId} limit 1)
          union all
          (select id, 2 from spike.s75_emails where ds = ${ds} and thread_id = ${threadId} order by key limit 1)
        ) m where exists (select 1 from hook) and ${!!status}::boolean order by pref limit 1),
      upd as (
        update spike.s75_emails e set data = e.data || ${sql.json(patch)} from match
        where e.ds = ${ds} and e.id = match.id and (${always}::boolean or ${minRank}::int >= ${rankSql}) returning e.email_key),
      bounce as (insert into spike.s75_contacts (ds, kind, email) select ${ds}, 'bounced', email_key from upd where ${always}::boolean and email_key is not null on conflict do nothing),
      act as (
        insert into spike.s75_activity (ds, key, data)
        select ${ds}, ${`${received_at}-${activityId}`}, ${sql.json(activity("", ""))}::jsonb
          || jsonb_build_object('summary', 'Webhook "' || (data->>'name') || '" received an event', 'details', jsonb_build_object('event_id', ${id}::text, 'service', coalesce(data->>'service', 'generic'))) from hook)
      select 1 from hook`;
    if (!rows.length) return { status: 404, body: "Webhook not found" };
  }
  return { status: 200, body: { ok: true, event_id: id } };
}

/** The token carries everything (command.ts:615): { c: campaign, l: lead, e: email, u: destination }. */
export function decodeToken(token: string): { c?: string; l?: string; e?: string; u?: string } | null {
  try {
    const normalised = token.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((token.length + 3) % 4);
    return JSON.parse(Buffer.from(normalised, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function click(sql: Sql, ds: string, token: string, headers: Rec, variant: "a" | "b"): Promise<{ status: number; location?: string; body?: string }> {
  const p = decodeToken(token);
  if (!p || !p.u) return { status: 400, body: "Invalid tracking token" };
  const redirect = { status: 302, location: p.u };
  if (!p.c || !p.e) return redirect;
  const clickId = rid(), at = new Date().toISOString(), activityId = rid();
  const record = { id: clickId, campaign_id: p.c, lead_id: p.l ?? null, email_id: p.e, url: p.u, user_agent: headers["user-agent"] ?? null, ip: headers["x-forwarded-for"] ?? null, clicked_at: at };
  const activity = { id: activityId, agent_id: null, category: "email", summary: "", details: { campaign_id: p.c, email_id: p.e, url: p.u }, created_at: at };
  try {
    const emailPatch = sql`data || jsonb_build_object('status', case when status = 'replied' then 'replied' else 'clicked' end,
      'click_count', coalesce((data->>'click_count')::int, 0) + 1, 'last_clicked_at', ${at}::text, 'updated_at', ${at}::text)`;
    const campaignPatch = sql`data || jsonb_build_object('emails_clicked', coalesce((data->>'emails_clicked')::int, 0) + 1, 'updated_at', ${at}::text)`;
    const clickKey = `${p.c}/${at}-${clickId}`, activityKey = `${at}-${activityId}`;
    if (variant === "a") {
      await sql`insert into spike.s75_clicks (ds, key, data) values (${ds}, ${clickKey}, ${sql.json(record)})`;
      await sql`update spike.s75_emails set data = ${emailPatch} where ds = ${ds} and id = ${p.e} and campaign_id = ${p.c}`;
      const [camp] = await sql`update spike.s75_campaigns set data = ${campaignPatch} where ds = ${ds} and id = ${p.c} returning data->>'name' as name`;
      await sql`insert into spike.s75_activity (ds, key, data) values (${ds}, ${activityKey}, ${sql.json({ ...activity, summary: `Link clicked in campaign ${camp?.name ?? p.c}` })})`;
    } else {
      await sql`
        with c as (insert into spike.s75_clicks (ds, key, data) values (${ds}, ${clickKey}, ${sql.json(record)})),
        e as (update spike.s75_emails set data = ${emailPatch} where ds = ${ds} and id = ${p.e} and campaign_id = ${p.c}),
        camp as (update spike.s75_campaigns set data = ${campaignPatch} where ds = ${ds} and id = ${p.c} returning data->>'name' as name)
        insert into spike.s75_activity (ds, key, data)
        select ${ds}, ${activityKey}, ${sql.json(activity)}::jsonb || jsonb_build_object('summary', 'Link clicked in campaign ' || coalesce((select name from camp), ${p.c}::text))`;
    }
  } catch (err) {
    console.error("[click] logging error:", err); // never block the redirect
  }
  return redirect;
}
