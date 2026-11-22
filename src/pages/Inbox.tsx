import { usePolling } from "@/lib/usePolling";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Inbox as InboxIcon, Loader2, MessageSquare, KanbanSquare, AlertCircle, Trash2, RefreshCw } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import { call } from "@/lib/api";
import { timeAgo } from "@/lib/utils";

type Reply = {
  id: string;
  campaign_id: string | null;
  lead_id: string | null;
  original_email_id: string | null;
  from: string | null;
  to: string[] | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  received_at: string;
  handled: boolean;
  opt_out?: boolean; // reply said no/stop/unsubscribe → lead marked do-not-contact
  flag?: "unauthenticated" | "spam" | "blocked" | null; // how AgentMail filed it (usually still a real person)
  is_test?: boolean; // sent from Lakshmi's own address
};

const FLAG_TEXT = { unauthenticated: "Unauthenticated", spam: "Spam", blocked: "Blocked" } as const;
const FLAG_TIP = {
  unauthenticated: "The sender's domain has no email authentication. Usually a real person; check before acting.",
  spam: "AgentMail's filter marked this as spam. Often a real reply; check before acting.",
  blocked: "AgentMail blocked this sender. Check before acting.",
} as const;

function ReplyBadges({ r }: { r: Reply }) {
  return (
    <>
      {r.flag && (
        <span title={FLAG_TIP[r.flag]} className="tag tag-flag shrink-0">
          {FLAG_TEXT[r.flag]}
        </span>
      )}
      {r.is_test && (
        <span title="Sent from one of your own addresses. Not counted as a campaign reply." className="tag tag-neutral shrink-0">
          Test
        </span>
      )}
    </>
  );
}

export default function Inbox() {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  usePolling(refresh, 30000, []);

  async function syncMissed() {
    setBusy(true);
    setErr(null);
    setSyncMsg(null);
    try {
      const r = await call<{ added: number; flagged: number; scanned: number; more: number }>("outreach.replies.sync", { days: 14 });
      setSyncMsg(`${r.added} new repl${r.added === 1 ? "y" : "ies"} added (${r.flagged} flagged). Checked ${r.scanned} messages from the last 14 days.${r.more ? ` ${r.more} more are waiting: press the button again.` : ""}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Check failed");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    try {
      const list = await call<Reply[]>("outreach.replies.list", { limit: 200 });
      setReplies(list);
      if (!selectedId && list[0]) setSelectedId(list[0].id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoaded(true);
    }
  }

  async function deleteReply(id: string) {
    if (!confirm("Delete this reply from the Inbox? If it asked us to stop, the lead stays marked do-not-contact.")) return;
    setBusy(true);
    setErr(null);
    try {
      await call("outreach.replies.delete", { id });
      const rest = replies.filter((r) => r.id !== id);
      setReplies(rest);
      setSelectedId(rest[0]?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function convertToTask(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await call("outreach.replies.convert_to_task", { id });
      alert("Reply converted to task. Open /tasks to see it in the Needs Input column.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Convert failed");
    } finally {
      setBusy(false);
    }
  }

  const selected = replies.find((r) => r.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Inbound replies to your outreach campaigns. AgentMail pushes them here in real time via webhook."
      />

      <div className="flex justify-end items-center gap-2 flex-wrap -mt-2 mb-3">
        {syncMsg && <span className="text-xs text-fg2 mr-1">{syncMsg}</span>}
        <button
          onClick={() => void syncMissed()}
          disabled={busy}
          title="Reads the last 14 days from AgentMail (read-only) and adds any reply Alcance does not have yet"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-xs font-semibold transition disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <InboxIcon size={12} />} Check AgentMail for missed replies
        </button>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fg/[0.04] hover:bg-fg/[0.08] border border-line text-fg2 text-xs font-semibold transition"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {err && (
        <GlassCard className="mb-5 border-red-500/40 bg-red-500/10">
          <div className="flex items-center gap-3 text-red-200">
            <AlertCircle size={18} />
            <span className="text-sm font-medium">{err}</span>
          </div>
        </GlassCard>
      )}

      {loaded && replies.length === 0 && (
        <GlassCard className="text-center py-16 bg-gradient-to-br from-primary/[0.04] to-primary/[0.04]">
          <div className="w-16 h-16 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center mx-auto mb-5">
            <InboxIcon size={28} className="text-primary" />
          </div>
          <h3 className="font-display text-2xl font-bold text-fg mb-2">No replies yet.</h3>
          <p className="text-sm text-fg2 max-w-md mx-auto">
            Once you send a campaign and a prospect replies, it will show up here within seconds.
            The fastest way to see it working: add a test lead with your own email, send a campaign, reply to yourself.
          </p>
        </GlassCard>
      )}

      {replies.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-[380px_1fr] gap-4">
          {/* Thread list */}
          <GlassCard className="!p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-line flex items-center gap-2">
              <InboxIcon size={14} className="text-primary" />
              <span className="font-display text-xs text-fg2 font-medium">Inbound</span>
              <span className="text-xs font-mono text-muted ml-1">({replies.length})</span>
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {replies.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full text-left px-4 py-3 border-b border-line transition hover:bg-fg/[0.03] ${
                    selectedId === r.id ? "bg-primary/[0.06]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-fg truncate flex-1">{r.from ?? "Unknown"}</span>
                    <ReplyBadges r={r} />
                    {r.opt_out && (
                      <span className="tag tag-bad shrink-0">
                        Do not contact
                      </span>
                    )}
                    <span className="text-label text-muted font-mono shrink-0">{timeAgo(r.received_at)}</span>
                  </div>
                  <div className="text-xs text-fg2 mb-1 truncate">{r.subject ?? "(no subject)"}</div>
                  <div className="text-xs text-muted line-clamp-2">{r.text ?? ""}</div>
                </button>
              ))}
            </div>
          </GlassCard>

          {/* Selected thread */}
          {selected ? (
            <GlassCard>
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-green-500/20 border border-green-500/40 flex items-center justify-center shrink-0">
                  <MessageSquare size={16} className="text-green-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-fg truncate">{selected.from ?? "Unknown"}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted font-mono">{new Date(selected.received_at).toLocaleString()}</span>
                    <ReplyBadges r={selected} />
                  </div>
                  {selected.flag && <div className="text-xs text-amber-200 mt-1">{FLAG_TIP[selected.flag]}</div>}
                  {selected.opt_out && (
                    <div className="text-xs text-red-300 mt-1">This reply asked us to stop — the lead is marked do-not-contact and won't be emailed again.</div>
                  )}
                </div>
                <button
                  onClick={() => convertToTask(selected.id)}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-50"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <KanbanSquare size={12} />}
                  Convert to task
                </button>
                <button
                  onClick={() => void deleteReply(selected.id)}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/40 text-red-300 text-xs font-bold tracking-wide transition disabled:opacity-50"
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              </div>
              <h2 className="font-display text-xl font-bold text-fg mb-4">{selected.subject ?? "(no subject)"}</h2>
              {/* Plain text only: an inbound email's own HTML is never rendered (its colours, links and scripts are not ours to run). */}
              <pre className="whitespace-pre-wrap break-words font-sans text-sm text-fg2 leading-relaxed">{selected.text || "(no text)"}</pre>
              {selected.campaign_id && (
                <div className="mt-5 pt-4 border-t border-line text-xs text-muted">
                  From campaign <Link to={`/outreach/${selected.campaign_id}`} className="text-primary hover:underline">view campaign →</Link>
                </div>
              )}
            </GlassCard>
          ) : (
            <GlassCard className="flex items-center justify-center text-muted text-sm">
              Select a reply on the left to read it.
            </GlassCard>
          )}
        </div>
      )}
    </>
  );
}
