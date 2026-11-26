-- Settings, service config and the rest of the app's stores. No key or password is ever stored here.

create table outreach_settings (
  key text primary key,            -- 'settings', 'preview/<id>'
  data jsonb not null default '{}'
);

-- Which services are set up. The keys themselves are typed in again in Settings at the switch (P5).
create table service_config (
  service text primary key,
  updated_at timestamptz,
  last_test jsonb,
  data jsonb not null default '{}'
);

create table activity (
  id text primary key,
  blob_key text,
  agent_id text,
  category text,
  summary text,
  details jsonb,
  created_at timestamptz,
  data jsonb not null default '{}'
);

create table tasks (
  id text primary key,
  blob_key text,
  title text,
  description text,
  status text,
  assignee_id text,
  priority text,
  created_at timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}'
);

create table agents (
  id text primary key,
  blob_key text,
  name text,
  sign_in_name text,
  role text,
  status text,
  last_heartbeat timestamptz,
  created_at timestamptz,
  data jsonb not null default '{}'
);

create table forms (
  slug text primary key,
  blob_key text,
  title text,
  created_at timestamptz,
  data jsonb not null default '{}'
);

create table submissions (
  id text primary key,
  blob_key text,
  form_slug text,
  received_at timestamptz,
  data jsonb not null default '{}'
);

create table pages (
  slug text primary key,
  blob_key text,
  title text,
  linked_form_slug text,
  created_at timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}'
);

create table webhooks (
  id text primary key,
  blob_key text,
  name text,
  service text,
  event_count int,
  created_at timestamptz,
  data jsonb not null default '{}'
);

create table webhook_events (
  id text primary key,
  blob_key text,
  webhook_id text,
  headers jsonb,
  body jsonb,
  received_at timestamptz,
  data jsonb not null default '{}'
);

create table voice_config (
  key text primary key,
  data jsonb not null default '{}'
);

create table voice_sessions (
  id text primary key,
  blob_key text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds numeric,
  invitation_id text,
  data jsonb not null default '{}'
);

create table voice_invitations (
  id text primary key,
  blob_key text,
  status text,
  agent_id text,
  created_at timestamptz,
  data jsonb not null default '{}'
);
