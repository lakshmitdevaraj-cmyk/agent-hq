import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Loader2, X } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import { OwnerField, SiteDetails } from "@/components/SiteDetails";
import { call } from "@/lib/api";
import { GapBadge, LinkIcons, leadLinks, reachAnotherWay, shortDate } from "@/lib/leadInfo";
import { STATUS_LABEL, areaOf, downloadCsv, prospectsToCsv, type EmailState, type Prospect } from "@/lib/prospects";

const HIGH_GAP = 60;
const STATUS_TONE: Record<EmailState, string> = {
  not_emailed: "bg-white/10 border-white/20 text-white/70",
  emailed: "bg-accent/15 border-accent/40 text-accent",
  replied: "bg-green-500/15 border-green-500/40 text-green-300",
  bounced: "bg-red-500/15 border-red-500/40 text-red-300",
  do_not_contact: "bg-red-500/15 border-red-500/40 text-red-300",
};

const selectCls = "bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-xs text-white";

export default function Prospects() {
  const [rows, setRows] = useState<Prospect[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTests, setShowTests] = useState(false);
  const [hasLinkedin, setHasLinkedin] = useState(false);
  const [reachOnly, setReachOnly] = useState(false);
  const [highGap, setHighGap] = useState(false);
  const [noReply, setNoReply] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [niche, setNiche] = useState("");
  const [area, setArea] = useState("");
  const [asc, setAsc] = useState(false);

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
  const campaigns = useMemo(() => [...new Map(base.filter((r) => r.campaign_id).map((r) => [r.campaign_id!, r.campaign_name ?? r.campaign_id!])).entries()], [base]);
  const niches = useMemo(() => [...new Set(base.map((r) => r.category).filter(Boolean) as string[])].sort(), [base]);
  const areas = useMemo(() => [...new Set(base.map((r) => areaOf(r.address)).filter(Boolean))].sort(), [base]);

  const shown = useMemo(() => {
    const f = base.filter((r) => {
      if (hasLinkedin && !(r.social?.linkedin_company || r.social?.linkedin_person)) return false;
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
      const x = a.gap_score, y = b.gap_score;
      if (x === null && y === null) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return asc ? x - y : y - x;
    });
  }, [base, hasLinkedin, reachOnly, highGap, noReply, campaign, niche, area, asc]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const patchRow = (id: string, patch: Record<string, unknown>) => setRows((prev) => prev.map((r) => (r.id === id ? ({ ...r, ...patch } as Prospect) : r)));
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
          <button className={chip(hasLinkedin)} onClick={() => setHasLinkedin(!hasLinkedin)}>Has LinkedIn</button>
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
          <label className="flex items-center gap-1.5 text-xs text-white/60 ml-auto cursor-pointer">
            <input type="checkbox" className="accent-primary" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} /> Show test leads
          </label>
        </div>
      </GlassCard>

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
                  <th className="py-2 font-bold">Links</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} onClick={() => setSelectedId(r.id)} className={`border-b border-white/[0.06] hover:bg-white/[0.05] cursor-pointer ${selectedId === r.id ? "bg-primary/[0.07]" : ""}`}>
                    <td className="py-2 pr-3 text-white font-medium max-w-[220px] truncate">
                      {r.name}{r.is_test && <span className="ml-1.5 text-[9px] text-accent">TEST</span>}
                      {!r.email && reachAnotherWay(r).length > 0 && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-purple/15 border border-purple/40 text-purple">Reach another way</span>}
                    </td>
                    <td className="py-2 pr-3 text-white/70">{r.owner_name ? `${r.owner_name}${r.owner_confidence === "low" ? " ?" : ""}` : <span className="text-white/30">-</span>}</td>
                    <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                      {r.campaign_id ? <Link to={`/outreach/${r.campaign_id}`} className="text-primary hover:underline">{r.campaign_name}</Link> : "-"}
                    </td>
                    <td className="py-2 pr-3 text-white/70 max-w-[160px] truncate">{r.category ?? "-"}</td>
                    <td className="py-2 pr-3 text-white/70">{areaOf(r.address) || "-"}</td>
                    <td className="py-2 pr-3"><GapBadge score={r.gap_score} reasons={r.gap_reasons} /></td>
                    <td className="py-2 pr-3">
                      <span className={`px-1.5 py-0.5 rounded-md border text-[10px] font-mono ${STATUS_TONE[r.email_status]}`}>{STATUS_LABEL[r.email_status]}</span>
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
            {selected.email && <div>Email: <span className="font-mono">{selected.email}</span></div>}
            {selected.phone && <div>Phone: <a className="font-mono" href={`tel:${selected.phone}`}>{selected.phone}</a></div>}
            {selected.rating !== null && <div>Google rating: {selected.rating}{selected.reviews_count ? ` (${selected.reviews_count} reviews)` : ""}</div>}
            {selected.hours_summary && <div>Hours: {selected.hours_summary}</div>}
          </div>
          <div className="flex gap-1.5 flex-wrap"><LinkIcons items={leadLinks(selected)} size={13} /></div>
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
