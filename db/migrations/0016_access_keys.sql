-- P2 chunk 9, R6 / V8: access keys with limits, and revoke. A key is stored only as its SHA-256 hash (it is shown once,
-- when it is made); key_hint is its last 4 characters, to tell keys apart in the list.
--   master: everything (scope 'full'). agent: 'read' (read only), 'drafts' (read and write drafts), 'send' (also send
--   email and spend: lead finding, site checks). What each action needs is in netlify/functions/lib/sql/access.ts.
-- At P5 the master key and the agent keys are made again (they were never exported).

create table access_keys (
  id text primary key,
  key_hash text not null unique,
  key_hint text not null,
  kind text not null check (kind in ('master', 'agent')),
  agent_id text,
  scope text not null check (scope in ('full', 'read', 'drafts', 'send')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  check ((kind = 'master') = (scope = 'full')),
  check (kind = 'master' or agent_id is not null)
);
create index access_keys_agent on access_keys (agent_id);
create index access_keys_live_master on access_keys (kind) where revoked_at is null;
