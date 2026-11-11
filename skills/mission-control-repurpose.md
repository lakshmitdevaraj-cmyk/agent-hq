# mission-control-repurpose

**Trigger:** "repurpose this URL: <url>" or "repurpose https://..."

**What it does:** Takes a URL, scrapes the content, generates 5 repurposed pieces
of content (LinkedIn post, Instagram caption, blog summary, X/Twitter thread,
email newsletter snippet), creates an Instagram carousel cover image with
Gemini, and POSTs everything to your ShiftForge HQ dashboard so you can see it appear
in real time.

---

## Setup — one-time

Before using this skill, set the following in your agent config (SOUL.md,
.env, or wherever your agent stores secrets):

```
AGENT_HQ_URL=<your agent-hq URL, e.g., https://merry-mooncake-abc.netlify.app>
AGENT_HQ_KEY=<your master or agent api_key>
GEMINI_API_KEY=<your google gemini key>
```

---

## Execution steps

### STEP 1 — Scrape the URL

Read the full content of the URL the user gave you. Extract:
- Main topic
- 5 key points
- Any data, quotes, or statistics
- The overall tone

Use your built-in web-read or curl the URL directly.

### STEP 2 — Tell the dashboard you're starting

POST to ShiftForge HQ so the human can see you started working:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action": "task.create",
    "params": {
      "title": "Repurpose URL: <the url>",
      "priority": "medium"
    }
  }'
```

Save the returned task `id`. You'll update its status as you progress.

Move the task to doing:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{"action":"task.move","params":{"id":"<task_id>","status":"doing"}}'
```

### STEP 3 — Write 5 repurposed pieces

Generate each of these. Keep each one tight and formatted for its channel.

1. **LinkedIn Post** — professional tone, 1,200-1,300 characters, hook in the
   first line that stops the scroll, 3-5 hashtags at the end.
2. **Instagram Caption** — casual, engaging, emoji-rich, end with a call to
   action, 10 relevant hashtags.
3. **Blog Summary** — 400-500 words, compelling title, 3 subheadings, written
   for someone who hasn't read the original.
4. **X/Twitter Thread** — 5 tweets, each under 280 characters, numbered 1/5
   through 5/5, first tweet is the hook.
5. **Email Newsletter Snippet** — 150 words max, conversational, with a "Read
   more" CTA.

After each piece, log an activity entry so the human sees it appear live:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action": "activity.log",
    "params": {
      "category": "content",
      "summary": "Drafted LinkedIn post from URL",
      "details": { "content": "<the full LinkedIn post text>" }
    }
  }'
```

Repeat for each of the 5 pieces. Use category `content` for all of them.

### STEP 4 — Generate the Instagram cover image

Use Gemini 2.5 Flash image generation. Run this exact command, replacing
`$GEMINI_API_KEY` with your actual key:

```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [{
        "text": "High-end Instagram carousel cover image for a post about: <topic>. Modern, minimal, futuristic. Dark background, glowing accent color, typography-led. No people. 1080x1080."
      }]
    }]
  }'
```

Save the returned image as `content-image.png`.

Log it to the dashboard:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action": "activity.log",
    "params": {
      "category": "content",
      "summary": "Generated Instagram cover image",
      "details": { "image_path": "content-image.png" }
    }
  }'
```

### STEP 5 — Mark the task done

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{"action":"task.move","params":{"id":"<task_id>","status":"done"}}'
```

Then log a final summary:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action": "activity.log",
    "params": {
      "category": "decision",
      "summary": "Finished repurposing <url> — 5 pieces + 1 image delivered"
    }
  }'
```

---

## Reply to the user

After all steps complete, reply with:

> Done. Repurposed **<topic>** into 5 content pieces + an Instagram cover
> image. Your ShiftForge HQ dashboard shows everything live — check the Activity
> feed and the Tasks board.

Do NOT paste all 5 pieces into the chat reply. The human reads them in the
dashboard. Keep the chat reply short.

---

## Error handling

If any step fails:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action": "activity.log",
    "params": {
      "category": "error",
      "summary": "<what broke, one line>",
      "details": { "step": "<which step>", "error": "<raw error>" }
    }
  }'
```

Then move the task to `needs_input` so the human knows to take a look:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{"action":"task.move","params":{"id":"<task_id>","status":"needs_input"}}'
```
