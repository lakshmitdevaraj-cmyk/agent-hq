-- F14: a value typed by hand is never overwritten by a check. Only another 'manual' write can change it.

create function keep_manual_email() returns trigger language plpgsql as $$
begin
  if old.email_source = 'manual' and new.email_source is distinct from 'manual' then
    new.email := old.email;
    new.email_key := old.email_key;
    new.email_source := old.email_source;
  end if;
  return new;
end $$;

create trigger leads_keep_manual_email before update on leads
for each row execute function keep_manual_email();

create function keep_manual_link() returns trigger language plpgsql as $$
begin
  if old.source = 'manual' and new.source is distinct from 'manual' then
    return null;   -- the whole change is dropped
  end if;
  return new;
end $$;

create trigger links_keep_manual before update on lead_social_links
for each row execute function keep_manual_link();
