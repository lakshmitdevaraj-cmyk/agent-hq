import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Loader2, X } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import { OwnerField, SiteDetails } from "@/components/SiteDetails";
import { call } from "@/lib/api";
import { GapBadge, LinkIcons, leadLinks, reachAnotherWay, shortDate } from "@/lib/leadInfo";
import { HAS_OPTIONS, LOW_GAP, autoHidden, isNotFit, NOT_FIT_REASONS, REVIEW_LABEL, STATUS_LABEL, areaOf, contactedList, downloadCsv, fitLabels, hasChannel, prospectsToCsv, reasonLabel, type HasKey, type EmailState, type Prospect } from "@/lib/prospects";

const HIGH_GAP = 60;
const STATUS_TONE: Record<EmailState, string> = {
  not_emailed: "bg-white/10 border-white/20 text-white/70",
  emailed: "bg-accent/15 border-accent/40 text-accent",
  replied: "bg-green-500/15 border-green-500/40 text-green-300",
  bounced: "bg-red-500/15 border-red-500/40 text-red-300",
  do_not_contact: "bg-red-500/15 border-red-500/40 text-red-300",
};

const selectCls = "bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-xs text-white";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "Edit email" in the detail panel: saved on the lead itself (source manual + date). Unsent drafts for the lead get the new To address. */
function EmailField({ lead, onSaved }: { lead: Prospect; onSaved: (patch: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function save() {
    const v = value.trim();
    if (!EMAIL_SHAPE.test(v)) { setErr("That does not look like an email address."); return; }
    if (!lead.campaign_id) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await call<{ email: string; email_source: string; email_manual_at: string; drafts_updated: number; warning: string | null }>("outreach.lead.set_email", { campaign_id: lead.campaign_id, lead_id: lead.id, email: v });
      onSaved({ email: r.email, email_source: r.email_source, email_manual_at: r.email_manual_at });
      setNote([r.drafts_updated > 0 ? `${r.drafts_updated} unsent draft${r.drafts_updated === 1 ? "" : "s"} now go to this address.` : null, r.warning].filter(Boolean).join(" "));
      setEditing(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return (
    <div className="text-xs text-white/75 space-y-1">
      {editing ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <input autoFocus type="email" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} placeholder="name@company.com" className="flex-1 min-w-[180px] bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-xs text-white font-mono" />
          <button onClick={() => void save()} disabled={busy} className="px-2 py-1 rounded-md bg-primary/20 border border-primary/40 text-primary text-[11px] font-bold disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
          <button onClick={() => { setEditing(false); setErr(null); }} className="px-2 py-1 rounded-md bg-white/5 border border-white/15 text-[11px] text-white/70">Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span>Email: {lead.email ? <span className="font-mono">{lead.email}</span> : <span className="text-white/40">none</span>}</span>
          {lead.email_source === "manual" && <span className="text-[10px] text-white/45">manual{lead.email_manual_at ? `, ${shortDate(lead.email_manual_at)}` : ""}</span>}
          <button onClick={() => { setValue(lead.email ?? ""); setEditing(true); setNote(null); }} disabled={!lead.campaign_id} className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-[10px] text-white/80">Edit email</button>
        </div>
      )}
      {err && <p className="text-[11px] text-red-300">{err}</p>}
      {note && <p className="text-[11px] text-amber-200/90">{note}</p>}
    </div>
  );
}

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
  }, [base, hasAny, reviewF, reachOnly, highGap, noReply, campaign, niche, area, asc, showNotFit]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const patchRow = (id: string, patch: Record<string, unknown>) => setRows((prev) => prev.map((r) => (r.id === id ? ({ ...r, ...patch } as Prospect) : r)));
  const [rowErr, setRowErr] = useState<string | null>(null);
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
  const chip = (on: boolean) => `px-2.5 py-1.5 rounded-md border text-xs font-semibold transition ${on ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/5 border-white/15 text-white/70 hover:bg-white/10"}`;

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
          <span className="text-[11px] text-white/50 font-bold">Has:</span>
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
          <label className="flex items-center gap-1.5 text-xs text-white/60 ml-auto cursor-pointer">
            <input type="checkbox" className="accent-primary" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} /> Show test leads
          </label>
        </div>
      </GlassCard>

      {rowErr && <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3">{rowErr}</div>}
      {err && <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3">{err}</div>}

      <GlassCard>
        {!loaded ? (
          <div className="flex items-center gap-2 text-white/60 text-sm py-6"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-white/60 py-6 text-center">{base.length === 0 ? "No leads yet. Run a campaign first." : "No leads match these filters."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-white/50 uppercase tracking-wider text-[10px] border-b border-white/10">
                  <th className="py-2 pr-3 font-bold">Business</th>
                  <th className="py-2 pr-3 font-bold">Owner</th>
                  <th className="py-2 pr-3 font-bold">Campaign</th>
                  <th className="py-2 pr-3 font-bold">Niche</th>
                  <th className="py-2 pr-3 font-bold">Area</th>
                  <th className="py-2 pr-3 font-bold"><button onClick={() => setAsc(!asc)} className="uppercase font-bold" title="Sort by gap score">Gap {asc ? "▲" : "▼"}</button></th>
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
                  <tr key={r.id} onClick={() => setSelectedId(r.id)} className={`border-b border-white/[0.06] hover:bg-white/[0.05] cursor-pointer ${selectedId === r.id ? "bg-primary/[0.07]" : ""}`}>
                    <td className="py-2 pr-3 text-white font-medium max-w-[220px] truncate">
                      {r.name}{r.is_test && <span className="ml-1.5 text-[9px] text-accent">TEST</span>}
                      {fitLabels(r).map((t) => <span key={t} title={t} className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">{t.includes("lead-gen") ? "Check: lead-gen?" : "Check: not home service?"}</span>)}
                      {!r.email && reachAnotherWay(r).length > 0 && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-purple/15 border border-purple/40 text-purple">Reach another way</span>}
                      {(r.social_sent ?? []).map((x) => <span key={x.channel} title={`Marked as sent on ${x.sent_at.slice(0, 10)}`} className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-green-500/10 border border-green-500/30 text-green-300">{x.channel} sent</span>)}
                    </td>
                    <td className="py-2 pr-3 text-white/70">{r.owner_name ? `${r.owner_name}${r.owner_confidence === "low" ? " ?" : ""}` : <span className="text-white/30">-</span>}</td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      {r.campaign_id ? <Link to={`/outreach/${r.campaign_id}`} className="text-primary hover:underline">{r.campaign_name}</Link> : "-"}
                    </td>
                    <td className="py-2 pr-3 text-white/70 max-w-[160px] truncate">{r.category ?? "-"}</td>
                    <td className="py-2 pr-3 text-white/70">{areaOf(r.address) || "-"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap"><GapBadge score={r.gap_score} reasons={r.gap_reasons} />{lowGap(r) && <span title={`Gap score is under ${LOW_GAP}: probably little to improve. A hint only.`} className="ml-1 text-[9px] px-1 py-0.5 rounded bg-white/5 border border-white/10 text-white/40">Low gap</span>}</td>
                    <td className="py-2 pr-3">
                      <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${STATUS_TONE[r.email_status]}`}>{STATUS_LABEL[r.email_status]}</span>
                    </td>
                    <td className="py-2 pr-3 text-white/70 whitespace-nowrap">{contactedList(r).length > 0 ? contactedList(r).map((c) => `${c.channel} ${shortDate(c.at)}`).join(" · ") : <span className="text-white/30">-</span>}</td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="accent-primary" aria-label={`Not a fit: ${r.name}`} checked={isNotFit(r)} disabled={!r.campaign_id} onChange={(e) => void setNotFit(r, e.target.checked)} />
                    </td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      {r.excluded ? (
                        <select className={selectCls} value={r.excluded_reason ?? "other"} aria-label={`Reason: ${r.name}`} onChange={(e) => void setNotFit(r, true, { reason: e.target.value })}>
                          {NOT_FIT_REASONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                        </select>
                      ) : r.not_fit_kept ? <span className="text-[11px] text-white/45">Kept by me</span> : r.auto_not_fit ? (
                        <span title={r.auto_not_fit.detail} className="text-[11px] text-white/45">{reasonLabel(r.auto_not_fit.code) || "Other"} <span className="text-white/30">(auto)</span></span>
                      ) : <span className="text-white/30">-</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {r.review_status ? <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${r.review_status === "ready" ? "border-green-500/40 text-green-300 bg-green-500/10" : r.review_status === "blocked" ? "border-red-500/40 text-red-300 bg-red-500/10" : "border-amber-500/40 text-amber-300 bg-amber-500/10"}`}>{REVIEW_LABEL[r.review_status]}</span> : <span className="text-white/30">-</span>}
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

      {selected && (
        <div className="fixed inset-y-0 right-0 w-full max-w-md z-40 bg-[#0e1017] border-l border-white/15 shadow-2xl overflow-y-auto p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-bold">{selected.name}</h2>
              <p className="text-xs text-white/55 mt-0.5">{selected.category ?? ""}{selected.address ? ` · ${selected.address}` : ""}</p>
            </div>
            <button onClick={() => setSelectedId(null)} className="text-white/60 hover:text-white" aria-label="Close"><X size={18} /></button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${STATUS_TONE[selected.email_status]}`}>{STATUS_LABEL[selected.email_status]}</span>
            {selected.emailed_at && <span className="text-[11px] text-white/50">on {shortDate(selected.emailed_at)}</span>}
            {selected.campaign_id && <Link to={`/outreach/${selected.campaign_id}`} className="text-[11px] text-primary hover:underline">{selected.campaign_name}</Link>}
          </div>
          <div className="space-y-1 text-xs text-white/75">
            <EmailField key={selected.id} lead={selected} onSaved={(p) => patchRow(selected.id, p)} />
            {selected.phone && <div>Phone: <a className="font-mono" href={`tel:${selected.phone}`}>{selected.phone}</a></div>}
            {selected.rating !== null && <div>Google rating: {selected.rating}{selected.reviews_count ? ` (${selected.reviews_count} reviews)` : ""}</div>}
            {selected.hours_summary && <div>Hours: {selected.hours_summary}</div>}
          </div>
          <div className="flex gap-1.5 flex-wrap"><LinkIcons items={leadLinks(selected)} size={13} /></div>
          <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Not a fit</p>
              {lowGap(selected) && <span className="text-[9px] px-1 py-0.5 rounded bg-white/5 border border-white/10 text-white/40">Low gap ({selected.gap_score})</span>}
            </div>
            <label className="flex items-center gap-2 text-xs text-white/80 cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={isNotFit(selected)} disabled={!selected.campaign_id} onChange={(e) => void setNotFit(selected, e.target.checked)} />
              Not a fit (no emails or social messages; nothing is deleted)
            </label>
            {selected.excluded ? (
              <div className="space-y-1.5">
                <select className={selectCls} value={selected.excluded_reason ?? "other"} onChange={(e) => void setNotFit(selected, true, { reason: e.target.value })}>
                  {NOT_FIT_REASONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                </select>
                <input key={selected.id} defaultValue={selected.excluded_note ?? ""} maxLength={200} placeholder="Optional note" onBlur={(e) => { if (e.target.value !== (selected.excluded_note ?? "")) void setNotFit(selected, true, { note: e.target.value }); }} className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-xs text-white" />
              </div>
            ) : selected.auto_not_fit ? <p className="text-[11px] text-white/50">HQ's own flag (auto): {reasonLabel(selected.auto_not_fit.code) || "Other"}. {selected.auto_not_fit.detail}{autoHidden(selected) ? " Untick to keep this lead; the next website check will not flag it again." : ""}</p> : selected.not_fit_kept ? <p className="text-[11px] text-white/50">Kept by me: HQ's own flags no longer hide or skip this lead.</p> : null}
            <div className="text-[11px] text-white/60">Contacted: {contactedList(selected).length > 0 ? contactedList(selected).map((c) => `${c.channel} ${shortDate(c.at)}`).join(" · ") : "not yet"}</div>
          </div>
          <OwnerField lead={selected} onSaved={(p) => patchRow(selected.id, p)} />
          <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3">
            <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold mb-2">Website check</p>
            <SiteDetails lead={selected} />
          </div>
        </div>
      )}
    </div>
  );
}
