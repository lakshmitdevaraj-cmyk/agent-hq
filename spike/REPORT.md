# Spike report: Alcance on Cloudflare Workers (free) + Neon (free), 25 Nov 2026

## Summary

| Test | Result | Numbers | GO / NO-GO |
|---|---|---|---|
| A. Website check CPU | Does not fit in a Worker | Parsing 29–362 ms CPU on Cloudflare (limit 10 ms). Repeat runs: only 5 of 30 got through | **NO-GO** |
| B. Sending in chunks | One email per queue message works | 10/10 accepted by AgentMail in 13.6 s; 60-fetch request stopped at exactly 50 | **GO** (inbox arrival not checked by me) |
| C. Worker ↔ Neon (Hyperdrive) | Works, CPU fits when warm | Warm CPU median 2–4 ms, worst 8 ms; cold call 1.5–1.8 s; 16 MB storage | **GO** |
| D. Long job (Workflow) | Finished | 10/10 steps, 201 s, no errors. `httpbin` returned 400, so a 20 s timer stood in | **GO** for waiting jobs, not for CPU work |
| E. InstaBox fallback | Works | 20 sites in 211 s, 18 loaded, 20 rows in Neon; started from the Mac CLI | **GO**, with free-plan caveats |
| F. Local development | Works | `wrangler dev`: site check, 3 queries, queue (dry run, 10/10), Workflow 10/10 | **GO**, needs a DNS workaround on this network |

## Recommendation

| Runs on Cloudflare free as it is | Needs chunking | Needs the InstaBox worker | Blockers |
|---|---|---|---|
| Database pages (filtering and sorting in SQL, JSON built by Postgres); jobs that mostly wait (AI calls) as Workflows | Sending (one email per queue message); anything with more than 50 outgoing calls | Website check and email finder (all HTML parsing) | None that stops the move |

Move to Cloudflare + Neon, and run the website check outside Workers from day one. Keep the Worker's job to "start it and read progress from Neon".
Set `placement: { "region": "aws:us-east-1" }` (or move Neon nearer): it cut database time per query from 300–1,040 ms to 25–40 ms.

## Test A: CPU time of the website check

Method: the same parsing functions as production, imported read-only from `netlify/functions/lib/`. `analyzeSite` is not exported, so its call order is copied into `lib/analyze.ts`, without the Gemini owner fallback and the browser-merge branches. Production fetches **9 paths per site** (home, contact, about and team pages), and so does this test. Worker output matched local output on every site compared.

| Site | Pages | KB | Mac, parse ms | Cloudflare live CPU ms, 3 runs (x = cut off) | InstaBox, parse ms |
|---|---|---|---|---|---|
| makcomfort.com | 3 | 584 | 43 | 150 / 139 / x | 99 |
| jimsairandheat.com | 2 | 300 | 17 | 42 / 51 / x | 30 |
| bayareaacplumbing.com | – | – | 403 from Mac | 38 | 18 |
| nolimitroofingtexas.com | 3 | 330 | 27 | 76 / 70 / x | 44 |
| schulzeac.com | 3 | 913 | 56 | 175 / 173 / x | 101 |
| plumbingchamp.com | – | – | 403 from Mac | did not load | 71 |
| txdvp.com | 1 | 266 | 27 | 74 / 58 / x | 42 |
| climateservicesoftexas.com | 1 | 76 | 10 | 29 / x / x | 18 |
| newhorizonac.com | 3 | 682 | 39 | 146 / x / x | 108 |
| brownairandheat.com | 3 | 2051 | 94 | 362 / x / x | 201 |
| mcdarisac.com | 2 | 114 | 17 | 50 / x / x | 19 |
| simplycozy.com | 2 | 236 | 18 | 44 / x / x | 21 |
| texasroofmasters.com | – | – | connection error | did not load | did not load |
| vick-construction.com | 2 | 179 | 16 | 45 / x / x | 28 |
| abel-ac.com | – | – | 403 from Mac | 115 | 75 |
| trusealroofingsolutions.com | 3 | 1241 | 52 | 182 / x / x | 97 |
| airtechofconroe.com | – | – | 403 from Mac | did not load | did not load |
| doctorcool.com | 1 | 224 | 18 | 50 / x / x | 31 |
| bosworthac.com | 3 | 111 | 14 | 43 / x / x | 18 |
| onthewaypros.com | 3 | 492 | 31 | 139 / x / x | 67 |

Sites that refused a plain download were left alone (no User-Agent tricks).

**The limit is not applied consistently, so one successful try proves nothing.** The first live runs went through at up to 362 ms. Later rounds were cut at 10 ms with "exceeded CPU" (HTTP 503): round 2 let 5 through, round 3 none. After a rest, 30 parses in a row succeeded again, 28 of them over 10 ms.

### Cheap optimisations

| Variant | Mac ms | Sites ≤ 10 ms on Mac (of 15) | Sites whose results changed | On Cloudflare (after a rest) |
|---|---|---|---|---|
| Home + contact pages only | 6–64 | 4 | 1 | not re-measured |
| `<head>` + first 60 KB + last 20 KB | 6–31 | 7 | **10** (loses forms, social links, owner, booking) | not re-measured |
| Strip script and style bodies | 5–29 | 7 | 3 | 20–102 ms, 0 of 15 ≤ 10 ms |
| Biggest page only + strip | – | – | partial by design | 7–25 ms, 2 of 15 ≤ 10 ms |
| One page per request (full) | 3–35 | 7 | not measured after merging | not re-measured |

None brings the check reliably under 10 ms. Stripping is the least harmful speed-up and is not enough.

The early Cloudflare variant runs (`results/a-worker.json`) were all cut off because they ran straight after the live runs; the re-measure is `results/a-worker-variants.json`. Both used HTML saved on the Mac, so the websites were not visited again.

### Could a queue or Workflow get more CPU? (added check, synthetic pages, no websites)

| Handler | Result at about 120–150 ms CPU each |
|---|---|
| HTTP request | 38 of 40 ok; first cut-off on the 19th |
| Queue consumer | 14 of 16 observed ok, 2 cut off (only 16 of 40 seen in the log window) |
| Workflow | Errored "Worker exceeded CPU time limit" after about 2 s of CPU in total; steps without waits share one invocation |

Treat every handler as 10 ms. Sometimes more is tolerated, but it cannot be relied on.

## Test B: sending in chunks

- 10 messages queued; consumer batch size 1, no retries, a row claimed in Neon before sending. All 10 `sent`, HTTP 200. 13.6 s from queueing to the last send.
- Consumer CPU: 30 ms on the first (cold) run, then 5–8 ms. Producer: 20 ms. Both over-10 ms runs were allowed.
- A second `/queue/start` returns 409, so no further test emails can leave.
- 60 fetches in one request: 50 succeeded, the 51st threw "Too many subrequests".
- Free allowance: 10,000 queue operations a day (about 3 per message), 24 h retention.
- The queue was purged afterwards. AgentMail accepting a message is not proof it reached the inbox.

## Test C: Worker ↔ Neon through Hyperdrive

Data: 25 campaigns, 1,500 leads, 6,000 emails, 500 social messages, 200 replies, all fake, in a `spike` schema. Hyperdrive caching **off**. Direct (non-pooler) Neon host.

| Endpoint | Rows / size | Warm response, median (p95) | DB time | CPU median / worst | Cold response | Cold CPU |
|---|---|---|---|---|---|---|
| Prospects: no email but social | 200 / 72 KB | 562 (596) ms | 478 ms | 3 / 5 ms | – | – |
| Prospects: emailed, no reply | 200 / 73 KB | 553 (3,975) ms | 482 ms | 3 / 4 ms | 1,491 ms | 7 ms |
| Prospects: due today | 119 / 43 KB | 367 (392) ms | 298 ms | 2 / 5 ms | – | – |
| Follow-ups due | 200 / 39 KB | 372 (466) ms | 301 ms | 3 / 4 ms | 1,780 ms | 19 ms |
| One campaign page | 296 KB | 1,126 (1,225) ms | 1,039 ms | 4 / 8 ms | 1,801 ms | 16 ms |

With the Worker placed next to the database (`aws:us-east-1`), DB time dropped to 30, 27, 25, 27 and 40 ms. Response seen from the Mac: 513, 558, 401, 387, 937 ms.

- Cold calls were made after 390 s of silence; Neon's uptime of 2–3 s afterwards confirms it had slept.
- Each endpoint: 1 SQL query through Hyperdrive, 0 external fetches (the 50 limit is untouched).
- Two cold calls used more than 10 ms CPU and were allowed. The campaign page is the one to watch as campaigns grow.
- Follow-up rules checked separately: 0 of 200 returned rows were replied, do-not-contact or bounced; the "3 weekdays" cut-off date was correct. The top 200 are the oldest ones, so rows near the boundary were checked by the cut-off date, not row by row.
- **Production differs:** today's follow-ups use calendar-day gaps (3, 8, 15 days from the first email), not "3 weekdays since the previous step". The migration must port the real rule.
- Storage: 16.4 MB whole database, 8.3 MB the spike tables (free: 1 GB per project).
- **CU-hours used: not recorded.** Read it in the Neon console (free: 100 CU-hours a month).

## Test D: Workflow

- 10 steps, each a ~20 s wait and one Neon row: all completed, 201 s from first to last step, no errors, 48 ms CPU in total.
- `https://httpbin.org/delay/20` answered 400 (also from the Mac), so every step used the local 20 s timer. A real 20–60 s network call was **not** exercised.
- Free allowance: **3,000 steps a day**, 1,024 steps per instance, 100 concurrent instances, 10 ms CPU, 3 days retention.

## Test E: InstaBox

- Existing machine `shiftforge` reused (4 vCPU / 8 GiB, Debian 13, Node 22). It woke from pause in about 5 s. One temporary file was uploaded and then removed; nothing else changed.
- 20 sites in 211 s (mostly polite pauses and network); total parsing CPU 1.1 s; per site 18–201 ms. 18 loaded, including 3 that refused the Mac.
- `NEON_URL` was passed on standard input for that run only: not on the command line, not saved on the machine. Results hold counts and presence flags only.
- Remote start: **verified with the CLI** from outside the machine. HTTP API documented (`POST https://api.instabox.sh/v1/machines/{id}/exec`, `X-API-Key`), **not exercised** because it needs an API key that you would create. A paused machine is woken by use.
- What could block regular use: one free machine, shared with whatever else you use `shiftforge` for; idle pause fixed at 30 min; a run starts at 120 min and grows to at most 480 min; after hitting that limit, a 5–20 min cooldown; one `exec` call waits at most 600 s (use background mode for longer); 100 GiB egress a month. Long-term availability of the free plan is not guaranteed. GitHub Actions is the fallback in the migration analysis.

## Test F: local development

`wrangler dev` ran the site check (15 s, polite sequential fetches), the three queries (2.0–2.6 s from India to US East), the queue in dry-run mode and the 10-step Workflow. `wrangler dev` does **not** enforce the CPU limit, so CPU problems only show after deploy.

This network's router DNS refuses `*.neon.tech` database hosts. The spike scripts look those up through `1.1.1.1`, and `scripts/test-f.mjs` runs a small local proxy for `wrangler dev`. No Mac settings were changed. Setting the Mac's DNS to `1.1.1.1` would remove the need.

## Not tested (open before migrating)

- The size and start-up CPU of the whole API (`command.ts` is 5,886 lines) as one Worker.
- CPU of other heavy actions: message checks on large campaigns, imports and exports.
- Gemini, Apify and browser checks; AgentMail webhooks pointing at a Worker; screenshots in R2.
- The certificate check that uses `node:https` with checking off; it does not port to Workers.

## What is left running

- Worker `alcance-spike` on workers.dev (free). Every route needs `SPIKE_TOKEN`. It holds the AgentMail key and test recipient as secrets. If you will not reuse it: `npx wrangler delete` from `spike/`.
- Cloudflare queue `alcance-spike-q` (empty), Hyperdrive config `alcance-spike-hd`, Workflow `alcance-spike-wf`.
- Neon project and its `spike` schema, kept.
