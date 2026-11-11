import { useState } from "react";
import { Mic, KeyRound, ExternalLink, CheckCircle2 } from "lucide-react";
import GlassCard from "./GlassCard";
import { FormField, TextInput, PrimaryButton } from "./Modal";
import { call } from "@/lib/api";

type Props = {
  onSaved: () => void;
};

export default function VoiceOnboarding({ onSaved }: Props) {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await call("voice.config.set", { gemini_key: key.trim() });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setLoading(false);
    }
  }

  return (
    <GlassCard className="max-w-2xl mx-auto p-8">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/30 to-purple/30 border border-primary/40 flex items-center justify-center shadow-glow">
          <Mic size={28} className="text-primary" strokeWidth={2} />
        </div>
        <div>
          <h2 className="font-display text-2xl text-white font-bold tracking-wide">Talk to your agent</h2>
          <p className="text-sm text-white/75 font-medium">Real voice, in your browser, free with Gemini.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Step n={1} title="Get a free Gemini key" note="takes 30 seconds" />
        <Step n={2} title="Paste it below" note="stored in your Blobs" />
        <Step n={3} title="Say hello" note="agent talks back" />
      </div>

      <GlassCard className="bg-primary/[0.04] border-primary/30 mb-6">
        <div className="flex items-start gap-3">
          <KeyRound size={18} className="text-primary shrink-0 mt-0.5" strokeWidth={2.3} />
          <div className="flex-1 min-w-0">
            <div className="font-display text-sm text-white font-bold tracking-wide mb-1">
              Getting your Gemini key
            </div>
            <p className="text-sm text-white/80 font-medium mb-2">
              Open Google AI Studio → click <span className="text-primary font-bold">Get API Key</span> → Create.
              Free tier has generous limits and works for voice.
            </p>
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-bold uppercase tracking-widest"
            >
              <ExternalLink size={12} strokeWidth={2.5} />
              aistudio.google.com/apikey
            </a>
          </div>
        </div>
      </GlassCard>

      <form onSubmit={submit}>
        <FormField
          label="Gemini API Key"
          required
          hint="Starts with 'AIza'. Stored server-side in your ShiftForge HQ Blobs — never committed anywhere."
        >
          <TextInput
            autoFocus
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="AIzaSy..."
            required
          />
        </FormField>

        {error && <p className="text-sm text-danger font-semibold mb-3">{error}</p>}

        <PrimaryButton type="submit" loading={loading}>
          <CheckCircle2 size={16} strokeWidth={3} /> Save &amp; Continue
        </PrimaryButton>
      </form>
    </GlassCard>
  );
}

function Step({ n, title, note }: { n: number; title: string; note: string }) {
  return (
    <div className="glass p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded-full bg-primary/25 border border-primary/50 flex items-center justify-center text-xs font-display font-black text-primary">
          {n}
        </div>
        <span className="text-sm text-white font-bold">{title}</span>
      </div>
      <p className="text-xs text-white/65 font-medium">{note}</p>
    </div>
  );
}
