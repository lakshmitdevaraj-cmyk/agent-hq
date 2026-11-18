
## Later: stale-read hardening (Blobs reads can lag ~1 min; strong consistency unavailable with connectLambda in @netlify/blobs 8.1.0)
- Deleting a lead then generating right away may still draft for it.
- Editing a draft (To/subject/body) then sending right away may send the old copy.
- Deleting a draft then sending right away may still send it.
- Editing a lead's email then drafting may use the old address.
- Idea: send the page's known state with draft/send requests (as done for the exclude tick), recheck drafts at send time.
