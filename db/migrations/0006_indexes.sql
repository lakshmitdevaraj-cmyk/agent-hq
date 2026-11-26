-- What screens and webhooks look up. Lead id, campaign id and email id are the primary keys.

create index campaigns_search on campaigns using gin (search gin_trgm_ops);
create index campaigns_newest on campaigns (created_at desc);

create index leads_campaign_page on leads (campaign_id, created_at desc, id);
create index leads_order on leads (gap_score desc nulls last, created_at desc, id);
create index leads_email on leads (email_key);
create index leads_website on leads (website_key);
create index leads_stop_state on leads (stop_state) where stop_state <> 'none';
create index leads_search on leads using gin (search gin_trgm_ops);

create index social_links_page on lead_social_links (page_id);
create index lead_facts_lead on lead_facts (lead_id);

create index emails_campaign on emails (campaign_id, status);
create index emails_lead on emails (lead_id, step);
create index emails_to on emails (to_key);
create index emails_status on emails (status);
create index emails_review on emails (review_status) where status = 'drafted';
create index emails_message_id on emails (agentmail_message_id);
create index emails_thread_id on emails (agentmail_thread_id);

create index social_campaign on social_messages (campaign_id);
create index social_lead on social_messages (lead_id);
create index touches_lead on touches (lead_id);

create index follow_ups_due on follow_ups (due_date) where stopped_reason is null;
create index follow_ups_campaign on follow_ups (campaign_id);

create index replies_lead on replies (lead_id);
create index replies_thread on replies (agentmail_thread_id);
create index replies_message_id on replies (agentmail_message_id);
create index replies_campaign on replies (campaign_id, received_at desc);
create index replies_from on replies (from_key);

create index clicks_email on clicks (email_id);   -- the tracking link carries the email id
create index clicks_campaign on clicks (campaign_id);
create index contacts_email on contacts (email, kind);

create index activity_newest on activity (created_at desc);
create index submissions_form on submissions (form_slug, received_at desc);
create index webhook_events_hook on webhook_events (webhook_id, received_at desc);
create index voice_sessions_newest on voice_sessions (started_at desc);
