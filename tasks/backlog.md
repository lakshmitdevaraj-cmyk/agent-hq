
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

## Later: stale-read hardening, remaining whole-record campaign writers (batch 7 item 9)
Batch 7 moved the running job, browser_checked_ids and sender defaults into their own record and made `campaign.update` re-read before writing. These handlers still read the whole campaign record and write it back, so with ~1 minute stale reads they could in theory undo a recent settings change: campaign.run / sync (status), leads import and delete (counters), send (`status: "sending"`, counters), webhook-receive (reply and bounce counters). Idea: derive counters from emails/leads (already done for emails) and keep a separate small status record.
