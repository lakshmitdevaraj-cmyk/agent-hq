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
| 5. README, handoff, report | `ee91060` |

**Chunk 3 is finished.** 128/128 tests, `npx tsc -b` clean. No migration. Nothing on `production`, no netlify command, no dependency added, no file deleted.

Decisions I took (to review): copies of four private helpers in `leadrules.ts`; the SQL Prospects list does not re-check drafts on read (chunk 5); paging only with `limit`; new SQL-only actions for facts and global search; lead delete removes the lead's `follow_ups` rows; writes on a merged lead answer 404; lead records gain `stop_state`, Prospects rows `facts`.

Next: chunk 4 (add lead and lead finding), same run.

## Chunk 4: Add lead and lead finding (27 Nov 2026, run A)

Plan `p2-reports/chunk4-plan.md`, report `p2-reports/chunk4-report.md`.

| Step | Commit |
|---|---|
| 1. Tests, cases, harness `fetchRoutes` / `openPrivates` (failing run in `p2-reports/chunk4-failing-run.txt`) | `9b014fe` |
| 2. Migration **0012** (phone and place-id indexes), applied to `dev`; row counts unchanged | `e992da0` |
| 3. `fitflags.ts` (F32/F33), `addlead.ts` (A1) | `c2028be` |
| 4. `leadgen.ts` (run, sync, add_test, site check with F3, browser check); `fit_flags` on lead rows | `7ae6261` |
| 5. `command.ts`: seven guarded lines, `outreach.leads.add` (SQL only), helper `sqlLeadgenCase` (31 lines added); switch proof; README, handoff, report | (this commit) |

**Chunk 4 is finished; run A is finished.** Migrations 0001–0012 are on `dev`. Nothing on `production`, no netlify command, no dependency, no file deleted. The named-case list for F32/F33 is outside the repo: `~/agent-hq-backups/p2-named-cases.json`.

Decisions I took (to review): deps passed in from `command.ts`; the SQL sync doesn't refresh email statuses (chunks 6–7); a failed import rolls back whole; flags worked out on read (`fit_flags`), drafting must call `draftAllowed` (chunk 5); `has_answering_booking` uses today's site-check signals until P4; A1 never adds a duplicate (no "add anyway"); a site check runs inside the transaction (fetch time isn't limited by the per-statement timeout; the clean version fetches outside it).

**For chunk 5:** call `draftAllowed(lead)` before drafting; re-check drafts when the rules change (chunk 3 decision). Next: run B (chunks 5 and 5b), its own session.

## Run B (27 Nov 2026): chunk 4 flag fix, chunk 5, chunk 5b

**Flag fix first** (commit `bc04e1e`): `not_call_driven` 27 → 25 leads (general remodelers out, custom builders and design-build firms in, from Google's full category list and the owner's description too); `has_answering_booking` 52 → 14 (needs chat or a real answering service; "24/7" alone no longer counts). All 8 named cases still flagged.

## Chunk 5: Drafts (run B)

Plan `p2-reports/chunk5-plan.md`, report `p2-reports/chunk5-report.md`, failing run `p2-reports/chunk5-failing-run.txt`.

| Step | Commit |
|---|---|
| 1–4. Tests, `lib/sql/emailchecks.ts`, `lib/sql/emails.ts`, equivalence cases, timing script; `command.ts`: nine guarded lines and helper `sqlEmailCase` (28 lines added); switch proof; README, handoff | `12fa871` |

Decisions I took (to review): her own `create` is allowed on a flagged lead (writing it is her say-so), an agent's is refused; `create` refuses a do-not-contact lead; a failed row never blocks a new draft; `generate_one` / `generate` answer 501 on the SQL path until the P4 runners give them the AI writer; the `ai-background` worker is unchanged (P4), so the switch must not flip before P4.

**From now on, timings are reported two ways:** database time (`EXPLAIN ANALYZE`) and time from this Mac.

## Chunk 5b: Message checks (run B)

Plan `p2-reports/chunk5b-plan.md`, report `p2-reports/chunk5b-report.md`, failing run `p2-reports/chunk5b-failing-run.txt`. Lakshmi approved the edits to `lib/messagerules.ts` and `lib/angle.ts` (27 Nov).

- **F38** (`messagerules.ts`): "N Star <Name>" and the lead's own name are left out before the rating rule; "5-star" now counts as a rating. **F39** (`angle.ts`): sameness leaves out runs of 5+ words shared with the offer or examples; "busy service schedules" is not the assistant scheduling. **`RULES_VERSION` 4 → 5.** Both behave the same on the old path (listed in the switch proof as intended).
- **F35, F36, F37, F40**: new `lib/sql/messagechecks.ts`, run on every save by `codeCheckDraft` (SQL path only). A re-check now lifts a stale "code checks" block to "Check this" (SQL path only).
- **Switch proof harness:** `old-path.mjs` now loads every `netlify/functions/` file at the base commit, so `lib/` changes show up (they could not before).
- Named cases: message cases added to `~/agent-hq-backups/p2-named-cases.json` (outside the repo).

**Run B is finished.** Next: run C (chunks 6 and 7), its own session. **For chunk 8:** the F41 named case (social reviewer) is checked there, not in 5b. **For P4:** wire the AI writer into `lib/sql/emails.ts` (`deps.writeDraft`) and move `ai-background`; then `generate_one` / `generate` stop answering 501.

## Run C (28 Nov 2026): three fixes, chunk 6 (chunk 7 not started)

**Fixes first** (commit `bb7e285`): real names out of `tasks/p2-plan.md` and `tasks/tests-8b/dataquality.test.ts` (fix-list IDs, made-up names); `lib/angle.ts` catches "our team books jobs" again (the busy/team/crew exception is their schedule only), hit and near-miss tests; `scripts/db/recheck-dryrun.mjs`: no draft changes on the list-time re-check, a fresh check would move 18 of 87 Ready drafts to Check this (F35 recipient-domain 12, greeting-from-address 8). Full suite 230/230 in 41 min.

## Chunk 6: Sending and the plan (run C)

Plan `p2-reports/chunk6-plan.md`, report `p2-reports/chunk6-report.md`.

| Step | Commit |
|---|---|
| 1–3. Migration **0013** (`send_today`, `plan_send`), `lib/sql/send.ts`, `command.ts`: three guarded lines and helper `sqlSendCase` (26 lines added); switch proof | `3807061` |
| 4–5. Campaign status on `campaign_jobs`; migration **0014** (36 s → 30 ms); send tests, equivalence, timing script | `b789f50` |
| 6. README, handoff, report | (this commit) |

Migrations 0001–0014 are on `dev`. Nothing on `production`, no netlify command, no dependency, no file deleted, no real email or AgentMail call.

Decisions I took (to review): a failed row goes again only when named in `email_ids`; no answer from AgentMail leaves the row `sending` (never re-sent on its own); the daily limit stays a warning on `emails.send`, `plan_send` respects it; `send.plan` is read only; an AgentMail "failed" label is not a bounce on the SQL path; `last_send_at` in `campaigns.data`.

**Gotcha:** the campaign's status is the `campaign_jobs` row of kind `leads`; `campaigns` has no `status` column.

**Next: chunk 7 (replies and webhooks)**, not started: R4 (AgentMail signature, raw events 30 days), V8, D2, R12 (outbox), F31, F47; `lib/sql/replies.ts`, `lib/sql/webhooks.ts`, `webhook-receive.ts` (listed in `tasks/p2-plan.md` for chunk 7). Network stays blocked in every test.
