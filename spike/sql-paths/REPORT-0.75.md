# Step 0.75: the five worst paths in real SQL on a free Worker (25 Nov 2026)

## Summary

**No path passes the bar at both sizes, and cold starts miss it by a wide margin. The free Worker is not recommended for the API.**

CPU in ms. Pass = median ≤ 5, 95th percentile ≤ 8, no cut-offs. Marginal = median ≤ 7 (counted as not passed). The verdict uses the worse of the two runs.

| Path (best variant) | 500 leads | 1,500 leads | Worst-run median at 500 / 1,500 |
|---|---|---|---|
| Floor (key check + one query) | marginal | marginal | 6 / 5 |
| Campaign page | marginal | marginal | 6 / 6 |
| "Delivered" webhook, one statement | **pass** | marginal | 5 / 4 |
| Tracking link, one statement | marginal | marginal | 4 / 4 |
| Send one email | fail | fail | 21 / 20 |
| Prospects A (same response, built in the Worker) | fail | fail | 90 / 219 |
| Prospects B (same response, ready-made rows) | fail | fail | 15 / 31 |
| Prospects C (page of 50, with and without search) | fail | fail | 12–31 / 18–27 |
| **Cold start** (tracking link, 500 leads) | **fail: 22–44** | – | – |

For comparison, Step 0.5 with the unchanged code: campaign page 40 ms, "delivered" webhook 40, tracking link 35, Prospects 84, sending cut off (500 leads). **SQL helps a great deal, but not enough for this bar.**

The answer does not hang on the tight bar for the worst misses: sending (about 20 ms), Prospects and cold starts are also over Cloudflare's own 10 ms limit.

## Cold starts

Three fresh deploys of the small router (286 KiB, 81 KiB gzip; Step 0.5: 738 / 200). Start-up reported by wrangler: 9–11 ms. Sources: [deploy.json](results/deploy.json), [cold.json](results/cold.json).

| Deploy | First request | Second request (also a new isolate) |
|---|---|---|
| 1 | 26 ms | 26 ms |
| 2 | 44 ms | 34 ms |
| 3 | 30 ms | 22 ms |

All six redirected correctly and all six clicks were recorded: Cloudflare let the overruns through.

Extra check, not in the plan ([cold-idle.json](results/cold-idle.json)): a new isolate that only refuses a request (401) used 0–1 ms. So the cold cost comes with running the request itself (database connection and first run of the code), not with loading a bundle. A smaller bundle alone is unlikely to fix it (my inference).

## Warm runs

30 measured calls each after one warm-up call; every call checked for having done its work, and the database counted afterwards. 26 cases, 1,147 calls in both runs, 5 cut off. Sources: [first.json](results/first.json), [heavy.json](results/heavy.json), [second.json](results/second.json), [verdicts.json](results/verdicts.json).

<!-- runs -->
| Path and variant | Leads | First run: median / p95 / worst ms | Second run (after the heavy runs) | Response bytes | Verdict (worse run) |
|---|---|---|---|---|---|
| floor | 500 | 6 / 35 / 42 | 5 / 9 / 9 | 34 | **marginal** |
| floor | 1500 | 5 / 28 / 32 | 5 / 11 / 14 | 34 | **marginal** |
| campaign page | 500 | 6 / 16 / 17 | 4 / 10 / 10 | 467 | **marginal** |
| campaign page | 1500 | 6 / 14 / 16 | 6 / 9 / 10 | 472 | **marginal** |
| webhook (plain) | 500 | 9 / 18 / 28 | not re-run (failed) | 37 | **fail** |
| webhook (plain) | 1500 | 7 / 21 / 23 | 8 / 24 / 24 | 37 | **fail** |
| webhook (combined) | 500 | 4 / 7 / 9 | 5 / 8 / 9 | 37 | **pass** |
| webhook (combined) | 1500 | 4 / 10 / 10 | 4 / 7 / 10 | 37 | **marginal** |
| tracking link (plain) | 500 | 6 / 18 / 18 | 7 / 12 / 14 | 0 | **marginal** |
| tracking link (plain) | 1500 | 6 / 15 / 15 | 6 / 13 / 16 | 0 | **marginal** |
| tracking link (combined) | 500 | 4 / 8 / 12 | 4 / 9 / 9 | 0 | **marginal** |
| tracking link (combined) | 1500 | 4 / 7 / 9 | 4 / 10 / 11 | 0 | **marginal** |
| send | 500 | 21 / 42 / 44 | not re-run (failed) | 52286 | **fail** |
| send | 1500 | 20 / 37 / 39 | not re-run (failed) | 157429 | **fail** |
| Prospects C page 1 | 500 | 31 / 56 / 72 | not re-run (failed) | 118241 | **fail** |
| Prospects C page 1 | 1500 | 20 / 46 / 87 | not re-run (failed) | 117763 | **fail** |
| Prospects C page 3 | 500 | 26 / 57 / 63 | not re-run (failed) | 118204 | **fail** |
| Prospects C page 3 | 1500 | 27 / 63 / 63 | not re-run (failed) | 119035 | **fail** |
| Prospects C search name | 500 | 14 / 27 / 30 | not re-run (failed) | 26023 | **fail** |
| Prospects C search name | 1500 | 23 / 41 / 66 | not re-run (failed) | 118978 | **fail** |
| Prospects C search 2 letters | 500 | 12 / 29 / 29 | not re-run (failed) | 35247 | **fail** |
| Prospects C search 2 letters | 1500 | 18 / 34 / 43 | not re-run (failed) | 118978 | **fail** |
| Prospects A | 500 | 90 / 208 / 237 | not re-run (failed) | 1207766 | **fail** |
| Prospects A | 1500 | 219 / 433 / 558 (cut 2/30) | not re-run (failed) | 3580906 | **fail** |
| Prospects B | 500 | 15 / 29 / 35 (cut 2/30) | not re-run (failed) | 1207766 | **fail** |
| Prospects B | 1500 | 31 / 64 / 69 (cut 1/30) | not re-run (failed) | 3580906 | **fail** |
<!-- /runs -->

How to read it:

- **Spikes decide the marginal rows.** Medians of 4–6 ms are near the bar, but the 95th percentile is often 9–18 ms. The floor's was 35 and 28 in the first run and 9 and 11 in the second, so with 30 calls this figure is noisy. A new or still-warming isolate is the likely reason (not confirmed).
- **One statement beats several.** The webhook's plain version was 7–9 ms median against 4 for the single statement; the tracking link 6–7 against 4.
- **Cut-offs were rare.** Even sending, at twice the limit, was never cut off in 30 calls. The app would probably work most days, on Cloudflare's tolerance. Step 0.5 showed that tolerance end after heavy use.
- **Run order:** the second run came after the heavy Prospects runs. Most figures were similar or better, but the combined tracking link passed in the first run at both sizes and was marginal in the second (95th percentile 9 and 10 ms), so it counts as marginal.

## Right answers first

The real production handlers and the new SQL ran side by side on the same fake data at 25 and 500 leads: **42 of 42 checks the same** (responses, changed records, redirect, outside calls). A deliberate one-value change was caught by 7 checks, so the comparison can fail. Sources: [equivalence.json](results/equivalence.json), [equivalence-control.json](results/equivalence-control.json). Timestamps and random ids are masked.

## Search

[search-explain.json](results/search-explain.json). Name searches use the trigram index. A two-letter search does not: Postgres scans the table, and forcing the index reads all of it. The CPU figures above include both. Index use costs database time, not Worker CPU; what the Worker pays for is building the rows it returns.

## What is behind the misses

- **Send** makes about ten database round trips, runs the free message checks and returns the full "not sent" list, as today. I did not trim it or try to split it.
- **Prospects C** builds 50 rows in the Worker. A version that pages **and** uses ready-made rows was not built; it might pass, but that is a guess.
- **Prospects B's price:** every write that affects a lead would have to rebuild its row. That cost is not in these numbers.

## Recommendation

1. **Do not plan M2 on the free Worker.** Webhook, tracking link, send, the floor and cold starts all miss at one size or both.
2. **Keep the API on Netlify for now**, and check its real credit use (below).
3. **The SQL work is still worth having** wherever the API runs: it removes whole-store reads, so each request does far less. M1 (tables and export/import) stays useful. This is a suggestion; the Netlify saving was not measured.

## Where else (paper only, nothing deployed, no sign-ups)

All pages fetched 25 Nov 2026.

### Keep the API on Netlify

Free plan: 300 credits a month, hard limit; when used up, **all projects on the account pause** ([how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)). Rates ([pricing](https://www.netlify.com/pricing/)): compute 10 per GB-hour, web requests 2 per 10,000, bandwidth 20 per GB, 15 per production deploy. Functions use 1,024 MB by default, with 60 s synchronous and 15 min background limits ([configuration](https://docs.netlify.com/build/functions/configuration/)); that page lists no per-request CPU limit.

Monthly estimate ([netlify-estimate.json](results/netlify-estimate.json)). **The usage figures are my assumptions, not your data**; 1 second per request is a guess.

| Use | API requests a day | Bandwidth | Deploys | Credits (compute + requests + bandwidth + deploys) |
|---|---|---|---|---|
| Light | 500 | 1 GB | 4 | 42 + 3 + 20 + 60 = **125** |
| Typical | 2,000 | 3 GB | 4 | 167 + 12 + 60 + 60 = **299** |
| Heavy | 5,000 | 5 GB | 4 | 417 + 30 + 100 + 60 = **607** (over) |

"Typical" leaves no margin. Compute is the large part, and it falls if requests get faster. Your Netlify usage page has the real figures.

### Hosts with no per-request CPU limit

| | Render free web service | Google Cloud Run free tier |
|---|---|---|
| Card needed | The page describes running without one (usage over the bandwidth allowance then suspends services) | Yes, at sign-up ([free programme](https://cloud.google.com/free/docs/free-cloud-features)) |
| Commercial use | Page says do not use free instances for production | Not checked |
| Sleep | Stops after 15 idle minutes; about 1 minute to wake | Cold-start time not checked |
| Monthly limits | 750 instance hours; services suspended when used up | 2 million requests, 180,000 vCPU-seconds, 360,000 GiB-seconds (request-based, us-central1) |
| Beyond the limit | Suspended (without a payment method) | Billed |
| Source | [Render free](https://render.com/docs/free) | [Cloud Run pricing](https://cloud.google.com/run/pricing) |

- **Render is not suitable:** a one-minute wake-up would hit people clicking a link, and Render itself says not for production.
- **Cloud Run fits technically**, but needs a card and bills past the free tier, which goes against the free-only rule. Check commercial terms and a budget cap before considering it.

## Departures from the plan

- The second run also repeated the marginal cases, not only the passes.
- Added the cold 401 check.
- Send implements the `limit` form only. `email_ids`, `sequence_position` and `allow_check` are not written; the Follow-ups page sends by `email_ids`.

## Not tested

- Inbound reply webhooks, the other "needs rewrite" actions, and re-checking old drafts.
- Several users at once; real traffic gaps; real AgentMail.
- Equivalence at 1,500 leads, and on data less uniform than the fake set.
- Any tuning of the SQL versions after measuring them.

## Cleanup

The test Worker `alcance-sql-paths` was deleted; wrangler reports it missing and its address answers 404 ([cleanup.json](results/cleanup.json)). `spike.kv` and the `s75_` tables are left in place.

## Reproduce

From `spike/sql-paths/`, with `NEON_URL` and `SQL_PATHS_TOKEN` in `spike/.dev.vars` and Step 0.5's `spike.kv` data in place: `sh scripts/build.sh load`, `sh scripts/build.sh equiv`, `sh scripts/build.sh smoke`, `node scripts/deploy.mjs deploy|cold|cold-idle`, `node scripts/measure.mjs first|heavy|second`, `node scripts/explain.mjs`, `node scripts/where-else.mjs`, `node scripts/report.mjs`, `node scripts/deploy.mjs delete`.

New tables: `spike.s75_*` (28.8 MB; database 120 MB in total, [data.json](results/data.json)). `pg_trgm` is installed in the `spike` schema. `spike.kv` is untouched.
