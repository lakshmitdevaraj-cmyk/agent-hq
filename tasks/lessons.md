# Lessons

- **Background jobs and Blobs reads (batch 6 live test):** the page records a job and immediately calls the background function; Blobs reads are eventually consistent, so the function may not see the job yet. A background job must wait/retry for its own job record (`waitForJob`) and must not clobber its progress with a stale read (`jobMemo`). Never "return quietly" when the record is missing on the first read.
- **Apify actors: read the actor's real input schema** (`GET /v2/acts/<actor>/builds/default`) before choosing fields. playwright-scraper waits for `networkidle` by default, which never happens on sites with chat widgets/trackers; use `waitUntil: "domcontentloaded"` plus a short in-page wait. Field names matter (`maxPagesPerCrawl`, not `maxRequestsPerCrawl`).
- **Show failures where the user looks:** record the external run's status, message and last error lines on the job so the banner explains a failure without opening the vendor console.
- **Test leads named after real businesses:** the greeting helper treated a test lead's name as a person's name. The code (not the model) decides the greeting; only a confirmed owner counts.
- **Uncertain facts must not leak into the pitch:** when a gap is unknown, the fallback pitches phone calls only; code check rejects chat/website wording.
- **Prove an external-service fix locally when the key is not available:** replay the same navigation in real Chromium (playwright-core + cached Chrome) and run the same detectors on the output.
