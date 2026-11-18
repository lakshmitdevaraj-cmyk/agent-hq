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

// Gemini model + default sender details (prefill the Generate emails form).
type OutreachDefaults = {
  gemini_model: string;
  default_gemini_model: string;
  default_sender_name: string;
  default_sender_company: string;
  default_sender_offer: string;
};

function OutreachDefaultsSettings() {
  const [form, setForm] = useState<OutreachDefaults | null>(null);
  const [saved, setSaved] = useState<OutreachDefaults | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    call<OutreachDefaults>("outreach.settings.get")
      .then((r) => {
        setForm(r);
        setSaved(r);
      })
      .catch(() => undefined);
  }, []);

  if (!form || !saved) return null;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (k: keyof OutreachDefaults, v: string) => setForm({ ...form, [k]: v });
  const input = "mt-1 w-full px-3 py-2 rounded-lg bg-black/30 border border-white/15 text-white text-sm focus:outline-none focus:border-primary/60";
  const label = "text-xs font-bold tracking-wider uppercase text-white/60";

  async function save() {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<OutreachDefaults>("outreach.settings.set", {
        gemini_model: form.gemini_model,
        default_sender_name: form.default_sender_name,
        default_sender_company: form.default_sender_company,
        default_sender_offer: form.default_sender_offer,
      });
      const next = { ...form, ...r };
      setForm(next);
      setSaved(next);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="mt-6">
      <h3 className="font-display text-lg font-bold text-white mb-1">Drafting defaults</h3>
      <p className="text-sm text-white/65 mb-3">
        These prefill the "Generate emails" form for every campaign (a campaign's own saved sender details win).
        Changing the Gemini model runs a real test call first, so a wrong name fails here, not mid-campaign.
      </p>
      <div className="grid gap-3">
        <div>
          <label htmlFor="g-model" className={label}>Gemini model</label>
          <input id="g-model" value={form.gemini_model} onChange={(e) => set("gemini_model", e.target.value)} className={input} />
          <div className="text-[11px] text-white/45 mt-1">Default: {form.default_gemini_model}</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label htmlFor="s-name" className={label}>Your name</label>
            <input id="s-name" value={form.default_sender_name} onChange={(e) => set("default_sender_name", e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="s-company" className={label}>Company</label>
            <input id="s-company" value={form.default_sender_company} onChange={(e) => set("default_sender_company", e.target.value)} className={input} />
          </div>
        </div>
        <div>
          <label htmlFor="s-offer" className={label}>What you offer (one sentence)</label>
          <textarea id="s-offer" rows={2} value={form.default_sender_offer} onChange={(e) => set("default_sender_offer", e.target.value)} className={input} />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-40"
        >
          {busy && <Loader2 size={12} className="animate-spin" />} {busy ? "Testing and saving…" : "Save"}
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-white/60" : "text-red-300"}`}>{msg.text}</span>}
      </div>
    </GlassCard>
  );
}

type MoveRecord = { key: string; value: string };
type MoveFile = { format: "shiftforge-hq-export"; version: 1; exported_at: string; stores: Record<string, MoveRecord[]> };

function MoveSiteSettings() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [ok, setOk] = useState(true);
  const add = (t: string) => setLog((l) => [...l, t]);

  async function listStores(): Promise<Record<string, number>> {
    return (await call<{ counts: Record<string, number> }>("data.counts")).counts;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setLog([]);
    setOk(true);
    try {
      await fn();
    } catch (e) {
      setOk(false);
      add(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const exportAll = () =>
    run(async () => {
      const names = Object.keys(await listStores());
      const file: MoveFile = { format: "shiftforge-hq-export", version: 1, exported_at: new Date().toISOString(), stores: {} };
      for (const name of names) {
        const rows: MoveRecord[] = [];
        let cursor: string | null = null;
        do {
          const r: { records: MoveRecord[]; next_cursor: string | null } = await call("data.export", { store: name, cursor });
          rows.push(...r.records);
          cursor = r.next_cursor;
        } while (cursor);
        file.stores[name] = rows;
        add(`${name.replace("agent-hq-", "")}: ${rows.length}`);
      }
      const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `shiftforge-hq-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      add("Downloaded. Keep this file private: it contains your leads and emails.");
    });

  const importFile = (f: File) =>
    run(async () => {
      const file = JSON.parse(await f.text()) as MoveFile;
      if (file.format !== "shiftforge-hq-export" || !file.stores) throw new Error("This is not a ShiftForge HQ export file");
      for (const [name, rows] of Object.entries(file.stores)) {
        let written = 0;
        let skipped = 0;
        let i = 0;
        while (i < rows.length) {
          const chunk: MoveRecord[] = [];
          let bytes = 0;
          while (i < rows.length && chunk.length < 100 && bytes < 1_500_000) {
            bytes += rows[i].value.length + rows[i].key.length;
            chunk.push(rows[i++]);
          }
          const r = await call<{ written: number; skipped: number }>("data.import", { store: name, records: chunk });
          written += r.written;
          skipped += r.skipped;
        }
        add(`${name.replace("agent-hq-", "")}: ${written} added, ${skipped} already there`);
      }
      add("Done. Press Compare counts to check against the old site.");
    });

  const compare = () =>
    run(async () => {
      const c = await listStores();
      Object.entries(c).forEach(([k, v]) => add(`${k.replace("agent-hq-", "")}: ${v}`));
    });

  const btn = "flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-40";
  return (
    <GlassCard className="mt-6">
      <h3 className="font-display text-lg font-bold text-white mb-1">Move to another site</h3>
      <p className="text-sm text-white/65 mb-3">
        Export everything (campaigns, leads, drafts, sent emails, replies, settings) to one file, then import it on the new site.
        Your API keys (AgentMail, Gemini, Apify) are never included; enter them again on the new site.
        Wait a minute after your last change before exporting.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={exportAll} disabled={busy} className={btn}>
          {busy && <Loader2 size={12} className="animate-spin" />} Export everything
        </button>
        <label className={`${btn} cursor-pointer ${busy ? "opacity-40 pointer-events-none" : ""}`}>
          Import a file
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importFile(f);
            }}
          />
        </label>
        <button onClick={compare} disabled={busy} className={btn}>Compare counts</button>
      </div>
      {log.length > 0 && (
        <pre className={`mt-3 text-xs whitespace-pre-wrap ${ok ? "text-white/70" : "text-red-300"}`}>{log.join("\n")}</pre>
      )}
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

      <OutreachDefaultsSettings />
      <MoveSiteSettings />
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
