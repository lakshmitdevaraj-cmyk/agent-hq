-- P2 chunk 6 (C2): the two plan actions are one database call each.
--   send_today(own)              how many real emails went out today, and the daily limit
--   plan_send(day, own, camp)    which drafts to send on a day: email 1s first, then due follow-ups, up to the room left
-- `own` is the list of the sender's own addresses (OWN_ADDRESSES in lib/replies.ts, a constant in the code, not data).
-- Both only read. Nothing is sent from here.

-- Settings helpers (the same fallbacks as lib/sendcount.ts and lib/fourstep.ts).
create function settings_time_zone() returns text
language sql stable as $$
  select coalesce((select s.data->>'time_zone' from outreach_settings s
                   where s.key = 'settings' and exists (select 1 from pg_timezone_names z where z.name = s.data->>'time_zone')),
                  'Asia/Kolkata')
$$;

create function settings_daily_limit() returns int
language sql stable as $$
  select coalesce((select (s.data->>'daily_send_limit')::int from outreach_settings s
                   where s.key = 'settings' and s.data->>'daily_send_limit' ~ '^\d{1,5}$'
                     and (s.data->>'daily_send_limit')::int between 1 and 10000), 30)
$$;

-- Days after email 1 for follow-up 1, 2, 3 (default 3, 8, 15).
create function settings_email_gaps() returns int[]
language sql stable as $$
  select coalesce((select array_agg(g.v::int order by g.n) from outreach_settings s,
                     jsonb_array_elements_text(s.data->'follow_up_gaps_email') with ordinality g(v, n)
                   where s.key = 'settings' and jsonb_typeof(s.data->'follow_up_gaps_email') = 'array'
                     and jsonb_array_length(s.data->'follow_up_gaps_email') > 0
                     and not exists (select 1 from jsonb_array_elements_text(s.data->'follow_up_gaps_email') x
                                     where x !~ '^\d{1,3}$' or x::int not between 1 and 120)),
                  array[3, 8, 15])
$$;

-- The bare address, with name+tag@gmail.com counted as name@gmail.com (isOwnAddress).
create function own_base(addr text) returns text
language sql immutable as $$
  select regexp_replace(lower(trim(coalesce(substring(addr from '[^<>[:space:]]+@[^<>[:space:]]+'), ''))),
                        '^([^@+]+)\+[^@]*@(gmail\.com|googlemail\.com|yahoo\.com)$', '\1@\2')
$$;

-- A country the profiles know, else US (next_working_day refuses an unknown one).
create function known_country(c text) returns text
language sql stable as $$
  select coalesce((select code from country_profiles where code = c), 'US')
$$;

create function send_today(own text[] default '{}') returns jsonb
language sql stable as $$
  with z as (select settings_time_zone() as tz),
  ownb as (select array_agg(own_base(x)) as a from unnest(own) x)
  select jsonb_build_object(
    'day', (now() at time zone z.tz)::date,
    'time_zone', z.tz,
    'limit', settings_daily_limit(),
    'sent_today', (select count(*) from emails e left join leads l on l.id = e.lead_id
                   where e.status not in ('drafted', 'failed', 'sending') and e.sent_at is not null
                     and (e.sent_at at time zone z.tz)::date = (now() at time zone z.tz)::date
                     and coalesce(e.agentmail_message_id, '') !~* '^mock-'
                     and not coalesce(l.is_test, false)
                     and not (own_base(e.to_email) = any (coalesce(ownb.a, '{}')))),
    'sending_unknown', (select count(*) from emails where status = 'sending'))
  from z, ownb
$$;

create function plan_send(for_day date, own text[] default '{}', for_campaign text default null) returns jsonb
language sql stable as $$
  with st as (select (select data from outreach_settings where key = 'settings') as s),
  today as (select send_today(own) as t),
  gaps as (select settings_email_gaps() as g),
  cand as (
    select e.id, e.campaign_id, e.lead_id, e.step, e.framework, e.to_key, e.created_at, l.is_test,
           known_country(c.country) as country
    from emails e
    join leads l on l.id = e.lead_id
    join campaigns c on c.id = e.campaign_id
    where e.status = 'drafted' and not e.is_duplicate and e.review_status = 'ready'
      and l.merged_into is null and not l.excluded and not l.do_not_contact and l.stop_state = 'none'
      and (for_campaign is null or e.campaign_id = for_campaign)
  ),
  open_day as (select * from cand where next_working_day(for_day, cand.country) = for_day),
  postal as (
    select o.*, (p.postal_address_required and coalesce(trim(st.s->>'postal_address'), '') = '') as postal_missing
    from open_day o join country_profiles p on p.code = o.country, st
  ),
  firsts as (
    select p.id, p.campaign_id, p.lead_id, p.step, 'new'::text as kind, null::date as due_date, p.created_at, 0 as grp
    from postal p
    where not p.postal_missing and p.step = 1
      and (p.is_test or not exists (select 1 from emails o where o.to_key = p.to_key and o.id <> p.id
                                      and o.status not in ('drafted', 'failed') and not o.is_duplicate))
  ),
  follows as (
    select p.id, p.campaign_id, p.lead_id, p.step, 'follow_up'::text as kind,
           coalesce(case when fs.steps->(p.step::text)->>'moved_to' ~ '^\d{4}-\d{2}-\d{2}$' then (fs.steps->(p.step::text)->>'moved_to')::date end,
                    (f.sent_at at time zone 'UTC')::date + coalesce(gaps.g[p.step - 1], gaps.g[array_length(gaps.g, 1)], 3)) as due_date,
           p.created_at, 1 as grp
    from postal p
    cross join gaps
    join emails f on f.lead_id = p.lead_id and f.campaign_id = p.campaign_id and f.step = 1 and f.framework = 'four-step'
                 and not f.is_duplicate and f.status not in ('drafted', 'failed', 'sending') and f.sent_at is not null
    left join follow_up_state fs on fs.lead_id = p.lead_id and fs.channel = 'email'
    where not p.postal_missing and p.step > 1 and p.framework = 'four-step'
      and coalesce(fs.steps->(p.step::text)->>'skipped', 'false') <> 'true'
      and not exists (select 1 from emails q where q.lead_id = p.lead_id and q.campaign_id = p.campaign_id and q.framework = 'four-step'
                        and not q.is_duplicate and q.step > 1 and q.step < p.step and q.status in ('drafted', 'failed', 'sending')
                        and coalesce(fs.steps->(q.step::text)->>'skipped', 'false') <> 'true')
  ),
  -- Sends already made count only when the plan is for today (in the Settings time zone).
  sent as (select case when for_day = (t->>'day')::date then (t->>'sent_today')::int else 0 end as n from today),
  room as (select greatest(0, (today.t->>'limit')::int - sent.n) as n from today, sent),
  picked as (
    select x.*, row_number() over (order by x.grp, x.due_date nulls first, x.created_at, x.id) as rn
    from (select * from firsts union all select * from follows where due_date <= for_day) x
  )
  select jsonb_build_object(
    'day', for_day,
    'working_day', next_working_day(for_day, 'US') = for_day,
    'reason', case when next_working_day(for_day, 'US') <> for_day then 'not a working day (weekend, holiday or blackout date)' end,
    'limit', (today.t->>'limit')::int,
    'sent_today', sent.n,
    'room', room.n,
    'postal_address_missing', exists (select 1 from postal where postal_missing),
    'items', coalesce((select jsonb_agg(jsonb_build_object('email_id', id, 'campaign_id', campaign_id, 'lead_id', lead_id, 'step', step,
                                                          'kind', kind, 'due_date', due_date) order by rn)
                       from picked where rn <= room.n), '[]'::jsonb))
  from today, sent, room
$$;
