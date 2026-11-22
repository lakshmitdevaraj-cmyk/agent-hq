import { useState } from "react";
import Modal, { FormField, TextInput, TextArea, PrimaryButton } from "./Modal";
import { call } from "@/lib/api";
import type { Page } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (page: Page) => void;
};

const DEFAULT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Page Title</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>body{font-family:Inter,sans-serif} .serif{font-family:'Instrument Serif',serif}</style>
</head>
<body class="bg-neutral-950 text-neutral-100 antialiased">
  <section class="min-h-screen flex items-center px-6 md:px-12 relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-indigo-500/15 via-transparent to-transparent"></div>
    <div class="relative max-w-5xl mx-auto w-full">
      <span class="inline-block text-xs tracking-[0.3em] uppercase text-indigo-400 font-semibold mb-6">Your Brand</span>
      <h1 class="serif text-5xl md:text-7xl lg:text-8xl leading-[0.95] mb-6">Headline that<br/>stops the scroll.</h1>
      <p class="text-lg md:text-xl text-neutral-400 max-w-xl mb-10 leading-relaxed">One or two sentences that make the value unmistakable.</p>
      <div class="flex flex-wrap gap-3">
        <a href="#contact" class="inline-flex items-center gap-2 bg-indigo-500 hover:bg-indigo-400 text-black font-semibold px-6 py-3 rounded-full transition">Get in touch →</a>
        <a href="#learn-more" class="inline-flex items-center gap-2 border border-neutral-700 hover:border-neutral-500 px-6 py-3 rounded-full transition">Learn more</a>
      </div>
    </div>
  </section>

  <section id="contact" class="px-6 md:px-12 py-24">
    <div class="max-w-xl mx-auto">
      {{form:contact}}
    </div>
  </section>
</body>
</html>
`;

export default function NewPageModal({ open, onClose, onCreated }: Props) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [htmlBody, setHtmlBody] = useState(DEFAULT_HTML);
  const [linkedFormSlug, setLinkedFormSlug] = useState("");
  const [accent, setAccent] = useState("#00BFFF");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug.trim() || !title.trim() || !htmlBody.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const page = await call<Page>("page.create", {
        slug: slug.trim(),
        title: title.trim(),
        html_body: htmlBody.trim(),
        linked_form_slug: linkedFormSlug.trim() || null,
        accent: accent.trim() || null,
      });
      onCreated(page);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create page");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setSlug("");
    setTitle("");
    setHtmlBody(DEFAULT_HTML);
    setLinkedFormSlug("");
    setAccent("#00BFFF");
    setError(null);
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Create Landing Page"
      description="Paste a full HTML document (with <!doctype html>) and it's served verbatim — bring Tailwind, bring your own fonts, bring whatever you want. Or paste a body fragment and the dark-futuristic theme wraps it. Embed a form anywhere with {{form:slug}}."
      maxWidth="max-w-3xl"
    >
      <form onSubmit={submit} className="flex flex-col">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Slug" required hint="URL path — lowercase, dashes only">
            <TextInput
              autoFocus
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="my-portfolio"
              required
            />
          </FormField>
          <FormField label="Title" required>
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My Portfolio"
              required
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField label="Linked Form Slug" hint="Optional — the page embeds this form inline">
            <TextInput
              value={linkedFormSlug}
              onChange={(e) => setLinkedFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="contact"
            />
          </FormField>
          <FormField label="Accent Color" hint="Used for headings, buttons, glows">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="w-10 h-10 rounded-lg border border-line bg-transparent cursor-pointer"
              />
              <TextInput value={accent} onChange={(e) => setAccent(e.target.value)} className="flex-1" />
            </div>
          </FormField>
        </div>

        <FormField
          label="HTML Body"
          required
          hint="Full document (<!doctype html>...) served verbatim — OR just a body fragment wrapped in the theme (class names: .hero, .features, .card, .button, .stat, .eyebrow, .cta-row, footer)."
        >
          <TextArea
            rows={14}
            value={htmlBody}
            onChange={(e) => setHtmlBody(e.target.value)}
            className="font-mono text-xs"
          />
        </FormField>

        {error && <p className="text-sm text-danger font-semibold mb-3">{error}</p>}

        <div className="flex items-center gap-3 mt-2">
          <PrimaryButton type="submit" loading={loading}>
            Publish Page
          </PrimaryButton>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="px-4 py-3 text-sm text-fg2 hover:text-fg font-display font-medium"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
