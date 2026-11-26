-- Emails, social messages, contact history, follow-ups, replies, clicks and the contacted/bounced index.

create table emails (
  id text primary key,
  blob_key text,
  campaign_id text,
  lead_id text,
  to_email text,
  to_key text,                     -- lower-cased address
  to_name text,
  subject text,
  body_text text,
  body_html text,
  sender_name text,
  step int not null default 1,     -- sequence_position
  sequence_total int,
  framework text,
  status text not null default 'drafted',
  error text,                      -- why a send failed
  review_status text check (review_status in ('ready', 'check', 'blocked')),
  review_reasons jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  rules_version int,
  written_by text check (written_by in ('lakshmi', 'claude', 'gemini')),
  written_model text,              -- the exact model name
  source text,
  edited boolean not null default false,
  agentmail_message_id text,
  agentmail_thread_id text,
  agentmail_inbox_id text,
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  replied_at timestamptz,
  click_count int not null default 0,
  last_clicked_at timestamptz,
  is_duplicate boolean not null default false,  -- a second draft for the same lead and step, found at import
  created_at timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}'
);

-- One row per step of a channel (today one record holds all the steps in "parts"; record_id is that record's id).
create table social_messages (
  id text primary key,             -- '<record id>:<step key>'
  record_id text,
  blob_key text,
  campaign_id text,
  lead_id text not null,
  channel text not null,
  step_key text not null,          -- note, message, dm, follow_up, last
  step int not null,
  url text,
  label text,
  body text,
  status text not null default 'drafted',
  type text,
  review_status text check (review_status in ('ready', 'check', 'blocked')),
  review_reasons jsonb,
  written_by text check (written_by in ('lakshmi', 'claude', 'gemini')),
  written_model text,
  sent_at timestamptz,
  skipped boolean not null default false,
  touch_id text,
  is_duplicate boolean not null default false,
  created_at timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}'
);

-- F9: one draft per lead, channel and step.
create unique index emails_one_per_step on emails (lead_id, step) where status <> 'failed' and not is_duplicate;
create unique index social_one_per_step on social_messages (lead_id, channel, step_key) where not is_duplicate;

create table touches (
  id text primary key,
  blob_key text,
  lead_id text,
  campaign_id text,
  channel text,
  kind text,
  sent_at timestamptz,
  subject text,
  body text,
  source text,
  ref text,
  data jsonb not null default '{}'
);

-- What the user saved about follow-ups: skips, notes, moved dates, "they replied". lead_id/all holds the lead-wide mark.
create table follow_up_state (
  lead_id text not null,
  channel text not null,
  blob_key text,
  steps jsonb not null default '{}',
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  replied_by_hand timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}',
  primary key (lead_id, channel)
);

-- The next step per lead and channel with its due date. Today the app works this out on every read;
-- here it is stored (worked out by the same rule) so it can be indexed.
create table follow_ups (
  lead_id text not null,
  channel text not null,
  campaign_id text,
  step_key text not null,
  position int not null,
  due_date date,
  stopped_reason text,
  email_id text,
  computed_at timestamptz not null default now(),
  primary key (lead_id, channel)
);

create table replies (
  id text primary key,
  blob_key text,
  campaign_id text,
  lead_id text,
  original_email_id text,
  agentmail_message_id text,
  agentmail_thread_id text,
  from_address text,
  from_key text,
  subject text,
  body_text text,
  body_html text,
  received_at timestamptz,
  handled boolean not null default false,
  opt_out boolean not null default false,
  flag text,
  is_test boolean not null default false,
  kind text,                       -- person, test, system, bounce_report
  source text,
  data jsonb not null default '{}'
);

create table clicks (
  id text primary key,
  blob_key text,
  campaign_id text,
  lead_id text,
  email_id text,
  url text,
  clicked_at timestamptz,
  data jsonb not null default '{}'
);

-- Who has been emailed / bounced, across campaigns (today: one blob per fact, keyed by address).
create table contacts (
  blob_key text primary key,
  kind text not null,              -- sent, bounced, do_not_contact, meta
  email text not null default '',
  campaign_id text not null default '',
  value text                       -- stored as plain text, as today
);
