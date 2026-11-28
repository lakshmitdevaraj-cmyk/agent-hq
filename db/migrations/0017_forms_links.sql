-- P2 chunk 10: forms (A2), the links library (A3) and signed click links (R7).
-- The old April forms stay in `forms` / `submissions` as they are (X8 removes them in chunk 12).

-- A2: forms she builds. A personal link per lead is a random token in form_links.
create table lead_forms (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  title text not null,
  description text not null default '',
  fields jsonb not null default '[]',
  thank_you text not null default '',
  campaign_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table form_links (
  token text primary key check (token ~ '^[A-Za-z0-9_-]{22}$'),
  form_slug text not null references lead_forms (slug) on delete cascade,
  lead_id text not null,
  created_at timestamptz not null default now(),
  unique (form_slug, lead_id)
);

-- Submissions to A2 forms and to the old April forms (form_slug is either). ip_hash is a SHA-256 of the address,
-- kept only for the rate limit; the address itself is never stored.
create table form_submissions (
  id text primary key,
  form_slug text not null,
  lead_id text,
  data jsonb not null default '{}',
  spam boolean not null default false,
  spam_reason text,
  ip_hash text,
  link_token text,
  received_at timestamptz not null default now()
);
create index form_submissions_form on form_submissions (form_slug, received_at desc);
create index form_submissions_ip on form_submissions (ip_hash, received_at);
create index form_submissions_token on form_submissions (link_token, received_at) where link_token is not null;

-- A3: the links library.
create table link_library (
  id text primary key,
  name text not null,
  type text not null default 'other' check (type in ('site', 'booking', 'demo', 'video', 'doc', 'other')),
  url text not null check (url ~* '^https?://'),
  niche text,
  note text,
  utm jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- R7: one row per link in a sent email. The click reads the destination from here, never from the token.
create table click_links (
  token text primary key check (token ~ '^[A-Za-z0-9_-]{22}$'),
  email_id text not null,
  campaign_id text,
  lead_id text,
  url text not null check (url ~* '^https?://'),
  created_at timestamptz not null default now()
);
create index click_links_email on click_links (email_id);
