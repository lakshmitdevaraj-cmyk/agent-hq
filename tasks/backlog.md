
## Later: stale-read hardening (Blobs reads can lag ~1 min; strong consistency unavailable with connectLambda in @netlify/blobs 8.1.0)
- Deleting a lead then generating right away may still draft for it.
- Editing a draft (To/subject/body) then sending right away may send the old copy.
- Deleting a draft then sending right away may still send it.
- Editing a lead's email then drafting may use the old address.
- Idea: send the page's known state with draft/send requests (as done for the exclude tick), recheck drafts at send time.

## Notes from batch 5
- John Moore Services (and other sites) answer 403 to automated visits: the check reports "website did not load" and moves on. We do not disguise the request.
- Owner found only by the Gemini fallback is stored as low confidence (shown for review, not used in greetings). Retype it on the lead to confirm.
- Re-check of an old campaign refreshes gap/social/owner only; it only fills an email for a lead that has none (never replaces one).
