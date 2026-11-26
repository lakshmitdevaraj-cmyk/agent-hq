-- F10: country rules as data. Only the US is seeded. Footer and opt-out wording are today's (lib/outreach.ts).
-- The send window comes from the migration requirements (today's code has none).

create table country_profiles (
  code text primary key,
  name text not null,
  default_time_zone text not null,
  time_zones jsonb not null,                  -- state -> time zone, to place a lead
  send_window_start time not null,
  send_window_end time not null,
  working_days int[] not null,                -- ISO days, 1 = Monday
  spelling text not null,
  date_format text not null,
  phone_format text not null,
  currency text not null,
  footer_signoff text not null,
  footer_signature text not null,
  opt_out_line text not null,
  postal_address_required boolean not null    -- false: as today, the address is added only when one is saved
);

create table public_holidays (
  country text not null references country_profiles (code),
  day date not null,
  name text not null,
  primary key (country, day)
);

-- Days nothing is sent, on top of weekends and holidays. country null = every country.
create table blackout_dates (
  id bigint generated always as identity primary key,
  country text references country_profiles (code),
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  note text
);

-- The date itself when it is a working day, otherwise the next one.
create function next_working_day(from_day date, for_country text) returns date
language plpgsql stable as $$
declare
  days int[];
  d date := from_day;
begin
  select working_days into days from country_profiles where code = for_country;
  if days is null then raise exception 'unknown country: %', for_country; end if;
  for i in 1..400 loop
    if extract(isodow from d)::int = any (days)
       and not exists (select 1 from public_holidays h where h.country = for_country and h.day = d)
       and not exists (select 1 from blackout_dates b where (b.country is null or b.country = for_country) and d between b.starts_on and b.ends_on)
    then
      return d;
    end if;
    d := d + 1;
  end loop;
  raise exception 'no working day within 400 days of % for %', from_day, for_country;
end $$;

insert into country_profiles values (
  'US', 'United States', 'America/Chicago',
  '{"AL":"America/Chicago","AK":"America/Anchorage","AZ":"America/Phoenix","AR":"America/Chicago","CA":"America/Los_Angeles","CO":"America/Denver","CT":"America/New_York","DE":"America/New_York","DC":"America/New_York","FL":"America/New_York","GA":"America/New_York","HI":"Pacific/Honolulu","ID":"America/Boise","IL":"America/Chicago","IN":"America/Indiana/Indianapolis","IA":"America/Chicago","KS":"America/Chicago","KY":"America/New_York","LA":"America/Chicago","ME":"America/New_York","MD":"America/New_York","MA":"America/New_York","MI":"America/Detroit","MN":"America/Chicago","MS":"America/Chicago","MO":"America/Chicago","MT":"America/Denver","NE":"America/Chicago","NV":"America/Los_Angeles","NH":"America/New_York","NJ":"America/New_York","NM":"America/Denver","NY":"America/New_York","NC":"America/New_York","ND":"America/Chicago","OH":"America/New_York","OK":"America/Chicago","OR":"America/Los_Angeles","PA":"America/New_York","RI":"America/New_York","SC":"America/New_York","SD":"America/Chicago","TN":"America/Chicago","TX":"America/Chicago","UT":"America/Denver","VT":"America/New_York","VA":"America/New_York","WA":"America/Los_Angeles","WV":"America/New_York","WI":"America/Chicago","WY":"America/Denver"}',
  '08:00', '10:00', '{1,2,3,4,5}', 'en-US', 'MM/DD/YYYY', '(NNN) NNN-NNNN', 'USD',
  'Best,', 'ShiftForge AI',
  'If you would rather not hear from me, just reply "no thanks" and I won''t email you again.',
  false
);

-- The days US home-service offices are really closed (calendar dates).
insert into public_holidays (country, day, name)
select 'US', day::date, name from (values
  ('2026-01-01', 'New Year''s Day'), ('2026-05-25', 'Memorial Day'), ('2026-07-04', '4 July'), ('2026-09-07', 'Labor Day'),
  ('2026-11-26', 'Thanksgiving'), ('2026-11-27', 'Day after Thanksgiving'), ('2026-12-24', 'Christmas Eve'), ('2026-12-25', 'Christmas Day'),
  ('2027-01-01', 'New Year''s Day'), ('2027-05-31', 'Memorial Day'), ('2027-07-04', '4 July'), ('2027-09-06', 'Labor Day'),
  ('2027-11-25', 'Thanksgiving'), ('2027-11-26', 'Day after Thanksgiving'), ('2027-12-24', 'Christmas Eve'), ('2027-12-25', 'Christmas Day')
) as h (day, name);

insert into blackout_dates (country, starts_on, ends_on, note) values
  (null, '2026-11-26', '2026-11-29', 'Thanksgiving'),
  (null, '2026-12-21', '2027-01-01', 'Christmas and New Year');
