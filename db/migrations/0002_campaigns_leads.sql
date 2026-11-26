-- Campaigns and leads. Ids are today's ids; blob_key is the key the record had in Netlify Blobs; every field without
-- its own column stays in data. No foreign keys to campaigns or leads in P1: orphans are kept and listed.

-- Settings only. Nothing a running job writes lives here (F2/F3).
create table campaigns (
  id text primary key,
  blob_key text,
  name text not null default '',
  description text,
  niche text,                      -- the search words ("query")
  area text,                       -- structured_query.location
  country text,
  time_zone text,
  created_by text,
  default_sender_name text,
  default_sender_company text,
  default_sender_offer text,
  default_framework text,
  default_sequence_total int,
  any_trade boolean not null default false,
  agentmail_inbox_id text,
  search text generated always as (lower(coalesce(name, '') || ' ' || coalesce(niche, '') || ' ' || coalesce(area, ''))) stored,
  created_at timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}'
);

-- Job progress, one row per campaign and kind of job: 'leads' (the lead search run), 'generate', 'review', 'social'.
create table campaign_jobs (
  campaign_id text not null,
  kind text not null,
  status text,
  total int,
  done int,
  made int,
  started_at timestamptz,
  progress_at timestamptz,
  finished_at timestamptz,
  data jsonb not null default '{}',
  primary key (campaign_id, kind)
);

create table leads (
  id text primary key,
  blob_key text,
  campaign_id text,
  name text,
  owner_name text,
  contact_name text,
  email text,
  email_key text,                  -- lower-cased address
  email_source text,               -- google_maps, site_check, browser, manual, ...
  phone text,
  website text,
  website_key text,                -- website domain
  address text,
  city text,
  category text,
  rating numeric,
  reviews_count int,
  time_zone text,
  status text,

  -- Flags set by a person or by a reply. A job never writes them.
  is_test boolean not null default false,
  excluded boolean not null default false,
  excluded_at timestamptz,
  excluded_reason text,
  excluded_note text,
  not_fit_kept boolean not null default false,
  do_not_contact boolean not null default false,
  do_not_contact_at timestamptz,
  do_not_contact_reason text,

  -- F7/F8: one stop state. do_not_contact and replied stop every channel; bounced stops email only.
  stop_state text not null default 'none' check (stop_state in ('none', 'do_not_contact', 'replied', 'bounced')),
  stop_reason text,
  stopped_at timestamptz,

  -- Results of checks.
  gap_score numeric,
  site_check jsonb,
  enriched_at timestamptz,
  browser_checked_at timestamptz,
  contacted_at timestamptz,

  merged_into text,                -- an approved duplicate merge (F17); the row is kept

  search text generated always as (lower(
    coalesce(name, '') || ' ' || coalesce(owner_name, '') || ' ' || coalesce(email, '') || ' ' ||
    coalesce(phone, '') || ' ' || coalesce(website, '') || ' ' || coalesce(city, ''))) stored,
  created_at timestamptz,
  updated_at timestamptz,
  data jsonb not null default '{}'
);

-- F12/F13: each social page once; several leads can point to it.
create table social_pages (
  id bigint generated always as identity primary key,
  platform text not null,
  url_norm text not null unique,
  url text not null,
  created_at timestamptz not null default now()
);

create table lead_social_links (
  lead_id text not null,
  kind text not null,              -- facebook, instagram, linkedin_company, linkedin_person, yelp, nextdoor, google_reviews
  page_id bigint references social_pages (id),
  url text not null,
  source text not null,            -- F14: site_check, browser, manual, ...
  updated_at timestamptz not null default now(),
  primary key (lead_id, kind)
);

-- F18: facts typed by hand.
create table lead_facts (
  id bigint generated always as identity primary key,
  lead_id text not null,
  fact text not null,
  source text not null default 'manual',
  noted_on date not null default current_date,
  created_at timestamptz not null default now()
);

create table lead_screenshots (
  campaign_id text not null,
  lead_id text not null,
  jpeg bytea not null,
  bytes int,
  saved_at timestamptz,
  primary key (campaign_id, lead_id)
);
