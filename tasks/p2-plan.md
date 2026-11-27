# P2 plan: data layer and rules (plan only, no code)

Written 27 Nov 2026 in P2 chunk 1. Scope IDs come from the approved v2 scope (see the appendix of `~/Documents/ShiftForge HQ/p2-reports/p2-chunk1-prompt.md`). Each chunk is about 2 hours and gets its own prompt. Every chunk ends the same way: commit, push `rebuild/p2-data-layer`, update `tasks/handoff.md`, and save a report in `p2-reports/`.

## How every chunk works
- **New code** lives in `netlify/functions/lib/db/` (client from chunk 1) and `netlify/functions/lib/sql/<area>.ts` (one module per area). Each action's SQL version is a plain function `(sql, params) => result`.
- **Editing `command.ts`** (each case calls the SQL version) is an edit to an existing app file, so each chunk's prompt must approve it. **Decided 27 Nov:** the Blobs code stays behind one switch (`DATA_BACKEND=blobs|sql`, Blobs by default until P5), so the live app keeps running on Blobs until P5. The old code is removed about 2 weeks after P5.
- **Proof for every rewritten action (R13):** an equivalence case in `scripts/db/equiv/` (old Blobs path on the P1 export vs SQL on `dev`). Known, intended differences (P1 merges, step fixes, `+` restored, merged leads hidden) must be listed, never hidden. Writes are tested in rolled-back transactions on `dev`.
- **Tests:** `node --test --test-concurrency=1 scripts/db/test/*.test.mjs` and `npx tsc -b`, all passing.
- Every list and count leaves out `merged_into is not null` leads.

## Chunks

| # | Name | Scope IDs | Files touched | Tests | Proof |
|---|---|---|---|---|---|
| 1 | Foundations (this chunk) | R8, R9/V3, R2 (column), R12 (table), V9 (function), R10 (blocked), R13 (harness) | `CLAUDE.md`, `tasks/p2-plan.md`, `lib/db/client.ts`, `db/migrations/0008–0010`, `scripts/db/equiv/` | db-client, schema-p2, equiv | bad cert refused; migrations on `dev` with row counts; harness catches a wrong result |
| 2 | Campaign reads and writes | S0 (campaign search), R1 **F2** (a job never undoes a setting), F17 (merged hidden), R13 | `lib/sql/campaigns.ts`, `command.ts` cases | equiv for list/get; write tests | campaign list and get equal to old path, merged leads left out |
| 3 | Leads and Prospects | S0, S6b (indexed search, global search), A1 (dup check), R1 **F16** (one email edit: merge `leads.update` and `lead.set_email`; changing the address updates every unsent draft) | `lib/sql/leads.ts`, `lib/sql/search.ts` | equiv for leads.list, prospects.list; search speed | Prospects list paged and indexed; `explain` shows index use |
| 4 | Add lead and lead finding | A1 (single, paste, CSV; dup check on link, website, phone, email across campaigns; never reads LinkedIn), R1 **F3** (a site check never overwrites a newer contacted / do-not-contact flag), **F33** (chains, franchises, non-home-service flagged), **F32** flags (too big, already has 24/7 answering and booking, not call-driven, template / keyword sites; never draft without her say-so; the site facts behind them are P4) | `lib/sql/leads.ts`, `lib/sql/leadgen.ts` | dup-check tests; equiv for sync on a fixture | duplicate across campaigns refused; Apify calls stubbed in tests |
| 5 | Drafts | A4 (write from scratch, one draft per lead and step), R1 **F9** (create updates the existing draft or refuses with its id), F46/F22 backends, R9 (footer check) | `lib/sql/emails.ts` | equiv for emails.list; one-draft rule; hand-written draft never sent to Gemini | F9 unique rule holds through the action; createDraft never calls Gemini |
| 5b | Message checks | R1 **F35** (recipient check: email vs website domain, greeting vs personal address → "Check this"), **F36** (personal address as greeting when no owner is saved → "Check this"), **F37** ("your assistant", email 4 must not pitch, opening-hours claims only with a saved source), **F38** ("5 Star" in a name is not a rating), **F39** (sameness check: offer core phrase; "scheduling" near-miss), **F40** (`phone_not_tappable` is lead info only) | `lib/messagerules.ts`, `lib/review.ts` (existing files; the chunk prompt must approve), checks run on save in `lib/sql/emails.ts` | hit and near-miss tests per check, on drafts the real writer produced (lessons, 22 Nov) | the named cases (Hart, DTH, Campbell, 5 Star A/C Filter, Tri City) give the expected result |
| 6 | Sending and plan | R2 (failed reason saved, bounced is its own state), R9 (US postal address blank → warn, don't send), C2 (`today`, `planSend` one DB call each), R13 timings, R1 **F4** (no whole-store scans; timings), **F7** (Bounced is its own state: email stops, social stays open), **F8** (three stop states only), **F45** (mark "sending" before AgentMail, then "sent"; keep `limit`, `email_ids`, `sequence_position`; never double-sends) | `lib/sql/send.ts`, `db/migrations/00xx_plan_functions.sql` | send tests with AgentMail stubbed; planSend rules; timings at 1,500 leads / 6,000 emails on a `perf` branch | failed send keeps its reason and is never a bounce; send refused with blank postal address; timings report |
| 7 | Replies and webhooks | R4 (AgentMail signature, raw events 30 days), V8 (webhook status), D2 (health-check subject), R12 (outbox writes for CRM handoff), R1 **F31** (short FYI alert or daily summary for opt-outs and bounces, through the outbox), **F47** (match webhook events by AgentMail message id, thread id only as a checked fallback; a webhook never changes `sent_at`; the day count counts real sends; store the inbox actually used) | `lib/sql/replies.ts`, `lib/sql/webhooks.ts`, `webhook-receive.ts` | signature tests (bad signature refused); equiv for replies.list | unsigned or wrongly signed event refused |
| 8 | Follow-ups, social and touches | A5 (social blocks; manual link never overwritten; hand-sent message recorded), `dueFollowUps`, R1 F12–F14, **F3** (a follow-up move never overwrites a newer move or flag), **F10** (due dates skip weekends, holidays and blackout dates via `next_working_day`), **F11** (Facebook page gone stops that channel), **F15** (record a hand-sent message with its date), **F30** (opt-out / do-not-contact skips every social draft), **F34** (`touch.delete` removes only hand-recorded touches), **F41** (social reviewer gets the same offer text) | `lib/sql/followups.ts`, `lib/sql/social.ts` | equiv for followups.list, social.list, lead.touches | manual link survives every check; follow-ups skip stopped leads |
| 9 | Settings, keys and access | R3 (Gemini key in Settings → API keys only; drafting stops reading Voice), R6 (access keys: read only / drafts / can send; revoke; `agent.list` returns no keys), V7 (API key tests), V8 (access keys) | `lib/sql/settings.ts`, `lib/sql/agents.ts`, `lib/auth.ts` | key-scope tests (a read-only key can't send); revoke test | `agent.list` has no keys; revoked key refused |
| 10 | Forms, links and clicks | A2 (form builder, per-lead link, interested + stop follow-ups, spam trap, rate limit), A3 (links library, UTM), R7 (signed click links, no open redirect) | `lib/sql/forms.ts`, `lib/sql/links.ts`, `form-submit.ts`, `track-click.ts`, migration for links | forged click link refused; spam trap; rate limit | open redirect refused; form submission stops follow-ups |
| 11 | Alcance client and the rest | C1 (one documented module with tests: today, planSend, send, repliesSince, sentList, dueFollowUps, recordSocialSent, recordReply, createDraft, markReady, addLead, importLeads, searchLeads, stopLead, switchToSocial, weeklyReport, health; stubs checkWebsite (P4), sendToCrm (P6)), jobs, analytics, activity, data.* | `lib/alcance/` (client), `lib/sql/jobs.ts`, `lib/sql/activity.ts` | one test per client function | `markReady` refuses without explicit say-so; `send` refuses an unapproved plan |
| 12 | Removals and sweep | X1 (export 7 tasks), X2 (move Gemini key first, export 5 calls), X3 + R5 (save the page as a file; no public HTML), X8 (old April forms), D2 sweep, R13 final timings | removed actions in `command.ts`, `page-serve.ts`, `netlify.toml` (with approval) | removed actions return a clear "removed" error; archives exist | archives saved outside the repo before anything is deleted |

**Fix list (R1)**, placed from `scope-reports/alcance-master-fix-list.md` (25 Nov). Every R1 item has one home:

| F | Chunk | | F | Chunk | | F | Chunk |
|---|---|---|---|---|---|---|---|
| F2 | 2 | | F11 | 8 | | F37 | 5b |
| F3 | 4 (lead flags), 8 (follow-up moves) | | F15 | 8 | | F38 | 5b |
| F32 | 4 (flags; site facts P4) | | | | | | |
| F4 | 6 (timings; every chunk avoids scans) | | F16 | 3 | | F39 | 5b |
| F7 | 6 (state), 8 (social stays due) | | F30 | 8 | | F40 | 5b |
| F8 | 6 | | F31 | 7 | | F41 | 8 |
| F9 | 5 | | F33 | 4 | | F45 | 6 |
| F10 | 8 | | F34 | 8 | | F47 | 7 |
| | | | F35 | 5b | | | |
| | | | F36 | 5b | | | |

Not in R1 but touching P2: **F1** (stale reads) is proved in every chunk by "change, then read straight away" in its tests. F12–F14, F17 and F19 were done in P1; chunks 2 and 8 re-test them. **F18** (facts typed by hand) is marked P1–P2 in the fix list but isn't in R1; I've placed it in chunk 3 (`lead_facts` with `source`). **F32** (flags before drafting) isn't in R1; Lakshmi placed its flags in chunk 4 with F33 (27 Nov). The site facts behind them stay in P4. F5, F6, F20–F29 and F46 are P3 screens (chunks 3, 5 and 8 build their backends). F42–F44 are P4. The "already in the code" list is re-tested where its action is rewritten.

## All 111 actions

Line numbers are from `command.ts` at `ccafc2c`. "Removed" actions are archived first (chunk 12).

| Action | Line | Chunk |
|---|---|---|
| auth.bootstrap | 3054 | 9 |
| auth.rotate | 3065 | 9 |
| data.counts | 3079 | 11 |
| data.export | 3088 | 11 |
| data.import | 3110 | 11 |
| agent.register | 3137 | 9 |
| agent.list | 3161 | 9 |
| agent.heartbeat | 3165 | 9 |
| agent.delete | 3175 | 9 |
| task.create | 3184 | removed (X1) |
| task.list | 3203 | removed (X1) |
| task.move | 3207 | removed (X1) |
| task.delete | 3222 | removed (X1) |
| activity.log | 3230 | 11 |
| activity.list | 3241 | 11 |
| form.create | 3249 | 10 (replaced by A2; old April forms removed under X8) |
| form.list | 3280 | 10 (replaced by A2; X8) |
| form.submissions | 3283 | 10 (replaced by A2; X8) |
| webhook.create | 3290 | 7 |
| webhook.list | 3298 | 7 |
| webhook.events | 3301 | 7 |
| voice.config.check | 3308 | removed (X2) |
| voice.config.get | 3312 | removed (X2) |
| voice.config.set | 3322 | removed (X2) |
| voice.config.clear | 3332 | removed (X2) |
| config.status | 3341 | 9 |
| config.set | 3356 | 9 |
| config.test | 3383 | 9 |
| config.clear | 3400 | 9 |
| voice.session.save | 3411 | removed (X2) |
| voice.session.list | 3440 | removed (X2) |
| voice.session.get | 3446 | removed (X2) |
| voice.session.delete | 3454 | removed (X2) |
| voice.invitation.create | 3470 | removed (X2) |
| voice.invitation.list | 3492 | removed (X2) |
| voice.invitation.get | 3498 | removed (X2) |
| voice.invitation.dismiss | 3505 | removed (X2) |
| voice.invitation.accept | 3514 | removed (X2) |
| page.create | 3525 | removed (X3) |
| page.list | 3550 | removed (X3) |
| page.get | 3553 | removed (X3) |
| page.update | 3560 | removed (X3) |
| page.delete | 3577 | removed (X3) |
| outreach.preview | 3588 | 9 |
| outreach.preview.start | 3607 | 9 |
| outreach.preview.result | 3618 | 9 |
| outreach.social.write | 3625 | 8 |
| outreach.social.list | 3650 | 8 |
| outreach.social.update | 3659 | 8 |
| outreach.social.verify | 3695 | 8 |
| outreach.social.mark_sent | 3706 | 8 |
| outreach.social.record_hand | 3773 | 8 |
| outreach.touch.delete | 3792 | 8 |
| outreach.lead.touches | 3802 | 8 |
| outreach.lead.fb_checked | 3808 | 3 |
| outreach.social.plan | 3820 | 8 |
| outreach.social.batch.start | 3834 | 8 |
| outreach.social.batch.status | 3857 | 8 |
| outreach.social.batch.resume | 3865 | 8 |
| outreach.social.delete | 3873 | 8 |
| outreach.job.resume | 3880 | 11 |
| outreach.job.resume_due | 3900 | 11 |
| outreach.emails.review.start | 3913 | 5 |
| outreach.browsercheck.plan | 3933 | 4 |
| outreach.browsercheck.start | 3944 | 4 |
| outreach.draft.start | 3962 | 5 |
| outreach.campaign.create | 3981 | 2 |
| outreach.campaign.list | 4017 | 2 |
| outreach.campaign.get | 4023 | 2 |
| outreach.campaign.update | 4031 | 2 |
| outreach.campaign.delete | 4066 | 2 |
| outreach.campaign.run | 4089 | 4 |
| outreach.campaign.sync | 4141 | 4 |
| outreach.leads.list | 4289 | 3 |
| outreach.lead.set_email | 4311 | 3 |
| outreach.leads.update | 4359 | 3 |
| outreach.prospects.list | 4406 | 3 |
| outreach.lead.screenshot.get | 4484 | 3 |
| outreach.leads.count | 4492 | 2 |
| outreach.leads.add_test | 4499 | 4 |
| outreach.leads.delete | 4544 | 3 |
| outreach.leads.enrich_one | 4585 | 4 |
| outreach.leads.check_site | 4586 | 4 |
| outreach.emails.generate_one | 4641 | 5 |
| outreach.emails.create | 4653 | 5 |
| outreach.emails.generate | 4746 | 5 |
| outreach.emails.list | 4843 | 5 |
| outreach.emails.update | 4878 | 5 |
| outreach.emails.delete | 4932 | 5 |
| outreach.footer.preview | 4958 | 5 |
| outreach.settings.get | 4979 | 9 |
| outreach.inboxes.list | 4983 | 9 |
| outreach.settings.set | 5014 | 9 |
| outreach.emails.send | 5129 | 6 |
| outreach.replies.list | 5360 | 7 |
| outreach.replies.delete | 5372 | 7 |
| outreach.replies.get | 5389 | 7 |
| outreach.send.today | 5402 | 6 |
| followups.list | 5411 | 8 |
| followups.update | 5465 | 8 |
| followups.replied | 5488 | 8 |
| followups.linkedin | 5498 | 8 |
| outreach.reply.draft | 5512 | 7 |
| outreach.reply.send | 5557 | 7 |
| outreach.replies.convert_to_task | 5604 | removed (X1: it writes tasks) |
| outreach.analytics.summary | 5647 | 11 |
| outreach.replies.sync | 5705 | 7 |
| outreach.webhook.events | 5770 | 7 |
| outreach.webhook.test | 5802 | 7 |
| webhook.create_typed | 5855 | 7 |
| webhook.delete | 5870 | 7 |

Totals (counted from the table): chunk 2: 6 · 3: 7 · 4: 7 · 5: 9 · 6: 2 · 7: 13 · 8: 17 · 9: 16 · 10: 3 · 11: 8 · removed: 23 (X1: 5, X2: 13, X3: 5) = **111**. X8 removes the old April forms' data; their three actions are replaced in chunk 10.

## Notes
- `outreach.leads.enrich_one` falls through to `check_site`; both move together.
- `config.*` and `outreach.settings.*` read `voice-config` today (the Gemini key). R3 (chunk 9) must move the key **before** X2 removes Voice (chunk 12).
- `outreach.replies.convert_to_task` goes with Tasks (X1). If Lakshmi wants a reply → "to do" later, it becomes a new feature, not a carried action.
- Other functions also change: `webhook-receive.ts` (7), `track-click.ts` and `form-submit.ts` (10), `page-serve.ts` (12), `ai-background.ts` (5 and 8: draft jobs read and write through SQL).
