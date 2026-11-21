import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import { shortDate, type LeadInfo } from "@/lib/leadInfo";

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
};

type LeadRef = LeadInfo & { id: string; campaign_id?: string | null; email?: string | null };

const LABEL: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
const STATUS_TEXT: Record<string, string> = { ready: "Ready", check: "Check this", blocked: "Blocked" };
const STATUS_CLASS: Record<string, string> = {
  ready: "border-green-500/40 text-green-300 bg-green-500/10",
  check: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  blocked: "border-red-500/40 text-red-300 bg-red-500/10",
};

const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;

function pagesFor(lead: LeadRef): Array<{ channel: SocialRow["channel"]; url: string }> {
  const so = lead.social ?? {};
  const out: Array<{ channel: SocialRow["channel"]; url: string }> = [];
  if (so.facebook) out.push({ channel: "facebook", url: so.facebook });
  if (so.instagram) out.push({ channel: "instagram", url: so.instagram });
  const li = so.linkedin_person || so.linkedin_company;
  if (li) out.push({ channel: "linkedin", url: li });
  return out;
}

/** Social messages for one lead: copy, open their page, and mark as sent by hand. The app never posts or opens a conversation itself. */
export function SocialMessages({ lead, emailedOn, busy, jobSeq, onWrite }: { lead: LeadRef; emailedOn: string | null; busy: boolean; jobSeq: string; onWrite: (regenerate: boolean) => void }) {
  const [rows, setRows] = useState<SocialRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const pages = pagesFor(lead);

  async function load() {
    if (!lead.campaign_id) return;
    try {
      setRows(await call<SocialRow[]>("outreach.social.list", { campaign_id: lead.campaign_id, lead_id: lead.id }));
    } catch { /* leave what we have */ }
  }
  // Reload when the lead changes and whenever the social job moves (the modal stays open while it runs).
  useEffect(() => { void load(); }, [lead.id, lead.campaign_id, jobSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pages.length === 0) return null;
  const byChannel = new Map(rows.map((r) => [r.channel, r]));

  async function copy(r: SocialRow, p: Part) {
    try { await navigator.clipboard.writeText(p.text); setCopied(`${r.channel}-${p.key}`); setTimeout(() => setCopied(null), 1500); } catch { setErr("Could not copy. Select the text and copy it by hand."); }
  }
  async function markSent(r: SocialRow, sent: boolean) {
    try { await call("outreach.social.mark_sent", { campaign_id: r.campaign_id, lead_id: r.lead_id, channel: r.channel, sent }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); }
  }
  async function saveEdit(r: SocialRow) {
    try {
      const parts = Object.fromEntries(r.parts.map((p) => [p.key, draft[`${r.channel}-${p.key}`] ?? p.text]));
      await call("outreach.social.update", { campaign_id: r.campaign_id, lead_id: r.lead_id, channel: r.channel, parts });
      setEditing(null);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); }
  }

  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Social messages</p>
        {emailedOn && <span className="text-[11px] text-green-300/80">Emailed on {shortDate(emailedOn)}</span>}
        <div className="flex-1" />
        <button
          onClick={() => onWrite(rows.some((r) => r.status === "drafted"))}
          disabled={busy}
          className="px-2.5 py-1 rounded-md bg-purple/20 border border-purple/40 text-purple text-[11px] font-bold disabled:opacity-50"
        >
          {busy ? "Writing…" : rows.length > 0 ? "Rewrite" : "Write social messages"}
        </button>
      </div>
      {rows.length === 0 && <p className="text-[11px] text-white/45">None written yet. They follow the same skip rules as emails; if this lead is skipped you will see why.</p>}
      {pages.map(({ channel, url }) => {
        const r = byChannel.get(channel);
        if (!r) return null;
        return (
          <div key={channel} className="rounded-md border border-white/10 bg-black/20 p-2.5 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-white">{LABEL[channel]}</span>
              {r.review_status ? <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${STATUS_CLASS[r.review_status]}`}>{STATUS_TEXT[r.review_status]}</span> : <span className="px-1.5 py-0.5 rounded-md border border-white/15 text-[10px] font-mono text-white/50">Not reviewed yet</span>}
              {r.status === "sent" && r.sent_at && <span className="px-1.5 py-0.5 rounded-md border border-green-500/40 bg-green-500/10 text-green-300 text-[10px] font-mono">Sent on {shortDate(r.sent_at)}</span>}
              {emailedOn && <span className="text-[10px] text-green-300/70">Emailed on {shortDate(emailedOn)}</span>}
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
                    <p className="whitespace-pre-wrap text-xs text-white/85 leading-relaxed">{p.text}</p>
                  )}
                  {editing !== channel && <button onClick={() => void copy(r, p)} className="mt-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] text-white/80">{copied === k ? "Copied" : `Copy ${p.label.toLowerCase()}`}</button>}
                </div>
              );
            })}
            {r.review_reasons.length > 0 && r.review_status !== "ready" && <ul className="text-[11px] text-amber-200/90 list-disc pl-4">{r.review_reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            <div className="flex items-center gap-2 flex-wrap">
              <a href={url} target="_blank" rel="noopener noreferrer" className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/15 text-[11px] text-white/85">Open their page</a>
              {r.status === "sent" ? (
                <button onClick={() => void markSent(r, false)} className="px-2 py-1 rounded-md bg-white/5 border border-white/15 text-[11px] text-white/70">Undo "sent"</button>
              ) : (
                <button onClick={() => void markSent(r, true)} className="px-2 py-1 rounded-md bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 text-[11px] text-green-200">Mark as sent on {LABEL[channel]}</button>
              )}
              {editing === channel ? (
                <>
                  <button onClick={() => void saveEdit(r)} className="px-2 py-1 rounded-md bg-primary/20 border border-primary/40 text-primary text-[11px] font-bold">Save</button>
                  <button onClick={() => { setEditing(null); setDraft({}); }} className="px-2 py-1 rounded-md bg-white/5 border border-white/15 text-[11px] text-white/70">Cancel</button>
                </>
              ) : (
                <button onClick={() => setEditing(channel)} className="px-2 py-1 rounded-md bg-white/5 border border-white/15 text-[11px] text-white/70">Edit</button>
              )}
            </div>
          </div>
        );
      })}
      {err && <p className="text-[11px] text-red-300">{err}</p>}
    </div>
  );
}
