# mission-control-outreach

**Trigger:** "find me leads for …", "run outreach to …", "target …",
"build an outreach campaign for …", "email …", or any prompt where the
human describes an ideal customer profile and wants outbound email to
happen.

**What it does:** Turns one natural-language sentence into a real
outreach campaign — leads scraped from Google Maps, personalised emails
drafted by Gemini, real emails sent via the user's own AgentMail inbox,
with live tracking of delivered / bounced / clicked / replied events.

**Replaces:** Apollo ($99/mo), Instantly ($97/mo), Clay ($149/mo),
Smartlead ($97/mo), plus an SDR making $60K+/yr.

---

## Setup — one-time

The human installs AgentHQ from the one-click Netlify button, then pastes
three keys (Gemini, Apify, AgentMail) in the onboarding wizard. That's
your entire prerequisite. Env vars for you:

```
AGENT_HQ_URL=<e.g. https://agent-hq.netlify.app>
AGENT_HQ_KEY=<master or agent api_key>
```

Every call is the same shape:

```
POST {AGENT_HQ_URL}/api/command
Headers:
  Content-Type: application/json
  X-API-Key: {AGENT_HQ_KEY}
Body:
  {"action": "<group.verb>", "params": { ... }}
```

---

## The flow — two approval gates, everything else autonomous

```
HUMAN                AGENT (you)                       UI SURFACE
─────                ───────────                       ──────────
"Find me 20                                            /outreach wizard
 roofing
 contractors
 in Phoenix"   →     outreach.preview                  preview step
                     → location + 3 search terms
                     + maxResults
               ←     "Location: Phoenix, AZ.
                     Terms: roofing contractor,
                     commercial roofer, solar
                     roof installer. Green-light
                     to spend Apify credits?"

   — GATE 1 —

"Go"           →     outreach.campaign.create          campaign card
               →     outreach.campaign.run             status: searching
                     [Apify runs ~30–120s]             → ready
               ←     "20 leads imported."

               →     outreach.emails.generate          drafts appear
                     [Gemini drafts N emails]
               ←     "20 drafts ready. Review
                     one or send all?"

   — GATE 2 —

"Send all"     →     outreach.emails.send              sent counter ticks
               ←     "Sent 20/20."

                     [AgentMail webhooks fire]
                     → delivered counter ticks         live via webhook
                     → clicked counter ticks           live via /t/:token
                     → replied counter ticks           live via
                                                       message.received

                     outreach.replies.list             inbox populates
                     outreach.replies.convert_to_task  kanban card
```

**You never skip Gate 1 (spending Apify credits).** You never skip
Gate 2 (real emails to real people). Everything else is autonomous.

---

## Full action catalog

### Natural-language preview
- `outreach.preview` — Gemini converts a free-text ICP into
  `{ location, searchTerms[], maxResults }`. No side effects — safe to
  call repeatedly.
  params: `{ query, max_results? }`

### Campaigns (the container)
- `outreach.campaign.create` — persists a campaign. Pass the
  `structured_query` you got from preview so the UI shows the plan.
  params: `{ name, query, structured_query?, description? }`
- `outreach.campaign.list` — all campaigns, newest first.
- `outreach.campaign.get` — one campaign by id.
  params: `{ id }`
- `outreach.campaign.update` — patch (e.g. rename).
  params: `{ id, ...patch }`
- `outreach.campaign.run` — **fires Apify**. Blocks 30s–3min. Writes
  one lead record per result. Only call after Gate 1.
  params: `{ id }`
- `outreach.campaign.delete` — removes the campaign record. Leads &
  emails remain in storage but become unreachable via the UI.
  params: `{ id }`

### Leads
- `outreach.leads.list` — all leads for a campaign, newest first.
  params: `{ campaign_id, limit? }`
- `outreach.leads.count` — cheap count.
  params: `{ campaign_id }`
- `outreach.leads.add_test` — **Critical for demos.** Self-seeds a lead
  with the user's own email so they can watch send→reply live. Shows as
  🧪 TEST in the UI. ALWAYS offer this as a step if the human is
  piloting the flow for the first time.
  params: `{ campaign_id, email, name?, notes? }`
- `outreach.leads.enrich_one` — **Important after an Apify import.**
  Google Maps rarely returns emails (phone + website only, typically).
  After leads import, loop this across every lead with a website but no
  email. Each call fetches homepage + /contact + /contact-us and regex's
  out email addresses. Recovers ~40–70% of the missing addresses. Fails
  open — if a site blocks scraping, we move on.
  params: `{ campaign_id, lead_id }`
- `outreach.leads.delete` — removes one lead and its drafted (unsent) emails.
  params: `{ campaign_id, lead_id }`

### Emails — two paths, pick based on who's writing

**Path A — You (the agent) write the draft yourself (PREFERRED when you're a capable writer).**
- `outreach.emails.create` — inject a draft straight into the campaign.
  No Gemini call. Same downstream pipeline: link tracking, webhook
  status updates, reply correlation. Dedupes on (lead_id, step). Use
  this when you already have strong writing in-context and don't need
  a second model to re-write it.
  params: `{ campaign_id, lead_id, subject, body_text, body_html?, sender_name?, sequence_position?, sequence_total?, framework? }`

**Path B — Hand off drafting to Gemini.**
- `outreach.emails.generate_one` — Gemini drafts exactly one email for
  one (lead, step) combination. Call in a loop. Keeps every call well
  under Netlify's 26s cap regardless of campaign size. Returns
  `{ ..., skipped: true }` if that (lead, step) already has a draft.
  Supports the same framework + step params as Path A.
  params: `{ campaign_id, lead_id, sender_name?, sender_company?, sender_offer?, framework?, step?, total_steps? }`
- `outreach.emails.generate` — batch variant that drafts a one-off email
  for every lead with an email. No framework support (always one-off).
  Safe only for small campaigns (<10 leads). Prefer `generate_one` for
  anything real.
  params: `{ campaign_id, sender_name?, sender_company?, sender_offer? }`

### Sequence frameworks

Outreach is rarely a single email. Pick a 3-step framework at draft time
for dramatically higher reply rates:

| `framework` | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| `one-off` (default) | Single email. No follow-ups. | — | — |
| `pas` | Name the pain (no pitch) | Agitate the cost | Propose solution + CTA |
| `aida` | Attention hook | Build interest / proof | Desire + low-friction CTA |
| `sdr` | Direct 2-line pitch | Value-add (free resource) | Breakup email ("last time") |

When drafting a sequence, **batch by step, not by lead**:
- Loop 1: for every lead, generate step 1
- Loop 2: for every lead, generate step 2 (references step 1)
- Loop 3: for every lead, generate step 3 (references 1 and 2)

This way the handler can fetch prior steps for continuity when it drafts
step 2/3, so the emails read like a coherent thread rather than three
cold strangers.

### Sending a sequence
- `outreach.emails.send` — by default sends all drafted emails. For
  sequences, pass `sequence_position: N` to send only that step.
  Leads who already replied (at any prior step) are auto-skipped for
  step 2+. The human clicks "Send step N" when they're ready — there
  is no auto-scheduler; cadence is deliberate and human-controlled.
  params: `{ campaign_id, email_ids?, sequence_position?, limit? }`
  - `limit` — send only this many drafts, oldest first; the rest stay
    queued. Returns `{ sent, total, queued, errors }`.
  - A footer (opt-out line + "ShiftForge AI" signature, plus the optional
    postal address from `outreach.settings`) is appended automatically at
    send time — never write it into drafts. Leads marked do-not-contact
    (an inbound reply said no/stop/unsubscribe) are never sent to.
  - `email_ids` — explicit list wins over everything else
  - `sequence_position` — filter by step (1, 2, or 3)
  - neither — send all drafts (legacy single-step behavior)

### Other email actions
- `outreach.emails.list` — all drafts/sends for a campaign.
  params: `{ campaign_id, limit? }`
- `outreach.emails.update` — edit a single draft before send (drafts only).
  params: `{ campaign_id, email_id, subject?, body_text?, body_html? }`
- `outreach.emails.delete` — delete a single draft (drafts only).
  params: `{ campaign_id, email_id }`
- `outreach.settings.get` / `outreach.settings.set` — optional footer
  postal address (blank by default). params: `{ postal_address }`

### Replies (inbound, after AgentMail webhook fires)
- `outreach.replies.list` — inbound replies. Filter by campaign.
  params: `{ campaign_id?, limit? }`
- `outreach.replies.get` — one reply's full content.
  params: `{ id }`
- `outreach.replies.convert_to_task` — turns a reply into a kanban
  card in the Needs Input column. Ties the loop back to `/tasks`.
  params: `{ id }`

### Analytics
- `outreach.analytics.summary` — aggregate totals + per-campaign rows.
  No params.

### Webhook health
- `outreach.webhook.test` — end-to-end health check. Sends a closed-loop
  test email from the user's AgentMail inbox to itself, polls for
  inbound events for 15s. Use this if the user reports counters aren't
  ticking.
  params: `{ webhook_id }`

---

## How to write a good campaign brief in natural language

You should **only pass the human's own words** to `outreach.preview`.
Don't pre-format them into keywords — Gemini does the expansion. The
more colour the human gave (ratings, niches, neighbourhoods, sizes),
the more useful the expansion.

Bad brief you should push back on:
> "real estate agents"

Ask a clarifying question: *"Which city or metro, and any niche
(commercial, luxury, first-time buyer)?"*

Good brief you can run:
> "Commercial real estate brokers in downtown Austin, TX, focused on
> tech-company office leases. At least 20 reviews."

---

## How to write the sender context for emails.generate

The `sender_offer` field shapes the hook Gemini writes. It should be
**one sentence** stating what's being offered and why it matters.
Vague → generic emails. Specific → high-reply emails.

Bad: `"We help businesses with AI."`

Good: `"We ship AI voice agents that answer inbound leads 24/7. Flat
$28K, live in 30 days, full source handover."`

---

## The Gate 1 / Gate 2 pattern — explicit

When you get to either gate, log an activity entry describing exactly
what the human is about to approve, then stop and wait:

```
activity.log {
  category: "decision",
  summary: "About to run Apify scrape for Phoenix roofing contractors.
            3 search terms, up to 20 leads. ~$0.004 Apify credit.",
  details: { campaign_id, searchTerms, maxResults }
}
```

Then tell the human what you just logged and ask for go/no-go. Never
bypass this even if you think the human "obviously" wants it.

---

## Demo-safe pattern: seed a test lead first

For the first campaign of a session, always offer to add the human's
own email as a test lead before sending. This lets them see:
- the send counter tick,
- their own inbox receive the email,
- the click counter tick when they click a link in it,
- the reply counter + `/inbox` populate when they reply.

That's the full flywheel demonstrated with one email they control the
timing of. If they say "skip the test," respect it and send to the real
list directly — but recommend it first.

---

## Error recovery

- **`Gemini key not configured`** — direct the human to `/settings`
  (or `/outreach` for the onboarding wizard).
- **`Apify key not configured`** — same.
- **`AgentMail key not configured`** — same.
- **Apify run fails** — the campaign is marked `failed` with the error
  in `error_message`. Offer to retry (`outreach.campaign.run` again) or
  simplify the query.
- **`outreach.emails.send` returned errors** — check `result.errors`.
  Most common: invalid recipient email (lead had no/bad email). Use
  `outreach.leads.list` to filter those out before retrying.
- **Counters aren't ticking after send** — webhook isn't wired. Direct
  the human to `/outreach` → the webhook setup card. Run
  `outreach.webhook.test` to confirm.

---

## End-to-end example (copy, adapt, send)

Human prompt: *"Run outreach for dental clinics in Austin, TX, 4 stars
and up. Offer is our no-show reduction product — we cut no-shows 40%
with SMS reminders. I'm Mani from Vertical AI."*

```bash
# 1. Preview (no side effects)
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{"action":"outreach.preview","params":{"query":"dental clinics in Austin, TX, 4 stars and up","max_results":30}}'
# → { location: "Austin, TX", searchTerms: ["dental clinic Austin TX", "family dentist Austin TX", "cosmetic dentist Austin TX"], maxResults: 30 }

# ── GATE 1 ── log decision, ask human to approve Apify spend ──
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{"action":"activity.log","params":{"category":"decision","summary":"Ready to scrape 30 Austin dental clinics. ~$0.006 Apify spend."}}'

# (Human: "Go")

# 2. Create campaign
curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.campaign.create","params":{"name":"Austin Dentists · No-Show","query":"dental clinics in Austin, TX, 4 stars and up","structured_query":{"location":"Austin, TX","searchTerms":["dental clinic Austin TX","family dentist Austin TX","cosmetic dentist Austin TX"],"maxResults":30}}}'
# → { id: "abc123xyz", ... }

# 3. Run scrape
curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.campaign.run","params":{"id":"abc123xyz"}}'
# → { leads_imported: 28, ... }

# 4. Offer test-lead seeding
# (Human: "Yes, add my email as a test — mani@vertical.ai")
curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.leads.add_test","params":{"campaign_id":"abc123xyz","email":"mani@vertical.ai","name":"Mani (test)"}}'

# 4b. Enrich — Apify Google Maps rarely returns emails, so loop the
#     enrichment action over every lead with a website but no email.
MISSING=$(curl -s -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.leads.list","params":{"campaign_id":"abc123xyz"}}' \
  | jq -r '.data[] | select(.email == null and .website != null) | .id')
for LEAD_ID in $MISSING; do
  curl -X POST $AGENT_HQ_URL/api/command ... \
    -d "{\"action\":\"outreach.leads.enrich_one\",\"params\":{\"campaign_id\":\"abc123xyz\",\"lead_id\":\"$LEAD_ID\"}}"
done
# Typically 40–70% of those leads now have emails.

# 5a. Generate drafts — Gemini path, 3-step PAS sequence.
#     Loop by STEP first, then by lead. This lets step 2 reference
#     step 1 for continuity when the server fetches prior steps.
LEADS=$(curl -s -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.leads.list","params":{"campaign_id":"abc123xyz"}}' \
  | jq -r '.data[] | select(.email != null) | .id')
for STEP in 1 2 3; do
  for LEAD_ID in $LEADS; do
    curl -X POST $AGENT_HQ_URL/api/command ... \
      -d "{\"action\":\"outreach.emails.generate_one\",\"params\":{\"campaign_id\":\"abc123xyz\",\"lead_id\":\"$LEAD_ID\",\"sender_name\":\"Mani\",\"sender_company\":\"Vertical AI\",\"sender_offer\":\"We cut dental no-shows 40% with AI SMS reminders. 2-week pilot, flat fee.\",\"framework\":\"pas\",\"step\":$STEP,\"total_steps\":3}}"
  done
  curl -X POST $AGENT_HQ_URL/api/command ... \
    -d "{\"action\":\"activity.log\",\"params\":{\"category\":\"content\",\"summary\":\"Drafted step $STEP of 3 for all leads\"}}"
done

# 5b. ALTERNATIVE — you write the drafts yourself (no Gemini detour).
#     Better quality if you're a strong writer already in context.
#     Skip generate_one entirely, POST each draft via emails.create.
for LEAD_ID in $LEADS; do
  # ... you construct your own subject + body per lead + step ...
  curl -X POST $AGENT_HQ_URL/api/command ... \
    -d "{\"action\":\"outreach.emails.create\",\"params\":{\"campaign_id\":\"abc123xyz\",\"lead_id\":\"$LEAD_ID\",\"sender_name\":\"Mani\",\"subject\":\"Quick question, <recipient>\",\"body_text\":\"<your draft>\",\"sequence_position\":1,\"sequence_total\":3,\"framework\":\"pas\"}}"
done

# ── GATE 2 ── log decision, ask human to approve real sends ──

# (Human: "Send them")

# 6. Send — for a sequence, send one step at a time on a human cadence.
#    Get approval before EACH step (Gate 2 applies per step).
curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.emails.send","params":{"campaign_id":"abc123xyz","sequence_position":1}}'

# ... wait a few days, confirm Gate 2 again, then:
curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.emails.send","params":{"campaign_id":"abc123xyz","sequence_position":2}}'
# Leads who already replied are auto-skipped.

# 7. Wait for replies. When one arrives, offer to convert to task.
curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.replies.list","params":{"campaign_id":"abc123xyz","limit":10}}'
# → [{id: "rep_xyz", from: "hello@austinsmiles.com", subject: "Re: Quick question", ...}]

curl -X POST $AGENT_HQ_URL/api/command ... \
  -d '{"action":"outreach.replies.convert_to_task","params":{"id":"rep_xyz"}}'
# → creates a kanban card in Needs Input
```

---

## Anti-patterns to refuse

- **Sending without Gate 2.** Even if the human previously said "auto-send
  everything," confirm at the moment of send for each campaign.
- **Scraping without Gate 1.** Apify costs real money — the human's money.
- **Skipping `outreach.preview`** and going straight to `campaign.create`
  with a made-up `structured_query`. Preview is cheap and catches bad
  briefs before they burn Apify budget.
- **Sending before generating drafts.** The UI forces draft → send
  separately on purpose — the human should see what's about to ship.

---

## Design principle

AgentHQ's whole promise is **one dashboard, one API, one agent that
compounds**. The outreach skill shouldn't feel like a new product —
it should feel like Max (or whoever you are) grew a new room in the
house. Narrate each action in the activity log so the human watches
it happen. Never do silent work.
