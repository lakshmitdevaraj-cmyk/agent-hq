# agent-hq (Alcance rebuild)

This repo is **public**. Never commit keys, connection strings, export data, real lead names or email addresses.

## Read first
- `tasks/handoff.md`: where the work stands and what to do next. Update it after every item.
- `db/README.md`: the Neon database, its tables, migrations and tests.
- `tasks/p2-plan.md`: the P2 chunks, and which chunk each action belongs to.
- `tasks/lessons.md`: past corrections. Add a line each time Lakshmi corrects you.
- `~/Documents/ShiftForge HQ/` (outside the repo): `scope-reports/` (the approved scope and inventories), `p1-reports/`, `p2-reports/`.

## Plans and reports
Save every plan and report as a file in `~/Documents/ShiftForge HQ/p2-reports/` (`pN-reports/` for later phases), e.g. `chunk1-plan.md` and `chunk1-report.md`, so Lakshmi never has to paste them. Mask email addresses.

## Working rules
- **Branch:** P2 work goes on `rebuild/p2-data-layer`. Push only that branch. Never push to `main`, and never deploy or make previews.
- **Commits:** put `[skip netlify]` in every message. Stage exact paths (never `git add -A`) and scan the staged diff before each commit.
- **Keys:** never open, print or commit `db/local/.env` (git-ignored). If a key is missing, stop and ask Lakshmi to type it into that file herself. Never ask her to paste it in chat.
- **Database:** use the Neon `dev` branch only. Never touch `production`. Migrations are forward-only: never edit an applied file, add the next number.
- **Ask Lakshmi first before you:** add a dependency, delete a file, run any netlify command, edit an existing app file (`src/`, `netlify/functions/`, `netlify.toml`), or apply a migration.
- **Sub-agents:** Haiku for searching, reading code, logs and test output, and checking. Sonnet for building a fully specified item with its tests. Keep security, migrations, decisions and reviews in the main session. A sub-agent's "done" is a claim: check it before reporting.
- **Work in small steps:** one item at a time. Commit and push it, then update `tasks/handoff.md`, so a fresh session can carry on.
- **Nothing is done until it has been shown working.** For security checks, show the bad case being refused, not just that a setting exists.

## Commands
    node --test --test-concurrency=1 scripts/db/test/*.test.mjs
    npx tsc -b                      # the real type check; `tsc --noEmit` checks nothing here
    node scripts/db/check.mjs dev
    node scripts/db/migrate.mjs dev
