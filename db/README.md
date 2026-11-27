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
| `activity`, `tasks`, `agents`, `forms`, `submissions`, `pages` | the rest of HQ |
| `webhooks`, `webhook_events`, `voice_config`, `voice_sessions`, `voice_invitations` | webhooks and voice |

Ids are the same as today. Fields without a column are kept in `data`.

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

## At the P5 switch

- **Type these in again in Settings:** the Gemini key, the service keys and the agent keys. They were removed from the export and never go into the database from it.
- Import into `production` from a fresh export.

## Left for P2

No foreign keys yet, because some rows point to things that no longer exist. Once those are sorted, add:

- `campaign_jobs.campaign_id`, `leads.campaign_id`, `emails.campaign_id` to `campaigns`
- `emails.lead_id`, `social_messages.lead_id`, `touches.lead_id`, `follow_up_state.lead_id`, `follow_ups.lead_id`, `lead_social_links.lead_id`, `lead_facts.lead_id`, `lead_screenshots.lead_id`, `leads.merged_into` to `leads`
- `replies.campaign_id`, `replies.lead_id`, `replies.original_email_id`, `clicks.email_id`, `follow_ups.email_id` to `campaigns`, `leads` and `emails`
- `submissions.form_slug` to `forms`, `webhook_events.webhook_id` to `webhooks`

Also: save the error when a send fails (today it is only shown on screen), and make every screen and count leave out merged leads (`merged_into is null`).
