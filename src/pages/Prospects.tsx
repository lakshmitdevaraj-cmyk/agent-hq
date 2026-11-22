import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Loader2, X } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import { OwnerField, SiteDetails } from "@/components/SiteDetails";
import Drawer from "@/components/Drawer";
import ContactedCell from "@/components/ContactedCell";
import Modal from "@/components/Modal";
import { SocialMessages } from "@/components/SocialMessages";
import { call, callBackground } from "@/lib/api";
import { GapBadge, LinkIcons, leadLinks, reachAnotherWay, shortDate } from "@/lib/leadInfo";
import { FB_RESULT_LABEL, touchesText, HAS_OPTIONS, LOW_GAP, autoHidden, autoFlagLabel, isLeadGenFlagged, isNotFit, NOT_FIT_REASONS, REVIEW_LABEL, STATUS_LABEL, areaOf, contactedList, downloadCsv, fitLabels, hasChannel, prospectsToCsv, reasonLabel, type HasKey, type EmailState, type Prospect } from "@/lib/prospects";

const HIGH_GAP = 60;
const STATUS_TONE: Record<EmailState, string> = {
  not_emailed: "bg-fg/10 border-line text-fg2",
  emailed: "tag-warn",
  replied: "tag-ok",
  bounced: "tag-bad",
  do_not_contact: "tag-bad",
};

const selectCls = "bg-inset border border-line rounded-md px-2 py-1.5 text-xs text-fg";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "Edit email" in the detail panel: saved on the lead itself (source manual + date). Unsent drafts for the lead get the new To address. */
function EmailField({ lead, onSaved }: { lead: Prospect; onSaved: (patch: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function save(clear = false) {
    const v = clear ? "" : value.trim();
    if (!clear && !EMAIL_SHAPE.test(v)) { setErr("That does not look like an email address."); return; }
    if (!lead.campaign_id) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call<{ email: string | null; email_source: string; email_manual_at: string; drafts_updated: number; warning: string | null }>("outreach.lead.set_email", { campaign_id: lead.campaign_id, lead_id: lead.id, email: v });
      onSaved({ email: r.email, email_source: r.email_source, email_manual_at: r.email_manual_at });
      setNote([r.drafts_updated > 0 ? `${r.drafts_updated} unsent draft${r.drafts_updated === 1 ? "" : "s"} now go to this address.` : null, r.warning].filter(Boolean).join(" "));
      setEditing(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return (
    <div className="text-xs text-fg2 space-y-1">
      {editing ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <input autoFocus type="email" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} placeholder="name@company.com" className="flex-1 min-w-[180px] bg-inset border border-line rounded-md px-2 py-1.5 text-xs text-fg font-mono" />
          <button onClick={() => void save()} disabled={busy} className="px-2 py-1 rounded-md bg-primary/20 border border-primary/40 text-primary text-label font-bold disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
          {lead.email && <button onClick={() => { if (confirm("Remove this email address from the lead? Unsent drafts for it are removed too.")) void save(true); }} disabled={busy} className="px-2 py-1 rounded-md bg-red-500/10 border border-red-500/40 text-red-300 text-label disabled:opacity-50">Clear email</button>}
          <button onClick={() => { setEditing(false); setErr(null); }} className="px-2 py-1 rounded-md bg-fg/5 border border-line text-label text-fg2">Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span>Email: {lead.email ? <span className="font-mono">{lead.email}</span> : <span className="text-muted">none</span>}</span>
          {lead.email_source === "manual" && <span className="text-label text-muted">manual{lead.email_manual_at ? `, ${shortDate(lead.email_manual_at)}` : ""}</span>}
          <button onClick={() => { setValue(lead.email ?? ""); setEditing(true); setNote(null); }} disabled={!lead.campaign_id} className="px-1.5 py-0.5 rounded bg-fg/5 hover:bg-fg/10 border border-line text-label text-fg2">Edit email</button>
        </div>
      )}
      {lead.email_typo && lead.email && <p className="text-label text-amber-200">Possible typo: <span className="font-mono">{lead.email_typo.domain}</span> looks like <span className="font-mono">{lead.email_typo.suggestion}</span>. Check it; nothing was changed.</p>}
      {err && <p className="text-label text-red-300">{err}</p>}
      {note && <p className="text-label text-amber-200">{note}</p>}
    </div>
  );
}


/** "I looked at their Facebook page": when, what I found and a note. Shown for leads with a Facebook page. */
function FacebookChecked({ lead, onSaved }: { lead: Prospect; onSaved: (patch: Record<string, unknown>) => void }) {
  const [result, setResult] = useState<string>(lead.fb_checked?.result ?? "real");
  const [note, setNote] = useState(lead.fb_checked?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!lead.social?.facebook || !lead.campaign_id) return null;
  async function save(clear = false) {
    setBusy(true); setErr(null);
    try {
      const r = await call<{ fb_checked: Prospect["fb_checked"] }>("outreach.lead.fb_checked", { campaign_id: lead.campaign_id, lead_id: lead.id, result: clear ? null : result, note });
      onSaved({ fb_checked: r.fb_checked });
      if (clear) setNote("");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-lg bg-fg/[0.03] border border-line p-3 space-y-2" data-testid="fb-checked">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-label text-muted font-medium">Facebook checked</p>
        {lead.fb_checked ? <span className="text-label text-green-300">{FB_RESULT_LABEL[lead.fb_checked.result]} on {shortDate(lead.fb_checked.at)}</span> : <span className="text-label text-muted">not checked yet</span>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <select value={result} onChange={(e) => setResult(e.target.value)} aria-label="What I found" className={selectCls}>
          <option value="real">Real page</option>
          <option value="gone">Page gone</option>
          <option value="not_fit">Not a fit</option>
        </select>
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" aria-label="Note" className="flex-1 min-w-[140px] bg-inset border border-line rounded-md px-2 py-1.5 text-xs text-fg" />
        <button onClick={() => void save()} disabled={busy} className="px-2 py-1 rounded-md bg-primary/20 border border-primary/40 text-primary text-label font-bold disabled:opacity-50">{busy ? "Saving…" : lead.fb_checked ? "Update" : "Mark as checked"}</button>
        {lead.fb_checked && <button onClick={() => void save(true)} disabled={busy} className="px-2 py-1 rounded-md bg-fg/5 border border-line text-label text-fg2">Clear</button>}
      </div>
      {lead.fb_checked?.note && <p className="text-label text-muted break-words">Note: {lead.fb_checked.note}</p>}
      {err && <p className="text-label text-red-300">{err}</p>}
    </div>
  );
}

type BatchStatus = { status: string; finished_at?: string; total?: number; done?: number; made?: number; skipped?: number; message?: string; resume_at?: string; failures?: Array<{ name: string; error: string }> };
type SocialPlan = { total: number; by_channel: Record<string, number>; leads: number; skipped: number; skip_reasons: Record<string, number>; gemini_calls: { writing: number; reviewing: number; rough_total: number } };

export default function Prospects() {
  const [rows, setRows] = useState<Prospect[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTests, setShowTests] = useState(false);
  const [hasAny, setHasAny] = useState<HasKey[]>([]);
  const [reviewF, setReviewF] = useState("");
  const [reachOnly, setReachOnly] = useState(false);
  const [highGap, setHighGap] = useState(false);
  const [noReply, setNoReply] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [niche, setNiche] = useState("");
  const [area, setArea] = useState("");
  const [asc, setAsc] = useState(false);
  const [showNotFit, setShowNotFit] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [readyCh, setReadyCh] = useState("");
  const [notOn, setNotOn] = useState("");
  const [fbF, setFbF] = useState("");
  const [olderDays, setOlderDays] = useState("");
  const [emailedNoSocial, setEmailedNoSocial] = useState(false);
  const [leadGenF, setLeadGenF] = useState(false);
  // Leads with a follow-up due today or overdue (from the Follow-ups page's own read; the list never writes anything).
  const [dueIds, setDueIds] = useState<Set<string>>(new Set());
  const [dueF, setDueF] = useState(false);
  useEffect(() => { call<{ rows: Array<{ lead_id: string; bucket: string }> }>("followups.list").then((d) => setDueIds(new Set(d.rows.filter((x) => x.bucket === "overdue" || x.bucket === "today").map((x) => x.lead_id)))).catch(() => undefined); }, []);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [planFor, setPlanFor] = useState<{ plan: SocialPlan | null; rewrite: boolean; err: string | null; starting: boolean } | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    try {
      setRows(await call<Prospect[]>("outreach.prospects.list"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => { void load(); }, []);

  const base = useMemo(() => rows.filter((r) => showTests || !r.is_test), [rows, showTests]);
  const notFitCount = useMemo(() => base.filter((r) => isNotFit(r)).length, [base]);
  const campaigns = useMemo(() => [...new Map(base.filter((r) => r.campaign_id).map((r) => [r.campaign_id!, r.campaign_name ?? r.campaign_id!])).entries()], [base]);
  const niches = useMemo(() => [...new Set(base.map((r) => r.category).filter(Boolean) as string[])].sort(), [base]);
  const areas = useMemo(() => [...new Set(base.map((r) => areaOf(r.address)).filter(Boolean))].sort(), [base]);

  const shown = useMemo(() => {
    const f = base.filter((r) => {
      if (isNotFit(r) && !showNotFit) return false; // "Not a fit" leads are hidden until you ask for them
      if (hasAny.length > 0 && !hasAny.some((k) => hasChannel(r, k))) return false;
      if (reviewF && (r.review_status ?? "") !== reviewF) return false;
      if (reachOnly && !(!r.email && reachAnotherWay(r).length > 0)) return false;
      if (highGap && !((r.gap_score ?? -1) >= HIGH_GAP)) return false;
      if (noReply && r.email_status !== "emailed") return false;
      if (leadGenF && !isLeadGenFlagged(r)) return false;
      if (dueF && !dueIds.has(r.id)) return false;
      if (readyCh && !(r.social_drafts ?? []).some((d) => d.channel === readyCh)) return false;
      if (notOn && (r.touches?.counts[notOn as "email"] ?? 0) > 0) return false;
      if (emailedNoSocial && !((r.touches?.counts.email ?? 0) > 0 && !r.touches?.replied && (r.touches?.counts.facebook ?? 0) + (r.touches?.counts.instagram ?? 0) + (r.touches?.counts.linkedin ?? 0) === 0)) return false;
      if (olderDays && !(r.touches?.last_at && Date.now() - Date.parse(r.touches.last_at) > Number(olderDays) * 86_400_000)) return false;
      if (fbF === "none" ? !!r.fb_checked || !r.social?.facebook : fbF && r.fb_checked?.result !== fbF) return false;
      if (campaign && r.campaign_id !== campaign) return false;
      if (niche && r.category !== niche) return false;
      if (area && areaOf(r.address) !== area) return false;
      return true;
    });
    // Sort by gap score (unchecked leads last either way).
    return [...f].sort((a, b) => {
      const x = a.gap_score ?? null, y = b.gap_score ?? null;
      if (x === null && y === null) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return asc ? x - y : y - x;
    });
  }, [base, hasAny, reviewF, reachOnly, highGap, noReply, campaign, niche, area, asc, showNotFit, readyCh, notOn, emailedNoSocial, olderDays, fbF, leadGenF, dueF, dueIds]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const patchRow = (id: string, patch: Record<string, unknown>) => setRows((prev) => prev.map((r) => (r.id === id ? ({ ...r, ...patch } as Prospect) : r)));
  const [rowErr, setRowErr] = useState<string | null>(null);
  const pickedShown = shown.filter((r) => picked.has(r.id));
  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const togglePick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /** The banner for the cross-campaign writing run: read from the saved record, so it survives a reload. */
  const refreshBatch = useCallback(async () => {
    try {
      const b = await call<BatchStatus>("outreach.social.batch.status");
      setBatch(b);
      if (poll.current) clearTimeout(poll.current);
      if (b.status === "running") poll.current = setTimeout(() => void refreshBatch(), 3500);
      else if (b.status === "done") void load();
    } catch { /* keep the last banner */ }
  }, []);
  useEffect(() => { void refreshBatch(); return () => { if (poll.current) clearTimeout(poll.current); }; }, [refreshBatch]);

  const leadsOf = (list: Prospect[]) => list.filter((r) => r.campaign_id).map((r) => ({ campaign_id: r.campaign_id!, lead_id: r.id }));
  async function openPlan() {
    setPlanFor({ plan: null, rewrite: false, err: null, starting: false });
    await loadPlan(false);
  }
  async function loadPlan(rewrite: boolean) {
    try {
      const plan = await call<SocialPlan>("outreach.social.plan", { leads: leadsOf(pickedShown), regenerate: rewrite });
      setPlanFor((p) => p && { ...p, plan, rewrite, err: null });
    } catch (e) { setPlanFor((p) => p && { ...p, plan: null, rewrite, err: e instanceof Error ? e.message : "Could not work out the plan" }); }
  }
  async function startBatch() {
    if (!planFor) return;
    setPlanFor({ ...planFor, starting: true, err: null });
    try {
      await call("outreach.social.batch.start", { leads: leadsOf(pickedShown), regenerate: planFor.rewrite });
      await callBackground("social_batch", {});
      setPlanFor(null);
      setPicked(new Set());
      await refreshBatch();
    } catch (e) { setPlanFor((p) => p && { ...p, starting: false, err: e instanceof Error ? e.message : "Could not start" }); }
  }
  async function resumeBatch() {
    try { await call("outreach.social.batch.resume"); await callBackground("social_batch", {}); await refreshBatch(); } catch (e) { setRowErr(e instanceof Error ? e.message : "Could not resume"); }
  }
  /** Tick / untick "Not a fit". Only the changed fields are sent; the lead is never deleted. Optimistic, rolled back on error. */
  async function setNotFit(r: Prospect, excluded: boolean, patch: { reason?: string; note?: string } = {}) {
    if (!r.campaign_id) return;
    // Unticking a flag HQ set itself saves "kept by me", so the next website check does not flag the lead again.
    if (!excluded && autoHidden(r)) {
      patchRow(r.id, { not_fit_kept: true });
      setRowErr(null);
      try { await call("outreach.leads.update", { campaign_id: r.campaign_id, lead_id: r.id, not_fit_kept: true }); } catch (e) { patchRow(r.id, { not_fit_kept: false }); setRowErr(e instanceof Error ? e.message : "Could not update the lead"); }
      return;
    }
    const reason = excluded ? (patch.reason ?? r.excluded_reason ?? r.auto_not_fit?.code ?? "other") : undefined;
    const before = { excluded: r.excluded, excluded_reason: r.excluded_reason, excluded_note: r.excluded_note };
    patchRow(r.id, { excluded, ...(reason !== undefined ? { excluded_reason: reason } : {}), ...(patch.note !== undefined ? { excluded_note: patch.note } : {}) });
    setRowErr(null);
    try {
      // Send only what changed: the tick when it flipped, the reason when it was set or changed, the note when it was edited.
      await call("outreach.leads.update", {
        campaign_id: r.campaign_id, lead_id: r.id,
        ...(!!r.excluded !== excluded ? { excluded } : {}),
        ...(reason !== undefined && (patch.reason !== undefined || !r.excluded) ? { excluded_reason: reason } : {}),
        ...(patch.note !== undefined ? { excluded_note: patch.note } : {}),
      });
    } catch (e) {
      patchRow(r.id, before);
      setRowErr(e instanceof Error ? e.message : "Could not update the lead");
    }
  }
  const lowGap = (r: Prospect) => typeof r.gap_score === "number" && r.gap_score < LOW_GAP;
  const chip = (on: boolean) => `px-2.5 py-1.5 rounded-md border text-xs font-semibold transition ${on ? "bg-primary/20 border-primary/50 text-primary" : "bg-fg/5 border-line text-fg2 hover:bg-fg/10"}`;

  return (
    <div>
      <PageHeader
        title="Prospects"
        subtitle="Every lead from every campaign in one place. Sort by automation gap to see who needs help most."
        right={
          <button
            onClick={() => downloadCsv(`prospects-${new Date().toISOString().slice(0, 10)}.csv`, prospectsToCsv(shown))}
            disabled={shown.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-sm font-bold disabled:opacity-40"
          >
            <Download size={15} /> Export CSV ({shown.length})
          </button>
        }
      />

      <GlassCard className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label text-muted font-bold">Has:</span>
          {HAS_OPTIONS.map((o) => (
            <button key={o.key} className={chip(hasAny.includes(o.key))} onClick={() => setHasAny(hasAny.includes(o.key) ? hasAny.filter((x) => x !== o.key) : [...hasAny, o.key])}>{o.label}</button>
          ))}
          <select className={selectCls} value={reviewF} onChange={(e) => setReviewF(e.target.value)} aria-label="Draft review">
            <option value="">Any draft review</option>
            <option value="ready">Draft ready</option>
            <option value="check">Draft needs check</option>
            <option value="blocked">Draft blocked</option>
          </select>
          <button className={chip(reachOnly)} onClick={() => setReachOnly(!reachOnly)}>No email, but form or social</button>
          <button className={chip(highGap)} onClick={() => setHighGap(!highGap)}>High gap ({HIGH_GAP}+)</button>
          <button className={chip(noReply)} onClick={() => setNoReply(!noReply)}>Emailed, no reply</button>
          <button className={chip(emailedNoSocial)} onClick={() => setEmailedNoSocial(!emailedNoSocial)} title="Emailed, no reply, and no Facebook, Instagram or LinkedIn message yet">Emailed, no reply, no social</button>
          <button className={chip(dueF)} onClick={() => setDueF(!dueF)} title="Leads with a follow-up due today or overdue">Due today ({base.filter((r) => dueIds.has(r.id)).length})</button>
          <button className={chip(leadGenF)} onClick={() => setLeadGenF(!leadGenF)} title="Leads with a lead-gen sign that stay visible because they have 10+ reviews or were already contacted">Possible lead-gen (check) ({base.filter(isLeadGenFlagged).length})</button>
          <select className={selectCls} value={readyCh} onChange={(e) => setReadyCh(e.target.value)} aria-label="Has a message ready to send">
            <option value="">Message ready to send: any</option>
            <option value="facebook">Has a Facebook message ready to send</option>
            <option value="instagram">Has an Instagram message ready to send</option>
            <option value="linkedin">Has a LinkedIn message ready to send</option>
          </select>
          <select className={selectCls} value={notOn} onChange={(e) => setNotOn(e.target.value)} aria-label="Not yet contacted on">
            <option value="">Contacted on: any</option>
            <option value="email">Not yet emailed</option>
            <option value="facebook">Not yet contacted on Facebook</option>
            <option value="instagram">Not yet contacted on Instagram</option>
            <option value="linkedin">Not yet contacted on LinkedIn</option>
          </select>
          <select className={selectCls} value={olderDays} onChange={(e) => setOlderDays(e.target.value)} aria-label="Last touch">
            <option value="">Last touch: any time</option>
            <option value="3">Last touch more than 3 days ago</option>
            <option value="7">Last touch more than 7 days ago</option>
            <option value="14">Last touch more than 14 days ago</option>
            <option value="30">Last touch more than 30 days ago</option>
          </select>
          <select className={selectCls} value={fbF} onChange={(e) => setFbF(e.target.value)} aria-label="Facebook checked">
            <option value="">Facebook checked: any</option>
            <option value="none">Has a Facebook page, not checked</option>
            <option value="real">Checked: real page</option>
            <option value="gone">Checked: page gone</option>
            <option value="not_fit">Checked: not a fit</option>
          </select>
          <select className={selectCls} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label="Campaign">
            <option value="">All campaigns</option>
            {campaigns.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select className={selectCls} value={niche} onChange={(e) => setNiche(e.target.value)} aria-label="Niche">
            <option value="">All niches</option>
            {niches.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select className={selectCls} value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area">
            <option value="">All areas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button className={chip(showNotFit)} onClick={() => setShowNotFit(!showNotFit)} title="Leads you ticked as Not a fit are hidden by default">Show not a fit ({notFitCount})</button>
          <label className="flex items-center gap-1.5 text-xs text-muted ml-auto cursor-pointer">
            <input type="checkbox" className="accent-primary" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} /> Show test leads
          </label>
        </div>
      </GlassCard>

      {rowErr && <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3">{rowErr}</div>}
      {err && <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3">{err}</div>}

      {batch && batch.status !== "none" && (batch.status === "running" || batch.status === "paused" || batch.status === "stopped" || (batch.status === "done" && batch.made !== undefined && !!batch.finished_at && Date.now() - Date.parse(batch.finished_at) < 3_600_000)) && (
        <div className={`mb-4 rounded-lg border text-sm px-4 py-3 flex items-center gap-3 flex-wrap ${batch.status === "paused" || batch.status === "stopped" ? "bg-amber-500/10 border-amber-500/30 text-amber-200" : batch.status === "done" ? "bg-green-500/10 border-green-500/30 text-green-300" : "bg-primary/10 border-primary/30 text-primary"}`} data-testid="batch-banner">
          {batch.status === "running" && <Loader2 size={15} className="animate-spin" />}
          <span className="font-semibold">
            {batch.status === "running" ? `Writing social messages: ${batch.done ?? 0} of ${batch.total ?? 0} done` : batch.status === "done" ? `Social messages written: ${batch.made ?? 0} new${batch.skipped ? `, ${batch.skipped} skipped` : ""}` : batch.status === "paused" ? "Social message writing is paused" : "Social message writing stopped"}
          </span>
          {batch.message && <span className="text-xs opacity-90 break-words min-w-0">{batch.message}</span>}
          <div className="flex-1" />
          {(batch.status === "paused" || batch.status === "stopped") && <button onClick={() => void resumeBatch()} className="px-3 py-1 rounded-md bg-fg/10 border border-line text-xs font-bold">Continue</button>}
          {batch.status !== "running" && <button onClick={() => setBatch(null)} className="text-xs underline opacity-80">Dismiss</button>}
        </div>
      )}

      {picked.size > 0 && (
        <div className="mb-4 rounded-lg bg-primary/10 border border-primary/30 text-sm px-4 py-2.5 flex items-center gap-3 flex-wrap" data-testid="bulk-bar">
          <span className="font-semibold text-primary">{pickedShown.length} selected{pickedShown.length !== picked.size ? ` (${picked.size - pickedShown.length} hidden by the filters)` : ""}</span>
          <button onClick={() => void openPlan()} disabled={pickedShown.length === 0 || batch?.status === "running"} className="px-3 py-1.5 rounded-md bg-primary/20 border border-primary/40 text-primary text-xs font-bold disabled:opacity-50">Write social messages for {pickedShown.length} selected</button>
          <button onClick={() => setPicked(new Set())} className="text-xs text-fg2 underline">Clear selection</button>
        </div>
      )}

      <GlassCard className="min-w-0">
        {!loaded ? (
          <div className="flex items-center gap-2 text-muted text-sm py-6"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted py-6 text-center">{base.length === 0 ? "No leads yet. Run a campaign first." : "No leads match these filters."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-muted text-label border-b border-line whitespace-nowrap">
                  <th className="py-2 pr-2 font-bold"><input type="checkbox" className="accent-primary" aria-label="Select all shown" title="Select all shown" checked={allShownPicked} onChange={(e) => setPicked(e.target.checked ? new Set([...picked, ...shown.map((r) => r.id)]) : new Set([...picked].filter((id) => !shown.some((r) => r.id === id))))} /></th>
                  <th className="py-2 pr-3 font-bold">Business</th>
                  <th className="py-2 pr-3 font-bold">Owner</th>
                  <th className="py-2 pr-3 font-bold">Campaign</th>
                  <th className="py-2 pr-3 font-bold">Niche</th>
                  <th className="py-2 pr-3 font-bold">Area</th>
                  <th className="py-2 pr-3 font-bold"><button onClick={() => setAsc(!asc)} className="font-medium" title="Sort by gap score">Gap {asc ? "▲" : "▼"}</button></th>
                  <th className="py-2 pr-3 font-bold">Email</th>
                  <th className="py-2 pr-3 font-bold">Contacted</th>
                  <th className="py-2 pr-3 font-bold">Not a fit</th>
                  <th className="py-2 pr-3 font-bold">Reason</th>
                  <th className="py-2 pr-3 font-bold">Draft</th>
                  <th className="py-2 font-bold">Links</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} onClick={() => setSelectedId(r.id)} className={`border-b border-line hover:bg-fg/[0.05] cursor-pointer ${selectedId === r.id ? "bg-primary/[0.07]" : ""}`}>
                    <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}><input type="checkbox" className="accent-primary" aria-label={`Select ${r.name}`} checked={picked.has(r.id)} onChange={() => togglePick(r.id)} /></td>
                    <td className="py-2 pr-3 text-fg font-medium max-w-[220px] truncate">
                      {r.name}{r.is_test && <span className="ml-1.5 text-label text-accent">TEST</span>}{dueIds.has(r.id) && <span className="ml-1.5 tag tag-flag" title="A follow-up is due today or overdue">Due today</span>}
                      {fitLabels(r).map((t) => <span key={t} title={t} className="ml-1.5 text-label px-1 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">{t.includes("lead-gen") ? "Check: lead-gen?" : "Check: not home service?"}</span>)}
                      {!r.email && reachAnotherWay(r).length > 0 && <span className="ml-1.5 text-label px-1 py-0.5 rounded bg-primary/15 border border-primary/40 text-primary">Reach another way</span>}
                    </td>
                    <td className="py-2 pr-3 text-fg2">{r.owner_name ? `${r.owner_name}${r.owner_confidence === "low" ? " ?" : ""}` : <span className="text-muted">-</span>}</td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      {r.campaign_id ? <Link to={`/outreach/${r.campaign_id}`} className="text-primary hover:underline">{r.campaign_name}</Link> : "-"}
                    </td>
                    <td className="py-2 pr-3 text-fg2 max-w-[160px] truncate">{r.category ?? "-"}</td>
                    <td className="py-2 pr-3 text-fg2">{areaOf(r.address) || "-"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap"><GapBadge score={r.gap_score} reasons={r.gap_reasons} />{lowGap(r) && <span title={`Gap score is under ${LOW_GAP}: probably little to improve. A hint only.`} className="ml-1 text-label px-1 py-0.5 rounded bg-fg/5 border border-line text-muted">Low gap</span>}</td>
                    <td className="py-2 pr-3">
                      <span className={`px-1.5 py-0.5 rounded-md border text-label font-mono ${STATUS_TONE[r.email_status]}`}>{STATUS_LABEL[r.email_status]}</span>
                    </td>
                    <td className="py-2 pr-3"><ContactedCell r={r} /></td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="accent-primary" aria-label={`Not a fit: ${r.name}`} checked={isNotFit(r)} disabled={!r.campaign_id} onChange={(e) => void setNotFit(r, e.target.checked)} />
                    </td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      {r.excluded ? (
                        <select className={selectCls} value={r.excluded_reason ?? "other"} aria-label={`Reason: ${r.name}`} onChange={(e) => void setNotFit(r, true, { reason: e.target.value })}>
                          {NOT_FIT_REASONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                        </select>
                      ) : r.not_fit_kept ? <span className="text-label text-muted">Kept by me</span> : r.auto_not_fit ? (
                        <span title={r.auto_not_fit.detail} className="text-label text-muted">{reasonLabel(r.auto_not_fit.code) || "Other"} <span className="text-muted">(auto)</span></span>
                      ) : r.auto_flag ? (
                        <span title={`${r.auto_flag.detail}${r.auto_flag.why === "contacted" ? " (kept visible: already contacted)" : r.auto_flag.why === "reviews" ? " (kept visible: 10 or more reviews)" : ""}`} className="tag tag-warn">{autoFlagLabel(r.auto_flag)}</span>
                      ) : <span className="text-muted">-</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {r.review_status ? <span className={`px-1.5 py-0.5 rounded-md border text-label font-mono ${r.review_status === "ready" ? "border-green-500/40 text-green-300 bg-green-500/10" : r.review_status === "blocked" ? "border-red-500/40 text-red-300 bg-red-500/10" : "border-amber-500/40 text-amber-300 bg-amber-500/10"}`}>{REVIEW_LABEL[r.review_status]}</span> : <span className="text-muted">-</span>}
                    </td>
                    <td className="py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1"><LinkIcons items={leadLinks(r)} size={11} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <Drawer open={!!selected} onClose={() => setSelectedId(null)} title={selected?.name ?? ""} subtitle={selected ? `${selected.category ?? ""}${selected.address ? ` · ${selected.address}` : ""}` : undefined}>
        {selected && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-1.5 py-0.5 rounded-md border text-label font-mono ${STATUS_TONE[selected.email_status]}`}>{STATUS_LABEL[selected.email_status]}</span>
              {selected.emailed_at && <span className="text-label text-muted">on {shortDate(selected.emailed_at)}</span>}
              {selected.campaign_id && <Link to={`/outreach/${selected.campaign_id}`} className="text-label text-primary hover:underline">{selected.campaign_name}</Link>}
            </div>
            <div className="space-y-1 text-xs text-fg2">
              <EmailField key={selected.id} lead={selected} onSaved={(p) => patchRow(selected.id, p)} />
              {selected.phone && <div>Phone: <a className="font-mono" href={`tel:${selected.phone}`}>{selected.phone}</a></div>}
              {selected.rating !== null && <div>Google rating: {selected.rating}{selected.reviews_count ? ` (${selected.reviews_count} reviews)` : ""}</div>}
              {selected.hours_summary && <div>Hours: {selected.hours_summary}</div>}
            </div>
            <div className="flex gap-1.5 flex-wrap"><LinkIcons items={leadLinks(selected)} size={13} /></div>
            <SocialMessages key={selected.id} lead={selected} emailedOn={selected.emailed_at} order="newest" onChanged={(st) => patchRow(selected.id, { touches: st.summary, social_drafts: st.social_drafts })} />
            <FacebookChecked key={`fb-${selected.id}`} lead={selected} onSaved={(p) => patchRow(selected.id, p)} />
            <div className="rounded-lg bg-fg/[0.03] border border-line p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-label text-muted font-medium">Not a fit</p>
                {lowGap(selected) && <span className="text-label px-1 py-0.5 rounded bg-fg/5 border border-line text-muted">Low gap ({selected.gap_score})</span>}
              </div>
              <label className="flex items-center gap-2 text-xs text-fg2 cursor-pointer">
                <input type="checkbox" className="accent-primary" checked={isNotFit(selected)} disabled={!selected.campaign_id} onChange={(e) => void setNotFit(selected, e.target.checked)} />
                Not a fit (no emails or social messages; nothing is deleted)
              </label>
              {selected.excluded ? (
                <div className="space-y-1.5">
                  <select className={selectCls} value={selected.excluded_reason ?? "other"} onChange={(e) => void setNotFit(selected, true, { reason: e.target.value })}>
                    {NOT_FIT_REASONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </select>
                  <input key={selected.id} defaultValue={selected.excluded_note ?? ""} maxLength={200} placeholder="Optional note" onBlur={(e) => { if (e.target.value !== (selected.excluded_note ?? "")) void setNotFit(selected, true, { note: e.target.value }); }} className="w-full bg-inset border border-line rounded-md px-2 py-1.5 text-xs text-fg" />
                </div>
              ) : selected.auto_flag && !selected.not_fit_kept ? <p className="text-label text-amber-300 break-words"><span className="font-semibold">{autoFlagLabel(selected.auto_flag)}.</span> {selected.auto_flag.detail}. {selected.auto_flag.why === "contacted" ? "It stays visible because you already contacted it." : "It stays visible because it has 10 or more reviews."}</p> : selected.auto_not_fit ? <p className="text-label text-muted">Alcance's own flag (auto): {reasonLabel(selected.auto_not_fit.code) || "Other"}. {selected.auto_not_fit.detail}{autoHidden(selected) ? " Untick to keep this lead; the next website check will not flag it again." : ""}</p> : selected.not_fit_kept ? <p className="text-label text-muted">Kept by me: HQ's own flags no longer hide or skip this lead.</p> : null}
              <div className="text-label text-muted">Contacted: {touchesText(selected) || "not yet"}{selected.touches?.replied ? " · Replied" : ""}</div>
            </div>
            <OwnerField lead={selected} onSaved={(p) => patchRow(selected.id, p)} />
            <div className="rounded-lg bg-fg/[0.03] border border-line p-3">
              <p className="text-label text-muted font-medium mb-2">Website check</p>
              <SiteDetails lead={selected} />
            </div>

          </>
        )}
      </Drawer>

      <Modal open={!!planFor} onClose={() => { if (!planFor?.starting) setPlanFor(null); }} title="Write social messages?" description={`For ${pickedShown.length} selected lead${pickedShown.length === 1 ? "" : "s"}, across campaigns.`} maxWidth="max-w-lg">
        {planFor && (
          <div className="space-y-3 text-sm" data-testid="plan-confirm">
            {!planFor.plan && !planFor.err && <div className="flex items-center gap-2 text-muted"><Loader2 size={15} className="animate-spin" /> Working out what will be written…</div>}
            {planFor.plan && (
              <>
                <p><strong>{planFor.plan.total}</strong> message{planFor.plan.total === 1 ? "" : "s"} for <strong>{planFor.plan.leads}</strong> lead{planFor.plan.leads === 1 ? "" : "s"}{Object.keys(planFor.plan.by_channel).length > 0 ? ` (${Object.entries(planFor.plan.by_channel).map(([c, n]) => `${n} ${c === "linkedin" ? "LinkedIn" : c[0].toUpperCase() + c.slice(1)}`).join(", ")})` : ""}.</p>
                <p className="text-fg2">About {planFor.plan.gemini_calls.rough_total} Gemini calls ({planFor.plan.gemini_calls.writing} to write, about {planFor.plan.gemini_calls.reviewing} to review). Writing runs in the background and pauses by itself if Gemini's daily limit is reached.</p>
                {planFor.plan.skipped > 0 && (
                  <div className="rounded-md bg-fg/5 border border-line px-3 py-2 text-xs text-fg2">
                    <p className="font-semibold mb-1">{planFor.plan.skipped} skipped:</p>
                    <ul className="list-disc pl-4">{Object.entries(planFor.plan.skip_reasons).map(([r, n]) => <li key={r}>{n} × {r}</li>)}</ul>
                  </div>
                )}
              </>
            )}
            <label className="flex items-start gap-2 text-xs text-fg2 cursor-pointer">
              <input type="checkbox" className="accent-primary mt-0.5" checked={planFor.rewrite} onChange={(e) => void loadPlan(e.target.checked)} />
              <span>Rewrite existing: also write again for leads that already have a message waiting. Messages already sent are never touched.</span>
            </label>
            {planFor.err && <p className="text-red-300 text-xs">{planFor.err}</p>}
            <div className="flex items-center gap-2 justify-end pt-1">
              <button onClick={() => setPlanFor(null)} disabled={planFor.starting} className="px-3 py-2 rounded-md bg-fg/5 border border-line text-xs text-fg2">Cancel</button>
              <button onClick={() => void startBatch()} disabled={planFor.starting || !planFor.plan || planFor.plan.total === 0} className="px-4 py-2 rounded-md bg-primary/25 border border-primary/50 text-primary text-xs font-bold disabled:opacity-50">{planFor.starting ? "Starting…" : `Write ${planFor.plan?.total ?? 0} message${planFor.plan?.total === 1 ? "" : "s"}`}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
