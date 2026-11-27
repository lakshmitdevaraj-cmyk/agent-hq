# Alcance database (Neon Postgres)

P1: tables, indexes and import. The app does not use this database yet.

Neon project `alcance`, AWS US East 2 (Ohio). Branches: `production` (stays empty until P5), `dev` (work), `perf` (made for speed tests, then deleted).

## Connection strings

`db/local/.env` (git-ignored; check with `git check-ignore -v db/local/.env`): `DEV_DATABASE_URL`, `DEV_DIRECT_URL`, `PERF_DATABASE_URL`, `PERF_DIRECT_URL`, `ALCANCE_MASTER_KEY`, `NETLIFY_PROJECT_ID`. Never print, log or commit them.

**For P2:** the `postgres` driver turns certificate checking off when a string says `sslmode=require`, as Neon's do. The app must pass `ssl: { rejectUnauthorized: true }` itself (see `scripts/db/env.mjs`). The scripts also look up `*.neon.tech` through public DNS, because one home router refuses those names; the app does not need that.

## App connection (P2)

`netlify/functions/lib/db/client.ts` is the app's one client. It reads `DATABASE_URL` (the pooled string), always checks the certificate and host name (whatever `sslmode` says), uses `prepare: false` for the pooler, and limits the connect time to 5 s and each query to 8 s. Neon's pooler ignores a `statement_timeout` sent when connecting, so `withTx(fn)` sets it per transaction and `timed(query)` cancels a single query from the client side. Proof: `scripts/db/test/db-client.test.mjs`, where a fake server with a self-signed or wrong-name certificate is refused.

## Migrations

Plain SQL in `db/migrations`, forward only. Never edit an applied file; add the next number.

    node scripts/db/migrate.mjs dev

## Tables

| Tables | Holds |
|---|---|
| `campaigns`, `campaign_jobs` | campaign settings; job progress, one row per job type |
| `leads` | one row per lead: contact fields, flags, `stop_state`, `merged_into`, time zone |
| `social_pages`, `lead_social_links` | each page once (normalised address); which leads link to it, and the `source` |
| `lead_facts`, `lead_screenshots` | facts about a lead; screenshots |
| `emails`, `social_messages` | drafts and sends; one live draft per lead (and channel) and step; `written_by` |
| `touches`, `follow_up_state`, `follow_ups` | contact log; per-lead follow-up settings; next due step (worked out) |
| `replies`, `clicks`, `contacts` | replies with their `kind`; link clicks; addresses already sent to or bounced |
| `outreach_settings`, `service_config` | settings; service keys' status (filled at P5) |
| `country_profiles`, `public_holidays`, `blackout_dates` | sending rules; `next_working_day(date, country)` |
| `outbox` | handoffs to other systems (the CRM), written in the same transaction as the change; `sent_at` null until delivered (R12, 0009) |
| `activity`, `tasks`, `agents`, `forms`, `submissions`, `pages` | the rest of HQ |
| `webhooks`, `webhook_events`, `voice_config`, `voice_sessions`, `voice_invitations` | webhooks and voice |

Ids are the same as today. Fields without a column are kept in `data`.

**P2 changes (0008–0010):** US `postal_address_required` is now `true` (R9): when it is blank, warn and don't send. `purge_old_records(as_of)` (V9) deletes raw `webhook_events` and "webhook received" History entries older than 30 days, other `system` History entries older than 90 days, and keeps everything else (outreach and email entries forever). It is not scheduled yet. The failed-send reason (R2) already has a column: `emails.error`. **0011:** a campaign with no `any_trade` means true, as in the live app (`!== false`). The column default is now `true`, the 9 campaigns from before 19 Nov 2026 that the import had set to `false` are `true` on `dev`, and `transform.mjs` imports a missing value as `true`.

`stop_state` is the first that applies: `do_not_contact`, `replied` (a real person), `bounced` (a real bounce of the current address; stops email only), `none`. A failed send is never a bounce.

## Export and import

The export holds real names and emails. It stays in `~/agent-hq-backups/p1-<date>/`, never in the repo.

    node scripts/db/export.mjs counts
    node scripts/db/export.mjs export
    node scripts/db/export-cli.mjs list <export folder>
    node scripts/db/export-cli.mjs export <export folder>
    node scripts/db/verify-export.mjs <export folder>
    node scripts/db/import.mjs <export folder> dev
    node scripts/db/reports.mjs <export folder>
    node scripts/db/proofs.mjs <export folder>

`export.mjs` calls only `data.counts` and `data.export`. The Netlify CLI is used only through `netlify-read.mjs` (`blobs:list`, `blobs:get`). Reports go to `../p1-reports/`, with addresses masked.

The import is repeatable. It applies only what is in `<export folder>/decisions.json`: lead merges (the row is kept and marked) and email step fixes. `decide.mjs` wrote the changes approved on 26 November 2026. **At P5, look at the new export's findings before running it again: the approval covered the rows seen then.**

## Speed test

Make a Neon branch `perf` from `production`, add its two strings, then:

    node scripts/db/migrate.mjs perf
    node scripts/db/seed-perf.mjs
    node scripts/db/bench.mjs

Delete the branch afterwards.

## Tests

    node --test --test-concurrency=1 scripts/db/test/*.test.mjs

Database tests run on `dev` in transactions that are rolled back.

**Equivalence checks (R13):** `scripts/db/equiv/` runs an action two ways and compares the answers. The old way is the real `command.ts` bundled with Blobs swapped for the P1 export (read only; writes stay in memory) and every network route blocked (fetch, http/https/net/tls/child_process). The new way is its SQL version on `dev`, in a read-only transaction that is rolled back. Key order and timestamps are ignored. Intended differences are listed per case with a reason, matched narrowly, and still reported. Cases: `cases/campaign-list.mjs` (chunk 1 proof) and the chunk 2 campaign cases. `openNew().callWrite` runs a write in a transaction that is rolled back; `openOld(dir, { commit })` bundles `command.ts` as it was at a commit; `{ allowDb: true }` lets only net/tls through, for the SQL route of the handler. The export is read at test time from `~/agent-hq-backups/p1-2026-11-26/` and never committed; the tests skip if it is missing.

## App data layer (P2)

`netlify/functions/lib/sql/<area>.ts`: each action's SQL version, a plain function taking `sql` (a client or a transaction). `command.ts` calls it only when `DATA_BACKEND=sql`; unset (or any other value) keeps the Blobs code, unchanged, until P5.

**Chunk 2, `lib/sql/campaigns.ts`:** `outreach.campaign.create/list/get/update/delete` and `outreach.leads.count`.
- `list` and `get` are one statement. Counters come from the emails (same rules as `deriveCampaign`), and the lead count leaves out merged leads (F17). **S0:** `list` takes `q` (name, niche, area; the `campaigns_search` trigram index works from 3 characters), `filter` (`active`: a running job, searching or sending, or unsent drafts; `has_replies`; `followups_due`: a due row in `follow_ups`, not stopped, lead not merged, today in the campaign's time zone), `sort` (`newest` default, `name`, `replies`) and `limit` (1–200). No new migration: the indexes from 0006 cover it.
- **F2:** settings live in `campaigns`, job progress in `campaign_jobs`. `update` sets only the columns it is given (`data` merged with `||`). Job writers (`writeJob`, `writeLeadsJob`, for chunks 4, 5 and 8) never read or write the campaigns row. The old Blobs `campaign.run` / `campaign.sync` still write the whole record (the live F2 bug) until chunk 4 moves them.
- `delete` removes the campaign, its leads (merged too), unsent drafts, jobs, screenshots, social drafts and `follow_ups` rows; sent emails stay. Touches, follow-up settings, facts and social links stay, as in Blobs (settle with R10).
- `lib/sql/area.ts`: country and time zone from the area, the import's rule.

Tests: `campaigns-sql`, `campaigns-f2`, `campaigns-equiv` (R13 cases in `scripts/db/equiv/cases/campaign-*.mjs`, `leads-count.mjs`), `backend-switch` (switch unset = `command.ts` at `4f9338c`).

**Chunk 3, `lib/sql/leads.ts` and `lib/sql/search.ts`:** `outreach.leads.list`, `lead.set_email`, `leads.update`, `prospects.list`, `lead.screenshot.get`, `leads.delete`, `lead.fb_checked`, and four new actions (SQL only; on Blobs they answer `Unknown action` as before): `outreach.lead.facts.list/add/delete`, `outreach.search`.
- `leadRecord(row)` rebuilds the old lead record from its columns and `data`, plus `stop_state`. Merged leads are never listed and are "not found" for writes (F17).
- **F16:** one email edit. `leads.update` takes `email` too; it and `set_email` share `writeEmail`, which sends every unsent draft of the lead (any campaign) to the new address, or removes them when the address is cleared. Sent emails are never touched. Writes set only their own columns (`data` merged with `||`).
- **F18:** `lead_facts` (fact, `source` manual / site_check / google / browser, `noted_on`); only hand-typed facts can be removed. Prospects rows carry `facts`.
- **Prospects (S0/S6b):** no `limit` = every lead as today; `limit` 1–500 = one page `{ rows, next_cursor }` (keyset on `leads_order`); `q` searches name, owner, email, phone, website and city (`leads_search`); `campaign_id` filters. Two statements per page: the page, then everything else for that page's leads in one statement (no store read whole, F4). Social links come from `lead_social_links`. The SQL list does not re-check drafts on read (moved to chunk 5).
- **Global search (S6b):** `searchAll`: campaigns and leads, 2–200 characters, up to 50 each.
- `lib/sql/leadrules.ts`: copies of four helpers private to `command.ts` (`campaignSkipCtx`, `withoutJunkEmail`, `autoNotFit`, `NOT_FIT_REASONS`), identical bodies; the only copy once the Blobs code goes.

Tests: `leads-sql`, `leads-equiv` (cases in `scripts/db/equiv/cases/leads.mjs`), `backend-switch` (chunk 3 part: switch unset = `command.ts` at `4e2eecb`). `scripts/db/equiv/ts-ext.mjs` (test harness only) lets Node load the app's `lib/` files, which use extensionless imports.

**Chunk 4, `lib/sql/leadgen.ts`, `addlead.ts`, `fitflags.ts`:** `outreach.campaign.run`, `campaign.sync`, `leads.add_test`, `leads.enrich_one`, `leads.check_site`, `browsercheck.plan`, `browsercheck.start`, and the new SQL-only `outreach.leads.add` (A1).
- **No network in `lib/sql/`:** the Apify calls, the website check and the lead helpers private to `command.ts` are passed in as `deps` by the guarded helper `sqlLeadgenCase`. A refusal marked `keep` (a failed run saved as failed) keeps its writes; any other refusal rolls back, so a failed import leaves nothing half done.
- **F2:** run, sync and add_test write the `leads` job only (`writeLeadsJob`), never the campaigns row. The sync's import claim is one `update … where`, so two syncs can't import twice. The sync no longer refreshes email statuses from AgentMail (chunks 6–7).
- **F3:** a site check writes only site fields (`site_check`, `gap_score`, `enriched_at`, other result keys in `data`), never a flag, never over a hand-typed owner name, email (0007) or link (links trigger). Links go to `lead_social_links` with source `site_check`.
- **A1:** `addLeads` (single, paste, CSV) checks every row across all campaigns on email, website, phone and link (Google Maps place id or link; Facebook / Instagram / LinkedIn page) and adds no duplicate; nothing is fetched. **Migration 0012:** indexes `leads_phone_key` (last 10 digits) and `leads_place_id` (`data->'raw'->>'placeId'`).
- **F32/F33:** `leadFlags(lead)` (chain, not_home_service, too_big, has_answering_booking, not_call_driven, template_site), worked out on read and shown as `fit_flags` on lead and Prospects rows; `draftAllowed(lead)` (no flag, or kept by her) is for drafting in chunk 5. The fix list's named cases are checked from `~/agent-hq-backups/p2-named-cases.json`, outside the repo.

Tests: `leadgen-sql`, `leadgen-equiv` (cases in `scripts/db/equiv/cases/leadgen.mjs`; the old path gets a made-up Apify key and `fetchRoutes` answering made-up Apify and website responses; the SQL side gets the same private functions from `openPrivates`), `addlead`, `fitflags`, `backend-switch` (chunk 4 part: `ee91060`).

Flag fix (27 Nov, after the chunk 4 review): `not_call_driven` = custom builders and design-build firms (main category, name, Google's full category list `raw.categories`, or the owner's description), shops, suppliers, wholesale and rentals; never a general remodeler. `has_answering_booking` = a booking tool plus a chat widget or a real answering service (`site_check.answering_service`, a P4 fact); "24/7" wording never counts.

**Chunk 5, `lib/sql/emails.ts`, `emailchecks.ts`:** `outreach.emails.list`, `.create`, `.update`, `.delete`, `outreach.footer.preview`, `outreach.draft.start`, `outreach.emails.review.start` (and `.generate_one`, `.generate`, tested with a stand-in writer).
- **F9:** `create` on a step with an unsent draft updates that draft (`replaced: true`, same id); a step already sent answers 409 `draft_exists` with `email_id`. The insert is `on conflict do nothing` on `emails_one_per_step`, so a race also answers 409, never a 500.
- **A4 / F46:** `create` never gets an AI dependency. `written_by` is `lakshmi` from the app, `claude` from an agent key; the free code checks run on save (`codeCheckDraft`, the twin of `codeCheckSavedEmail`).
- **F32:** drafting calls `draftAllowed`: a flagged lead is refused (`fit_flagged`) or left out of the plan; an agent's `create` too. Her own `create` is allowed and returns the flags.
- **R9:** `footer.preview` adds `postal_address_missing` and a warning when the country needs a postal address and Settings has none.
- **Not yet on SQL:** the AI writer. Under `DATA_BACKEND=sql`, `generate_one` and `generate` answer 501 until the P4 runners (F43); `draft.start` / `review.start` plan and record the job, but the `ai-background` worker still reads Blobs, so the switch must not flip before P4.

Tests: `emails-sql`, `emails-equiv` (cases in `scripts/db/equiv/cases/emails.mjs`), `backend-switch` (chunk 5 part: `bc04e1e`). Timing script: `scripts/db/bench-emails.mjs` (database time from `EXPLAIN ANALYZE` and time from this Mac).

## At the P5 switch

- **Type these in again in Settings:** the Gemini key, the service keys and the agent keys. They were removed from the export and never go into the database from it.
- Import into `production` from a fresh export.

## Left for P2

No foreign keys yet, because some rows point to things that no longer exist. Once those are sorted, add:

- `campaign_jobs.campaign_id`, `leads.campaign_id`, `emails.campaign_id` to `campaigns`
- `emails.lead_id`, `social_messages.lead_id`, `touches.lead_id`, `follow_up_state.lead_id`, `follow_ups.lead_id`, `lead_social_links.lead_id`, `lead_facts.lead_id`, `lead_screenshots.lead_id`, `leads.merged_into` to `leads`
- `replies.campaign_id`, `replies.lead_id`, `replies.original_email_id`, `clicks.email_id`, `follow_ups.email_id` to `campaigns`, `leads` and `emails`
- `submissions.form_slug` to `forms`, `webhook_events.webhook_id` to `webhooks`

**Still blocked (27 Nov 2026, P2 chunk 1):** the orphans in `p1-reports/orphans-and-clashes.md` are still in `dev`: 10 leads and 12 emails whose campaign is gone, 4 emails whose lead is gone, 16 replies with no campaign and 14 with no lead, and 6 contact entries for a gone campaign. Most are test rows or bounce and system reports. Each needs a decision (delete, keep and null the link, or a placeholder campaign) before the keys can be added.

Also: save the error when a send fails (today it is only shown on screen), and make every screen and count leave out merged leads (`merged_into is null`).
