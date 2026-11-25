-- Step 0.75 tables. Everything is in the "spike" schema, every table starts with s75_.
-- "ds" keeps the fake data sizes apart (d25, d100, d500, d1500). Records stay as jsonb; the columns the paths
-- filter or sort on are generated from it, so a write only ever changes "data".
create extension if not exists pg_trgm schema spike;

create table if not exists spike.s75_campaigns (ds text, id text, data jsonb not null, primary key (ds, id));

create table if not exists spike.s75_leads (
  ds text, id text, key text collate "C" not null, campaign_id text not null, data jsonb not null,
  do_not_contact boolean generated always as (coalesce(data->>'do_not_contact', '') = 'true') stored,
  excluded boolean generated always as (coalesce(data->>'excluded', '') = 'true') stored,
  email_key text generated always as (nullif(lower(btrim(data->>'email')), '')) stored,
  gap_score numeric generated always as (case when jsonb_typeof(data->'gap_score') = 'number' then (data->>'gap_score')::numeric else -1 end) stored,
  created_at text collate "C" generated always as (coalesce(data->>'created_at', '')) stored,
  search text generated always as (lower(coalesce(data->>'name', '') || ' ' || coalesce(data->>'owner_name', '') || ' ' || coalesce(data->>'email', '') || ' ' ||
    coalesce(data->>'phone', '') || ' ' || coalesce(data->>'website', '') || ' ' || coalesce(data->>'address', ''))) stored,
  row_json text, -- Prospects variant B: this lead's finished row
  primary key (ds, id));
create index if not exists s75_leads_campaign on spike.s75_leads (ds, campaign_id);
create index if not exists s75_leads_order on spike.s75_leads (ds, gap_score desc, created_at desc, key);
create index if not exists s75_leads_dnc on spike.s75_leads (ds, email_key) where do_not_contact;
create index if not exists s75_leads_search on spike.s75_leads using gin (search spike.gin_trgm_ops);

create table if not exists spike.s75_emails (
  ds text, id text, key text collate "C" not null, campaign_id text not null, data jsonb not null,
  lead_id text generated always as (data->>'lead_id') stored,
  status text generated always as (coalesce(data->>'status', 'drafted')) stored,
  review_status text generated always as (case when data->>'review_status' in ('ready', 'blocked') then data->>'review_status' else 'check' end) stored,
  step int generated always as (coalesce((data->>'sequence_position')::int, 1)) stored,
  created_at text collate "C" generated always as (coalesce(data->>'created_at', '')) stored,
  email_key text generated always as (nullif(lower(btrim(data->>'to_email')), '')) stored,
  message_id text generated always as (data->>'agentmail_message_id') stored,
  thread_id text generated always as (data->>'agentmail_thread_id') stored,
  primary key (ds, id));
create index if not exists s75_emails_campaign on spike.s75_emails (ds, campaign_id, status);
create index if not exists s75_emails_lead on spike.s75_emails (ds, lead_id);
create index if not exists s75_emails_message on spike.s75_emails (ds, message_id);
create index if not exists s75_emails_thread on spike.s75_emails (ds, thread_id);

create table if not exists spike.s75_social (ds text, key text collate "C", campaign_id text, lead_id text, channel text, data jsonb not null, primary key (ds, key));
create index if not exists s75_social_lead on spike.s75_social (ds, lead_id);
create table if not exists spike.s75_replies (ds text, key text collate "C", campaign_id text, lead_id text, data jsonb not null, primary key (ds, key));
create index if not exists s75_replies_campaign on spike.s75_replies (ds, campaign_id);
create index if not exists s75_replies_lead on spike.s75_replies (ds, lead_id);
create table if not exists spike.s75_touches (ds text, key text collate "C", lead_id text, data jsonb not null, primary key (ds, key));
create index if not exists s75_touches_lead on spike.s75_touches (ds, lead_id);
-- kind: 'sent' (campaign_id = where from) or 'bounced' (campaign_id = '')
create table if not exists spike.s75_contacts (ds text, kind text, email text, campaign_id text not null default '', primary key (ds, email, kind, campaign_id));
create table if not exists spike.s75_clicks (ds text, key text collate "C", data jsonb not null, primary key (ds, key));
create table if not exists spike.s75_webhooks (ds text, id text, data jsonb not null, primary key (ds, id));
create table if not exists spike.s75_webhook_events (ds text, key text collate "C", data jsonb not null, primary key (ds, key));
create table if not exists spike.s75_activity (ds text, key text collate "C", data jsonb not null, primary key (ds, key));
create table if not exists spike.s75_settings (ds text, name text, data jsonb not null, primary key (ds, name));
