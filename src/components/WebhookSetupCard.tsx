import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Webhook, Zap, AlertCircle, Sparkles, RefreshCw } from "lucide-react";
import GlassCard from "./GlassCard";
import { call } from "@/lib/api";
import { copyToClipboard } from "@/lib/utils";

type WebhookRecord = {
  id: string;
  name: string;
  service?: string;
  event_count: number;
  created_at: string;
};

type WebhookFix = { webhook_id: string; url: string; before: string[]; after: string[]; added: string[]; needs_change: boolean; applied: boolean; message: string };

type TestResult = {
  ok: boolean;
  waiting?: boolean;
  before_count?: number;
  test_message_id: string | null;
  test_address: string;
  new_events: number;
  hint: string;
};

/**
 * A progress card that walks the user through wiring the AgentMail webhook.
 * Step 1: Create a webhook (we auto-create one tagged service=agentmail).
 * Step 2: Copy its URL + paste into AgentMail settings.
 * Step 3: Click Run test — we fire a test send, poll for events, flip green.
 *
 * Once the webhook has any event_count > 0, the card collapses into a
 * small "tracking live" banner instead of the full setup flow.
 */
export default function WebhookSetupCard() {
  const [webhooks, setWebhooks] = useState<WebhookRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"create" | "test" | "events" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const list = await call<WebhookRecord[]>("webhook.list");
      setWebhooks(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }

  const agentmailWebhook = webhooks.find((w) => w.service === "agentmail");
  const webhookUrl = agentmailWebhook
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/webhook/${agentmailWebhook.id}`
    : null;

  async function createWebhook() {
    setBusy("create");
    setErr(null);
    try {
      await call("webhook.create_typed", {
        name: "AgentMail events",
        description: "Receives sent / delivered / bounced / received events from AgentMail",
        service: "agentmail",
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (!agentmailWebhook) return;
    setBusy("test");
    setErr(null);
    setTestResult(null);
    try {
      // Events can arrive about 20 s late: send once, then keep checking (no new email) for up to 45 s.
      const started = Date.now();
      let result = await call<TestResult>("outreach.webhook.test", { webhook_id: agentmailWebhook.id });
      setTestResult(result);
      while (!result.ok && Date.now() - started < 45_000) {
        result = await call<TestResult>("outreach.webhook.test", { webhook_id: agentmailWebhook.id, check_only: true, before_count: result.before_count ?? 0 });
        result = { ...result, test_address: result.test_address ?? testResult?.test_address ?? "" };
        setTestResult(result);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  const [fix, setFix] = useState<WebhookFix[] | null>(null);
  async function checkEvents(apply: boolean) {
    setBusy("events");
    setErr(null);
    try {
      const r = await call<{ dry_run: boolean; webhooks: WebhookFix[] }>("outreach.webhook.events", { apply, url_contains: window.location.host });
      setFix(r.webhooks);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not read the AgentMail webhook");
    } finally {
      setBusy(null);
    }
  }

  async function copyUrl() {
    if (!webhookUrl) return;
    await copyToClipboard(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const fixBlock = (
    <div className="mt-3 pt-3 border-t border-white/[0.06] text-xs text-white/70 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => void checkEvents(false)} disabled={busy === "events"} className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 text-xs font-semibold disabled:opacity-50">
          {busy === "events" ? "Reading…" : "Check webhook events"}
        </button>
        {fix?.some((w) => w.needs_change) && (
          <button onClick={() => void checkEvents(true)} disabled={busy === "events"} className="px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-xs font-bold disabled:opacity-50">
            Fix webhook events
          </button>
        )}
        <span className="text-white/45">Replies from domains without email authentication need the "message.received.unauthenticated" event.</span>
      </div>
      {fix && fix.length === 0 && <p className="text-amber-200/90">No AgentMail webhook points at this site yet. Paste the URL above into the AgentMail console first.</p>}
      {fix?.map((w) => (
        <div key={w.webhook_id} className="rounded-md bg-black/25 border border-white/10 p-2 space-y-1 break-words">
          <div className="font-mono text-[11px] text-white/60 break-all">{w.url}</div>
          <div>{w.message}</div>
          {w.needs_change && (
            <div className="font-mono text-[11px] text-white/55 break-all">
              Now: {w.before.join(", ") || "(none)"}<br />Would send: {w.after.join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  if (loading) {
    return (
      <GlassCard className="mb-5 flex items-center gap-3 text-white/60">
        <Loader2 size={16} className="animate-spin" /> Checking webhook status…
      </GlassCard>
    );
  }

  // If we've received at least one event AND a test has succeeded,
  // collapse to a slim "tracking live" badge.
  const isLive = agentmailWebhook && agentmailWebhook.event_count > 0;

  if (isLive) {
    return (
      <GlassCard className="mb-5 bg-gradient-to-br from-green-500/[0.06] to-transparent border-green-500/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-500/20 border border-green-500/40 flex items-center justify-center shrink-0">
            <Zap size={16} className="text-green-300" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-white">Event tracking live</p>
            <p className="text-xs text-white/60">
              AgentMail webhook has received {agentmailWebhook!.event_count} events. Opens, clicks, bounces, and replies update in real time.
            </p>
          </div>
          <button
            onClick={runTest}
            disabled={busy === "test"}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 text-xs font-semibold transition disabled:opacity-50"
          >
            {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Re-test
          </button>
        </div>
        {fixBlock}
      </GlassCard>
    );
  }

  // Step 1: no webhook yet
  if (!agentmailWebhook) {
    return (
      <GlassCard className="mb-5 bg-gradient-to-br from-accent/[0.08] to-purple/[0.08] border-accent/30">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
            <Webhook size={18} className="text-accent" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles size={13} className="text-accent" />
              <span className="text-xs uppercase tracking-widest text-accent font-bold">Final setup step</span>
            </div>
            <p className="text-sm text-white font-semibold mb-1">Wire event tracking</p>
            <p className="text-xs text-white/70 leading-relaxed mb-3">
              AgentMail pushes delivered / bounced / clicked / replied events to your dashboard via webhook. This
              is how counters tick live during a send. Takes 60 seconds.
            </p>
            {err && <p className="text-xs text-red-300 mb-2">{err}</p>}
            <button
              onClick={createWebhook}
              disabled={busy === "create"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/20 hover:bg-accent/30 border border-accent/50 text-accent text-xs font-bold tracking-wide transition disabled:opacity-50"
            >
              {busy === "create" ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Create AgentMail webhook
            </button>
          </div>
        </div>
      </GlassCard>
    );
  }

  // Step 2 & 3: webhook exists, guide user through paste + test
  return (
    <GlassCard className="mb-5 bg-gradient-to-br from-accent/[0.06] to-purple/[0.06] border-accent/25">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
          <Webhook size={18} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={13} className="text-accent" />
            <span className="text-xs uppercase tracking-widest text-accent font-bold">Almost there</span>
          </div>

          {/* Step 2: paste into AgentMail */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-5 h-5 rounded-full bg-green-500/20 border border-green-500/40 flex items-center justify-center text-[10px] font-bold text-green-300">
                <Check size={10} />
              </div>
              <span className="text-xs text-white/80 font-semibold">Webhook created</span>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-5 h-5 rounded-full bg-accent/20 border border-accent/60 flex items-center justify-center text-[10px] font-bold text-accent">
                2
              </div>
              <span className="text-xs text-white font-semibold">Paste this URL into AgentMail → Settings → Webhooks</span>
            </div>
            <div className="flex items-center gap-2 ml-7">
              <code className="flex-1 px-3 py-2 rounded-md bg-black/50 border border-white/10 text-[11px] text-primary font-mono overflow-x-auto whitespace-nowrap">
                {webhookUrl}
              </code>
              <button
                onClick={copyUrl}
                className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/85 text-xs font-semibold transition"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
              <a
                href="https://console.agentmail.to/dashboard/webhooks"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-md bg-accent/15 hover:bg-accent/25 border border-accent/40 text-accent text-xs font-semibold transition"
              >
                <ExternalLink size={12} />
                Open AgentMail
              </a>
            </div>
            <p className="text-[11px] text-white/50 ml-7 mt-1">
              Enable all event types (message.sent, message.delivered, message.bounced, message.received).
            </p>
          </div>

          {/* Step 3: run test */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-5 h-5 rounded-full bg-accent/20 border border-accent/60 flex items-center justify-center text-[10px] font-bold text-accent">
                3
              </div>
              <span className="text-xs text-white font-semibold">Run a test</span>
            </div>
            <div className="ml-7 flex items-center gap-3">
              <button
                onClick={runTest}
                disabled={busy === "test"}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-black text-xs font-bold tracking-wide shadow-glow-accent hover:bg-accent/90 transition disabled:opacity-50"
              >
                {busy === "test" ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> Sending test + waiting up to 45s…
                  </>
                ) : (
                  <>
                    <Zap size={12} /> Run webhook test
                  </>
                )}
              </button>
              {testResult && (
                <div
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono font-bold ${
                    testResult.ok
                      ? "bg-green-500/20 border border-green-500/50 text-green-300"
                      : "bg-red-500/15 border border-red-500/40 text-red-300"
                  }`}
                >
                  {testResult.ok ? <Check size={12} /> : <AlertCircle size={12} />}
                  {testResult.ok ? `${testResult.new_events} event(s) received` : "No events yet"}
                </div>
              )}
            </div>
            {testResult && <p className="text-[11px] text-white/55 ml-7 mt-2">{testResult.hint}</p>}
            {err && <p className="text-[11px] text-red-300 ml-7 mt-2">{err}</p>}
            <div className="ml-7">{fixBlock}</div>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
