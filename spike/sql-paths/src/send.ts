// Send emails of one campaign (measured with limit 1). Production: command.ts:5129-5360.
// Same rules and same response; the who-may-be-sent questions are answered by indexed SQL.
import { checkStep, checkSubject, scanBanned, statusOf, mentionsRating, dedupeReasons, RULES_VERSION } from "../../../netlify/functions/lib/messagerules";
import { resolveInputs } from "../../../netlify/functions/lib/fourstep";
import { appendFooter, textToHtml } from "../../../netlify/functions/lib/outreach";
import { rid, type Sql } from "./db";

type Rec = Record<string, any>;
const AGENTMAIL = "https://api.agentmail.to/v0";

// copy of command.ts:551
const agentmailFetch = (key: string, path: string, init: RequestInit = {}) =>
  fetch(`${AGENTMAIL}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

// copy of command.ts:564
async function getInbox(key: string, campaignName: string, preferredId?: string): Promise<Rec> {
  if (preferredId) {
    const r = await agentmailFetch(key, `/inboxes/${encodeURIComponent(preferredId)}`);
    if (r.ok) return (await r.json()) as Rec;
    throw new Error(`The sending inbox chosen in Settings (${preferredId}) could not be found in AgentMail (${r.status}). Pick another one in Settings.`);
  }
  const listR = await agentmailFetch(key, "/inboxes?limit=10");
  if (listR.ok) {
    const body = (await listR.json()) as { inboxes?: Rec[] };
    if (body.inboxes && body.inboxes.length > 0) return body.inboxes[0];
  }
  const createR = await agentmailFetch(key, "/inboxes", { method: "POST", body: JSON.stringify({ display_name: campaignName.slice(0, 80) }) });
  if (!createR.ok) throw new Error(`AgentMail inbox create failed (${createR.status})`);
  return (await createR.json()) as Rec;
}

// copy of command.ts:596
async function ensureDisplayName(key: string, inboxId: string, desired: string, current?: string) {
  const target = desired.replace(/["\r\n]/g, "").trim();
  if (!target || current === target) return;
  await agentmailFetch(key, `/inboxes/${encodeURIComponent(inboxId)}`, { method: "PATCH", body: JSON.stringify({ display_name: target }) });
}

// copy of command.ts:615
function rewriteLinksForTracking(html: string, baseUrl: string, campaignId: string, leadId: string, emailId: string): string {
  return html.replace(/href="([^"]+)"/gi, (full, rawUrl) => {
    if (!rawUrl || typeof rawUrl !== "string") return full;
    if (/^(#|mailto:|tel:|sms:)/i.test(rawUrl)) return full;
    if (rawUrl.startsWith(`${baseUrl}/t/`)) return full;
    const token = Buffer.from(JSON.stringify({ c: campaignId, l: leadId, e: emailId, u: rawUrl })).toString("base64url");
    return `href="${baseUrl}/t/${token}"`;
  });
}

/** The free checks on one saved draft (command.ts:1253), reading only this lead's own records. */
async function codeCheck(sql: Sql, ds: string, row: Rec, settings: Rec, campaignId: string) {
  const inp = resolveInputs(settings, String(row.to_name ?? ""));
  const [emails, socials] = await Promise.all([
    sql`select data from spike.s75_emails where ds = ${ds} and lead_id = ${row.lead_id} and campaign_id = ${campaignId} order by key`,
    sql`select data from spike.s75_social where ds = ${ds} and lead_id = ${row.lead_id} and campaign_id = ${campaignId}`,
  ]);
  const all = emails.map((r) => r.data as Rec);
  const four = row.framework === "four-step";
  const pos = Math.min(4, Math.max(1, Number(row.sequence_position ?? 1)));
  const earlier = four ? all.filter((e) => e.id !== row.id && e.framework === "four-step" && (e.sequence_position ?? 1) < pos).sort((a, b) => (a.sequence_position ?? 1) - (b.sequence_position ?? 1)) : [];
  const body = String(row.body_text ?? ""), subject = String(row.subject ?? "");
  const rated = all.some((e) => mentionsRating(String(e.body_text ?? ""))) || socials.some((s) => ((s.data as Rec).parts ?? []).some((x: Rec) => mentionsRating(String(x.text ?? ""))));
  const ratingAlready = rated || earlier.some((e) => mentionsRating(String(e.body_text ?? "")));
  const kinds = ["email1", "email2", "email3", "email4"] as const;
  let hits = checkStep(four ? kinds[pos - 1] : "email1", body, { channel: "email", earlierChars: earlier.map((e) => String(e.body_text ?? "").length), ratingAlready, freeAsset: pos === 2 ? inp.freeAsset2 : inp.freeAsset1, proofLine: inp.proofLine, earlierTexts: earlier.map((e) => String(e.body_text ?? "")), namedSources: inp.namedSources } as any);
  if (!four) hits = hits.filter((h) => h.level === "hard");
  const subjectHits = four && pos === 1 ? checkSubject(subject) : [...scanBanned(subject).filter((h) => h.level === "hard" && h.id !== "dash"), ...checkSubject(subject).filter((h) => h.id === "fake-re" || h.id === "empty-subject")];
  hits = [...hits, ...subjectHits.filter((h) => !hits.some((x) => x.id === h.id))];
  const hitLine = (h: Rec) => `${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}. ${h.because}`.slice(0, 240); // command.ts:1247
  void dedupeReasons;
  return { reasons: statusOf(hits).reasons, hard: hits.filter((h) => h.level === "hard").map(hitLine), earlierSent: earlier };
}

export async function send(sql: Sql, ds: string, params: Rec, baseUrl: string, agentId: string | null): Promise<{ status: number; body: Rec }> {
  const { campaign_id: cid, limit } = params;
  const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });
  if (typeof cid !== "string" || !cid) return fail(400, "campaign_id required");
  const [cfg] = await sql`
    select
      (select data->>'key' from spike.s75_settings where ds = ${ds} and name = 'service-agentmail') as key,
      (select data from spike.s75_campaigns where ds = ${ds} and id = ${cid}) as campaign,
      (select data from spike.s75_settings where ds = ${ds} and name = 'outreach') as settings,
      (select data from spike.s75_settings where ds = ${ds} and name = ${`state-${cid}`}) as state`;
  if (!cfg.key) return fail(400, "AgentMail key not configured");
  if (!cfg.campaign) return fail(404, "campaign not found");
  const campaign: Rec = cfg.campaign, settings: Rec = cfg.settings ?? {};
  const batch = typeof limit === "number" && limit >= 1 ? Math.floor(limit) : 1;

  // Every drafted email of the campaign with the first reason it must not go (command.ts:5200), decided in the database.
  const decided = sql`
    with d as (
      select e.id, e.key, e.created_at, e.step, e.review_status, e.data->>'to_email' as to_email, e.data->'review_reasons' as reasons,
        (coalesce(l.do_not_contact, false) or exists (select 1 from spike.s75_leads x where x.ds = e.ds and x.do_not_contact and x.email_key = e.email_key)) as dnc,
        coalesce(l.excluded, false) as excluded,
        case
          when exists (select 1 from spike.s75_contacts c where c.ds = e.ds and c.email = e.email_key and c.kind = 'bounced') then 'bounced earlier'
          when coalesce(l.data->>'is_test', '') <> 'true' and exists (select 1 from spike.s75_contacts c where c.ds = e.ds and c.email = e.email_key and c.kind = 'sent' and c.campaign_id <> ${cid}) then 'already contacted in another campaign'
        end as contacted,
        exists (select 1 from spike.s75_emails r where r.ds = e.ds and r.lead_id = e.lead_id and r.campaign_id = e.campaign_id and r.status = 'replied') as replied
      from spike.s75_emails e left join spike.s75_leads l on l.ds = e.ds and l.id = e.lead_id
      where e.ds = ${ds} and e.campaign_id = ${cid} and e.status = 'drafted'),
    w as (
      select *, case
        when dnc then 'do_not_contact' when excluded then 'lead_skipped' when contacted is not null then 'contacted'
        when review_status = 'blocked' then 'blocked' when review_status = 'check' then 'not_ready'
        when step > 1 and replied then 'replied' end as code
      from d)`;
  const [sum] = await sql`
    ${decided}
    select
      count(*) filter (where not dnc and not excluded and contacted is null and review_status = 'ready')::int as queued_before,
      count(*) filter (where not dnc and contacted is null and excluded)::int as skipped_excluded,
      count(*) filter (where not dnc and contacted is null and not excluded and review_status = 'blocked')::int as skipped_blocked,
      count(*) filter (where not dnc and contacted is null and not excluded and review_status = 'check')::int as skipped_not_ready,
      count(*) filter (where code is null)::int as eligible,
      count(*) filter (where dnc)::int as dnc,
      coalesce(json_agg(json_build_object('email_id', id, 'to_email', to_email, 'step', step, 'code', code, 'reason',
          case when code = 'replied' then 'This lead already replied, so later emails are not sent'
          else 'Blocked: ' || coalesce(nullif((select string_agg(t, ' | ') from jsonb_array_elements_text(coalesce(reasons, '[]'::jsonb)) t), ''), 'fix it first') end)
        order by key) filter (where code in ('blocked', 'replied')), '[]')::text as not_sent,
      coalesce(json_agg(json_build_object('email_id', id, 'to_email', to_email, 'reason', contacted) order by key) filter (where not dnc and contacted is not null), '[]')::text as skipped_contacted,
      (select json_agg(id) from (select id from w where code is null order by created_at, key limit ${batch + 5}) p) as first_ids
    from w`;
  const candidates = sum.first_ids?.length
    ? await sql`select data, key from spike.s75_emails where ds = ${ds} and id in ${sql(sum.first_ids as string[])} order by created_at, key`
    : [];

  const notSent: Rec[] = JSON.parse(sum.not_sent);
  const skippedContacted: Rec[] = JSON.parse(sum.skipped_contacted);
  const toSend: Array<{ em: Rec; earlier: Rec[] }> = [];
  let gateBlocked = 0;
  for (const c of candidates) {
    if (toSend.length >= batch) break;
    const em = c.data as Rec;
    const ck = await codeCheck(sql, ds, em, settings, cid);
    if (ck.hard.length) {
      gateBlocked++;
      await sql`update spike.s75_emails set data = data || ${sql.json({ review_status: "blocked", review_reasons: ck.reasons, reviewed_by: "code checks", reviewed_at: new Date().toISOString(), rules_version: RULES_VERSION } as any)} where ds = ${ds} and id = ${em.id}`;
      notSent.push({ email_id: em.id, to_email: em.to_email, step: em.sequence_position ?? 1, code: "blocked", reason: `Blocked by the free checks: ${ck.hard.join(" | ")}` });
      continue;
    }
    toSend.push({ em, earlier: ck.earlierSent });
  }
  const skip = {
    skipped_excluded: sum.skipped_excluded, skipped_blocked: sum.skipped_blocked + gateBlocked, skipped_not_ready: sum.skipped_not_ready,
    skipped_over_limit: Math.max(0, sum.eligible - gateBlocked - toSend.length), not_sent: notSent,
  };
  if (!toSend.length) {
    const first = notSent.slice(0, 3).map((x) => `${x.to_email}${x.step ? ` (email ${x.step})` : ""}: ${x.reason}`).join("; ");
    return { status: 200, body: { ok: true, data: { sent: 0, total: 0, queued: sum.queued_before, errors: [], ...skip, reason: `Nothing was sent. ${first}`, skipped_do_not_contact: sum.dnc, skipped_contacted: skippedContacted } } };
  }

  const now = () => new Date().toISOString();
  await sql`update spike.s75_campaigns set data = data || ${sql.json({ status: "sending", updated_at: now() })} where ds = ${ds} and id = ${cid}`;
  const inbox = await getInbox(cfg.key, campaign.name, settings.sending_inbox_id || undefined);
  const sender = (cfg.state?.default_sender_name ?? campaign.default_sender_name ?? "") as string;
  if (sender) await ensureDisplayName(cfg.key, inbox.inbox_id, sender, inbox.display_name);

  let sent = 0;
  const errors: Rec[] = [];
  for (const { em, earlier } of toSend) {
    try {
      const html = rewriteLinksForTracking(em.body_html || textToHtml(em.body_text || ""), baseUrl, cid, em.lead_id, em.id);
      const withFooter = appendFooter(em.body_text || "", html, settings.postal_address ?? "", em.sender_name || sender);
      let body: Rec = { to: [em.to_email], subject: em.subject, text: withFooter.text, html: withFooter.html };
      let path = `/inboxes/${inbox.inbox_id}/messages/send`;
      if (em.framework === "four-step" && (em.sequence_position ?? 1) > 1) {
        const before = earlier.filter((x) => x.status !== "drafted" && x.agentmail_message_id && (x.sequence_position ?? 1) === 1).sort((a, b) => String(b.sent_at ?? "").localeCompare(String(a.sent_at ?? "")))[0];
        if (!before) { errors.push({ email_id: em.id, error: "Send email 1 first: this one goes as a reply in the same thread." }); continue; }
        path = `/inboxes/${encodeURIComponent(before.agentmail_inbox_id || inbox.inbox_id)}/messages/${encodeURIComponent(String(before.agentmail_message_id))}/reply`;
        body = { text: withFooter.text, html: withFooter.html };
      }
      // Recorded BEFORE the call: if the request is cut off here, the row is "sending", not "drafted", and is not sent twice.
      const claimed = await sql`update spike.s75_emails set data = data || ${sql.json({ status: "sending", updated_at: now() })} where ds = ${ds} and id = ${em.id} and status = 'drafted' returning id`;
      if (!claimed.length) continue;
      const r = await agentmailFetch(cfg.key, path, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) {
        errors.push({ email_id: em.id, error: `AgentMail send ${r.status}` });
        await sql`update spike.s75_emails set data = data || '{"status":"drafted"}'::jsonb where ds = ${ds} and id = ${em.id}`;
        continue;
      }
      const resp = (await r.json()) as Rec;
      const at = now();
      await sql`
        with e as (update spike.s75_emails set data = data || ${sql.json({ status: "sent", agentmail_message_id: resp.message_id ?? null, agentmail_thread_id: resp.thread_id ?? null, agentmail_inbox_id: inbox.inbox_id, sent_at: at, updated_at: at })} where ds = ${ds} and id = ${em.id}),
        c as (insert into spike.s75_contacts (ds, kind, email, campaign_id) values (${ds}, 'sent', ${String(em.to_email).trim().toLowerCase()}, ${cid}) on conflict do nothing)
        update spike.s75_leads set data = data || ${sql.json({ contacted_at: at })} where ds = ${ds} and id = ${em.lead_id}`;
      sent++;
    } catch (err) {
      errors.push({ email_id: em.id, error: err instanceof Error ? err.message : "unknown" });
    }
  }

  const queued = Math.max(0, sum.queued_before - sent);
  const activityId = rid(), at = now();
  await sql`
    with c as (update spike.s75_campaigns set data = data || ${sql.json({ status: sent > 0 ? (queued > 0 ? "ready" : "completed") : "failed", last_send_at: at, agentmail_inbox_id: inbox.inbox_id, updated_at: at })} where ds = ${ds} and id = ${cid})
    insert into spike.s75_activity (ds, key, data) values (${ds}, ${`${at}-${activityId}`}, ${sql.json({ id: activityId, created_at: at, agent_id: agentId, category: "email", summary: `Sent ${sent} of ${toSend.length} emails for "${campaign.name}" (${queued} still queued)`, details: { campaign_id: cid, sent, queued, errors: errors.length, inbox: inbox.inbox_id } })})`;
  return { status: 200, body: { ok: true, data: { sent, total: toSend.length, queued, errors, inbox, skipped_contacted: skippedContacted, ...skip } } };
}
