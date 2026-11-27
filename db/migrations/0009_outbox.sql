-- R12: an outbox, so a handoff to another system (the CRM, P6) is written in the same transaction as the change
-- that causes it and is never lost. A worker sends unsent rows and records each try.

create table outbox (
  id bigint generated always as identity primary key,
  kind text not null,                          -- what to send, e.g. 'crm.lead_interested'
  payload jsonb not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,                         -- null until delivered
  attempts int not null default 0 check (attempts >= 0),
  last_error text                              -- why the last try failed
);

create index outbox_unsent on outbox (created_at) where sent_at is null;
