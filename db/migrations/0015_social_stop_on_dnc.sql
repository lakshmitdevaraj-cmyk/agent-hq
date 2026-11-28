-- P2 chunk 8, F30: when a lead becomes do-not-contact (an opt-out reply, a spam complaint, the flag set by hand),
-- every social step of that lead that is not sent yet is marked skipped, so no path can copy or mark it as sent.
-- It lives in the database so every writer is covered (leads.update, the opt-out ingest, the complaint webhook).
-- Sent steps are history and are never touched. Clearing do-not-contact does not bring the steps back.

create function skip_social_on_dnc() returns trigger
language plpgsql as $$
begin
  if (new.stop_state = 'do_not_contact' or new.do_not_contact)
     and not (coalesce(old.stop_state, '') = 'do_not_contact' or coalesce(old.do_not_contact, false)) then
    update social_messages
       set status = 'skipped', skipped = true, updated_at = now(),
           data = data || jsonb_build_object('skipped_reason', 'do_not_contact')
     where lead_id = new.id and sent_at is null and status <> 'sent' and not skipped;
  end if;
  return new;
end $$;

create trigger leads_skip_social_on_dnc
  after update of stop_state, do_not_contact on leads
  for each row execute function skip_social_on_dnc();

-- The leads that are already do-not-contact.
update social_messages s
   set status = 'skipped', skipped = true, updated_at = now(),
       data = s.data || jsonb_build_object('skipped_reason', 'do_not_contact')
  from leads l
 where l.id = s.lead_id and (l.stop_state = 'do_not_contact' or l.do_not_contact)
   and s.sent_at is null and s.status <> 'sent' and not s.skipped;
