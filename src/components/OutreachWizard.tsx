import { noteCreated } from "@/lib/recent";
import { useState } from "react";
import { ChevronRight, Loader2, MapPin, Search, Sparkles, Target, Check, ArrowLeft } from "lucide-react";
import Modal, { FormField, PrimaryButton, TextArea, TextInput } from "./Modal";
import { call } from "@/lib/api";

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
      const result = await call<StructuredQuery>("outreach.preview", {
        query: query.trim(),
        max_results: maxResults,
      });
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
              className="px-4 py-3 text-sm text-white/60 hover:text-white transition font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-black/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <MapPin size={14} className="text-primary" />
              <span className="text-xs font-display tracking-widest uppercase text-white/60 font-bold">Location</span>
            </div>
            <p className="text-lg font-medium text-white">{preview.location}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Search size={14} className="text-purple" />
              <span className="text-xs font-display tracking-widest uppercase text-white/60 font-bold">
                Search queries ({preview.searchTerms.length})
              </span>
            </div>
            <ul className="space-y-2">
              {preview.searchTerms.map((term, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-white/85">
                  <ChevronRight size={14} className="text-primary shrink-0 mt-0.5" />
                  <span className="font-mono">{term}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/30 p-4 flex items-center gap-3">
            <Target size={14} className="text-accent" />
            <span className="text-xs text-white/70">
              Up to <span className="text-white font-bold">{preview.maxResults}</span> leads · Apify Google Maps scraper runs in Phase 3
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
              className="flex items-center gap-2 px-4 py-3 text-sm rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/85 font-semibold transition"
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
