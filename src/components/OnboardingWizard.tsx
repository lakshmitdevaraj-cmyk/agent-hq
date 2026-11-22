import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import Modal, { FormField, PrimaryButton, TextInput } from "./Modal";
import { call } from "@/lib/api";

type ServiceKey = "gemini" | "apify" | "agentmail";

type ConfigStatus = Record<
  ServiceKey,
  {
    configured: boolean;
    masked: string | null;
    updated_at?: string;
    last_test?: { ok: boolean; at: string; message?: string };
  }
>;

type Step = {
  service: ServiceKey;
  title: string;
  eyebrow: string;
  tagline: string;
  why: string;
  getKeyUrl: string;
  getKeyLabel: string;
  placeholder: string;
};

const STEPS: Step[] = [
  {
    service: "gemini",
    title: "Gemini API Key",
    eyebrow: "01 / Brain",
    tagline: "Powers voice, ICP preview, and email drafting.",
    why: "Your agent's brain. Free tier covers voice conversations, natural-language ICP-to-query conversion, and AI-written outreach emails. No credit card required.",
    getKeyUrl: "https://aistudio.google.com/apikey",
    getKeyLabel: "Google AI Studio",
    placeholder: "AIza…",
  },
  {
    service: "apify",
    title: "Apify API Token",
    eyebrow: "02 / Scrape",
    tagline: "Finds real businesses from your ICP description.",
    why: "Runs the Google Maps scraper that turns \"dental clinics in Austin\" into 50 real leads with names, emails, and phones. Free tier: $5 credit on signup, ~12,500 leads.",
    getKeyUrl: "https://console.apify.com/settings/integrations",
    getKeyLabel: "Apify Console",
    placeholder: "apify_api_…",
  },
  {
    service: "agentmail",
    title: "AgentMail API Key",
    eyebrow: "03 / Send",
    tagline: "Inbox provisioned in seconds. Sends and receives.",
    why: "Each dashboard gets its own agent inbox. No domain, no DNS, no warmup. Send outreach, receive real replies, agent acts on them. Built for this use case.",
    getKeyUrl: "https://www.agentmail.to/",
    getKeyLabel: "AgentMail",
    placeholder: "amk_…",
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** If true, show only steps for services not yet configured. */
  onlyMissing?: boolean;
  onComplete?: () => void;
};

export default function OnboardingWizard({ open, onClose, onlyMissing = true, onComplete }: Props) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Which steps to actually show (skip ones already configured if `onlyMissing`).
  const activeSteps = useMemo(() => {
    if (!onlyMissing || !status) return STEPS;
    return STEPS.filter((s) => !status[s.service]?.configured);
  }, [status, onlyMissing]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  useEffect(() => {
    // Reset per-step state when the active step changes.
    setValue("");
    setReveal(false);
    setError(null);
    setJustSaved(false);
  }, [stepIndex]);

  async function refresh() {
    try {
      const s = await call<ConfigStatus>("config.status");
      setStatus(s);
    } catch {
      // noop — user can still paste keys even if status read fails.
    }
  }

  // If user started with 2 missing and fills them all, we should end the wizard.
  useEffect(() => {
    if (open && status && activeSteps.length === 0) {
      onComplete?.();
      onClose();
    }
  }, [status, activeSteps.length, open]);

  async function save() {
    if (!value.trim() || stepIndex >= activeSteps.length) return;
    setTesting(true);
    setError(null);
    try {
      const current = activeSteps[stepIndex];
      await call("config.set", { service: current.service, key: value.trim() });
      setJustSaved(true);
      await refresh();
      // Advance after a beat so user sees the "verified" state.
      setTimeout(() => {
        if (stepIndex + 1 >= activeSteps.length) {
          onComplete?.();
          onClose();
        } else {
          setStepIndex((i) => i + 1);
        }
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify key");
    } finally {
      setTesting(false);
    }
  }

  function skip() {
    if (stepIndex + 1 >= activeSteps.length) onClose();
    else setStepIndex((i) => i + 1);
  }

  if (!open) return null;
  const current = activeSteps[stepIndex];
  if (!current) return null;

  const totalSteps = activeSteps.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect your stack"
      description="Three keys, all free tier. Paste, verify, done. Your keys live only in your own Netlify deployment."
      maxWidth="max-w-2xl"
    >
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {activeSteps.map((s, i) => (
          <div key={s.service} className="flex items-center gap-2 flex-1">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-mono font-bold shrink-0 ${
                i === stepIndex
                  ? "bg-primary/25 text-primary border border-primary/60"
                  : i < stepIndex
                  ? "bg-green-500/20 text-green-400 border border-green-500/40"
                  : "bg-fg/[0.04] text-muted border border-line"
              }`}
            >
              {i < stepIndex ? <Check size={14} /> : i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-display truncate ${i === stepIndex ? "text-fg" : "text-muted"}`}>
                {s.title.split(" ")[0]}
              </div>
            </div>
            {i < totalSteps - 1 && <div className="w-4 h-px bg-fg/10 shrink-0" />}
          </div>
        ))}
      </div>

      {/* Current step */}
      <div className="space-y-5">
        <div>
          <div className="text-xs font-mono text-primary font-medium mb-2">
            {current.eyebrow}
          </div>
          <h3 className="font-display text-2xl font-bold text-fg mb-1">{current.title}</h3>
          <p className="text-sm text-fg2">{current.tagline}</p>
        </div>

        <div className="rounded-xl bg-primary/[0.05] border border-primary/20 p-4">
          <p className="text-sm text-fg2 leading-relaxed">{current.why}</p>
        </div>

        <a
          href={current.getKeyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-sm text-primary hover:text-fg transition font-semibold"
        >
          Get a key from {current.getKeyLabel}
          <ExternalLink size={14} />
        </a>

        <FormField
          label="Paste your key"
          required
          hint="We verify it against the service before saving. No raw keys are ever displayed after this."
        >
          <div className="relative">
            <TextInput
              type={reveal ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={current.placeholder}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute top-1/2 right-3 -translate-y-1/2 text-muted hover:text-fg transition"
              aria-label={reveal ? "Hide key" : "Show key"}
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </FormField>

        {error && (
          <div className="rounded-lg bg-red-500/15 border border-red-500/40 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {justSaved && (
          <div className="rounded-lg bg-green-500/15 border border-green-500/40 px-4 py-3 text-sm text-green-200 flex items-center gap-2">
            <Check size={16} /> {current.title} verified and saved.
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <PrimaryButton onClick={save} disabled={!value.trim() || testing} loading={testing}>
            {testing ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Verifying
              </>
            ) : stepIndex + 1 >= totalSteps ? (
              <>
                <Sparkles size={14} /> Save & finish
              </>
            ) : (
              <>Save & continue →</>
            )}
          </PrimaryButton>
          <button
            onClick={skip}
            className="px-4 py-3 text-sm text-muted hover:text-fg transition font-medium"
          >
            {stepIndex + 1 >= totalSteps ? "Finish later" : "Skip for now"}
          </button>
        </div>

        <p className="text-xs text-muted pt-2">
          Step {stepIndex + 1} of {totalSteps} · All keys editable later in Settings.
        </p>
      </div>
    </Modal>
  );
}
