# Step 0.5: can the whole Alcance API run as one Cloudflare Worker? (25 Nov 2026)

## 1. Summary

| Test | Result | Numbers | GO / NO-GO |
|---|---|---|---|
| G. Does it build and fit? | Yes | 738.01 KiB raw, 200.47 KiB gzip (limit 64 MiB uncompressed). 0 build errors, 0 warnings. Start-up 11–14 ms (limit 1 s) | **GO** |
| H. Does it start, and what does each action cost? | Starts. Does not fit as it is | 126 rows: 64 fit, 7 fit marginally, 37 need a rewrite, 13 need chunking, 5 move to a runner. First request after deploy 22–46 ms CPU (limit 10 ms), all answered 200. 221 of 1,526 measured calls were cut off | **NO-GO** as a straight port |
| I. Long network wait inside a Workflow | Works | 30 / 45 / 60 s: all complete, step wall time 30.2 / 45.0 / 60.0 s, CPU of the waiting request 0 ms | **GO** |

**What was measured, and what was not**

- The real handlers, unchanged, behind a small adapter, on a free `workers.dev` Worker. Fake data in Neon (`spike` schema). Every outside service was faked.
- `@netlify/blobs` was replaced by a test stand-in over `spike.kv`. Its "batched" mode loads a whole store in one query. **It is not the SQL layer of M1**, so nothing here shows what a properly filtered SQL page costs.
- Outside calls were faked, so the 50-call limit was counted, not enforced. Highest count in one measured request: 30 (drafting 10 leads).
- CPU figures are from `wrangler tail`. A cut-off call is counted as cut off; its CPU figure is not used.
- "500 leads" means one campaign with 500 leads and 2,000 emails; "1,500" means 6,000 emails ([dataset-sizes.json](results/dataset-sizes.json)).

## G. Build and fit

Sources: [g-build.json](results/g-build.json), [g-deploy.json](results/g-deploy.json), [g-limits.json](results/g-limits.json).

- Bundle: 755,722 bytes of JavaScript (205,286 gzip). `command.ts` is 298,006 bytes of it. The real `@netlify/blobs` is not in the bundle.
- Limit, from [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), fetched 25 Nov 2026: 64 MiB uncompressed on free and paid, no compressed limit. The [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) page, same date, still says 3 MB for free. The deploy with a Workflow was accepted, and 200 KiB gzip is under both.
- Build: no warnings or errors, with or without the `node:https` replacement.

**Netlify and Node features**

| Feature | Where | On Workers | Fix |
|---|---|---|---|
| `node:https` with certificate checking off | `command.ts:8`, `tlsProblem` about 1606–1615 | Builds, but the option is ignored. In a local `workerd` probe a valid site answered and self-signed and expired ones failed the handshake ([g-https-probe.json](results/g-https-probe.json)). Not checked on the deployed edge. The app would report "did not load" and lose "certificate not valid" | Read the certificate error from the failed `fetch` and record it |
| `connectLambda` | `command.ts:7, 3016` and the other 5 handlers | Netlify only | Remove |
| `@netlify/blobs` | `lib/blobs.ts`; `lib/contacts.ts` also writes plain, non-JSON strings (lines 34, 40, 60, 63, 66) | Netlify only | SQL data layer; contacts need their own table or text column |
| Background function | app calls `/.netlify/functions/ai-background` (`src/lib/api.ts:127`; not in `netlify.toml`) | No 202-and-run-15-minutes equivalent; `waitUntil` gives about 30 s | Workflow or Queue |
| `x-forwarded-proto` / `x-forwarded-host` | `command.ts:5155`; `webhook-receive.ts:186` uses `host` | Not set the same way | The router sets them |
| Module-level `jobMemo` | `command.ts:2134` | Per isolate, can vanish or differ between requests | Keep the state in the database |
| Pacing sleeps (`PACE_MS` 4500) | `command.ts:4779` | Waiting is not CPU, but holds one request open | Workflow sleep or queue delay |
| `Buffer` | `command.ts:622`, `track-click.ts:34` | Works with `nodejs_compat` | None |
| `process.env` | `command.ts:244, 246, 5157, 5787`, `track-click.ts:25`, `lib/gemini-pause.ts`, `lib/inbound.ts:103` | Works | None |

Outside services the code calls: Gemini, DeepSeek, Apify, AgentMail and lead websites. I found no Geoapify call.

## H. Start and cost

### Start

Source: [h-cold.json](results/h-cold.json). Three fresh deploys.

| Deploy | Start-up reported by wrangler | First request CPU | Second request CPU (also a new isolate) |
|---|---|---|---|
| 1 | 13 ms | 23 ms | 30 ms |
| 2 | 13 ms | 22 ms | 26 ms |
| 3 | 11 ms | 46 ms | 21 ms |

All six answered 200, so Cloudflare let these overruns through. Its limits page says infrequent overruns are tolerated and consistent ones are stopped.

Without the test token every route answered 401 ([g-no-token.txt](results/g-no-token.txt)); the fake services refuse unknown hosts ([g-stub-block.txt](results/g-stub-block.txt)).

### What goes over, and from what size

Median / worst CPU in ms. "cut" = Cloudflare stopped the call. Sources: [h-light.json](results/h-light.json), [h-heavy.json](results/h-heavy.json).

| Work | 25 leads | 100 | 500 | 1,500 |
|---|---|---|---|---|
| Campaign page | 8 / 9 | 13 / 16 | 40 / 66 | 96 / 178 |
| Prospects list | 48 / 57 (2 cut) | 66 / 66 (3 cut) | 84 / 84 (2 cut) | 345 / 345 (3 cut) |
| Follow-ups list | 17 / 45 (1 cut) | 22 / 22 (2 cut) | 93 / 93 (3 cut) | – |
| Analytics summary | 30 / 30 (3 cut) | 30 / 30 (2 cut) | 46 / 53 (1 cut) | 122 / 161 (1 cut) |
| Export | 9 / 10 | 13 / 21 | 38 / 43 | 75 / 97 |
| Import (100 records) | 60 / 72 | 64 / 73 | 35 / 60 | 36 / 60 |
| Open tracking link | 8 / 9 | 12 / 14 (1 cut) | 35 / 63 | 64 / 64 (2 cut) |
| AgentMail "delivered" webhook | 17 / 20 (1 cut) | 29 / 29 (2 cut) | 40 / 69 (1 cut) | 63 / 124 |
| AgentMail "reply received" webhook | 8 / 29 | 26 / 42 (1 cut) | 52 / 93 | 56 / 82 (1 cut) |
| Mark a social message sent | 21 / 23 | 38 / 44 | 64 / 113 | 137 / 218 |

Follow-up due counts come from the Follow-ups list (above) and "Send today" (`outreach.send.today`: 94 / 94 with 2 cut at 500 leads, 247 / 424 at 1,500).

**Website check** (one lead): 316 ms median with 100 KB pages, 883 ms with 300 KB, 1,519 ms with 1 MB. This agrees with Step 0.

**Sending** ([h-send.json](results/h-send.json)): one email in a 25-lead account took 33 / 42 ms, 19 queries and 2 AgentMail calls. Ten emails there, and one or ten at 100 and 500 leads, were all cut off. The first send runs sent nothing (the fake drafts failed the app's own checks), so their numbers in the inventory are for the checking part only.

**Re-checking old drafts** (drafts saved under older rules, re-checked when a list is opened; [h-stale.json](results/h-stale.json)):

| List | 25 leads | 100 | 500 |
|---|---|---|---|
| Emails | 130 / 138, 144 queries | 1,435 / 1,488, 556 queries | cut |
| Follow-ups | 144 / 287 | 832 / 860 (1 cut) | cut |
| Prospects | 132 / 187 (2 cut) | 755 / 856 | cut |

This happens once after every rules change, and today it would fail at almost any size.

**One query per record** (what a direct Blobs-to-table swap would do; [h-literal.json](results/h-literal.json)): the campaign page at 500 leads makes 2,006 queries and takes 505 / 660 ms. A free Hyperdrive has 100,000 queries a day, so about 49 such page views would use it up. A literal swap is not an option.

**Cloudflare gets stricter.** The 18 borderline actions were measured again after a rest ([h-confirm.json](results/h-confirm.json)). After heavy use, several calls were stopped at 8–12 ms, in some cases all 8 in a row. So "a few ms over" is not safe, and one heavy page can make light actions fail afterwards.

**Mac comparison** (local CPU, not Cloudflare time; [h-local-cpu.json](results/h-local-cpu.json)), at 500 / 1,500 leads: campaign list 38 / 96 ms, campaign page 61 / 110, Prospects 59 / 173, Emails 39 / 126, Follow-ups 50 / 145, tracking link 30 / 73, "delivered" webhook 18 / 45, "reply received" webhook 31 / 42. The Mac run was cut short on purpose: write actions were very slow from here.

## 2. Action inventory

Verdict rules, fixed before measuring:

- **Fits Worker:** CPU median 8 ms or less, worst 10 ms or less at 500 leads, no cut-offs, 50 outside calls or fewer.
- **Needs chunking:** over, but the work is per item and can be split.
- **Needs rewrite:** over because of whole-store scans or an unsupported feature.
- **Move to runner:** heavy CPU on one item that cannot be split.

**One departure:** I added **Fits Worker (marginal)** after seeing the data (median 10 ms or less, no size above 12 ms, at most 2 cut-offs). By the original rules those 7 do not fit.

**Needs chunking and Move to runner are proposals, not results.** No chunked or SQL version was built or measured. A Workflow step on the free plan also has 10 ms of compute, so a chunk can still be too big.

® = measured again after a rest. Each action was called 4 times (first call not counted), so "worst" is the worst of 3 (of 7 for ®). Full data for all sizes: [inventory-verdicts.json](results/inventory-verdicts.json).

<!-- inventory -->
| Action or handler | Verdict | CPU ms median / worst at 500 leads | At 1,500 leads | Mac ms 500 / 1,500 (local) | Over from | Rows read, queries, outside calls at 500 | Note |
|---|---|---|---|---|---|---|---|
| `auth.bootstrap` | Fits Worker | 4 / 4 | – | – / – | – | 1, 1, 0 | only the closed (already set up) path |
| `auth.rotate` | Fits Worker | 2 / 3 | – | – / – | – | 1, 1, 0 | only the refusal path; a real rotation would break the test key |
| `data.counts` | Needs rewrite | 82 / 107 | 144 / 189 | 41.7 / 115 | 25 leads | 3368, 20, 0 | inflated by the test shim (values loaded just to count); SQL count not measured |
| `data.export` | Needs rewrite | 38 / 43 | 75 / 97 | 15.9 / 41 | 100 leads | 2001, 2, 0 | inflated by the test shim, which loads all values when only keys are asked for; a keys-only query is not measured |
| `data.import` | Needs chunking | 35 / 60 | 36 / 60 | 63.3 / – | 25 leads | 1, 101, 0 | one query per record: bulk insert, or fewer per call |
| `agent.register` | Fits Worker | 7 / 9 | 5 / 7 | – / – | – | 1, 4, 0 |  |
| `agent.list` | Fits Worker | 6 / 6 | – | – / – | – | 21, 2, 0 |  |
| `agent.heartbeat` | Fits Worker | 5 / 9 | – | – / – | – | 2, 3, 0 |  |
| `agent.delete` | Fits Worker | 6 / 8 | – | – / – | – | 1, 3, 0 |  |
| `task.create` | Fits Worker | 8 / 8 | – | – / – | – | 1, 3, 0 |  |
| `task.list` | Fits Worker | 3 / 4 | – | – / – | – | 21, 2, 0 |  |
| `task.move` | Fits Worker | 6 / 7 | 5 / 10 | – / – | – | 2, 4, 0 |  |
| `task.delete` | Fits Worker | 4 / 6 | – | – / – | – | 1, 2, 0 |  |
| `activity.log` | Fits Worker | 4 / 4 | – | – / – | – | 1, 2, 0 |  |
| `activity.list` | Needs rewrite | 12 / 15 ® | 12 / 13 | – / – | 1500 leads | 501, 2, 0 | reads whole stores: filter and sort in SQL |
| `form.create` | Fits Worker | 8 / 8 | – | – / – | – | 1, 2, 0 |  |
| `form.list` | Fits Worker | 3 / 5 | – | – / – | – | 2, 2, 0 |  |
| `form.submissions` | Fits Worker | 5 / 6 | – | – / – | – | 21, 2, 0 |  |
| `webhook.create` | Fits Worker | 2 / 6 | – | – / – | – | 1, 2, 0 |  |
| `webhook.list` | Fits Worker | 4 / 5 | – | – / – | – | 2, 2, 0 |  |
| `webhook.events` | Fits Worker | 6 / 8 | – | – / – | – | 21, 2, 0 |  |
| `voice.config.check` | Fits Worker | 3 / 5 | – | – / – | – | 2, 2, 0 |  |
| `voice.config.get` | Fits Worker | 3 / 3 | – | – / – | – | 2, 2, 0 |  |
| `voice.config.set` | Fits Worker | 6 / 7 | – | – / – | – | 1, 3, 0 |  |
| `voice.config.clear` | Fits Worker | 5 / 6 | – | – / – | – | 1, 2, 0 |  |
| `config.status` | Fits Worker | 5 / 7 | 4 / 9 | – / – | – | 5, 6, 0 |  |
| `config.set` | Fits Worker | 5 / 6 | – | – / – | – | 1, 3, 1 |  |
| `config.test` | Fits Worker | 5 / 10 | – | – / – | – | 2, 3, 1 |  |
| `config.clear` | Fits Worker | 3 / 8 | – | – / – | – | 1, 2, 0 |  |
| `voice.session.save` | Fits Worker | 6 / 9 | – | – / – | – | 1, 3, 0 |  |
| `voice.session.list` | Fits Worker | 7 / 9 | – | – / – | – | 21, 2, 0 |  |
| `voice.session.get` | Fits Worker | 7 / 8 | – | – / – | – | 21, 2, 0 |  |
| `voice.session.delete` | Fits Worker | 7 / 7 | – | – / – | – | 20, 3, 0 |  |
| `voice.invitation.create` | Fits Worker (marginal) | 8 / 14 ® | – | – / – | – | 1, 3, 0 | single-record work; some calls over 10 ms |
| `voice.invitation.list` | Fits Worker | 6 / 9 | – | – / – | – | 21, 2, 0 |  |
| `voice.invitation.get` | Fits Worker | 3 / 3 | – | – / – | – | 2, 2, 0 |  |
| `voice.invitation.dismiss` | Fits Worker | 8 / 9 | – | – / – | – | 2, 3, 0 |  |
| `voice.invitation.accept` | Fits Worker | 5 / 6 | – | – / – | – | 2, 3, 0 |  |
| `page.create` | Fits Worker | 4 / 5 | – | – / – | – | 1, 3, 0 |  |
| `page.list` | Fits Worker | 4 / 5 | – | – / – | – | 2, 2, 0 |  |
| `page.get` | Fits Worker | 2 / 5 | – | – / – | – | 2, 2, 0 |  |
| `page.update` | Fits Worker | 6 / 6 | 5 / 6 | – / – | – | 2, 4, 0 |  |
| `page.delete` | Fits Worker | 6 / 7 | – | – / – | – | 1, 2, 0 |  |
| `outreach.preview` | Fits Worker | 6 / 8 | 5 / 8 | – / – | – | 3, 4, 1 |  |
| `outreach.preview.start` | Fits Worker | 4 / 4 | – | – / – | – | 2, 3, 0 |  |
| `outreach.preview.result` | Fits Worker | 4 / 4 | – | – / – | – | 2, 2, 0 |  |
| `outreach.social.write` | Needs chunking | 20 / 24 | 27 / 28 | – / – | 25 leads | 91, 10, 0 | plans several leads in one request |
| `outreach.social.list` | Fits Worker | 8 / 10 ® | 14 / 14 | – / – | 1500 leads | 101, 2, 0 |  |
| `outreach.social.update` | Needs rewrite | 63 / 76 | 96 / 159 | – / – | 25 leads | 2003, 7, 0 | reads whole stores: filter and sort in SQL |
| `outreach.social.verify` | Needs rewrite | 43 / 48 | 134 / 145 | – / – | 25 leads | 2003, 6, 0 | reads whole stores: filter and sort in SQL |
| `outreach.social.mark_sent` | Needs rewrite | 64 / 113 | 137 / 218 | – / – | 25 leads | 2055, 12, 0 | reads whole stores: filter and sort in SQL |
| `outreach.social.record_hand` | Needs rewrite | 53 / 56 | 143 / 212 | – / – | 25 leads | 2051, 7, 0 | reads whole stores: filter and sort in SQL |
| `outreach.touch.delete` | Needs rewrite | 34 / 54 | 88 / 128 | – / – | 100 leads | 2053, 6, 0 | reads whole stores: filter and sort in SQL |
| `outreach.lead.touches` | Needs rewrite | 30 / 35 | 109 / 123 | – / – | 25 leads | 2052, 5, 0 | reads whole stores: filter and sort in SQL |
| `outreach.lead.fb_checked` | Needs rewrite | 18 / 42 | 53 / 67 | – / – | 500 leads | 501, 3, 0 | reads whole stores: filter and sort in SQL |
| `outreach.social.plan` | Needs rewrite | 91 / 118 | 186 / 316 | – / – | 25 leads | 2677, 8, 0 | reads whole stores: filter and sort in SQL |
| `outreach.social.batch.start` | Needs chunking | 17 / 20 (cut 1/8) ® | 14 / 20 | – / – | 500 leads | 91, 11, 0 | plans several leads in one request |
| `outreach.social.batch.status` | Fits Worker | 3 / 8 | – | – / – | – | 1, 2, 0 |  |
| `outreach.social.batch.resume` | Fits Worker | 5 / 5 | – | – / – | – | 1, 2, 0 | only the nothing-paused path |
| `outreach.social.delete` | Fits Worker | 6 / 9 | – | – / – | – | 1, 2, 0 |  |
| `outreach.job.resume` | Fits Worker | 6 / 7 | – | – / – | – | 1, 2, 0 | only the nothing-paused path |
| `outreach.job.resume_due` | Fits Worker | 5 / 6 | – | – / – | – | 1, 2, 0 |  |
| `outreach.emails.review.start` | Needs rewrite | 31 / 50 | 133 / 165 | – / – | 100 leads | 2003, 6, 0 | reads whole stores: filter and sort in SQL |
| `outreach.browsercheck.plan` | Needs rewrite | 43 / 67 | 119 / 149 | – / – | 25 leads | 503, 5, 0 | reads whole stores: filter and sort in SQL |
| `outreach.browsercheck.start` | Fits Worker (marginal) | 9 / 10 (cut 2/8) ® | 8 / 9 | – / – | 500 leads | 17, 7, 0 | single-record work; some calls over 10 ms |
| `outreach.draft.start` | Needs rewrite | 12 / 12 | 25 / 28 | – / – | 25 leads | 400, 9, 0 | reads whole stores: filter and sort in SQL |
| `outreach.campaign.create` | Fits Worker | 5 / 6 | – | – / – | – | 1, 3, 0 |  |
| `outreach.campaign.list` | Needs rewrite | 77 / 80 | 186 / 211 | 40.2 / 96.3 | 25 leads | 2517, 14, 0 | reads whole stores: filter and sort in SQL |
| `outreach.campaign.get` | Needs rewrite | 40 / 66 | 96 / 178 | 60.6 / 109.7 | 100 leads | 2502, 6, 0 | reads whole stores: filter and sort in SQL |
| `outreach.campaign.update` | Fits Worker | 4 / 5 | 3 / 4 | – / – | – | 2, 4, 0 |  |
| `outreach.campaign.delete` | Needs chunking | 609 / 609 (cut 2/4) | cut 3/4 | – / – | 25 leads | 2602, 1858, 0 | deletes one record per query: one SQL delete |
| `outreach.campaign.run` | Fits Worker | 4 / 4 | 10 / 10 | – / – | – | 3, 5, 1 |  |
| `outreach.campaign.sync` | Needs chunking | 82 / 107 | 186 / 197 | – / – | 25 leads | 567, 61, 2 | writes one record per query: bulk insert |
| `outreach.leads.list` | Needs rewrite | 62 / 85 | 137 / 204 | 37.5 / 97.2 | 25 leads | 886, 5, 0 | reads whole stores: filter and sort in SQL |
| `outreach.lead.set_email` | Needs rewrite | 88 / 90 | 184 / 225 | – / – | 25 leads | 2885, 10, 0 | reads whole stores: filter and sort in SQL |
| `outreach.leads.update` | Needs rewrite | 16 / 23 | 64 / 77 | – / – | 100 leads | 501, 3, 0 | reads whole stores: filter and sort in SQL |
| `outreach.prospects.list` | Needs rewrite | 84 / 84 (cut 2/4) | 345 / 345 (cut 3/4) | 59.2 / 172.9 | 25 leads | 2692, 7, 0 | reads whole stores: filter and sort in SQL |
| `outreach.lead.screenshot.get` | Fits Worker | 6 / 7 | – | – / – | – | 2, 2, 0 |  |
| `outreach.leads.count` | Needs rewrite | 18 / 18 | 28 / 41 | – / – | 500 leads | 501, 2, 0 | inflated by the test shim (values loaded just to count); SQL count not measured |
| `outreach.leads.add_test` | Fits Worker | 7 / 9 | 5 / 9 | – / – | – | 2, 5, 0 |  |
| `outreach.leads.delete` | Needs rewrite | 51 / 74 | 131 / 165 | – / – | 25 leads | 2498, 12, 0 | reads whole stores: filter and sort in SQL |
| `outreach.leads.enrich_one` | Move to runner | 146 / 200 | 220 / 254 (cut 1/4) | – / – | 25 leads | 17, 7, 10 | same website check |
| `outreach.leads.check_site` | Move to runner | 316 / 316 (cut 3/4) | – | 129.7 / – | 25 leads | 17, 7, 10 | parses whole web pages |
| `outreach.emails.generate_one` | Needs rewrite | 39 / 75 (cut 1/4) | 94 / 116 | – / – | 25 leads | 914, 19, 3 | reads whole stores: filter and sort in SQL |
| `outreach.emails.create` | Needs rewrite | 70 / 95 (cut 2/4) | 135 / 226 (cut 1/4) | – / – | 25 leads | 2502, 4, 0 | reads whole stores: filter and sort in SQL |
| `outreach.emails.generate` | Needs chunking | 39 / 58 (cut 1/4) | 46 / 58 (cut 1/4) | – / – | 25 leads | 401, 14, 3 | drafts many leads in one request: one lead per step |
| `outreach.emails.list` | Needs rewrite | 52 / 52 (cut 3/4) | – | 38.6 / 125.9 | 25 leads | 2898, 5, 0 | reads whole stores: filter and sort in SQL |
| `outreach.emails.update` | Needs rewrite | 70 / 77 (cut 1/4) | 78 / 126 (cut 2/4) | – / – | 25 leads | 2002, 7, 0 | reads whole stores: filter and sort in SQL |
| `outreach.emails.delete` | Needs rewrite | 38 / 43 (cut 2/4) | 49 / 59 | – / – | 25 leads | 2002, 5, 0 | reads whole stores: filter and sort in SQL |
| `outreach.footer.preview` | Needs rewrite | 28 / 39 (cut 2/4) | 42 / 46 (cut 1/4) | – / – | 100 leads | 2003, 5, 0 | reads whole stores: filter and sort in SQL |
| `outreach.settings.get` | Fits Worker | 4 / 6 | – | – / – | – | 2, 3, 0 |  |
| `outreach.inboxes.list` | Fits Worker | 7 / 7 | – | – / – | – | 3, 3, 2 |  |
| `outreach.settings.set` | Fits Worker (marginal) | 9 / 11 ® | 6 / 9 (cut 1/4) | – / – | 100 leads | 3, 5, 0 | single-record work; some calls over 10 ms |
| `outreach.emails.send` | Needs chunking | cut 4/4 | – | – / – | 25 leads | 0, 0, 0 | one email per queue message, plus SQL instead of store scans; first-pass numbers are with every draft stopped by the send checks (nothing sent); with passing drafts one email at 25 leads took 33 / 42 ms and every larger case was cut off (h-send.json) |
| `outreach.replies.list` | Fits Worker (marginal) | 8 / 12 ® | 8 / 18 | – / – | 500 leads | 51, 2, 0 | single-record work; some calls over 10 ms |
| `outreach.replies.delete` | Fits Worker | 6 / 9 | 7 / 12 | – / – | 25 leads | 50, 3, 0 |  |
| `outreach.replies.get` | Fits Worker | 8 / 8 | 8 / 15 | – / – | – | 51, 2, 0 |  |
| `outreach.send.today` | Needs rewrite | 94 / 94 (cut 2/4) | 247 / 424 | 79.2 / 167.5 | 25 leads | 2515, 4, 0 | reads whole stores: filter and sort in SQL |
| `followups.list` | Needs rewrite | 93 / 93 (cut 3/4) | – | 50.4 / 145.4 | 25 leads | 2688, 8, 0 | reads whole stores: filter and sort in SQL |
| `followups.update` | Fits Worker | 5 / 9 | – | – / – | – | 1, 3, 0 |  |
| `followups.replied` | Fits Worker | 7 / 9 | – | – / – | – | 1, 3, 0 |  |
| `followups.linkedin` | Fits Worker | 6 / 7 | – | – / – | – | 1, 3, 0 |  |
| `outreach.reply.draft` | Needs rewrite | 96 / 240 (cut 2/4) | 263 / 263 (cut 2/4) | – / – | 25 leads | 2554, 8, 1 | reads whole stores: filter and sort in SQL |
| `outreach.reply.send` | Needs rewrite | 52 / 55 | 220 / 239 | – / – | 100 leads | 2554, 9, 1 | reads whole stores: filter and sort in SQL |
| `outreach.replies.convert_to_task` | Fits Worker (marginal) | 8 / 13 ® | 8 / 12 (cut 1/4) | – / – | 25 leads | 51, 4, 0 | single-record work; some calls over 10 ms |
| `outreach.analytics.summary` | Needs rewrite | 46 / 53 (cut 1/4) | 122 / 161 (cut 1/4) | 24.6 / 85.3 | 25 leads | 2004, 8, 0 | reads whole stores: filter and sort in SQL |
| `outreach.replies.sync` | Needs chunking | 59 / 151 (cut 1/4) | 73 / 160 (cut 1/4) | – / – | 25 leads | 2053, 8, 22 | one inbound message per step, plus SQL lookups |
| `outreach.webhook.events` | Fits Worker | 5 / 9 ® | 9 / 9 | – / – | – | 2, 2, 1 |  |
| `outreach.webhook.test` | Fits Worker (marginal) | 8 / 12 ® | 5 / 5 (cut 2/4) | – / – | 500 leads | 23, 4, 2 | single-record work; some calls over 10 ms |
| `webhook.create_typed` | Fits Worker | 6 / 7 | – | – / – | – | 1, 2, 0 |  |
| `webhook.delete` | Fits Worker | 5 / 6 ® | 8 / 13 | – / – | 500 leads | 1, 2, 0 | only an id that does not exist |
| `page-serve GET /p/hello` | Fits Worker (marginal) | 5 / 25 ® | 4 / 5 | – / – | – | 2, 2, 0 | single-record work; some calls over 10 ms |
| `track-click GET /t/:token` | Needs rewrite | 35 / 63 | 64 / 64 (cut 2/4) | 30.2 / 72.9 | 100 leads | 2001, 6, 0 | reads whole stores: filter and sort in SQL |
| `form-submit GET /api/form/contact` | Fits Worker | 3 / 4 | – | – / – | – | 1, 1, 0 |  |
| `form-submit POST /api/form/contact` | Fits Worker | 7 / 8 | – | – / – | – | 1, 3, 0 |  |
| `webhook-receive message.delivered` | Needs rewrite | 40 / 69 (cut 1/4) | 63 / 124 | 18.1 / 44.6 | 25 leads | 2001, 6, 0 | reads whole stores: filter and sort in SQL |
| `webhook-receive message.bounced` | Needs rewrite | 25 / 27 (cut 1/4) | 100 / 102 | – / – | 25 leads | 2001, 7, 0 | reads whole stores: filter and sort in SQL |
| `webhook-receive message.received` | Needs rewrite | 52 / 93 | 56 / 82 (cut 1/4) | 30.6 / 41.7 | 100 leads | 2056, 12, 1 | reads whole stores: filter and sort in SQL |
| `ai-background draft (10 leads)` | Needs chunking | cut 4/4 | 287 / 418 | – / – | 25 leads | 0, 0, 0 | one lead per Workflow step; not measured at 500 leads: the start step before it was cut off |
| `ai-background review (3 drafts)` | Needs chunking | 62 / 132 | 194 / 364 | – / – | 25 leads | 2505, 24, 3 | one draft group per Workflow step, plus SQL lookups |
| `ai-background social (3 leads)` | Needs chunking | 56 / 61 (cut 1/4) | 47 / 56 | – / – | 25 leads | 93, 27, 9 | one lead per Workflow step |
| `ai-background social_batch (3 leads)` | Needs chunking | 37 / 38 (cut 1/4) | 65 / 70 | – / – | 25 leads | 93, 31, 9 | one lead per Workflow step |
| `ai-background browsercheck (1 lead)` | Move to runner | 169 / 173 | 81 / 118 | – / – | 25 leads | 19, 14, 7 | parses rendered pages |
| `ai-background preview` | Needs chunking | 10 / 10 (cut 2/4) | 9 / 10 | – / – | 100 leads | 3, 5, 1 | run as a Workflow step |
| `outreach.leads.check_site (300 KB pages)` | Move to runner | 883 / 883 (cut 3/4) | – | 206.5 / – | 500 leads | 17, 7, 10 | parses whole web pages |
| `outreach.leads.check_site (1 MB pages)` | Move to runner | 1519 / 1519 (cut 2/4) | – | 379.6 / – | 500 leads | 17, 7, 10 | parses whole web pages |
<!-- /inventory -->

## I. Long wait inside a Workflow

Source: [i-waits.json](results/i-waits.json). A Workflow step called a second route on the same Worker over the public network; that route waited on a timer.

| Wait | Instance | HTTP | Step wall time | CPU of the waiting request |
|---|---|---|---|---|
| 30 s | complete | 200 | 30,181 ms | 0 ms |
| 45 s | complete | 200 | 45,047 ms | 0 ms |
| 60 s | complete | 200 | 60,016 ms | 0 ms |

No timeouts. `wrangler tail` also logged the Workflow entrypoint with 1 ms CPU and outcome "canceled" (wall 106 s and 122 s) although the instances finished as complete. I do not know why; watch for it. This shows a long wait is fine. It does not show that the work done after a real Gemini answer fits in 10 ms.

## 3. Blockers and smallest fix

| # | Blocker | Smallest fix | Proven? |
|---|---|---|---|
| 1 | Pages and writes load whole stores (lists, campaign page, webhooks, click tracking, single-record edits) | Real SQL: indexed tables, filter and page in the query, count in SQL | No |
| 2 | Tracking link and AgentMail webhooks are over the limit, so clicks, bounces and replies can be lost | Look up by token or message id in SQL; answer first, do the rest from a queue | No |
| 3 | Sending is over even for one email | One email per queue message, SQL lookups instead of the account-wide scans, then measure. Record "sending" before calling AgentMail, so a cut-off cannot send twice (a risk I infer; not observed) | No |
| 4 | Re-check of old drafts runs inside list requests | Background batch after a rules change, a few drafts per step | No |
| 5 | Website check, lead enrichment, browser check | Runner (InstaBox, GitHub Actions or Mac), as in Step 0 | Step 0 test E |
| 6 | Background function does not exist; drafting makes 3 outside calls per lead, so more than 16 leads in one invocation passes 50 | One lead per Workflow step or queue message | Waiting: yes (test I). CPU: no |
| 7 | Cold requests used 21–46 ms; enforcement turns strict after overruns | Smaller router that loads heavy modules only where needed; remove the heavy requests first | No |
| 8 | `node:https` certificate option ignored | Take the certificate error from `fetch` | Local probe only |

## 4. Recommendation

**Do not go ahead with M2 as written** ("same actions behind a thin data layer"). The code builds and starts, but the screens used all day, sending, and the public click and webhook addresses go over the free CPU limit, several from as few as 25–100 leads.

- **M1 (tables and export/import): go ahead**, but design the tables and indexes from what each page and webhook needs to look up, not from the 28 Blobs stores.
- **Before M2, a short Step 0.75:** rewrite four things in real SQL and measure them on the same fake data: Prospects list, campaign page, the "delivered" webhook, and sending one email. If these do not come in under 10 ms with room to spare, the free Worker plan is the wrong home for the API.
- **M2: plan it as a rewrite of the data access**, not a port. Action names and responses can stay the same.
- **M3: nothing here changes the static site, screenshot or domain plan** (not tested). Moving the webhooks waits for blocker 2.

**The case against even that:** the 64 actions that fit are mostly small settings, agent, task and voice actions on tiny stores. Many single-record actions sit at 5–9 ms with spikes above 10, so there is little headroom even after good SQL. Cold requests are already at 2–4 times the limit and pass only because Cloudflare tolerates occasional overruns. A plan that depends on that tolerance is fragile. Under your free-only rule, the fallbacks are to keep the API on Netlify or to run it on a host without a per-request CPU limit; neither was tested here.

## Not tested

- Partial paths are marked in the inventory notes (for example a real key rotation, resuming a paused job).
- The 50-outside-call limit as enforced by Cloudflare.
- Real Gemini, Apify and AgentMail answers, which are larger and more varied than the fakes.
- Several users at once.

## Reproduce

From `spike/whole-app/`, with `NEON_URL` and `WHOLE_APP_TOKEN` in `spike/.dev.vars`: `node db/seed-kv.mjs`, `node scripts/deploy.mjs`, then `node scripts/run-h.mjs light|heavy|stale|literal`, `node scripts/confirm.mjs`, `node scripts/run-send.mjs`, `node scripts/run-i.mjs`, `node scripts/totals.mjs`, `node scripts/report.mjs`, and `node scripts/deploy.mjs delete`.

## Cleanup

The test Worker `alcance-whole-app` and its Workflow were deleted; wrangler reports the Worker missing and its address answers 404 ([cleanup.json](results/cleanup.json)). `spike.kv` and the Step 0 Hyperdrive config are left in place. The Step 0 Worker `alcance-spike` was already gone, but its Workflow `alcance-spike-wf` is still listed; I did not touch it.
