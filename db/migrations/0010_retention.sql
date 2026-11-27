-- V9 / R4: how long records are kept. Not scheduled yet; P2 decides when it runs.
--   raw webhook events (webhook_events)                       30 days
--   "webhook received" History entries (activity, system)     30 days
--   other system History entries (activity, system)           90 days
--   everything else, including outreach and email entries    kept forever
-- A "webhook received" entry is what webhook-receive.ts writes: category 'system', summary
-- 'Webhook "<name>" received an event', details holding event_id. Both must match, so nothing else is caught.

create function is_webhook_received_entry(category text, summary text, details jsonb) returns boolean
language sql immutable as $$
  -- coalesce: a blank summary or details is "no", never null (a null would keep the row out of both deletes)
  select coalesce(category = 'system' and summary like 'Webhook "%" received an event' and details ? 'event_id', false)
$$;

create function purge_old_records(as_of timestamptz default now())
returns table (kind text, deleted bigint)
language plpgsql as $$
declare n bigint;
begin
  delete from webhook_events where received_at < as_of - interval '30 days';
  get diagnostics n = row_count; kind := 'webhook_events'; deleted := n; return next;

  delete from activity a where is_webhook_received_entry(a.category, a.summary, a.details) and a.created_at < as_of - interval '30 days';
  get diagnostics n = row_count; kind := 'activity_webhook_received'; deleted := n; return next;

  delete from activity a where a.category = 'system' and not is_webhook_received_entry(a.category, a.summary, a.details) and a.created_at < as_of - interval '90 days';
  get diagnostics n = row_count; kind := 'activity_system'; deleted := n; return next;
end $$;

comment on function purge_old_records(timestamptz) is
  'V9 retention: webhook events and "webhook received" entries 30 days, other system entries 90 days, the rest forever. Not scheduled.';
