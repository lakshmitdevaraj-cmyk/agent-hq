import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity as ActivityIcon,
  Mail,
  Search,
  FileText,
  GitBranch,
  AlertCircle,
  Zap,
  X,
  Pause,
  Play,
} from "lucide-react";
import { call } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import type { Activity, ActivityCategory } from "@/lib/types";

/**
 * LiveAgentFeed — floating bottom-right ticker that shows agent/user
 * actions as they happen. Polls activity.list every 1.5s when the tab
 * is focused, pauses when hidden. Clicking an entry navigates to the
 * relevant surface if we can infer one from details.
 *
 * This is the "watch Max work" surface. Every action that calls
 * activity.log shows up here within ~1.5s, which makes headless agent
 * runs feel live even though it's just polling underneath.
 */

const CATEGORY_META: Record<ActivityCategory, { color: string; bg: string; border: string; icon: typeof Mail }> = {
  task: { color: "text-primary", bg: "bg-primary/15", border: "border-primary/40", icon: GitBranch },
  research: { color: "text-purple", bg: "bg-purple/15", border: "border-purple/40", icon: Search },
  email: { color: "text-accent", bg: "bg-accent/15", border: "border-accent/40", icon: Mail },
  content: { color: "text-primary", bg: "bg-primary/15", border: "border-primary/40", icon: FileText },
  decision: { color: "text-amber-300", bg: "bg-amber-500/15", border: "border-amber-500/40", icon: Zap },
  error: { color: "text-red-300", bg: "bg-red-500/15", border: "border-red-500/40", icon: AlertCircle },
  system: { color: "text-white/70", bg: "bg-white/5", border: "border-white/10", icon: ActivityIcon },
};

// Maps activity details → a dashboard route. If the activity carries
// enough context to link somewhere useful (a campaign id, a reply id,
// a page slug), we let the user click through.
function routeForActivity(a: Activity): string | null {
  const d = a.details ?? {};
  if (d.campaign_id) return `/outreach/${d.campaign_id}`;
  if (d.reply_id) return `/inbox`;
  if (d.slug && a.category === "content" && typeof d.slug === "string") {
    // page.update / page.create summaries mention "Landing page" in summary
    if (a.summary.toLowerCase().includes("landing page")) return `/pages`;
    return `/forms/${d.slug}`;
  }
  if (d.task_id) return `/tasks`;
  if (d.session_id || d.invitation_id) return `/voice`;
  return null;
}

// How recent the most-recent item needs to be for us to consider the
// feed "active" (and show the pulse). 60s is a good window — covers
// normal human-triggered bursts without flapping.
const ACTIVE_WINDOW_MS = 60_000;

export default function LiveAgentFeed() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<Activity[]>([]);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("agent_hq_live_feed_hidden") !== "1";
  });
  const [paused, setPaused] = useState(false);
  const [newestId, setNewestId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      // Skip the fetch when the tab is hidden — saves invocations and
      // matches the user's actual attention.
      // Hidden tab: stop completely. The visibilitychange handler below
      // restarts the loop when the tab comes back.
      if (typeof document !== "undefined" && document.hidden) return;
      if (paused) {
        pollRef.current = setTimeout(tick, 5000);
        return;
      }
      try {
        const fresh = await call<Activity[]>("activity.list", { limit: 20 });
        if (cancelled) return;
        // Dedupe + keep newest 20 only.
        const map = new Map<string, Activity>();
        for (const a of fresh) map.set(a.id, a);
        const merged = [...map.values()].sort((a, b) =>
          a.created_at < b.created_at ? 1 : -1,
        );
        setEntries(merged.slice(0, 20));

        // Detect a newly-arrived entry so we can flash the top card.
        const top = merged[0];
        if (top && !seenIds.has(top.id)) {
          setNewestId(top.id);
          setSeenIds((prev) => {
            const next = new Set(prev);
            for (const a of merged.slice(0, 5)) next.add(a.id);
            return next;
          });
          // Clear the flash highlight after the animation window.
          setTimeout(() => setNewestId((cur) => (cur === top.id ? null : cur)), 2500);
        }
      } catch {
        // Silently retry — network hiccups shouldn't break the feed.
      }
      // Tighten polling when there's been recent activity.
      const mostRecent = entries[0] ? Date.parse(entries[0].created_at) : 0;
      const active = Date.now() - mostRecent < ACTIVE_WINDOW_MS;
      const nextDelay = active ? 10_000 : 30_000;
      pollRef.current = setTimeout(tick, nextDelay);
    }

    void tick();
    const handleVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        // Tab came back — tick immediately.
        if (pollRef.current) clearTimeout(pollRef.current);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const isActive = entries[0]
    ? Date.now() - Date.parse(entries[0].created_at) < ACTIVE_WINDOW_MS
    : false;

  function dismiss() {
    localStorage.setItem("agent_hq_live_feed_hidden", "1");
    setOpen(false);
  }

  function reopen() {
    localStorage.removeItem("agent_hq_live_feed_hidden");
    setOpen(true);
  }

  // Minimal "reopen" chip when feed is hidden.
  if (!open) {
    return (
      <button
        onClick={reopen}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-3 py-2 rounded-full bg-black/70 backdrop-blur-xl border border-white/15 hover:border-primary/60 text-xs text-white/80 hover:text-white transition shadow-xl"
        title="Show live agent feed"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
        Live
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-[380px] max-w-[calc(100vw-3rem)]">
      <div className="glass backdrop-blur-2xl bg-black/60 border border-white/10 rounded-2xl overflow-hidden shadow-2xl shadow-black/50">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
          <span className="font-display text-[10px] tracking-[0.3em] uppercase text-white/80 font-bold">
            {isActive ? "Live feed" : "Agent feed"}
          </span>
          <span className="text-[10px] text-white/40 font-mono">({entries.length})</span>
          <div className="flex-1" />
          <button
            onClick={() => setPaused((p) => !p)}
            className="w-6 h-6 rounded-md hover:bg-white/10 text-white/60 hover:text-white flex items-center justify-center transition"
            title={paused ? "Resume polling" : "Pause polling"}
          >
            {paused ? <Play size={11} /> : <Pause size={11} />}
          </button>
          <button
            onClick={dismiss}
            className="w-6 h-6 rounded-md hover:bg-white/10 text-white/60 hover:text-white flex items-center justify-center transition"
            title="Hide feed (reopen with the Live chip)"
          >
            <X size={13} />
          </button>
        </div>

        {/* Entries */}
        <div className="max-h-[420px] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-white/40">
              No activity yet. Your agent's actions will appear here the moment they happen.
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {entries.slice(0, 10).map((a) => {
                const meta = CATEGORY_META[a.category] ?? CATEGORY_META.system;
                const Icon = meta.icon;
                const route = routeForActivity(a);
                const isNew = a.id === newestId;
                const Wrapper = route ? "button" : "div";
                return (
                  <Wrapper
                    key={a.id}
                    onClick={route ? () => navigate(route) : undefined}
                    className={`w-full text-left flex items-start gap-3 px-4 py-2.5 transition-colors ${
                      route ? "hover:bg-white/[0.03] cursor-pointer" : ""
                    } ${isNew ? "animate-feed-flash" : ""}`}
                  >
                    <div
                      className={`shrink-0 w-7 h-7 rounded-lg ${meta.bg} border ${meta.border} flex items-center justify-center ${meta.color}`}
                    >
                      <Icon size={13} strokeWidth={2.2} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-[9px] font-mono font-bold tracking-wider uppercase ${meta.color}`}
                        >
                          {a.category}
                        </span>
                        <span className="text-[10px] text-white/40 font-mono">{timeAgo(a.created_at)}</span>
                      </div>
                      <p className="text-xs text-white/85 leading-snug mt-0.5 line-clamp-2">{a.summary}</p>
                    </div>
                  </Wrapper>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-white/[0.06] text-[10px] text-white/35 font-mono text-center">
          {paused
            ? "Paused — click play to resume"
            : isActive
            ? "Polling every 1.5s"
            : "Polling every 4s · active mode when agents work"}
        </div>
      </div>
    </div>
  );
}
