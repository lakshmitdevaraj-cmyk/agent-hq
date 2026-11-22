import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Trash2, Key, Sparkles, AlertCircle, ExternalLink } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import OnboardingWizard from "@/components/OnboardingWizard";
import { call } from "@/lib/api";

type ServiceKey = "gemini" | "apify" | "agentmail";
type Role = "draft" | "review" | "helper";
const ROLES: { key: Role; title: string; hint: string }[] = [
  { key: "draft", title: "Drafting", hint: "Writes the emails." },
  { key: "review", title: "Reviewer", hint: "Checks every draft before it can be sent." },
  { key: "helper", title: "Helper", hint: "Small jobs: owner lookup, audience preview." },
];

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
    accent: "from-primary/20 to-primary/5 border-primary/30",
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
      <h3 className="font-display text-lg font-bold text-fg mb-1">Email footer</h3>
      <p className="text-sm text-fg2 mb-3">
        Every outreach email automatically ends with the opt-out line and the ShiftForge AI signature. Optionally add a postal address below — it is appended to that footer. Leave blank to omit.
      </p>
      <label htmlFor="postal-address" className="text-xs font-medium text-muted">
        Postal address (optional)
      </label>
      <textarea
        id="postal-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        rows={2}
        placeholder="Leave blank to omit"
        className="mt-1 w-full px-3 py-2 rounded-lg bg-inset border border-line text-fg text-sm focus:outline-none focus:border-primary/60"
      />
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={busy || address.trim() === saved}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-40"
        >
          {busy && <Loader2 size={12} className="animate-spin" />} Save
        </button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </GlassCard>
  );
}

// Which AgentMail inbox new emails are sent from, and where to be told about replies.
type InboxInfo = { inboxes: Array<{ inbox_id: string; email: string; display_name: string }>; selected: string; webhooks: Array<{ url: string; enabled: boolean; events: string[]; inbox_ids: string[] | null }> | null };

function SendingSettings() {
  const [info, setInfo] = useState<InboxInfo | null>(null);
  const [inbox, setInbox] = useState("");
  const [alertTo, setAlertTo] = useState("");
  const [saved, setSaved] = useState({ inbox: "", alertTo: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([call<InboxInfo>("outreach.inboxes.list"), call<{ reply_alert_email: string; sending_inbox_id: string }>("outreach.settings.get")])
      .then(([i, st]) => {
        setInfo(i);
        setInbox(st.sending_inbox_id);
        setAlertTo(st.reply_alert_email);
        setSaved({ inbox: st.sending_inbox_id, alertTo: st.reply_alert_email });
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : "Could not load AgentMail inboxes"));
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<{ sending_inbox_id: string; reply_alert_email: string }>("outreach.settings.set", { sending_inbox_id: inbox, reply_alert_email: alertTo });
      setInbox(r.sending_inbox_id);
      setAlertTo(r.reply_alert_email);
      setSaved({ inbox: r.sending_inbox_id, alertTo: r.reply_alert_email });
      setMsg({ ok: true, text: "Saved. New emails will use this inbox." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  // Do replies on every inbox reach this app? Read from the AgentMail webhook settings.
  let coverage: { ok: boolean; text: string } | null = null;
  if (info) {
    const hooks = info.webhooks?.filter((h) => h.enabled && h.events.includes("message.received")) ?? null;
    if (hooks === null) coverage = { ok: false, text: "Could not check which inboxes send replies to this app." };
    else if (hooks.length === 0) coverage = { ok: false, text: "No reply webhook found in AgentMail, so replies will not reach the Inbox." };
    else if (hooks.some((h) => h.inbox_ids === null)) coverage = { ok: true, text: "Replies sent to any of your inboxes reach the dashboard Inbox." };
    else {
      const covered = new Set(hooks.flatMap((h) => h.inbox_ids ?? []));
      const missing = info.inboxes.filter((i) => !covered.has(i.inbox_id)).map((i) => i.email);
      coverage = missing.length === 0 ? { ok: true, text: "Replies sent to any of your inboxes reach the dashboard Inbox." } : { ok: false, text: `Replies to ${missing.join(", ")} do NOT reach the Inbox yet. Add them to the webhook in AgentMail.` };
    }
  }

  // Replies from domains without DKIM/SPF/DMARC arrive as message.received.unauthenticated: the webhook must be subscribed to it.
  if (info && coverage?.ok) {
    const live = info.webhooks?.filter((h) => h.enabled && h.events.includes("message.received")) ?? [];
    if (live.length > 0 && live.every((h) => !h.events.includes("message.received.unauthenticated"))) {
      coverage = { ok: false, text: "The AgentMail webhook is not subscribed to \"message.received.unauthenticated\", so replies from small business domains without email authentication will not reach the Inbox. Go to Webhooks and press Fix webhook events." };
    }
  }

  const dirty = inbox !== saved.inbox || alertTo.trim().toLowerCase() !== saved.alertTo;
  return (
    <GlassCard className="mt-6">
      <h3 className="font-display text-lg font-bold text-fg mb-1">Sending inbox and reply alerts</h3>
      <p className="text-sm text-fg2 mb-3">
        New emails are sent from the inbox you pick. Emails already sent keep their own inbox, so their status and replies keep working. Leave it on the default to use your first AgentMail inbox, as before.
      </p>
      {loadErr && <p className="text-xs text-red-300 mb-2">{loadErr}</p>}
      <label htmlFor="sending-inbox" className="text-xs font-medium text-muted">Send new emails from</label>
      <select
        id="sending-inbox"
        value={inbox}
        onChange={(e) => setInbox(e.target.value)}
        disabled={!info}
        className="mt-1 w-full px-3 py-2 rounded-lg bg-inset border border-line text-fg text-sm focus:outline-none focus:border-primary/60"
      >
        <option value="">Default (first AgentMail inbox)</option>
        {info?.inboxes.map((i) => <option key={i.inbox_id} value={i.inbox_id}>{i.email}{i.display_name ? ` (${i.display_name})` : ""}</option>)}
        {inbox && info && !info.inboxes.some((i) => i.inbox_id === inbox) && <option value={inbox}>{inbox}</option>}
      </select>
      {coverage && <p className={`text-xs mt-1.5 ${coverage.ok ? "text-green-300" : "text-amber-300"}`}>{coverage.text}</p>}

      <label htmlFor="reply-alert" className="block mt-4 text-xs font-medium text-muted">Notify me of replies at</label>
      <input
        id="reply-alert"
        type="email"
        value={alertTo}
        onChange={(e) => setAlertTo(e.target.value)}
        placeholder="you@gmail.com (leave blank for no alerts)"
        className="mt-1 w-full px-3 py-2 rounded-lg bg-inset border border-line text-fg text-sm focus:outline-none focus:border-primary/60"
      />
      <p className="text-xs text-muted mt-1">One short email per new reply, sent from your sending inbox to this address only. No alert for "no thanks" replies or out-of-office messages.</p>

      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-40"
        >
          {busy && <Loader2 size={12} className="animate-spin" />} Save
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-green-300" : "text-red-300"}`}>{msg.text}</span>}
      </div>
    </GlassCard>
  );
}

// Gemini model + default sender details (prefill the Generate emails form).
type OutreachDefaults = {
  gemini_model: string;
  default_gemini_model: string;
  draft_model: string; review_model: string; helper_model: string;
  default_draft_model: string; default_review_model: string; default_helper_model: string;
  draft_provider: "gemini" | "second"; review_provider: "gemini" | "second"; helper_provider: "gemini" | "second";
  second_ai_base_url: string; second_ai_model: string; second_ai_configured: boolean;
  browser_check_cap: number;
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
  const set = (k: keyof OutreachDefaults, v: string | number) => setForm({ ...form, [k]: v });
  const input = "mt-1 w-full px-3 py-2 rounded-lg bg-inset border border-line text-fg text-sm focus:outline-none focus:border-primary/60";
  const label = "text-xs font-medium text-muted";

  async function save() {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<OutreachDefaults & { model_errors?: Array<{ field: string; model: string; message: string }> }>("outreach.settings.set", {
        draft_model: form.draft_model, review_model: form.review_model, helper_model: form.helper_model,
        draft_provider: form.draft_provider, review_provider: form.review_provider, helper_provider: form.helper_provider,
        browser_check_cap: Number(form.browser_check_cap),
        default_sender_name: form.default_sender_name,
        default_sender_company: form.default_sender_company,
        default_sender_offer: form.default_sender_offer,
      });
      const next = { ...form, ...r };
      setForm(next);
      setSaved(next);
      const bad = r.model_errors ?? [];
      const roleName = (f: string) => (f === "draft_model" ? "Drafting" : f === "review_model" ? "Reviewer" : "Helper");
      setMsg(bad.length === 0
        ? { ok: true, text: "Saved" }
        : { ok: false, text: `Your other changes are saved. Not saved: ${bad.map((b) => `${roleName(b.field)} model "${b.model}" (${b.message})`).join("; ")}` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="mt-6">
      <h3 className="font-display text-lg font-bold text-fg mb-1">Drafting defaults</h3>
      <p className="text-sm text-fg2 mb-3">
        These prefill the "Generate emails" form for every campaign (a campaign's own saved sender details win).
        Changing a model runs a real test call first, so a wrong name fails here, not mid-campaign.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {ROLES.map((r) => {
          const mk = `${r.key}_model` as keyof OutreachDefaults;
          const pk = `${r.key}_provider` as keyof OutreachDefaults;
          const dk = `default_${r.key}_model` as keyof OutreachDefaults;
          const second = form[pk] === "second";
          return (
            <div key={r.key}>
              <label htmlFor={`m-${r.key}`} className={label}>{r.title} model <span className="normal-case font-normal text-muted">· {r.hint}</span></label>
              <div className="flex gap-2">
                <select aria-label={`${r.title} provider`} value={String(form[pk])} onChange={(e) => set(pk, e.target.value)} className={`${input} !w-40`}>
                  <option value="gemini">Gemini</option>
                  <option value="second" disabled={!form.second_ai_configured}>Second provider{form.second_ai_configured ? "" : " (not set)"}</option>
                </select>
                <input id={`m-${r.key}`} value={second ? form.second_ai_model : String(form[mk])} disabled={second} onChange={(e) => set(mk, e.target.value)} className={input} />
              </div>
              <div className="text-label text-muted mt-1">{second ? "Uses the model set in the Second AI provider card below." : `Default: ${String(form[dk])}`}</div>
            </div>
          );
        })}
        <div>
          <label htmlFor="b-cap" className={label}>Browser check limit per campaign</label>
          <input id="b-cap" type="number" min={0} max={200} value={form.browser_check_cap} onChange={(e) => set("browser_check_cap", e.target.value === "" ? 0 : Number(e.target.value))} className={`${input} !w-32`} />
          <div className="text-label text-muted mt-1">Most leads each campaign can be re-checked in a real browser (Apify credits). Each check is about half a cent per page; you see the estimate before it starts.</div>
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
        {msg && <span className={`text-xs ${msg.ok ? "text-muted" : "text-red-300"}`}>{msg.text}</span>}
      </div>
    </GlassCard>
  );
}

function SecondProviderSettings() {
  const [form, setForm] = useState<{ base: string; model: string; configured: boolean; masked: string | null } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    try {
      const [o, c] = await Promise.all([call<OutreachDefaults>("outreach.settings.get"), call<ConfigStatus & Record<string, ServiceStatus>>("config.status")]);
      setForm({ base: o.second_ai_base_url, model: o.second_ai_model, configured: o.second_ai_configured, masked: (c as Record<string, ServiceStatus>).ai2?.masked ?? null });
    } catch { /* ignore */ }
  }
  useEffect(() => { void load(); }, []);
  if (!form) return null;
  const input = "mt-1 w-full px-3 py-2 rounded-lg bg-inset border border-line text-fg text-sm focus:outline-none focus:border-primary/60";
  const label = "text-xs font-medium text-muted";

  async function save() {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      await call("outreach.settings.set", { second_ai_base_url: form.base, second_ai_model: form.model });
      if (key.trim()) await call("config.set", { service: "ai2", key: key.trim() });
      else if (form.configured) await call("config.test", { service: "ai2" });
      setKey("");
      await load();
      setMsg({ ok: true, text: "Saved and tested: it works." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Remove the second provider key? Any model set to use it goes back to Gemini.")) return;
    setBusy(true);
    try {
      await call("config.clear", { service: "ai2" });
      await call("outreach.settings.set", { draft_provider: "gemini", review_provider: "gemini", helper_provider: "gemini" });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="mt-6">
      <h3 className="font-display text-lg font-bold text-fg mb-1">Second AI provider <span className="text-xs font-normal text-muted">(optional)</span></h3>
      <p className="text-sm text-fg2 mb-3">
        Any OpenAI-compatible service (DeepSeek by default). If Gemini is busy or out of quota, drafting and reviewing fall back to this one automatically.
        You can also pick it as the Drafting, Reviewer or Helper model above. A fallback never makes an unreviewed draft "ready".
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <div>
          <label htmlFor="a2-url" className={label}>Base URL</label>
          <input id="a2-url" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} className={input} />
        </div>
        <div>
          <label htmlFor="a2-model" className={label}>Model</label>
          <input id="a2-model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={input} />
        </div>
        <div>
          <label htmlFor="a2-key" className={label}>API key {form.configured && <span className="normal-case font-mono text-muted">· saved {form.masked}</span>}</label>
          <input id="a2-key" type="password" autoComplete="off" placeholder={form.configured ? "Leave empty to keep the saved key" : "Paste key"} value={key} onChange={(e) => setKey(e.target.value)} className={input} />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={busy} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-40">
          {busy && <Loader2 size={12} className="animate-spin" />} {busy ? "Testing…" : "Save and test"}
        </button>
        {form.configured && <button onClick={remove} disabled={busy} className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-semibold"><Trash2 size={12} /></button>}
        {msg && <span className={`text-xs ${msg.ok ? "text-green-300" : "text-red-300"}`}>{msg.text}</span>}
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
      if (file.format !== "shiftforge-hq-export" || !file.stores) throw new Error("This is not an Alcance export file");
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
      <h3 className="font-display text-lg font-bold text-fg mb-1">Move to another site</h3>
      <p className="text-sm text-fg2 mb-3">
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
        <pre className={`mt-3 text-xs whitespace-pre-wrap ${ok ? "text-fg2" : "text-red-300"}`}>{log.join("\n")}</pre>
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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {services.map((s) => {
          const meta = SERVICE_META[s];
          const svc = status?.[s];
          const configured = !!svc?.configured;
          const lastTestOk = svc?.last_test?.ok;

          return (
            <GlassCard key={s} className={`bg-gradient-to-br ${meta.accent}`}>
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 rounded-xl bg-inset border border-line flex items-center justify-center shrink-0">
                  <Key size={22} className="text-fg2" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap mb-1">
                    <h3 className="font-display text-lg font-bold text-fg">{meta.title}</h3>
                    {configured ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/40 text-green-300 text-label font-mono font-bold">
                        <Check size={10} /> Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-fg/5 border border-line text-muted text-label font-mono font-bold">
                        Not set
                      </span>
                    )}
                    {configured && lastTestOk === false && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 text-label font-mono font-bold">
                        <AlertCircle size={10} /> Last test failed
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-fg2 mb-1">{meta.summary}</p>
                  {configured ? (
                    <p className="text-xs text-muted font-mono break-words">
                      {svc?.masked}
                      {svc?.updated_at && <span className="text-muted ml-2">· saved {new Date(svc.updated_at).toLocaleString()}</span>}
                    </p>
                  ) : (
                    <a
                      href={meta.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:text-fg inline-flex items-center gap-1 font-semibold"
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
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-fg/5 hover:bg-fg/10 border border-line text-fg2 text-xs font-semibold transition disabled:opacity-50"
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
      <SecondProviderSettings />
      <SendingSettings />
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
