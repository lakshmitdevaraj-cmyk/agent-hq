-- Everything lives in its own "spike" schema, so nothing else in the database is touched.
create schema if not exists spike;
set search_path to spike;

create table if not exists campaigns (id text primary key, name text, query text, status text, created_at timestamptz, data jsonb);
create table if not exists leads (
  id text primary key, campaign_id text references campaigns(id), name text, email text, phone text, website text, address text,
  category text, rating numeric, reviews_count int, facebook text, instagram text, linkedin text,
  do_not_contact boolean not null default false, excluded boolean not null default false, created_at timestamptz, data jsonb);
create table if not exists emails (
  id text primary key, campaign_id text, lead_id text references leads(id), sequence_position int, subject text, body_text text,
  status text, due_date date, sent_at timestamptz, created_at timestamptz, data jsonb);
create table if not exists social_messages (
  id text primary key, campaign_id text, lead_id text references leads(id), channel text, status text, due_date date,
  sent_at timestamptz, text text, data jsonb);
create table if not exists replies (id text primary key, campaign_id text, lead_id text, email_id text, from_email text, body_text text, received_at timestamptz, data jsonb);

create table if not exists send_status (run_id text, n int, status text, http_status int, detail text, queued_at timestamptz default now(), done_at timestamptz, primary key (run_id, n));
create table if not exists workflow_steps (run_id text, step int, source text, started_at timestamptz, finished_at timestamptz, primary key (run_id, step));
create table if not exists sitecheck_results (run_id text, host text, pages int, kb int, fetch_ms numeric, cpu_ms numeric, summary jsonb, created_at timestamptz default now(), primary key (run_id, host));

create index if not exists leads_campaign on leads (campaign_id);
create index if not exists emails_lead on emails (lead_id, sequence_position);
create index if not exists emails_campaign on emails (campaign_id);
create index if not exists emails_unsent on emails (lead_id, sequence_position) where status = 'drafted';
create index if not exists emails_bounced on emails (lead_id) where status = 'bounced';
create index if not exists social_due on social_messages (due_date) where sent_at is null;
create index if not exists replies_lead on replies (lead_id);
