import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Inbox as InboxIcon, Loader2, MessageSquare, KanbanSquare, AlertCircle } from "lucide-react";
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
};

export default function Inbox() {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, []);

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

      {err && (
        <GlassCard className="mb-5 border-red-500/40 bg-red-500/10">
          <div className="flex items-center gap-3 text-red-200">
            <AlertCircle size={18} />
            <span className="text-sm font-medium">{err}</span>
          </div>
        </GlassCard>
      )}

      {loaded && replies.length === 0 && (
        <GlassCard className="text-center py-16 bg-gradient-to-br from-primary/[0.04] to-purple/[0.04]">
          <div className="w-16 h-16 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center mx-auto mb-5 shadow-glow">
            <InboxIcon size={28} className="text-primary" />
          </div>
          <h3 className="font-display text-2xl font-bold text-white mb-2">No replies yet.</h3>
          <p className="text-sm text-white/65 max-w-md mx-auto">
            Once you send a campaign and a prospect replies, it will show up here within seconds.
            The fastest way to see it working: add a test lead with your own email, send a campaign, reply to yourself.
          </p>
        </GlassCard>
      )}

      {replies.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-[380px_1fr] gap-4">
          {/* Thread list */}
          <GlassCard className="!p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <InboxIcon size={14} className="text-primary" />
              <span className="font-display text-xs tracking-widest uppercase text-white/75 font-bold">Inbound</span>
              <span className="text-xs font-mono text-white/45 ml-1">({replies.length})</span>
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {replies.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full text-left px-4 py-3 border-b border-white/[0.04] transition hover:bg-white/[0.03] ${
                    selectedId === r.id ? "bg-primary/[0.06]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-white truncate flex-1">{r.from ?? "Unknown"}</span>
                    {r.opt_out && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/40 text-red-300 shrink-0">
                        Do not contact
                      </span>
                    )}
                    <span className="text-[10px] text-white/40 font-mono shrink-0">{timeAgo(r.received_at)}</span>
                  </div>
                  <div className="text-xs text-white/65 mb-1 truncate">{r.subject ?? "(no subject)"}</div>
                  <div className="text-xs text-white/45 line-clamp-2">{r.text ?? ""}</div>
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
                  <div className="font-semibold text-white truncate">{selected.from ?? "Unknown"}</div>
                  <div className="text-xs text-white/50 font-mono">{new Date(selected.received_at).toLocaleString()}</div>
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
              </div>
              <h2 className="font-display text-xl font-bold text-white mb-4">{selected.subject ?? "(no subject)"}</h2>
              <div className="prose prose-invert prose-sm max-w-none">
                {selected.html ? (
                  <div className="text-sm text-white/85 leading-relaxed" dangerouslySetInnerHTML={{ __html: selected.html }} />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-white/85 leading-relaxed">{selected.text ?? ""}</pre>
                )}
              </div>
              {selected.campaign_id && (
                <div className="mt-5 pt-4 border-t border-white/[0.06] text-xs text-white/55">
                  From campaign <Link to={`/outreach/${selected.campaign_id}`} className="text-primary hover:underline">view campaign →</Link>
                </div>
              )}
            </GlassCard>
          ) : (
            <GlassCard className="flex items-center justify-center text-white/50 text-sm">
              Select a reply on the left to read it.
            </GlassCard>
          )}
        </div>
      )}
    </>
  );
}
