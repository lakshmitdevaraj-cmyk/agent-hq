import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, AlertCircle, CalendarClock } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import { call } from "@/lib/api";
import { sendTodayText } from "@/lib/sendToday";

// Follow-ups: what is due next for every lead, by channel. Nothing here sends by itself: emails go out only when you press Send and confirm,
// and social messages are copied and sent by hand, then marked as sent.

export type FollowRow = {
  lead_id: string; campaign_id: string; campaign_name: string; name: string; channel: "email" | "facebook" | "instagram" | "linkedin";
  step_key: string; step_label: string; position: number; due_date: string | null; bucket: "overdue" | "today" | "week" | "later" | "waiting" | "stopped"; days_late: number;
  last_sent_at: string | null; text: string; review_status?: "ready" | "check" | "blocked" | null; email_id?: string; note?: string; moved: boolean;
  by_hand?: boolean; stopped_reason?: string; waiting_text?: string; withdraw_prompt?: boolean; can_mark: boolean; page_url: string | null;
};
type Listing = { today: string; rows: FollowRow[]; counts: { email: number; social: number; total: number; week: number }; postal_address_set: boolean };

const STOP_TEXT: Record<string, string> = { replied: "Stopped: replied", opt_out: "Stopped: asked us to stop", do_not_contact: "Stopped: do not contact" };
const CH: Record<string, string> = { email: "Email", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
const STATUS_TEXT: Record<string, string> = { ready: "Ready", check: "Check this", blocked: "Blocked" };
const STATUS_CLASS: Record<string, string> = {
  ready: "border-green-500/40 text-green-300 bg-green-500/10",
  check: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  blocked: "border-red-500/40 text-red-300 bg-red-500/10",
};
const btn = "px-2 py-1 rounded-md bg-fg/[0.05] hover:bg-fg/[0.1] border border-line text-label text-fg2 disabled:opacity-50";
const shortDate = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const rowKey = (r: FollowRow) => `${r.lead_id}/${r.channel}/${r.step_key}`;

// Kept while you move between pages (the tab, the toggle, your ticks and how far you had scrolled).
const kept: { tab: "email" | "social"; scope: "due" | "week"; ticked: Set<string>; scroll: number } = (() => {
  try { const s = JSON.parse(sessionStorage.getItem("followups-state") ?? "null"); if (s) return { tab: s.tab === "social" ? "social" : "email", scope: s.scope === "week" ? "week" : "due", ticked: new Set<string>(s.ticked ?? []), scroll: Number(s.scroll) || 0 }; } catch { /* no saved state */ }
  return { tab: "email", scope: "due", ticked: new Set<string>(), scroll: 0 };
})();
const persist = () => { try { sessionStorage.setItem("followups-state", JSON.stringify({ tab: kept.tab, scope: kept.scope, ticked: [...kept.ticked], scroll: kept.scroll })); } catch { /* fine without it */ } };

export default function FollowUps() {
  const [data, setData] = useState<Listing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTabS] = useState(kept.tab);
  const [scope, setScopeS] = useState(kept.scope);
  const [ticked, setTicked] = useState<Set<string>>(new Set(kept.ticked));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sentOn, setSentOn] = useState<string>("");
  const [moveFor, setMoveFor] = useState<{ key: string; date: string } | null>(null);
  const [skipFor, setSkipFor] = useState<{ key: string; note: string } | null>(null);
  const loaded = useRef(false);

  const setTab = (t: "email" | "social") => { kept.tab = t; persist(); setTabS(t); };
  const setScope = (s: "due" | "week") => { kept.scope = s; persist(); setScopeS(s); };
  const setTick = (next: Set<string>) => { kept.ticked = next; persist(); setTicked(next); };

  async function load() {
    try {
      const d = await call<Listing>("followups.list");
      setData(d);
      if (!sentOn) setSentOn(d.today);
      setErr(null);
      if (!loaded.current) { loaded.current = true; setTimeout(() => window.scrollTo(0, kept.scroll), 0); }
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not load"); }
  }
  useEffect(() => { void load(); const onScroll = () => { kept.scroll = window.scrollY; }; window.addEventListener("scroll", onScroll); return () => { window.removeEventListener("scroll", onScroll); persist(); }; }, []);

  const rows = useMemo(() => {
    const all = (data?.rows ?? []).filter((r) => (tab === "email" ? r.channel === "email" : r.channel !== "email"));
    const live = all.filter((r) => r.bucket !== "stopped" && r.bucket !== "waiting");
    return {
      shown: live.filter((r) => (scope === "due" ? r.bucket === "overdue" || r.bucket === "today" : r.bucket === "week")),
      waiting: all.filter((r) => r.bucket === "waiting"),
      stopped: all.filter((r) => r.bucket === "stopped"),
      dueCount: live.filter((r) => r.bucket === "overdue" || r.bucket === "today").length,
      weekCount: live.filter((r) => r.bucket === "week").length,
    };
  }, [data, tab, scope]);
  const tabCount = (t: "email" | "social") => (data?.rows ?? []).filter((r) => (t === "email" ? r.channel === "email" : r.channel !== "email") && (r.bucket === "overdue" || r.bucket === "today")).length;

  const toggle = (k: string) => { const n = new Set(ticked); if (n.has(k)) n.delete(k); else n.add(k); setTick(n); };
  const pickedRows = rows.shown.filter((r) => ticked.has(rowKey(r)));

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setErr(null); setMsg(null);
    try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(null); }
  }
  const copy = (r: FollowRow) => { try { void navigator.clipboard.writeText(r.text); setMsg(`Copied the ${r.step_label.toLowerCase()} for ${r.name}.`); } catch { setErr("Could not copy. Select the text and copy it by hand."); } };

  async function sendEmails() {
    const sendable = pickedRows.filter((r) => r.channel === "email" && r.email_id && r.review_status === "ready");
    if (sendable.length === 0) return;
    const list = sendable.map((r) => `${r.name}: email ${r.position}`).join("\n");
    const warn = data && !data.postal_address_set ? "\n\nNo postal address in the footer. US law (CAN-SPAM) requires one for commercial email." : "";
    if (!confirm(`Send ${sendable.length} follow-up email${sendable.length === 1 ? "" : "s"} via AgentMail? Each goes as a reply in the same thread as the email before it, and this will hit real recipients' inboxes.\n\n${list}${warn}${await sendTodayText(sendable.length)}`)) return;
    await act("send", async () => {
      const byCampaign = new Map<string, string[]>();
      for (const r of sendable) byCampaign.set(r.campaign_id, [...(byCampaign.get(r.campaign_id) ?? []), r.email_id!]);
      let sent = 0, problems = 0;
      for (const [cid, ids] of byCampaign) {
        const res = await call<{ sent: number; errors: unknown[] }>("outreach.emails.send", { campaign_id: cid, email_ids: ids, limit: ids.length });
        sent += res.sent; problems += res.errors?.length ?? 0;
      }
      setTick(new Set([...ticked].filter((k) => !sendable.some((r) => rowKey(r) === k))));
      setMsg(`Sent ${sent} email${sent === 1 ? "" : "s"}${problems ? `; ${problems} could not be sent (open the campaign to see why)` : ""}.`);
    });
  }
  const markSent = (r: FollowRow) => act(`sent-${rowKey(r)}`, () => call("outreach.social.mark_sent", { campaign_id: r.campaign_id, lead_id: r.lead_id, channel: r.channel, part: r.step_key, sent_on: sentOn || data?.today }));
  async function markMany() {
    const list = pickedRows.filter((r) => r.channel !== "email" && r.can_mark);
    if (list.length === 0) return;
    if (!confirm(`Mark ${list.length} message${list.length === 1 ? "" : "s"} as sent on ${sentOn || data?.today}? Do this only for messages you really sent by hand.`)) return;
    await act("bulk", async () => { for (const r of list) await call("outreach.social.mark_sent", { campaign_id: r.campaign_id, lead_id: r.lead_id, channel: r.channel, part: r.step_key, sent_on: sentOn || data?.today }); setTick(new Set([...ticked].filter((k) => !list.some((r) => rowKey(r) === k)))); });
  }
  const update = (r: FollowRow, op: string, value?: unknown) => call("followups.update", { lead_id: r.lead_id, channel: r.channel, step_key: r.step_key, op, value });
  async function saveEdit(r: FollowRow) {
    if (!edit || !r.email_id) return;
    await act("edit", async () => { await call("outreach.emails.update", { campaign_id: r.campaign_id, email_id: r.email_id, body_text: edit.text }); setEdit(null); });
  }

  const dueWord = (r: FollowRow) => (r.bucket === "overdue" ? `${r.step_label} was due ${shortDate(r.due_date)} (${r.days_late} day${r.days_late === 1 ? "" : "s"} late)` : r.bucket === "today" ? `${r.step_label} is due today` : `${r.step_label} is due ${shortDate(r.due_date)}`);

  return (
    <>
      <PageHeader title="Follow-ups" subtitle="What is due next for each lead. Nothing is sent on its own: you send or mark each one." />
      {err && <GlassCard className="mb-4 border-red-500/40 bg-red-500/10"><div className="flex items-center gap-3 text-red-200 text-sm"><AlertCircle size={16} />{err}</div></GlassCard>}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {(["email", "social"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-lg border text-sm font-semibold ${tab === t ? "bg-primary/20 border-primary/50 text-primary" : "bg-fg/[0.04] border-line text-fg2"}`}>
            {t === "email" ? "Email" : "Social"} ({tabCount(t)})
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold">
          <button onClick={() => setScope("due")} className={`px-3 py-1.5 ${scope === "due" ? "bg-primary/20 text-primary" : "text-fg2"}`}>Due today and overdue ({rows.dueCount})</button>
          <button onClick={() => setScope("week")} className={`px-3 py-1.5 border-l border-line ${scope === "week" ? "bg-primary/20 text-primary" : "text-fg2"}`}>This week ({rows.weekCount})</button>
        </div>
        <button onClick={() => void load()} className={btn} aria-label="Refresh"><RefreshCw size={12} className="inline mr-1" />Refresh</button>
      </div>
      {msg && <p className="text-sm text-green-300 mb-2">{msg}</p>}

      {tab === "email" && pickedRows.length > 0 && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-fg2">{pickedRows.length} ticked ({pickedRows.filter((r) => r.review_status === "ready").length} Ready)</span>
          <button onClick={() => void sendEmails()} disabled={busy === "send" || !pickedRows.some((r) => r.review_status === "ready")} className="px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/50 text-primary text-xs font-bold disabled:opacity-50">{busy === "send" ? "Sending…" : "Send the Ready ones"}</button>
          <span className="text-label text-muted">Only emails marked Ready can be sent from here. Check this and Blocked ones are opened from their campaign.</span>
        </div>
      )}
      {tab === "social" && (
        <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
          <label className="text-label text-muted">Date sent</label>
          <input type="date" max={data?.today} value={sentOn} onChange={(e) => setSentOn(e.target.value)} className="bg-inset border border-line rounded-md px-1.5 py-1 text-label text-fg" />
          {pickedRows.length > 0 && <button onClick={() => void markMany()} disabled={busy === "bulk"} className="px-3 py-1.5 rounded-lg bg-green-500/15 border border-green-500/40 text-green-200 text-xs font-bold disabled:opacity-50">Mark {pickedRows.length} ticked as sent</button>}
        </div>
      )}

      {!data && !err && <div className="text-muted text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
      {data && rows.shown.length === 0 && (
        <GlassCard className="text-center py-10">
          <CalendarClock size={26} className="mx-auto text-primary mb-2" />
          <p className="text-sm text-fg2">{scope === "due" ? "Nothing is due today or overdue." : "Nothing is due in the next 7 days."}</p>
        </GlassCard>
      )}

      <div className="space-y-3">
        {rows.shown.map((r) => {
          const k = rowKey(r);
          const full = open.has(k);
          const preview = full || r.text.length <= 180 ? r.text : `${r.text.slice(0, 180).trim()}…`;
          return (
            <GlassCard key={k} className="!p-4">
              <div className="flex items-start gap-3">
                <input type="checkbox" checked={ticked.has(k)} onChange={() => toggle(k)} aria-label={`Tick ${r.name}`} className="mt-1" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-fg">{r.name}</span>
                    <span className="text-label text-muted">{CH[r.channel]}</span>
                    <Link to={`/outreach/${r.campaign_id}`} className="text-label text-primary hover:underline">{r.campaign_name}</Link>
                    {r.review_status && <span className={`px-1.5 py-0.5 rounded-md border text-label font-mono ${STATUS_CLASS[r.review_status]}`}>{STATUS_TEXT[r.review_status]}</span>}
                    {r.moved && <span className="text-label text-muted">date moved</span>}
                  </div>
                  <p className={`text-sm ${r.bucket === "overdue" ? "text-amber-300" : "text-fg2"}`}>{dueWord(r)}{r.last_sent_at ? `. Last message sent ${shortDate(r.last_sent_at)}.` : "."}</p>
                  {r.note && <p className="text-label text-muted">Note: {r.note}</p>}
                  {edit?.key === k ? (
                    <div className="space-y-2">
                      <textarea value={edit.text} onChange={(e) => setEdit({ key: k, text: e.target.value })} rows={7} className="w-full bg-inset border border-line rounded-md px-2 py-1.5 text-sm text-fg" />
                      <div className="flex gap-2"><button className={btn} onClick={() => void saveEdit(r)}>Save</button><button className={btn} onClick={() => setEdit(null)}>Cancel</button></div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-fg2 leading-relaxed break-words">{preview}</p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    {r.text.length > 180 && <button className={btn} onClick={() => { const n = new Set(open); if (n.has(k)) n.delete(k); else n.add(k); setOpen(n); }}>{full ? "Show less" : "Show full"}</button>}
                    {r.channel === "email" ? (
                      <button className={btn} onClick={() => setEdit({ key: k, text: r.text })}>Edit</button>
                    ) : (
                      <>
                        <button className={btn} onClick={() => copy(r)}>Copy</button>
                        {r.page_url && <a className={btn} href={r.page_url} target="_blank" rel="noopener noreferrer">Open page</a>}
                        <button className={btn} disabled={busy === `sent-${k}`} onClick={() => void markSent(r)}>Mark as sent</button>
                      </>
                    )}
                    <button className={btn} onClick={() => setSkipFor({ key: k, note: "" })}>Skip</button>
                    <button className={btn} onClick={() => setMoveFor({ key: k, date: r.due_date ?? data?.today ?? "" })}>Move date</button>
                    <button className={btn} onClick={() => { if (confirm(`Mark ${r.name} as replied? Every later message to them, on every channel, stops.`)) void act("replied", () => call("followups.replied", { lead_id: r.lead_id })); }}>They replied</button>
                  </div>
                  {skipFor?.key === k && (
                    <div className="flex gap-2 items-center flex-wrap"><input value={skipFor.note} onChange={(e) => setSkipFor({ key: k, note: e.target.value })} placeholder="Why skip it? (optional note)" className="bg-inset border border-line rounded-md px-2 py-1 text-label text-fg flex-1 min-w-[12rem]" /><button className={btn} onClick={() => void act("skip", async () => { if (skipFor.note.trim()) await update(r, "note", skipFor.note.trim()); await update(r, "skip"); setSkipFor(null); })}>Skip this step</button><button className={btn} onClick={() => setSkipFor(null)}>Cancel</button></div>
                  )}
                  {moveFor?.key === k && (
                    <div className="flex gap-2 items-center"><input type="date" min={data?.today} value={moveFor.date} onChange={(e) => setMoveFor({ key: k, date: e.target.value })} className="bg-inset border border-line rounded-md px-1.5 py-1 text-label text-fg" /><button className={btn} onClick={() => void act("move", async () => { await update(r, "move", moveFor.date); setMoveFor(null); })}>Move to this date</button><button className={btn} onClick={() => setMoveFor(null)}>Cancel</button></div>
                  )}
                </div>
              </div>
            </GlassCard>
          );
        })}
      </div>

      {rows.waiting.length > 0 && (
        <div className="mt-6">
          <h3 className="font-display text-sm font-semibold text-fg mb-2">LinkedIn invitations waiting</h3>
          <div className="space-y-2">
            {rows.waiting.map((r) => (
              <GlassCard key={rowKey(r)} className="!p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-fg text-sm">{r.name}</span>
                  <span className="text-label text-muted flex-1 min-w-[14rem]">{r.waiting_text}</span>
                  <button className={btn} onClick={() => void act("acc", () => call("followups.linkedin", { lead_id: r.lead_id, op: "accepted" }))}>They accepted</button>
                  {r.withdraw_prompt && <button className={btn} onClick={() => { if (confirm("Withdraw this LinkedIn invitation yourself on LinkedIn, then press OK here to stop waiting.")) void act("wd", () => call("followups.linkedin", { lead_id: r.lead_id, op: "withdrawn" })); }}>I withdrew it</button>}
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      )}

      {rows.stopped.length > 0 && (
        <div className="mt-6">
          <h3 className="font-display text-sm font-semibold text-fg mb-2">Stopped ({rows.stopped.length})</h3>
          <div className="space-y-1">
            {rows.stopped.map((r) => (
              <div key={rowKey(r)} className="text-sm text-fg2 flex gap-2 flex-wrap items-center">
                <span className="font-medium text-fg">{r.name}</span><span className="text-label text-muted">{CH[r.channel]}</span>
                <span className="text-amber-300">{STOP_TEXT[r.stopped_reason ?? "replied"]}</span>
                {r.stopped_reason === "replied" && r.by_hand && <button className={btn} onClick={() => void act("undo", () => call("followups.replied", { lead_id: r.lead_id, undo: true }))}>Undo "replied"</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
