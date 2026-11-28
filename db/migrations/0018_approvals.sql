-- P2 chunk 11 (C1): Lakshmi's say-so, kept as a record. The Alcance client's send(plan) and markReady(ids) go ahead only
-- with an approval of the right kind that covers every email, is unused and has not expired. Approvals are made by the
-- master key only (approval.create, in the app); an agent key can never make one.
create table approvals (
  id text primary key,
  kind text not null check (kind in ('send_plan', 'mark_ready')),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 500),
  note text,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz,
  used_by text,
  check (expires_at > approved_at)
);
create index approvals_open on approvals (kind, approved_at desc) where used_at is null;
