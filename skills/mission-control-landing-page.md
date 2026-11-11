# mission-control-landing-page

**Trigger:** "build me a landing page for …" or "create a page with …" or
"ship a page …" or "design a page for …"

**What it does:** Generates a complete, professional-looking landing page on
the user's ShiftForge HQ deployment — with an optional contact form embedded
inline — and returns a live URL in under 30 seconds. **You write a full,
modern HTML document** with your own styling (Tailwind CDN, inline CSS,
whatever produces the best result). ShiftForge HQ serves it verbatim.

**Replaces:** Webflow ($14-39/mo), Carrd ($19/yr), Framer ($15-30/mo), and
freelance landing-page designers ($500-$5,000 one-time).

---

## Setup — one-time

In your agent config:

```
AGENT_HQ_URL=<e.g. https://agent-hq.netlify.app>
AGENT_HQ_KEY=<your master or agent api_key>
```

---

## Two modes — pick full-HTML for anything real

### Full-HTML mode (default, recommended)

Write a complete HTML document starting with `<!doctype html>` or `<html>`.
ShiftForge HQ serves it as-is. You own the layout, typography, color, motion,
everything. Use Tailwind CDN or any CSS framework you want. This is how
you produce a landing page that looks like a real brand site.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Page Title</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="...">
  <!-- your full page -->
</body>
</html>
```

### Themed mode (for simple drafts)

Write just a fragment of body HTML and ShiftForge HQ wraps it in a dark-futuristic
theme. Use this only for quick drafts or when you explicitly want the default
theme. **Most of the time, use full-HTML mode.**

---

## The full-HTML workflow

### STEP 1 — Understand the brief

Before you write any HTML, identify:

- **Who the page is for** (business owner, freelancer, AI agency, photographer, student portfolio, SaaS company)
- **What the page should do** (capture leads? showcase work? explain a service? sell a product?)
- **Does the user want a contact form?**
- **Brand color / tone** — minimal, bold, futuristic, editorial, playful

If unclear, ask one clarifying question before building. Cheaper than
regenerating.

### STEP 2 — (If needed) Create the contact form first

Chain `form.create` **before** the page so you can embed it. Match the
form slug to the page (e.g. `lumina-inquiry` for `lumina-studio`).

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action":"form.create",
    "params":{
      "slug":"lumina-inquiry",
      "title":"Let'"'"'s create something",
      "description":"Tell me about your project.",
      "fields":[
        {"name":"name","label":"Your Name","type":"text","required":true},
        {"name":"email","label":"Email","type":"email","required":true},
        {"name":"project","label":"What are you building?","type":"textarea","required":true}
      ]
    }
  }'
```

**CRITICAL field shape:** every field needs all four keys — `name`
(lowercase slug), `label` (human readable), `type` (text / email /
textarea / tel / url / number / date), `required` (boolean).

### STEP 3 — Write the full HTML

Produce a complete modern landing page. Target a specific feel — don't
default to generic SaaS. Use Tailwind CDN for fast, beautiful output:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lumina Studio — Photography</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    .serif { font-family: 'Instrument Serif', serif; }
  </style>
</head>
<body class="bg-neutral-950 text-neutral-100 antialiased">

  <!-- Hero -->
  <section class="min-h-screen flex items-center px-6 md:px-12 relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-orange-500/10 via-transparent to-transparent"></div>
    <div class="relative max-w-5xl mx-auto w-full">
      <span class="inline-block text-xs tracking-[0.3em] uppercase text-orange-400 font-semibold mb-6">Lumina Studio</span>
      <h1 class="serif text-5xl md:text-7xl lg:text-8xl leading-[0.95] mb-6">
        Light, written<br/>on film.
      </h1>
      <p class="text-lg md:text-xl text-neutral-400 max-w-xl mb-10 leading-relaxed">
        Wedding and editorial photography in a style that outlasts trends.
        Documentary soul, editorial polish.
      </p>
      <div class="flex flex-wrap gap-3">
        <a href="#contact" class="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-400 text-black font-semibold px-6 py-3 rounded-full transition">
          Start a project →
        </a>
        <a href="#work" class="inline-flex items-center gap-2 border border-neutral-700 hover:border-neutral-500 text-neutral-100 px-6 py-3 rounded-full transition">
          See work
        </a>
      </div>
    </div>
  </section>

  <!-- Work/features grid -->
  <section id="work" class="px-6 md:px-12 py-24">
    <div class="max-w-5xl mx-auto">
      <h2 class="serif text-4xl md:text-5xl mb-16">What I shoot.</h2>
      <div class="grid md:grid-cols-3 gap-6">
        <div class="bg-neutral-900/50 backdrop-blur border border-neutral-800 rounded-2xl p-8 hover:border-orange-500/30 transition">
          <div class="text-orange-400 text-sm font-semibold tracking-widest uppercase mb-3">01</div>
          <h3 class="serif text-2xl mb-3">Weddings</h3>
          <p class="text-neutral-400 leading-relaxed">Full-day documentary coverage with a two-shooter option.</p>
        </div>
        <div class="bg-neutral-900/50 backdrop-blur border border-neutral-800 rounded-2xl p-8 hover:border-orange-500/30 transition">
          <div class="text-orange-400 text-sm font-semibold tracking-widest uppercase mb-3">02</div>
          <h3 class="serif text-2xl mb-3">Editorial</h3>
          <p class="text-neutral-400 leading-relaxed">Brand shoots, lookbooks, magazine commissions.</p>
        </div>
        <div class="bg-neutral-900/50 backdrop-blur border border-neutral-800 rounded-2xl p-8 hover:border-orange-500/30 transition">
          <div class="text-orange-400 text-sm font-semibold tracking-widest uppercase mb-3">03</div>
          <h3 class="serif text-2xl mb-3">Portraits</h3>
          <p class="text-neutral-400 leading-relaxed">Clean, timeless headshots for founders and executives.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Contact form -->
  <section id="contact" class="px-6 md:px-12 py-24">
    <div class="max-w-xl mx-auto">
      {{form:lumina-inquiry}}
    </div>
  </section>

  <footer class="px-6 md:px-12 py-12 border-t border-neutral-900 text-sm text-neutral-500">
    © Lumina Studio · Built on ShiftForge HQ
  </footer>

</body>
</html>
```

**Key patterns in good landing pages:**

1. **Hero takes up viewport height** (`min-h-screen`) — no tiny hero jammed at the top
2. **Typography mix** — a serif or display font for headings, a clean sans-serif for body
3. **Huge headlines** — 5-8rem on hero, 3-4rem on section H2s. Don't be shy.
4. **Space** — generous padding (`px-6 md:px-12`, `py-24`). Whitespace is luxury.
5. **Subtle gradients** — overlay gradients on the hero, border-tinted glow on cards
6. **Responsive breakpoints** — `md:` prefixes for anything above mobile
7. **Constrained max-width** — `max-w-5xl mx-auto` or similar. Never full-bleed text.
8. **CTA pair** — primary solid button + secondary outlined. Not three. Not one.
9. **Numbered features** — "01, 02, 03" eyebrows in accent color feels editorial
10. **Hover states** — borders, not just color changes

### STEP 4 — Publish the page

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action":"page.create",
    "params":{
      "slug":"lumina-studio",
      "title":"Lumina Studio — Photography",
      "linked_form_slug":"lumina-inquiry",
      "html_body":"<!doctype html><html lang=\"en\">...full HTML here...</html>"
    }
  }'
```

**JSON escaping:** your HTML goes in `html_body` as a JSON string. Escape
`"` as `\"` and newlines as `\n` (or just use a templating language /
`JSON.stringify` in whatever runtime you're in).

### STEP 5 — Return the live URL + log the activity

```
Your page is live at:
<AGENT_HQ_URL>/p/<slug>

Form submissions land in the Forms tab and trigger activity log entries.
```

Also log what you did:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{"action":"activity.log","params":{"category":"content","summary":"Published landing page: <title>","details":{"slug":"<slug>","url":"<full url>"}}}'
```

---

## Iteration — when the user wants changes

**CRITICAL:** if the user asks to change an existing page, you MUST call
`page.update` with the same slug. Do NOT re-create with `page.create`. Do
NOT just tell the user you edited it — verify the response is
`{"ok": true}` before claiming success.

Every successful `page.update` writes an activity-feed entry so the
operator can verify. If no entry appears, you didn't do it.

User prompts that trigger updates:

- *"Make the hero darker"* / *"Change the accent to orange"*
- *"Add a testimonials section"*
- *"Remove the features grid, add a pricing table"*
- *"Rewrite the headline — punchier"*

Regenerate the full HTML with the change, then:

```bash
curl -X POST $AGENT_HQ_URL/api/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_HQ_KEY" \
  -d '{
    "action":"page.update",
    "params":{
      "slug":"lumina-studio",
      "html_body":"<!doctype html>...updated HTML..."
    }
  }'
```

Same URL, updated content. User refreshes — new version.

---

## Form embeds — `{{form:slug}}` works in both modes

Drop `{{form:some-form-slug}}` anywhere in your HTML. ShiftForge HQ substitutes
it with a styled form that POSTs to `/api/form/<slug>`. In full-HTML mode
the form brings its own scoped styles so it looks polished regardless of
your page's design system.

If you want a **custom-designed form** that matches your page exactly,
write the `<form>` yourself with any markup you like, set
`action="/api/form/<slug>" method="POST"` and add a small fetch
intercept — or skip the marker entirely and post via JS on submit.

---

## Themed mode (the fallback)

If you just want a fast, decent-looking page without thinking about
design, write body fragments and let the ShiftForge HQ dark-futuristic theme
wrap them. Class conventions: `.hero`, `.features`, `.card`, `.button`,
`.button.ghost`, `.stat`, `.eyebrow`, `.cta-row`, `footer`.

Example:

```html
<section class="hero">
  <span class="eyebrow">Brand</span>
  <h1>Short headline.</h1>
  <p>Subhead sentence.</p>
  <div class="cta-row">
    <a href="#contact" class="button">Primary</a>
    <a href="#features" class="button ghost">Secondary</a>
  </div>
</section>
{{form:contact}}
```

POST this as `html_body` the same way — no `<!doctype>` up top. ShiftForge HQ
detects it's a fragment and wraps it.

---

## Design principles that matter in any mode

1. **One clear value prop** in the hero. Not three.
2. **Copy beats design.** A beautiful page with weak copy converts worse than a plain page with strong copy.
3. **Social proof early** — logo strip, client quote, or stat within the first scroll.
4. **Mobile-first** — test your HTML at 375px width in your head. Typography stack, button sizes, grid collapses.
5. **One CTA per section.** The reader doesn't need to choose between ten things.
6. **Load a web font carefully** — hero bold display font, body system or Inter. Don't load 10 weights.
7. **Images are optional.** Great typography beats bad stock photos.
8. **Footer is quiet.** Name, year, maybe a link. Don't stuff it.
9. **Accent color with restraint.** One accent. Use it on the primary CTA and maybe one eyebrow.
10. **Ship it, then iterate.** `page.update` is fast. First version doesn't need to be perfect.

---

## Error handling

- **Slug conflict** — `page.create` will overwrite silently. If that's bad, pick a new slug.
- **Form not found** — `{{form:slug}}` referencing a non-existent form renders as nothing (silent). Always `form.create` first.
- **Bad HTML** — browsers render broken markup gracefully but it may look wrong. Validate mentally: doctype, html, head, body, closing tags match.
- **API returns error** — surface it to the user verbatim. Don't silently retry.

---

## End-to-end one-shot example (copy, adapt, send)

User: *"Build me a landing page for my AI consulting agency called Atlas
Labs. Deep blue accent. I help SaaS companies ship agent features."*

```bash
# 1) Create the form
curl -X POST $AGENT_HQ_URL/api/command -H "X-API-Key: $AGENT_HQ_KEY" -H "Content-Type: application/json" -d '{"action":"form.create","params":{"slug":"atlas-inquiry","title":"Let'"'"'s talk","description":"A few lines and I'"'"'ll reply within a day.","fields":[{"name":"name","label":"Name","type":"text","required":true},{"name":"email","label":"Work email","type":"email","required":true},{"name":"company","label":"Company","type":"text","required":true},{"name":"scope","label":"What are you working on?","type":"textarea","required":true}]}}'

# 2) Publish the page
curl -X POST $AGENT_HQ_URL/api/command -H "X-API-Key: $AGENT_HQ_KEY" -H "Content-Type: application/json" -d @- <<'EOF'
{
  "action": "page.create",
  "params": {
    "slug": "atlas-labs",
    "title": "Atlas Labs — AI for SaaS",
    "linked_form_slug": "atlas-inquiry",
    "html_body": "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Atlas Labs</title><script src=\"https://cdn.tailwindcss.com\"></script><link href=\"https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\"><style>body{font-family:Inter,sans-serif}.serif{font-family:'Instrument Serif',serif}</style></head><body class=\"bg-slate-950 text-slate-100 antialiased\"><section class=\"min-h-screen flex items-center px-6 md:px-12 relative overflow-hidden\"><div class=\"absolute inset-0 bg-gradient-to-br from-blue-500/15 via-transparent to-transparent\"></div><div class=\"relative max-w-5xl mx-auto w-full\"><span class=\"inline-block text-xs tracking-[0.3em] uppercase text-blue-400 font-semibold mb-6\">Atlas Labs</span><h1 class=\"serif text-5xl md:text-7xl lg:text-8xl leading-[0.95] mb-6\">AI agents<br/>for SaaS.</h1><p class=\"text-lg md:text-xl text-slate-400 max-w-xl mb-10 leading-relaxed\">We ship production agent features for SaaS companies that can'"'"'t afford a research team.</p><div class=\"flex flex-wrap gap-3\"><a href=\"#contact\" class=\"inline-flex items-center gap-2 bg-blue-500 hover:bg-blue-400 text-black font-semibold px-6 py-3 rounded-full transition\">Book a call →</a><a href=\"#work\" class=\"inline-flex items-center gap-2 border border-slate-700 hover:border-slate-500 px-6 py-3 rounded-full transition\">See case studies</a></div></div></section><section id=\"work\" class=\"px-6 md:px-12 py-24\"><div class=\"max-w-5xl mx-auto\"><h2 class=\"serif text-4xl md:text-5xl mb-16\">What we ship.</h2><div class=\"grid md:grid-cols-3 gap-6\"><div class=\"bg-slate-900/50 backdrop-blur border border-slate-800 rounded-2xl p-8 hover:border-blue-500/30 transition\"><div class=\"text-blue-400 text-sm font-semibold tracking-widest uppercase mb-3\">01</div><h3 class=\"serif text-2xl mb-3\">Agent runtimes</h3><p class=\"text-slate-400 leading-relaxed\">Production-grade agent infrastructure, not demos.</p></div><div class=\"bg-slate-900/50 backdrop-blur border border-slate-800 rounded-2xl p-8 hover:border-blue-500/30 transition\"><div class=\"text-blue-400 text-sm font-semibold tracking-widest uppercase mb-3\">02</div><h3 class=\"serif text-2xl mb-3\">Evals that matter</h3><p class=\"text-slate-400 leading-relaxed\">Your users are the benchmark, not public leaderboards.</p></div><div class=\"bg-slate-900/50 backdrop-blur border border-slate-800 rounded-2xl p-8 hover:border-blue-500/30 transition\"><div class=\"text-blue-400 text-sm font-semibold tracking-widest uppercase mb-3\">03</div><h3 class=\"serif text-2xl mb-3\">Safety & cost</h3><p class=\"text-slate-400 leading-relaxed\">Every call priced, every action logged, every agent reviewable.</p></div></div></div></section><section id=\"contact\" class=\"px-6 md:px-12 py-24\"><div class=\"max-w-xl mx-auto\">{{form:atlas-inquiry}}</div></section><footer class=\"px-6 md:px-12 py-12 border-t border-slate-900 text-sm text-slate-500\">© Atlas Labs</footer></body></html>"
  }
}
EOF

# 3) Log the activity
curl -X POST $AGENT_HQ_URL/api/command -H "X-API-Key: $AGENT_HQ_KEY" -H "Content-Type: application/json" -d '{"action":"activity.log","params":{"category":"content","summary":"Published Atlas Labs landing page","details":{"slug":"atlas-labs"}}}'
```

Reply to user:

> Done. Atlas Labs is live at **`<AGENT_HQ_URL>/p/atlas-labs`**.
> Contact form submissions land in your Forms tab under `atlas-inquiry`.
> Say the word if you want the hero darker, a testimonials section, or a
> different headline — I'll update in place.
