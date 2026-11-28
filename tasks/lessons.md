# Lessons

- **Background jobs and Blobs reads (batch 6 live test):** the page records a job and immediately calls the background function; Blobs reads are eventually consistent, so the function may not see the job yet. A background job must wait/retry for its own job record (`waitForJob`) and must not clobber its progress with a stale read (`jobMemo`). Never "return quietly" when the record is missing on the first read.
- **Apify actors: read the actor's real input schema** (`GET /v2/acts/<actor>/builds/default`) before choosing fields. playwright-scraper waits for `networkidle` by default, which never happens on sites with chat widgets/trackers; use `waitUntil: "domcontentloaded"` plus a short in-page wait. Field names matter (`maxPagesPerCrawl`, not `maxRequestsPerCrawl`).
- **Show failures where the user looks:** record the external run's status, message and last error lines on the job so the banner explains a failure without opening the vendor console.
- **Test leads named after real businesses:** the greeting helper treated a test lead's name as a person's name. The code (not the model) decides the greeting; only a confirmed owner counts.
- **Uncertain facts must not leak into the pitch:** when a gap is unknown, the fallback pitches phone calls only; code check rejects chat/website wording.
- **Prove an external-service fix locally when the key is not available:** replay the same navigation in real Chromium (playwright-core + cached Chrome) and run the same detectors on the output.
- **Same-looking emails are a data problem, not a wording problem:** a reviewer that flags "too similar" is right. Give the writer real, saved, business-specific details (from the site and Google), make the opening use one, and check it in code; never loosen the similarity check.
- **A weak model makes the code checks look broken:** when a draft model keeps failing the same check, say so and test with the stronger model; do not weaken the check. Local runs on a free key can run out of daily quota, so switch the reviewer model only for the local test and say so.
- **Rewrite budget (batch 8 plan review):** at most ONE rewrite per draft or message in total (a writer retry after a code check or a reviewer rewrite, never both). Loops waste free-tier Gemini; after that one rewrite it becomes "Check this".
- **Social messages follow the email skip rules**, and show "Emailed on <date>" next to the buttons so the user can see a lead already got an email.
- **A test harness must run the current build:** rebuild the esbuild bundle before every run (esbuild is only found when the build script sits inside the project folder), or edits look like they changed nothing.
- **Short messages may share the offer sentence:** do not compare social messages with each other for 8+ repeated words (the plain offer sentence repeats naturally); only compare with the offer and the worked examples, and ignore the call-to-action sentence.
- **Check website facts against the real sites, not just the spec (batch 8 review):** a viewport with `initial-scale=1` and no fixed width is mobile friendly (Duda); iPhone Safari auto-links plain phone numbers, so "not tappable" must not be pitched unless `format-detection telephone=no` is set. Test each new fact on two or three real sites before trusting it.
- **Sameness checks must ignore true shared descriptions:** between emails of one campaign the limit is 12 words and plain descriptions of the service (answers calls and messages, takes the details, sends them to you) are ignored; copying from the offer or the examples stays at 8.
- **Every reviewer gets the same offer text:** the social reviewer was not given SENDER_OFFER and blocked calls as "not offered". Any new reviewer payload must carry the offer, and the "unoffered feature" rule must say what the offer really covers (calls and website messages).
- **Words are not claims:** "scheduling" must only fail when the assistant is said to schedule, book, dispatch, quote or take payments, not on "busy schedule".
- **Message timing matters:** a LinkedIn connection note is sent before they accept, so it can never thank them for accepting.
- **Never click a real download button while testing in the browser pane (batch 8):** it opens the user's macOS "Save As" dialog and can save test data into their Downloads. Check CSV content by calling the CSV builder in code (or intercept before any click), never by pressing "Export CSV".
- **Licensed third-party material never goes into this public repo (batch 8c):** the coach's packs are under a personal-use licence (no redistribution, no publishing). Read them only to understand the method; write our own rules, prompt wording and banned-phrase list from the principles, and never use the coach's or the tool's name in code, UI or docs. The framework is called "Alcance 3-step". Report that nothing was copied.
- **Apply a naming or licence rule to the plan file too (batch 8c):** the plan I wrote still used the third party's name for files, ids and prompts after the licence message; it was rejected until the names were own (messagerules, "three-step", THREE_STEP_REVIEW_PROMPT). Before presenting a plan, grep the plan text for every name the user has ruled out.
- **Check a pure function's day/time wrap-around with a far-apart pair (batch 8c):** the reply-slot helper accepted 12:00 in Texas because 23:30 in India has hour 23 and the end time wrapped to hour 0. Compare minutes-of-day, not hours, and test sender and prospect zones that do not overlap.

## 22 Nov (batch 8c, owner review)
- Test on what the real writer produces, never only on hand-made fixtures. Fixtures used a framework id and email count the real writer did not use ("three-step" vs the saved id), so threading, follow-up and send tests passed on data that never occurs. Use ONE framework id everywhere and run the send/follow-up tests on drafts the real writer just saved.
- A fact about the sender must stay inside the Settings proof line ("built on my own website"). The writer drifted to "my own home-services business", which is false. Facts about the sender get a code check (false-business-claim, proof-drift), not only a prompt line.
- Anything that can be decided by looking at the text (does it end with a yes/no offer, is it the last email, length) is a code check; the AI reviewer is told not to judge it and its remarks about it are dropped when the code already found the answer.
- When a re-count differs from an earlier number (19 vs 18 newly hidden), say so and say why, do not quietly replace it.
- tsc: the root tsconfig has "files": [] so `tsc --noEmit` checks NOTHING. Typecheck with `npx tsc -b` (what `npm run build` runs). 22 Nov: earlier "tsc exit 0" claims for batch 8c used the empty one.

## 26 Nov (P1 database, plan review)
- A send that "failed" (API or network error) is not a bounce. Only a real bounce (bounce event, bounce report, bounced/ contact entry) stops email; list failed sends with their error for the owner to decide.
- US holidays for this audience are the days home-service offices are really closed (New Year's Day, Memorial Day, 4 July, Labor Day, Thanksgiving and the day after, Christmas Eve, Christmas Day), not the federal list.

## 27 Nov (P2 chunk 1, plan review)
- Retention rules must name every kind the scope lists: "webhook received" History entries (activity, category system, details.event_id) keep 30 days, not the 90 days of other system entries. Check how each kind is really logged before writing a purge.
- Any harness that runs the old app code must block all network access (fetch, http/https, the Gemini client) and prove a call is refused, so tests can never reach Gemini, AgentMail or Apify.
- Plans and reports are saved as files in ~/Documents/ShiftForge HQ/pN-reports/ (e.g. chunk1-plan.md), never only shown in chat.

## 27 Nov (P2 chunk 2, planning)
- Chunk plans don't use plan mode: plan mode could only write its own file, so the plan never reached p2-reports/. Write `chunkN-plan.md` to the reports folder first, then stop and wait for the go.

## 27 Nov (P2 chunk 4, report review)
- `not_call_driven` covers custom builders and design-build firms (plus shops, suppliers, wholesale, rentals), never general remodelers. Catch the builder side from Google's full category list or the owner's description too, not only the main category (a named case had main category "Remodeler", with "Custom home builder" and "design-build firm" only in the raw data).
- `has_answering_booking` needs a booking tool AND a real answering service or chat widget. "24/7" or "24/7 emergency service" on the site is not an answering service. When a rule is approximate, check what each signal really means before counting it.
- Report timings two ways from now on: the database's own time (`EXPLAIN ANALYZE`) and the time measured from this Mac.
- Named cases from the fix list are real leads: never copy their names, first names or email domains into code, comments or test fixtures (run B caught three before commit). Make up names for fixtures, and keep the real ones only in `~/agent-hq-backups/p2-named-cases.json`.

## 28 Nov (P2 run C, start)
- Real prospect names also hide in plan files and older test fixtures (`tasks/p2-plan.md`, `tasks/tests-8b/`), not only in new code. Before a commit, grep every changed file for the named cases; use fix-list IDs in docs and made-up names (and made-up towns) in fixtures.
- An exception to a claim check must not swallow the claim itself: "busy/team/crew" before "books" is their schedule only when "our"/"we" is not the one doing it ("our team books jobs" is still a scheduling claim). Every exception gets a hit test that names "our"/"we" as the subject.
- Check table columns before writing SQL against them: `campaigns` has no `status` (it is the `campaign_jobs` row of kind `leads`). Write the tests first; they caught it.
- A SQL function that calls settings helpers or `next_working_day` per row is slow (36 s at 6,000 emails): work those out once per call (plpgsql variables), then time it at the target size.

## 28 Nov (P2 run C, chunk 7 start)
- Tests first is a rule in every chunk, not only when there is time: write the tests, run them, and save the failing run to `p2-reports/chunkN-failing-run.txt` before any code. It was skipped in chunks 5b and 6.
- A slow suite is a bug to fix, not a cost to report: the full suite took 41 min because equivalence tests made one Neon call after another (about 225 ms a round trip from India) on a pool of 2. Run independent calls side by side (the harness's own pool and `pmap`), and while building run only the area's files and that chunk's switch-proof block; the whole suite once at the end of the run.

## 28 Nov (P2 run D, chunks 8 and 9)
- `compare()` paths are written without `$` (`body.data`, not `$.body.data`); only the root is `"$"`. A wrong `unordered` path silently does nothing, and a test passes only while the order happens to match. Check an option works by seeing it change a result.
- Moving the key check into the database changes every SQL-mode handler test: they now reach the database first, so "answers 501 before any database call" stops being true. Tests that run the real handler need a key there: the harness registers a random key per run (never a fixed key in a public repo) and removes it on exit.
- A failing assertion can print a whole old answer, with real business names, into a saved report. Cut assertion messages to a few characters wherever they quote an answer from the export.
