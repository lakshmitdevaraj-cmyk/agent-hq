import { noteCreated } from "@/lib/recent";
import { useState } from "react";
import { ChevronRight, Loader2, MapPin, Search, Sparkles, Target, Check, ArrowLeft } from "lucide-react";
import Modal, { FormField, PrimaryButton, TextArea, TextInput } from "./Modal";
import { call, callBackground } from "@/lib/api";

type StructuredQuery = { location: string; searchTerms: string[]; maxResults: number };

type Step = "input" | "preview";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (campaign: { id: string; name: string }) => void;
};

const EXAMPLE =
  "Personal injury law firms in Miami, FL with at least 4-star ratings. Also include family lawyers and estate planning attorneys in the greater Miami area.";

export default function OutreachWizard({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>("input");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [maxResults, setMaxResults] = useState(50);
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<StructuredQuery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("input");
    setName("");
    setQuery("");
    setMaxResults(50);
    setDescription("");
    setPreview(null);
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function runPreview() {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Runs in the background function (Gemini may need up to 60 s + a retry); poll for the result.
      const { id } = await call<{ id: string }>("outreach.preview.start", { query: query.trim(), max_results: maxResults });
      await callBackground("preview", { id, query: query.trim(), max_results: maxResults });
      let result: StructuredQuery | null = null;
      const deadline = Date.now() + 5 * 60_000;
      while (!result) {
        if (Date.now() > deadline) throw new Error("The preview is taking too long. Try again in a minute.");
        await new Promise((r) => setTimeout(r, 2000));
        let rec: { status: string; result?: StructuredQuery; error?: string } | null = null;
        try {
          rec = await call<{ status: string; result?: StructuredQuery; error?: string }>("outreach.preview.result", { id });
        } catch (e) {
          // The record may not be listed yet (404) right after it was written; keep polling.
          if (!(e instanceof Error) || !/not found|Failed to fetch/i.test(e.message)) throw e;
        }
        if (rec?.status === "error") throw new Error(rec.error || "Preview failed");
        if (rec?.status === "done" && rec.result) result = rec.result;
      }
      setPreview(result);
      setStep("preview");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Preview failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function createCampaign() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const campaign = await call<{ id: string; name: string }>("outreach.campaign.create", {
        name: name.trim() || `Campaign · ${preview.location}`,
        query: query.trim(),
        structured_query: preview,
        description: description.trim(),
      });
      noteCreated("campaign", campaign);
      onCreated?.(campaign);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={step === "input" ? "Describe your target market" : "Review search strategy"}
      description={
        step === "input"
          ? "Natural language in. Structured Google Maps queries out. Gemini expands your one-liner into multiple search terms."
          : "Gemini turned your description into a location plus multiple search terms. Edit the query or create the campaign."
      }
      maxWidth="max-w-2xl"
    >
      {step === "input" && (
        <div className="space-y-4">
          <FormField label="Campaign name" hint="For your own reference. Auto-derived if blank.">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Miami Law Firms · Q2"
              autoFocus
            />
          </FormField>

          <FormField label="Who are you targeting?" required hint="Describe the business type, location, and any filters (ratings, size, niche).">
            <TextArea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={EXAMPLE}
              rows={5}
              spellCheck
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Max results" hint="Clamped to 10–200.">
              <TextInput
                type="number"
                min={10}
                max={200}
                value={maxResults}
                onChange={(e) => setMaxResults(Math.max(10, Math.min(200, Number(e.target.value))))}
              />
            </FormField>
            <FormField label="Description (optional)" hint="Internal note.">
              <TextInput
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Outbound pilot for Q2"
              />
            </FormField>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/15 border border-red-500/40 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <PrimaryButton onClick={runPreview} disabled={!query.trim() || busy} loading={busy}>
              {busy ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Analysing with Gemini
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Preview search strategy
                </>
              )}
            </PrimaryButton>
            <button
              onClick={close}
              className="px-4 py-3 text-sm text-muted hover:text-fg transition font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-inset p-4">
            <div className="flex items-center gap-2 mb-2">
              <MapPin size={14} className="text-primary" />
              <span className="text-xs font-display text-muted font-medium">Location</span>
            </div>
            <p className="text-lg font-medium text-fg">{preview.location}</p>
          </div>

          <div className="rounded-xl border border-line bg-inset p-4">
            <div className="flex items-center gap-2 mb-3">
              <Search size={14} className="text-primary" />
              <span className="text-xs font-display text-muted font-medium">
                Search queries ({preview.searchTerms.length})
              </span>
            </div>
            <ul className="space-y-2">
              {preview.searchTerms.map((term, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-fg2">
                  <ChevronRight size={14} className="text-primary shrink-0 mt-0.5" />
                  <span className="font-mono">{term}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-line bg-inset p-4 flex items-center gap-3">
            <Target size={14} className="text-accent" />
            <span className="text-xs text-fg2">
              Up to <span className="text-fg font-bold">{preview.maxResults}</span> leads · Apify Google Maps scraper runs in Phase 3
            </span>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/15 border border-red-500/40 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => {
                setStep("input");
                setError(null);
              }}
              className="flex items-center gap-2 px-4 py-3 text-sm rounded-lg bg-fg/5 hover:bg-fg/10 border border-line text-fg2 font-semibold transition"
            >
              <ArrowLeft size={14} /> Edit query
            </button>
            <PrimaryButton onClick={createCampaign} disabled={busy} loading={busy}>
              <Check size={14} /> Create campaign
            </PrimaryButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
