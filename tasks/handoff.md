# Handoff: Alcance P1 (database) to P2

P1 was accepted on 26 November 2026. P2 (data layer and rules) comes as its own prompt. This repo is **public**: never commit keys, connection strings, export data, real lead names or email addresses.

Read `db/README.md` too. It lists the tables.

## Where things are

| What | Where |
|---|---|
| Work so far | branch `rebuild/p1-database` (from `origin/main` at `bb1db3a`). `main` is unchanged. No app code changed |
| Neon project | `alcance`, AWS US East 2 (Ohio), Postgres 18 |
| Neon branches | `production` (empty until P5), `dev` (the imported copy). `perf` was deleted after the timings |
| Secrets | `db/local/.env`, git-ignored. Names: `DEV_DATABASE_URL`, `DEV_DIRECT_URL`, `PERF_DATABASE_URL`, `PERF_DIRECT_URL`, `ALCANCE_MASTER_KEY`, `NETLIFY_PROJECT_ID`. The two `PERF_` values point to the deleted branch. Never open, print or commit the file |
| Live export | `~/agent-hq-backups/p1-2026-11-26/` (outside the repo): one `.jsonl` per store, `manifest.json`, `decisions.json`, `import-report-dev.json` |
| Reports | `~/Documents/ShiftForge HQ/p1-reports/` (outside the repo). Lakshmi wants every report saved there, with email addresses masked |
| Netlify CLI | `~/agent-hq-backups/tools/`, used only through `scripts/db/netlify-read.mjs` |

## What P1 built

- **Migrations** `db/migrations/0001` to `0007`: extensions (`pg_trgm`), campaigns and leads, messages and replies, the other stores, countries (US profile, holidays, blackout dates, `next_working_day(date, country)`), indexes, triggers that protect manual emails and social links. All are applied to `dev`. **Never edit an applied file; add `0008` onwards.**
- **Scripts** in `scripts/db/`:

| Script | Does |
|---|---|
| `env.mjs`, `check.mjs` | connection (DNS workaround, certificate check) and a connection test |
| `migrate.mjs` | applies new migrations; refuses an edited or missing applied file |
| `export.mjs`, `export-cli.mjs`, `export-lib.mjs`, `netlify-read.mjs`, `verify-export.mjs` | read-only export of the live data, secrets removed |
| `read-export.mjs`, `transform.mjs`, `normalise.mjs`, `rules.ts`, `rules.mjs`, `load.mjs`, `import.mjs` | import; reuses the live rules from `netlify/functions/lib/` |
| `place-merges.mjs`, `decide.mjs` | records the approved clean-up |
| `reports.mjs`, `proofs.mjs`, `mask.mjs`, `queries.mjs` | reports and proofs |
| `seed-perf.mjs`, `bench.mjs` | speed test on a `perf` branch |

- **Tests** in `scripts/db/test/`: 46, all passing on 26 November. The database ones run on `dev` inside transactions that are rolled back.
- One new devDependency: `postgres`.

## How to run

    node scripts/db/check.mjs dev
    node scripts/db/migrate.mjs dev
    node --test --test-concurrency=1 scripts/db/test/*.test.mjs
    npx tsc -b
    node scripts/db/import.mjs ~/agent-hq-backups/p1-2026-11-26 dev
    node scripts/db/proofs.mjs ~/agent-hq-backups/p1-2026-11-26
    node scripts/db/reports.mjs ~/agent-hq-backups/p1-2026-11-26

`npx tsc -b` is the real type check (`tsc --noEmit` checks nothing here). The speed test is described in `db/README.md`; make a new `perf` branch from `production` first.

Re-running the import puts the export's values back over the imported rows in `dev` (manual emails and links are protected) and rebuilds `follow_ups` whole. Once P2 writes to `dev`, do not re-run it without saying so.

## Decisions applied

All are in `dev` only. The live app has not changed.

- **97 merges.** 28 pairs where one row had an email, and 69 with no email on either row but the same Google place id in the same campaign. The row is kept, with `merged_into` set. Screens and counts must leave out rows where `merged_into` is set.
- Of the 69, the row with messages, touches, follow-up records or a Facebook-checked note was kept. Where neither had any, the row holding more was kept, else the older one. No pair was left over.
- **First-send step fix** for two leads whose first email bounced and whose delivered email was stored as step 2: the delivered one is now step 1 of 1, the bounced one is marked `is_duplicate`.
- **`decisions.json`** in the export folder holds the merges and step fixes; `import.mjs` applies only what is in it. `decide.mjs` wrote it and overwrites it. At P5, look at the new export's findings before running `decide.mjs`: the approval covered the rows seen on 26 November.

**Stop state** (`leads.stop_state`), first match wins:

1. `do_not_contact`: the flag, an opt-out reply, a spam complaint, or the same address as one of these.
2. `replied`: a reply from a real person (not a test, system message or bounce report), "they replied" marked by hand, or an email marked replied with no stored reply.
3. `bounced`: a real bounce (bounce event, bounce report or bounced contact entry) of the lead's **current** address. It stops email only.
4. `none`.

**A failed send is never a bounce.**

Other agreed rules: US holidays are only New Year's Day, Memorial Day, 4 July, Labor Day, Thanksgiving and the day after, Christmas Eve and Christmas Day, plus the blackout dates in the migration. Default US time zone is America/Chicago.

## Gotchas

- **DNS:** the home router refuses `*.neon.tech`. `env.mjs` looks those names up through 1.1.1.1 and 8.8.8.8, inside the scripts only. Do not change Mac network settings.
- **Certificate checking:** the `postgres` driver turns it off for `sslmode=require`, which Neon's strings use. `env.mjs` forces `rejectUnauthorized: true`.
- **Neon's default branch is `production`**, not `main`.
- **Public repo.** Stage exact paths, never `git add -A` (`spike/` is excluded only locally), and scan the staged diff before each commit.
- **Netlify:** end commits with `[skip netlify]`. No push to `main`, no deploys or previews. Never call `data.import` on live.
- **Contact keys:** the CLI export gave `+` back as a space in six addresses. The import restores it. Whether the live store's keys hold the space was not checked.
- **Follow-up dates** in `follow_ups` use the live app's rule, so they can fall on a holiday or weekend. `next_working_day` is not applied to them.
- **Latency from India:** about two round trips per query (about 450 ms); the database itself took under 1 ms. Netlify to Neon was not measured.

## Carry-overs for P2

1. **US postal address required = true**, through a new migration (`country_profiles.postal_address_required` is now `false` for US). Check the tests and `db/README.md` for anything that assumes `false`.
2. **Foreign keys** listed under "Left for P2" in `db/README.md`. Orphan rows exist and were all kept, so sort them first (see `orphans-and-clashes.md` in the reports).
3. **Save the reason for every failed send.** Today the email stays "drafted", the error is only shown on screen, and the activity log keeps just a count.
4. **Force certificate checking in the app's connection:** `ssl: { rejectUnauthorized: true }`.

Later, at the P5 switch (after 13 December): the Gemini key, service keys and agent keys must be typed in again in Settings; they were removed from the export. Import into `production` from a fresh export.

- **P5:** move `postgres` from devDependencies to dependencies before the switch (needs Lakshmi's approval).

---

# P2 progress (branch `rebuild/p2-data-layer`, from `rebuild/p1-database`)

Chunk 1 prompt: `~/Documents/ShiftForge HQ/p2-reports/p2-chunk1-prompt.md`. Plan: `p2-reports/chunk1-plan.md`.

| Item | State |
|---|---|
| 1. `CLAUDE.md` | done |
| 2. `tasks/p2-plan.md` | done (111 actions mapped; fix-list definitions missing locally) |
| 3. DB client (R8) | done: `netlify/functions/lib/db/client.ts`, test `scripts/db/test/db-client.test.mjs` (56/56 tests pass) |
| 4. Migrations 0008+ | done: 0008 (US postal address required), 0009 (outbox), 0010 (`purge_old_records`, not scheduled) applied to `dev`. R2: `emails.error` already exists. R10 skipped: orphans remain (see `db/README.md`) |
| 5. Equivalence harness (R13) | done: `scripts/db/equiv/`, test `scripts/db/test/equiv.test.mjs`; proof on `outreach.campaign.list`. Finding: 9 campaigns have no `any_trade`, imported as false, but the old code reads them as true (needs a decision) |
| Report `p2-reports/chunk1-report.md` | done |

**Chunk 1 is finished (27 Nov 2026).** 78/78 tests, `npx tsc -b` clean. Migrations 0001–0010 are on `dev`.

Decisions made 27 Nov (after the chunk 1 report):
1. `any_trade`: missing means true. Migration **0011** (applied to `dev`) sets the default to true and fixes the 9 campaigns from before 19 Nov; `transform.mjs` imports a missing value as true (for P5). Commit `d7f9b41`.
2. Fix list: `~/Documents/ShiftForge HQ/scope-reports/alcance-master-fix-list.md`. Every R1 item is placed in `tasks/p2-plan.md`, with a new chunk **5b** (message checks F35–F40). **F32** (flags before drafting) goes in chunk 4 with F33; its site facts stay in P4.
3. `DATA_BACKEND` switch kept as planned; the old code is removed about 2 weeks after P5.

Also noted: Neon's pooler ignores `statement_timeout` sent at connect, so use `withTx` / `timed` from `lib/db/client.ts`. `postgres` is still a devDependency; moving it needs approval.

Next: chunk 2 (campaign reads and writes), see `tasks/p2-plan.md`. Add each rewritten action as a case in `scripts/db/equiv/cases/`.

## Chunk 2: campaign reads and writes (27 Nov 2026)

Prompt `p2-reports/p2-chunk2-prompt.md`, plan `p2-reports/chunk2-plan.md` (approved with decisions), report `p2-reports/chunk2-report.md`.

| Step | Commit |
|---|---|
| 1. Tests and equivalence cases first (failing run saved in the report) | `b6bc8ff` |
| 2. Reads: `lib/sql/campaigns.ts` list / get / leads.count / S0, `lib/sql/area.ts` | `7ebe3a2` |
| 3. Writes: create / update / delete, job writers, F2 | `83c6443` |
| 4. `command.ts`: six guarded lines plus a helper (22 lines added); switch proof | `e91c8d3` |
| 5. README, handoff, report | (this commit) |

**Chunk 2 is finished.** 109/109 tests, `npx tsc -b` clean. No migration. Nothing on `production`, no netlify command, no dependency added.

Decisions (27 Nov): `active` = a running job, searching or sending, or unsent drafts. Delete stays as today (touches, follow-up settings, facts and links are left for R10). No migration. No Blobs hot-fix: the live F2 bug in `campaign.run` / `campaign.sync` stays until P5. After the report: delete also removes the campaign's `follow_ups` rows (worked-out data); `follow_up_state` stays.

**For chunk 4:** move `campaign.run` / `campaign.sync` (and `leads.add_test`, which also writes the whole campaign record) to `writeLeadsJob`, never a campaign-record write. **For chunk 8:** `follow_ups` is the P1 snapshot; the `followups_due` filter reads it until chunk 8 keeps it current.

Next: chunk 3 (Leads and Prospects), its own prompt.

## Chunk 3: Leads and Prospects (27 Nov 2026, run A)

Run prompt `p2-reports/p2-runs-prompt.md` (run A = chunks 3 and 4, no stop between plan and build). Plan `p2-reports/chunk3-plan.md`, report `p2-reports/chunk3-report.md`.

| Step | Commit |
|---|---|
| 1. Tests and cases first (failing run in `p2-reports/chunk3-failing-run.txt`) | `487b9f2` |
| 2–3. Reads and writes: `lib/sql/leads.ts`, `search.ts`, `leadrules.ts`; F16, F18, paging, search | `bcb76cb` |
| 4. `command.ts`: seven guarded lines, four new SQL-only cases, a helper (26 lines added); switch proof | `f700bb3` |
| 5. README, handoff, report | (this commit) |

**Chunk 3 is finished.** 128/128 tests, `npx tsc -b` clean. No migration. Nothing on `production`, no netlify command, no dependency added, no file deleted.

Decisions I took (to review): copies of four private helpers in `leadrules.ts`; the SQL Prospects list does not re-check drafts on read (chunk 5); paging only with `limit`; new SQL-only actions for facts and global search; lead delete removes the lead's `follow_ups` rows; writes on a merged lead answer 404; lead records gain `stop_state`, Prospects rows `facts`.

Next: chunk 4 (add lead and lead finding), same run.
