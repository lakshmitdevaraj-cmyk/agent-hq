import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Trash2, Key, Sparkles, AlertCircle, ExternalLink } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import OnboardingWizard from "@/components/OnboardingWizard";
import { call } from "@/lib/api";

type ServiceKey = "gemini" | "apify" | "agentmail";

type ServiceStatus = {
  configured: boolean;
  masked: string | null;
  updated_at?: string;
  last_test?: { ok: boolean; at: string; message?: string };
};

type ConfigStatus = Record<ServiceKey, ServiceStatus>;

const SERVICE_META: Record<ServiceKey, { title: string; summary: string; url: string; urlLabel: string; accent: string }> = {
  gemini: {
    title: "Gemini",
    summary: "Voice, ICP preview, email drafts",
    url: "https://aistudio.google.com/apikey",
    urlLabel: "Google AI Studio",
    accent: "from-primary/20 to-primary/5 border-primary/30",
  },
  apify: {
    title: "Apify",
    summary: "Google Maps scraper for leads",
    url: "https://console.apify.com/settings/integrations",
    urlLabel: "Apify Console",
    accent: "from-purple/20 to-purple/5 border-purple/30",
  },
  agentmail: {
    title: "AgentMail",
    summary: "Agent inbox — send + receive + track",
    url: "https://www.agentmail.to/",
    urlLabel: "AgentMail",
    accent: "from-accent/20 to-accent/5 border-accent/30",
  },
};

// Optional postal address appended to the footer of every outreach email.
// Blank by default (CAN-SPAM asks for one on commercial email to US recipients).
function FooterSettings() {
  const [address, setAddress] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    call<{ postal_address: string }>("outreach.settings.get")
      .then((r) => {
        setAddress(r.postal_address);
        setSaved(r.postal_address);
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<{ postal_address: string }>("outreach.settings.set", { postal_address: address });
      setAddress(r.postal_address);
      setSaved(r.postal_address);
      setMsg("Saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="mt-6">
      <h3 className="font-display text-lg font-bold text-white mb-1">Email footer</h3>
      <p className="text-sm text-white/65 mb-3">
        Every outreach email automatically ends with the opt-out line and the ShiftForge AI signature. Optionally add a postal address below — it is appended to that footer. Leave blank to omit.
      </p>
      <label htmlFor="postal-address" className="text-xs font-bold tracking-wider uppercase text-white/60">
        Postal address (optional)
      </label>
      <textarea
        id="postal-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        rows={2}
        placeholder="Leave blank to omit"
        className="mt-1 w-full px-3 py-2 rounded-lg bg-black/30 border border-white/15 text-white text-sm focus:outline-none focus:border-primary/60"
      />
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={busy || address.trim() === saved}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-40"
        >
          {busy && <Loader2 size={12} className="animate-spin" />} Save
        </button>
        {msg && <span className="text-xs text-white/60">{msg}</span>}
      </div>
    </GlassCard>
  );
}

export default function Settings() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busy, setBusy] = useState<ServiceKey | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      setStatus(await call<ConfigStatus>("config.status"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load status");
    }
  }

  async function retest(service: ServiceKey) {
    setBusy(service);
    setErr(null);
    try {
      await call("config.test", { service });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  async function clear(service: ServiceKey) {
    if (!confirm(`Remove the ${SERVICE_META[service].title} key? You'll need to paste it again to use that feature.`)) return;
    setBusy(service);
    try {
      await call("config.clear", { service });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setBusy(null);
    }
  }

  const services: ServiceKey[] = ["gemini", "apify", "agentmail"];
  const missing = services.filter((s) => !status?.[s]?.configured);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Your third-party API keys. All stored in your own Netlify Blobs — never leave your deployment."
        right={
          <button
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30 transition font-bold tracking-wide"
          >
            <Sparkles size={16} /> {missing.length > 0 ? `Complete setup (${missing.length} left)` : "Re-run onboarding"}
          </button>
        }
      />

      {err && (
        <GlassCard className="mb-5 border-red-500/40 bg-red-500/10">
          <div className="flex items-center gap-3 text-red-200">
            <AlertCircle size={18} />
            <span className="text-sm font-medium">{err}</span>
          </div>
        </GlassCard>
      )}

      <div className="grid gap-4">
        {services.map((s) => {
          const meta = SERVICE_META[s];
          const svc = status?.[s];
          const configured = !!svc?.configured;
          const lastTestOk = svc?.last_test?.ok;

          return (
            <GlassCard key={s} className={`bg-gradient-to-br ${meta.accent}`}>
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 rounded-xl bg-black/30 border border-white/10 flex items-center justify-center shrink-0">
                  <Key size={22} className="text-white/80" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap mb-1">
                    <h3 className="font-display text-lg font-bold text-white">{meta.title}</h3>
                    {configured ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/40 text-green-300 text-[10px] font-mono font-bold uppercase tracking-wider">
                        <Check size={10} /> Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/15 text-white/50 text-[10px] font-mono font-bold uppercase tracking-wider">
                        Not set
                      </span>
                    )}
                    {configured && lastTestOk === false && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 text-[10px] font-mono font-bold uppercase tracking-wider">
                        <AlertCircle size={10} /> Last test failed
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-white/65 mb-1">{meta.summary}</p>
                  {configured ? (
                    <p className="text-xs text-white/50 font-mono">
                      {svc?.masked}
                      {svc?.updated_at && <span className="text-white/35 ml-2">· saved {new Date(svc.updated_at).toLocaleString()}</span>}
                    </p>
                  ) : (
                    <a
                      href={meta.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:text-white inline-flex items-center gap-1 font-semibold"
                    >
                      Get a free key from {meta.urlLabel} <ExternalLink size={11} />
                    </a>
                  )}
                  {configured && svc?.last_test?.message && lastTestOk === false && (
                    <p className="text-xs text-red-300 mt-1">{svc.last_test.message}</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {configured && (
                    <>
                      <button
                        onClick={() => retest(s)}
                        disabled={busy === s}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 text-xs font-semibold transition disabled:opacity-50"
                      >
                        {busy === s ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        Test
                      </button>
                      <button
                        onClick={() => clear(s)}
                        disabled={busy === s}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-semibold transition disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                  {!configured && (
                    <button
                      onClick={() => setWizardOpen(true)}
                      className="px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition"
                    >
                      + Add key
                    </button>
                  )}
                </div>
              </div>
            </GlassCard>
          );
        })}
      </div>

      <FooterSettings />

      <OnboardingWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onlyMissing={missing.length > 0}
        onComplete={() => void refresh()}
      />
    </>
  );
}
