import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import { FACT_LABEL, GapBadge, factResult, shortDate, type LeadInfo } from "@/lib/leadInfo";

type LeadRef = LeadInfo & { id: string; campaign_id?: string | null; name?: string };

/** Editable owner name. A name you type is trusted: it is used in greetings and a re-check never replaces it. */
export function OwnerField({ lead, onSaved }: { lead: LeadRef; onSaved: (patch: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(lead.owner_name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setValue(lead.owner_name ?? ""), [lead.id, lead.owner_name]);

  async function save() {
    if (!lead.campaign_id) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await call<Record<string, unknown>>("outreach.leads.update", { campaign_id: lead.campaign_id, lead_id: lead.id, owner_name: value });
      onSaved(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const how = lead.owner_name
    ? lead.owner_confidence === "low"
      ? "Not sure about this one, so it is NOT used in greetings. Retype it to confirm."
      : "Used in greetings (\"Hi " + lead.owner_name.split(" ")[0] + "\")."
    : "Not found yet. Type a name to greet this person by first name.";
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3">
      <label className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Owner</label>
      <div className="flex gap-2 mt-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder="e.g. Dana Reyes"
          className="flex-1 min-w-0 bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-sm text-white"
        />
        <button
          onClick={() => void save()}
          disabled={busy || value.trim() === (lead.owner_name ?? "")}
          className="px-3 py-1.5 rounded-md bg-primary/20 border border-primary/40 text-primary text-xs font-bold disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-[11px] text-white/50 mt-1">{how}</p>
      {lead.owner_name && lead.owner_source_url && (
        <p className="text-[11px] text-white/50 mt-0.5">
          Found on <a className="underline" href={lead.owner_source_url} target="_blank" rel="noopener noreferrer">{lead.owner_source_url}</a>
        </p>
      )}
      {lead.owner_name && lead.owner_evidence && <p className="text-[11px] text-white/45 mt-0.5 italic">"{lead.owner_evidence}"</p>}
      {err && <p className="text-[11px] text-red-300 mt-1">{err}</p>}
    </div>
  );
}

const Row = ({ label, value, url }: { label: string; value: string; url?: string | null }) => (
  <div className="flex items-baseline gap-2 text-xs">
    <span className="w-28 shrink-0 text-white/45">{label}</span>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-white/85 underline break-all">{value}</a> : <span className="text-white/85">{value}</span>}
  </div>
);

/** Homepage screenshot taken by the browser check: a small thumbnail that opens full size. */
function Screenshot({ lead }: { lead: LeadRef }) {
  const has = !!lead.site_check?.screenshot;
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    setUrl(null);
    setErr(false);
    if (!has || !lead.campaign_id) return;
    let live = true;
    call<{ found: boolean; data_url?: string }>("outreach.lead.screenshot.get", { campaign_id: lead.campaign_id, lead_id: lead.id })
      .then((r) => { if (live && r.found && r.data_url) setUrl(r.data_url); else if (live) setErr(true); })
      .catch(() => live && setErr(true));
    return () => { live = false; };
  }, [lead.id, lead.campaign_id, has, lead.site_check?.screenshot?.saved_at]);
  if (!has || err) return <p className="text-[11px] text-white/40">No screenshot yet. A browser check takes one of the homepage.</p>;
  if (!url) return <p className="text-[11px] text-white/40">Loading screenshot…</p>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
      <img src={url} alt="Homepage screenshot" className="w-48 rounded-md border border-white/15" />
    </a>
  );
}

/** Everything the website check found, with the page each item came from. */
export function SiteDetails({ lead }: { lead: LeadInfo }) {
  const sc = lead.site_check;
  const so = lead.social ?? {};
  const src = sc?.sources ?? {};
  if (!sc?.checked_at) return <p className="text-xs text-white/50">Website not checked yet. Use "Check websites" on the campaign.</p>;
  if (sc.error) return <p className="text-xs text-white/50">Checked {shortDate(sc.checked_at)}: {sc.error}.{sc.needs_browser ? " A browser check may open it." : ""}</p>;
  const ev = sc.evidence ?? {};
  const links: Array<[string, string | null | undefined, string | undefined]> = [
    ["LinkedIn (company)", so.linkedin_company, src.linkedin_company],
    ["LinkedIn (person)", so.linkedin_person, src.linkedin_person],
    ["Facebook", so.facebook, src.facebook],
    ["Instagram", so.instagram, src.instagram],
    ["Yelp", so.yelp, src.yelp],
    ["Nextdoor", so.nextdoor, src.nextdoor],
    ["Google reviews", so.google_reviews, src.google_reviews],
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <GapBadge score={lead.gap_score} reasons={lead.gap_reasons} />
        <span className="text-xs text-white/60">{(lead.gap_reasons ?? []).join(" · ")}</span>
      </div>
      <div className="space-y-1">
        <Row label="Chat widget" value={sc.chat_widget ?? "none found"} url={src.chat_widget} />
        {ev.chat_widget && <div className="pl-28 text-[10px] text-white/35 break-all">{ev.chat_widget}</div>}
        <Row label="Online booking" value={sc.booking_tool ?? (sc.request_form ? "none (a request form only)" : "none found")} url={src.booking_tool ?? sc.request_form_url} />
        {(ev.booking_tool || ev.request_form) && <div className="pl-28 text-[10px] text-white/35 break-all">{ev.booking_tool ?? ev.request_form}</div>}
        <Row label="Contact form" value={sc.has_contact_form ? "yes" : "none found"} url={sc.contact_form_url} />
        <Row label="Opening hours" value={sc.hours_usable === false ? "not used (the site says it answers any time)" : "from Google"} />
        {sc.hours_evidence && <div className="pl-28 text-[10px] text-white/35 break-all">{sc.hours_evidence}</div>}
        <Row label="Looked at" value={sc.via === "browser" ? "in a real browser" : sc.needs_browser ? "plain download (needs a browser check)" : "plain download"} />
        <Row label="WhatsApp" value={sc.whatsapp_url ?? "none found"} url={sc.whatsapp_url} />
        {links.filter(([, u]) => u).map(([label, u, from]) => (
          <div key={label}>
            <Row label={label} value={u as string} url={u} />
            {from && <div className="pl-28 text-[10px] text-white/35 break-all">seen on {from}</div>}
          </div>
        ))}
      </div>
      <Screenshot lead={lead as LeadRef} />
      {(sc.facts?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-white/50 font-bold">Website facts</div>
          {sc.facts!.map((f) => (
            <div key={f.key}>
              <Row label={FACT_LABEL[f.key] ?? f.key} value={factResult(f)} url={f.evidence?.url} />
              {f.evidence?.text && <div className="pl-28 text-[10px] text-white/35 break-all">{f.evidence.text}</div>}
            </div>
          ))}
        </div>
      )}
      {sc.not_home_service && <p className="text-[11px] text-amber-300">Check: may not be a home-service business. {sc.not_home_service}.</p>}
      {sc.lead_gen_listing && <p className="text-[11px] text-amber-300">Check: may be a lead-gen listing. {sc.lead_gen_listing}.</p>}
      <p className="text-[10px] text-white/35">Checked {shortDate(sc.checked_at)}. Links only: LinkedIn and Facebook pages are never opened by the app.</p>
    </div>
  );
}
