-- P2 chunk 6 (F4): send_today and plan_send from 0013 took about 3 s on dev and 36 s at 1,500 leads / 6,000 emails,
-- because the settings helpers (one reads pg_timezone_names, a slow view), next_working_day and known_country were
-- worked out again for every row. Same rules and answers; the settings, the own addresses and the open countries are
-- now worked out ONCE per call into variables, and the row queries only compare plain values.

create or replace function send_today(own text[] default '{}') returns jsonb
language plpgsql stable as $$
declare
  tz text := settings_time_zone();
  lim int := settings_daily_limit();
  ownb text[] := coalesce((select array_agg(own_base(x)) from unnest(own) x), '{}');
  day0 date := (now() at time zone settings_time_zone())::date;
  t0 timestamptz;
  t1 timestamptz;
  n int;
  unknown int;
begin
  -- The day in the Settings time zone as a range of instants, so the index-friendly comparison is on sent_at itself.
  t0 := day0::timestamp at time zone tz;
  t1 := (day0 + 1)::timestamp at time zone tz;
  select count(*) into n from emails e left join leads l on l.id = e.lead_id
  where e.sent_at >= t0 and e.sent_at < t1
    and e.status not in ('drafted', 'failed', 'sending')
    and coalesce(e.agentmail_message_id, '') !~* '^mock-'
    and not coalesce(l.is_test, false)
    and not (own_base(e.to_email) = any (ownb));
  select count(*) into unknown from emails where status = 'sending';
  return jsonb_build_object('day', day0, 'time_zone', tz, 'limit', lim, 'sent_today', n, 'sending_unknown', unknown);
end $$;

create or replace function plan_send(for_day date, own text[] default '{}', for_campaign text default null) returns jsonb
language plpgsql stable as $$
declare
  t jsonb := send_today(own);
  gaps int[] := settings_email_gaps();
  postal_blank boolean := coalesce(trim((select data->>'postal_address' from outreach_settings where key = 'settings')), '') = '';
  open_countries text[];
  needs_postal text[];
  sent_n int;
  room int;
  us_open boolean := next_working_day(for_day, 'US') = for_day;
  postal_missing boolean;
  items jsonb;
begin
  -- A handful of countries: each checked once.
  select coalesce(array_agg(code), '{}') into open_countries from country_profiles where next_working_day(for_day, code) = for_day;
  select coalesce(array_agg(code), '{}') into needs_postal from country_profiles where postal_address_required and postal_blank;
  sent_n := case when for_day = (t->>'day')::date then (t->>'sent_today')::int else 0 end;
  room := greatest(0, (t->>'limit')::int - sent_n);

  with cand as materialized (
    select e.id, e.campaign_id, e.lead_id, e.step, e.framework, e.to_key, e.created_at, l.is_test,
           coalesce(cp.code, 'US') as country
    from emails e
    join leads l on l.id = e.lead_id
    join campaigns c on c.id = e.campaign_id
    left join country_profiles cp on cp.code = c.country
    where e.status = 'drafted' and not e.is_duplicate and e.review_status = 'ready'
      and l.merged_into is null and not l.excluded and not l.do_not_contact and l.stop_state = 'none'
      and (for_campaign is null or e.campaign_id = for_campaign)
  ),
  open_day as (select * from cand where country = any (open_countries)),
  firsts as (
    select p.id, p.campaign_id, p.lead_id, p.step, 'new'::text as kind, null::date as due_date, p.created_at, 0 as grp
    from open_day p
    where p.step = 1 and not (p.country = any (needs_postal))
      and (p.is_test or not exists (select 1 from emails o where o.to_key = p.to_key and o.id <> p.id
                                      and o.status not in ('drafted', 'failed') and not o.is_duplicate))
  ),
  follows as (
    select p.id, p.campaign_id, p.lead_id, p.step, 'follow_up'::text as kind,
           coalesce(case when fs.steps->(p.step::text)->>'moved_to' ~ '^\d{4}-\d{2}-\d{2}$' then (fs.steps->(p.step::text)->>'moved_to')::date end,
                    (f.sent_at at time zone 'UTC')::date + coalesce(gaps[p.step - 1], gaps[array_length(gaps, 1)], 3)) as due_date,
           p.created_at, 1 as grp
    from open_day p
    join emails f on f.lead_id = p.lead_id and f.campaign_id = p.campaign_id and f.step = 1 and f.framework = 'four-step'
                 and not f.is_duplicate and f.status not in ('drafted', 'failed', 'sending') and f.sent_at is not null
    left join follow_up_state fs on fs.lead_id = p.lead_id and fs.channel = 'email'
    where p.step > 1 and p.framework = 'four-step' and not (p.country = any (needs_postal))
      and coalesce(fs.steps->(p.step::text)->>'skipped', 'false') <> 'true'
      and not exists (select 1 from emails q where q.lead_id = p.lead_id and q.campaign_id = p.campaign_id and q.framework = 'four-step'
                        and not q.is_duplicate and q.step > 1 and q.step < p.step and q.status in ('drafted', 'failed', 'sending')
                        and coalesce(fs.steps->(q.step::text)->>'skipped', 'false') <> 'true')
  ),
  picked as (
    select x.*, row_number() over (order by x.grp, x.due_date nulls first, x.created_at, x.id) as rn
    from (select * from firsts union all select * from follows where due_date <= for_day) x
  )
  select coalesce(jsonb_agg(jsonb_build_object('email_id', id, 'campaign_id', campaign_id, 'lead_id', lead_id, 'step', step,
                                               'kind', kind, 'due_date', due_date) order by rn) filter (where rn <= room), '[]'::jsonb)
    into items
    from picked;
  postal_missing := exists (select 1 from emails e join leads l on l.id = e.lead_id join campaigns c on c.id = e.campaign_id
                            where e.status = 'drafted' and not e.is_duplicate and e.review_status = 'ready'
                              and l.merged_into is null and not l.excluded and not l.do_not_contact and l.stop_state = 'none'
                              and (for_campaign is null or e.campaign_id = for_campaign)
                              and coalesce((select cp.code from country_profiles cp where cp.code = c.country), 'US') = any (needs_postal)
                              and coalesce((select cp.code from country_profiles cp where cp.code = c.country), 'US') = any (open_countries));
  return jsonb_build_object(
    'day', for_day,
    'working_day', us_open,
    'reason', case when not us_open then 'not a working day (weekend, holiday or blackout date)' end,
    'limit', (t->>'limit')::int,
    'sent_today', sent_n,
    'room', room,
    'postal_address_missing', postal_missing,
    'items', items);
end $$;
