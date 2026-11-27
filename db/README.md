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

**P2 changes (0008–0010):** US `postal_address_required` is now `true` (R9): when it is blank, warn and don't send. `purge_old_records(as_of)` (V9) deletes raw `webhook_events` and "webhook received" History entries older than 30 days, other `system` History entries older than 90 days, and keeps everything else (outreach and email entries forever). It is not scheduled yet. The failed-send reason (R2) already has a column: `emails.error`.

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

**Equivalence checks (R13):** `scripts/db/equiv/` runs an action two ways and compares the answers. The old way is the real `command.ts` bundled with Blobs swapped for the P1 export (read only; writes stay in memory) and every network route blocked (fetch, http/https/net/tls/child_process). The new way is its SQL version on `dev`, in a read-only transaction that is rolled back. Key order and timestamps are ignored. Intended differences are listed per case with a reason, matched narrowly, and still reported. One case so far: `cases/campaign-list.mjs`. The export is read at test time from `~/agent-hq-backups/p1-2026-11-26/` and never committed; the tests skip if it is missing.

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
