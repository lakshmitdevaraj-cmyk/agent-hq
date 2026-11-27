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

---

# P2 progress (branch `rebuild/p2-data-layer`, from `rebuild/p1-database`)

Chunk 1 prompt: `~/Documents/ShiftForge HQ/p2-reports/p2-chunk1-prompt.md`. Plan: `p2-reports/chunk1-plan.md`.

| Item | State |
|---|---|
| 1. `CLAUDE.md` | done |
| 2. `tasks/p2-plan.md` | done (111 actions mapped; fix-list definitions missing locally) |
| 3. DB client (R8) | next |
| 4. Migrations 0008+ | to do |
| 5. Equivalence harness (R13) | to do |
| Report `p2-reports/chunk1-report.md` | to do |
