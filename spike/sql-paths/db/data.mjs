// Copies the fake datasets of Step 0.5 (spike.kv, "pristine-dN/...") into the s75_ tables, inside the database.
// reset() puts back everything a test write changes.

/** The one change to the fake data: "ready" drafts get wording the app's send checks accept, so a send really sends. */
export const SENDABLE = { subject: "missed calls", body_text: "Hi there,\n\nPeople who call a heating company after hours often have to ring back the next day.\n\nI put together a short note on how other HVAC teams catch those calls.\n\nWould it help if I sent it over?\n\nLakshmi" };

const from = (sql, size, store) => sql`spike.kv where store = ${`pristine-d${size}/${store}`}`;

/** Tables a test write can change. */
export async function reset(sql, size) {
  const ds = `d${size}`;
  await sql.begin(async (tx) => {
    for (const t of ["s75_campaigns", "s75_emails", "s75_contacts", "s75_webhooks", "s75_webhook_events", "s75_clicks", "s75_activity"]) {
      await tx`delete from ${tx(`spike.${t}`)} where ds = ${ds}`;
    }
    await tx`insert into spike.s75_campaigns (ds, id, data) select ${ds}, key, value from ${from(tx, size, "agent-hq-outreach-campaigns")}`;
    await tx`insert into spike.s75_emails (ds, id, key, campaign_id, data)
      select ${ds}, value->>'id', key, value->>'campaign_id', value from ${from(tx, size, "agent-hq-outreach-emails")}`;
    await tx`update spike.s75_emails set data = data || ${tx.json(SENDABLE)} where ds = ${ds} and status = 'drafted' and review_status = 'ready'`;
    await tx`insert into spike.s75_contacts (ds, kind, email, campaign_id)
      select ${ds}, split_part(key, '/', 1), split_part(key, '/', 2), split_part(key, '/', 3) from ${from(tx, size, "agent-hq-outreach-contacts")} and key <> 'meta/built'`;
    await tx`insert into spike.s75_webhooks (ds, id, data) select ${ds}, key, value from ${from(tx, size, "agent-hq-webhooks")}`;
    await tx`insert into spike.s75_webhook_events (ds, key, data) select ${ds}, key, value from ${from(tx, size, "agent-hq-webhook-events")}`;
    await tx`insert into spike.s75_clicks (ds, key, data) select ${ds}, key, value from ${from(tx, size, "agent-hq-outreach-clicks")}`;
    await tx`insert into spike.s75_activity (ds, key, data) select ${ds}, key, value from ${from(tx, size, "agent-hq-activity")}`;
    await tx`update spike.s75_leads set data = data - 'contacted_at' where ds = ${ds} and data ? 'contacted_at'`;
  });
}

export async function load(sql, size) {
  const ds = `d${size}`;
  for (const t of ["s75_leads", "s75_social", "s75_replies", "s75_touches", "s75_settings"]) await sql`delete from ${sql(`spike.${t}`)} where ds = ${ds}`;
  await sql`insert into spike.s75_leads (ds, id, key, campaign_id, data)
    select ${ds}, value->>'id', key, value->>'campaign_id', value from ${from(sql, size, "agent-hq-outreach-leads")}`;
  await sql`insert into spike.s75_social (ds, key, campaign_id, lead_id, channel, data)
    select ${ds}, key, value->>'campaign_id', value->>'lead_id', value->>'channel', value from ${from(sql, size, "agent-hq-outreach-social")}`;
  await sql`insert into spike.s75_replies (ds, key, campaign_id, lead_id, data)
    select ${ds}, key, value->>'campaign_id', value->>'lead_id', value from ${from(sql, size, "agent-hq-outreach-replies")}`;
  await sql`insert into spike.s75_touches (ds, key, lead_id, data)
    select ${ds}, key, value->>'lead_id', value from ${from(sql, size, "agent-hq-outreach-touches")}`;
  await sql`insert into spike.s75_settings (ds, name, data) select ${ds}, 'api-key', value from ${from(sql, size, "agent-hq-config")} and key = 'api-key'`;
  await sql`insert into spike.s75_settings (ds, name, data) select ${ds}, 'outreach', value from ${from(sql, size, "agent-hq-outreach-settings")} and key = 'settings'`;
  await sql`insert into spike.s75_settings (ds, name, data) select ${ds}, 'service-' || key, value from ${from(sql, size, "agent-hq-service-config")}`;
  await reset(sql, size);
}
