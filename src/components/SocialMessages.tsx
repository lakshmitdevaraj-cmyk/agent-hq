import { useEffect, useRef, useState } from "react";
import { call, callBackground } from "@/lib/api";
import { shortDate, type LeadInfo } from "@/lib/leadInfo";
import type { Touch, TouchSummary } from "@/lib/prospects";

type Part = { key: string; label: string; text: string };
type SocialRow = {
  id: string;
  campaign_id: string;
  lead_id: string;
  channel: "facebook" | "instagram" | "linkedin";
  url: string;
  parts: Part[];
  status: "drafted" | "sent";
  review_status: "ready" | "check" | "blocked" | null;
  review_reasons: string[];
  sent_at?: string | null;
  type?: "first" | "follow_up_email" | "follow_up_channel";
};
type TouchState = { touches: Touch[]; summary: TouchSummary; touch_id?: string };

type LeadRef = LeadInfo & { id: string; campaign_id?: string | null; email?: string | null };

const LABEL: Record<string, string> = { email: "Email", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
const STATUS_TEXT: Record<string, string> = { ready: "Ready", check: "Check this", blocked: "Blocked" };
const STATUS_CLASS: Record<string, string> = {
  ready: "border-green-500/40 text-green-300 bg-green-500/10",
  check: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  blocked: "border-red-500/40 text-red-300 bg-red-500/10",
};
const TYPE_TEXT: Record<string, string> = { first: "First message", follow_up_email: "Follow-up (mentions your email)", follow_up_channel: "Follow-up" };

const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;
const today = () => new Date().toISOString().slice(0, 10);
const btn = "px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/15 text-[11px] text-white/80 disabled:opacity-50";

function pagesFor(lead: LeadRef): Array<{ channel: SocialRow["channel"]; url: string }> {
  const so = lead.social ?? {};
  const out: Array<{ channel: SocialRow["channel"]; url: string }> = [];
  if (so.facebook) out.push({ channel: "facebook", url: so.facebook });
  if (so.instagram) out.push({ channel: "instagram", url: so.instagram });
  const li = so.linkedin_person || so.linkedin_company;
  if (li) out.push({ channel: "linkedin", url: li });
  return out;
}

/** Every touch on the lead: date, channel, first or follow-up, source, and the text (long text opens on click). */
export function TouchTimeline({ touches, order, onDelete }: { touches: Touch[]; order: "newest" | "oldest"; onDelete?: (t: Touch) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = [...touches].sort((a, b) => (order === "newest" ? b.sent_at.localeCompare(a.sent_at) : a.sent_at.localeCompare(b.sent_at)));
  if (list.length === 0) return <p className="text-[11px] text-white/45">Nothing sent to this lead yet.</p>;
  return (
    <ol className="space-y-1.5" aria-label="Contact history">
      {list.map((t) => (
        <li key={t.id} className="rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-[11px] min-w-0">
          <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
            <span className="font-mono text-white/80">{shortDate(t.sent_at)}</span>
            <span className="font-bold text-white">{LABEL[t.channel]}</span>
            <span className="text-white/60">{t.kind === "first" ? "first message" : "follow-up"}</span>
            <span className="text-white/40">{t.source === "manual" ? "recorded by hand" : "written in HQ"}</span>
            <div className="flex-1" />
            {t.text && <button onClick={() => setOpen(open === t.id ? null : t.id)} className="text-primary hover:underline">{open === t.id ? "Hide text" : "Show text"}</button>}
            {onDelete && t.source === "manual" && <button onClick={() => onDelete(t)} className="text-red-300/80 hover:underline">Remove</button>}
          </div>
          {t.subject && <div className="text-white/60 truncate" title={t.subject}>Subject: {t.subject}</div>}
          {t.text && open !== t.id && <div className="text-white/55 truncate" title={t.text}>{t.text.replace(/\s+/g, " ")}</div>}
          {t.text && open === t.id && <p className="whitespace-pre-wrap text-white/85 leading-relaxed mt-1 break-words">{t.text}</p>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Social messages and contact history for one lead. The next message to send comes first, the history under it.
 * Copy, open their page, mark as sent on a date (earlier dates allowed) and undo; or record a message sent by hand.
 * The app never posts or opens a conversation itself. Used in the Prospects panel and the campaign lead pop-up.
 */
export function SocialMessages({ lead, emailedOn, busy, jobSeq, onWrite, onChanged, order = "newest" }: { lead: LeadRef; emailedOn?: string | null; busy?: boolean; jobSeq?: string; onWrite?: (regenerate: boolean) => void; onChanged?: (state: { summary: TouchSummary; social_drafts: Array<{ channel: string; review_status: string | null; type: string }> }) => void; order?: "newest" | "oldest" }) {
  const [rows, setRows] = useState<SocialRow[]>([]);
  const [state, setState] = useState<TouchState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sentOn, setSentOn] = useState<Record<string, string>>({});
  const [last, setLast] = useState<{ channel: string; touch_id: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [type, setType] = useState<"first" | "follow_up_email">("first");
  const [hand, setHand] = useState<{ channel: string; text: string; date: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pages = pagesFor(lead);
  const campaignId = lead.campaign_id;

  async function load() {
    if (!campaignId) return;
    try {
      const [r, t] = await Promise.all([
        call<SocialRow[]>("outreach.social.list", { campaign_id: campaignId, lead_id: lead.id }),
        call<TouchState>("outreach.lead.touches", { campaign_id: campaignId, lead_id: lead.id }),
      ]);
      setRows(r);
      setState(t);
      return { rows: r, state: t };
    } catch { /* leave what we have */ }
  }
  function tell(r: SocialRow[], s: TouchState) { onChanged?.({ summary: s.summary, social_drafts: r.filter((x) => x.status === "drafted").map((x) => ({ channel: x.channel, review_status: x.review_status, type: x.type ?? "first" })) }); }
  useEffect(() => { setRows([]); setState(null); setErr(null); setEditing(null); setHand(null); setLast(null); void load(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [lead.id, campaignId, jobSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const byChannel = new Map(rows.map((r) => [r.channel, r]));
  const sentChannels = new Set((state?.touches ?? []).map((t) => t.channel));
  const checked = !!lead.site_check?.checked_at && !lead.site_check?.error;
  const hasFb = !!lead.social?.facebook;
  const canMentionEmail = (state?.summary.counts.email ?? 0) > 0 || !!emailedOn;

  async function refreshAfter() { const x = await load(); if (x) tell(x.rows, x.state); }

  async function write(regenerate: boolean, o: { channel?: string; manual?: boolean } = {}) {
    if (!campaignId) return;
    if (onWrite && !o.channel && !o.manual && type === "first") { onWrite(regenerate); return; }
    setErr(null);
    setWriting(true);
    try {
      const r = await call<{ total: number; params: Record<string, unknown> }>("outreach.social.write", { campaign_id: campaignId, lead_ids: [lead.id], ...(o.channel ? { channels: [o.channel] } : {}), ...(regenerate ? { regenerate: true } : {}), ...(type !== "first" ? { type } : {}), ...(o.manual ? { manual_start: true } : {}) });
      await callBackground("social", r.params);
      const poll = async () => {
        try {
          const c = await call<{ job?: { kind?: string; status?: string; message?: string } }>("outreach.campaign.get", { id: campaignId });
          if (c.job?.kind === "social" && c.job.status === "running") { timer.current = setTimeout(() => void poll(), 3000); return; }
          if (c.job?.kind === "social" && (c.job.status === "stopped" || c.job.status === "paused") && c.job.message) setErr(c.job.message);
        } catch { /* try once more below */ }
        setWriting(false);
        await refreshAfter();
      };
      timer.current = setTimeout(() => void poll(), 2500);
    } catch (e) {
      setWriting(false);
      setErr(e instanceof Error ? e.message : "Could not start writing");
    }
  }

  async function copy(r: SocialRow, p: Part) {
    try { await navigator.clipboard.writeText(p.text); setCopied(`${r.channel}-${p.key}`); setTimeout(() => setCopied(null), 1500); } catch { setErr("Could not copy. Select the text and copy it by hand."); }
  }
  async function markSent(r: SocialRow) {
    setBusyKey(`sent-${r.channel}`);
    try {
      const res = await call<TouchState>("outreach.social.mark_sent", { campaign_id: r.campaign_id, lead_id: r.lead_id, channel: r.channel, sent_on: sentOn[r.channel] || today() });
      setLast(res.touch_id ? { channel: r.channel, touch_id: res.touch_id } : null);
      setState(res);
      const rr = await call<SocialRow[]>("outreach.social.list", { campaign_id: r.campaign_id, lead_id: r.lead_id });
      setRows(rr);
      tell(rr, res);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusyKey(null); }
  }
  async function undo(channel: string, touchId?: string) {
    if (!campaignId) return;
    setBusyKey(`undo-${channel}`);
    try {
      await call("outreach.social.mark_sent", { campaign_id: campaignId, lead_id: lead.id, channel, sent: false, ...(touchId ? { touch_id: touchId } : {}) });
      setLast(null);
      await refreshAfter();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not undo"); } finally { setBusyKey(null); }
  }
  async function saveEdit(r: SocialRow) {
    try {
      const parts = Object.fromEntries(r.parts.map((p) => [p.key, draft[`${r.channel}-${p.key}`] ?? p.text]));
      await call("outreach.social.update", { campaign_id: r.campaign_id, lead_id: r.lead_id, channel: r.channel, parts });
      setEditing(null);
      setDraft({});
      await refreshAfter();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); }
  }
  async function saveHand() {
    if (!hand || !campaignId) return;
    setBusyKey("hand");
    try {
      const res = await call<TouchState>("outreach.social.record_hand", { campaign_id: campaignId, lead_id: lead.id, channel: hand.channel, text: hand.text, sent_on: hand.date });
      setState(res);
      setHand(null);
      setErr(null);
      onChanged?.({ summary: res.summary, social_drafts: rows.filter((x) => x.status === "drafted").map((x) => ({ channel: x.channel, review_status: x.review_status, type: x.type ?? "first" })) });
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusyKey(null); }
  }
  async function removeTouch(t: Touch) {
    if (!confirm("Remove this recorded message from the history?")) return;
    try {
      const res = await call<TouchState>("outreach.touch.delete", { lead_id: lead.id, touch_id: t.id });
      if (res.touches) setState(res);
      await refreshAfter();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not remove"); }
  }

  const drafts = rows.filter((r) => r.status === "drafted" || r.status === "sent");
  const writingNow = writing || !!busy;
  const handChannels = ["email", ...pages.map((p) => p.channel)];
  if (pages.length === 0 && (state?.touches.length ?? 0) === 0 && !hand) {
    return (
      <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 space-y-2" data-testid="social-section">
        <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Social messages and contact history</p>
        <p className="text-[11px] text-white/45">No Facebook, Instagram or LinkedIn page is saved for this lead.</p>
        <button className={btn} onClick={() => setHand({ channel: "email", text: "", date: today() })}>Record a message sent by hand</button>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 space-y-3" data-testid="social-section">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Social messages</p>
        {(emailedOn || (state?.summary.counts.email ?? 0) > 0) && <span className="text-[11px] text-green-300/80">Emailed{emailedOn ? ` on ${shortDate(emailedOn)}` : ""}</span>}
        <div className="flex-1" />
        {pages.length > 0 && (
          <>
            {canMentionEmail && (
              <select value={type} onChange={(e) => setType(e.target.value as "first" | "follow_up_email")} aria-label="Message type" className="bg-black/30 border border-white/15 rounded-md px-2 py-1 text-[11px] text-white">
                <option value="first">First message</option>
                <option value="follow_up_email">Follow-up (mention my email)</option>
              </select>
            )}
            <button onClick={() => void write(rows.some((r) => r.status === "drafted"))} disabled={writingNow} className="px-2.5 py-1 rounded-md bg-purple/20 border border-purple/40 text-purple text-[11px] font-bold disabled:opacity-50">
              {writingNow ? "Writing…" : rows.some((r) => r.status === "drafted") ? "Rewrite" : sentChannels.size > 0 && pages.some((p) => sentChannels.has(p.channel)) ? "Write a follow-up" : "Write social messages"}
            </button>
          </>
        )}
      </div>
      {pages.length > 0 && !checked && hasFb && (
        <p className="text-[11px] text-amber-200/90">
          The website check is not finished, so HQ will not write for this lead on its own.{" "}
          <button className="underline" disabled={writingNow} onClick={() => void write(false, { channel: "facebook", manual: true })}>Write a Facebook first message anyway</button>
          {" "}(you start it by hand; it is checked like any other message).
        </p>
      )}
      {drafts.length === 0 && pages.length > 0 && <p className="text-[11px] text-white/45">No message is waiting to be sent. If this lead is skipped you will see why when you write.</p>}
      {pages.map(({ channel, url }) => {
        const r = byChannel.get(channel);
        if (!r) return null;
        return (
          <div key={channel} className="rounded-md border border-white/10 bg-black/20 p-2.5 space-y-2 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-white">{LABEL[channel]}</span>
              <span className="px-1.5 py-0.5 rounded-md border border-white/15 text-[10px] text-white/70">{TYPE_TEXT[r.type ?? "first"]}</span>
              {r.review_status ? <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${STATUS_CLASS[r.review_status]}`}>{STATUS_TEXT[r.review_status]}</span> : <span className="px-1.5 py-0.5 rounded-md border border-white/15 text-[10px] font-mono text-white/50">Not reviewed yet</span>}
              {r.status === "sent" && r.sent_at && <span className="px-1.5 py-0.5 rounded-md border border-green-500/40 bg-green-500/10 text-green-300 text-[10px] font-mono">Sent on {shortDate(r.sent_at)}</span>}
            </div>
            {r.parts.map((p) => {
              const k = `${channel}-${p.key}`;
              const text = draft[k] ?? p.text;
              return (
                <div key={k}>
                  <div className="flex items-center gap-2 text-[10px] text-white/45 mb-0.5">
                    <span>{p.label}</span>
                    <span>{p.key === "note" ? `${text.length}/200 characters` : `${wordCount(text)} words`}</span>
                  </div>
                  {editing === channel ? (
                    <textarea value={text} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} rows={p.key === "note" ? 3 : 6} className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-xs text-white" />
                  ) : (
                    <p className="whitespace-pre-wrap text-xs text-white/85 leading-relaxed break-words">{p.text}</p>
                  )}
                  {editing !== channel && <button onClick={() => void copy(r, p)} className="mt-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] text-white/80">{copied === k ? "Copied" : `Copy ${p.label.toLowerCase()}`}</button>}
                </div>
              );
            })}
            {r.review_reasons.length > 0 && r.review_status !== "ready" && <ul className="text-[11px] text-amber-200/90 list-disc pl-4">{r.review_reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            <div className="flex items-center gap-2 flex-wrap">
              <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>Open their page</a>
              {r.status === "sent" ? (
                <button onClick={() => void undo(channel)} disabled={busyKey === `undo-${channel}`} className={btn}>Undo "sent"</button>
              ) : (
                <>
                  <input type="date" max={today()} value={sentOn[channel] ?? today()} onChange={(e) => setSentOn((s) => ({ ...s, [channel]: e.target.value }))} aria-label={`Date sent on ${LABEL[channel]}`} className="bg-black/30 border border-white/15 rounded-md px-1.5 py-1 text-[11px] text-white" />
                  <button onClick={() => void markSent(r)} disabled={busyKey === `sent-${channel}`} className="px-2 py-1 rounded-md bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 text-[11px] text-green-200 disabled:opacity-50">Mark as sent on {LABEL[channel]}</button>
                </>
              )}
              {editing === channel ? (
                <>
                  <button onClick={() => void saveEdit(r)} className="px-2 py-1 rounded-md bg-primary/20 border border-primary/40 text-primary text-[11px] font-bold">Save</button>
                  <button onClick={() => { setEditing(null); setDraft({}); }} className={btn}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setEditing(channel)} className={btn}>Edit</button>
              )}
            </div>
          </div>
        );
      })}
      {last && (
        <p className="text-[11px] text-green-300/90">
          Marked as sent on {LABEL[last.channel]}. <button className="underline" disabled={busyKey === `undo-${last.channel}`} onClick={() => void undo(last.channel, last.touch_id)}>Undo</button>
        </p>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Contact history{order === "newest" ? " (newest first)" : " (oldest first)"}</p>
          <div className="flex-1" />
          {!hand && <button className={btn} onClick={() => setHand({ channel: handChannels.includes("facebook") ? "facebook" : "email", text: "", date: today() })}>Record a message sent by hand</button>}
        </div>
        {hand && (
          <div className="rounded-md border border-white/15 bg-black/30 p-2.5 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <select value={hand.channel} onChange={(e) => setHand({ ...hand, channel: e.target.value })} aria-label="Channel" className="bg-black/30 border border-white/15 rounded-md px-2 py-1 text-[11px] text-white">
                {["email", "facebook", "instagram", "linkedin"].map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
              </select>
              <input type="date" max={today()} value={hand.date} onChange={(e) => setHand({ ...hand, date: e.target.value })} aria-label="Date sent" className="bg-black/30 border border-white/15 rounded-md px-1.5 py-1 text-[11px] text-white" />
            </div>
            <textarea value={hand.text} onChange={(e) => setHand({ ...hand, text: e.target.value })} rows={4} placeholder="Paste or type what you sent" className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-xs text-white" />
            <div className="flex items-center gap-2">
              <button onClick={() => void saveHand()} disabled={busyKey === "hand" || !hand.text.trim()} className="px-2 py-1 rounded-md bg-primary/20 border border-primary/40 text-primary text-[11px] font-bold disabled:opacity-50">Save to history</button>
              <button onClick={() => setHand(null)} className={btn}>Cancel</button>
            </div>
          </div>
        )}
        <TouchTimeline touches={state?.touches ?? []} order={order} onDelete={(t) => void removeTouch(t)} />
      </div>
      {err && <p className="text-[11px] text-red-300 break-words">{err}</p>}
    </div>
  );
}
