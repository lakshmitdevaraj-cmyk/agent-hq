-- P2 chunk 12 (run F): X1 Tasks, X2 Voice, X3 Pages, X8 the old April forms.
-- Approved by Lakshmi on 28 Nov 2026, after the records were archived outside the repo
-- (~/agent-hq-backups/p2-removals-2026-11-28/: 7 tasks, 5 voice calls, 0 invitations, the page as a file, 2 forms,
-- 1 submission; the Gemini key in voice_config is not archived, it lives in Settings, service_config).
-- The P5 import no longer loads these stores (scripts/db/transform.mjs, load.mjs). The A2 form tables
-- (lead_forms, form_links, form_submissions) stay. No foreign key or view points at these tables.
drop table submissions;
drop table forms;
drop table pages;
drop table tasks;
drop table voice_invitations;
drop table voice_sessions;
drop table voice_config;
