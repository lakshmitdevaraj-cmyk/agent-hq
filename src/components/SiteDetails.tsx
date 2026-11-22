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
    <div className="rounded-lg bg-fg/[0.03] border border-line p-3">
      <label className="text-label text-muted font-medium">Owner</label>
      <div className="flex gap-2 mt-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder="e.g. Dana Reyes"
          className="flex-1 min-w-0 bg-inset border border-line rounded-md px-2 py-1.5 text-sm text-fg"
        />
        <button
          onClick={() => void save()}
          disabled={busy || value.trim() === (lead.owner_name ?? "")}
          className="px-3 py-1.5 rounded-md bg-primary/20 border border-primary/40 text-primary text-xs font-bold disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-label text-muted mt-1">{how}</p>
      {lead.owner_name && lead.owner_source_url && (
        <p className="text-label text-muted mt-0.5">
          Found on <a className="underline" href={lead.owner_source_url} target="_blank" rel="noopener noreferrer">{lead.owner_source_url}</a>
        </p>
      )}
      {lead.owner_name && lead.owner_evidence && <p className="text-label text-muted mt-0.5 italic">"{lead.owner_evidence}"</p>}
      {err && <p className="text-label text-red-300 mt-1">{err}</p>}
    </div>
  );
}

const Row = ({ label, value, url }: { label: string; value: string; url?: string | null }) => (
  <div className="flex items-baseline gap-2 text-xs">
    <span className="w-28 shrink-0 text-muted">{label}</span>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-fg2 underline break-all">{value}</a> : <span className="text-fg2">{value}</span>}
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
  if (!has || err) {
    const sc = lead.site_check;
    const why = sc?.screenshot_error
      ? `No screenshot: ${sc.screenshot_error}`
      : sc && sc.via !== "browser"
        ? "No screenshot: the picture comes from the browser check, and this site was read with a plain download (only sites built with JavaScript get a browser check)."
        : "No screenshot yet. A browser check takes one of the homepage.";
    return <p className="text-label text-muted">{why}</p>;
  }
  if (!url) return <p className="text-label text-muted">Loading screenshot…</p>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
      <img src={url} alt="Homepage screenshot" className="w-48 rounded-md border border-line" />
    </a>
  );
}

/** Everything the website check found, with the page each item came from. */
export function SiteDetails({ lead }: { lead: LeadInfo }) {
  const sc = lead.site_check;
  const so = lead.social ?? {};
  const src = sc?.sources ?? {};
  if (!sc?.checked_at) return <p className="text-xs text-muted">Website not checked yet. Use "Check websites" on the campaign.</p>;
  if (sc.error) return <p className="text-xs text-muted">Checked {shortDate(sc.checked_at)}: {sc.error}.{sc.needs_browser ? " A browser check may open it." : ""}</p>;
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
        <span className="text-xs text-muted">{(lead.gap_reasons ?? []).join(" · ")}</span>
      </div>
      <div className="space-y-1">
        <Row label="Chat widget" value={sc.chat_widget ?? "none found"} url={src.chat_widget} />
        {ev.chat_widget && <div className="pl-28 text-label text-muted break-all">{ev.chat_widget}</div>}
        <Row label="Online booking" value={sc.booking_tool ?? (sc.request_form ? "none (a request form only)" : "none found")} url={src.booking_tool ?? sc.request_form_url} />
        {(ev.booking_tool || ev.request_form) && <div className="pl-28 text-label text-muted break-all">{ev.booking_tool ?? ev.request_form}</div>}
        <Row label="Contact form" value={sc.has_contact_form ? "yes" : "none found"} url={sc.contact_form_url} />
        <Row label="Opening hours" value={sc.hours_usable === false ? "not used (the site says it answers any time)" : "from Google"} />
        {sc.hours_evidence && <div className="pl-28 text-label text-muted break-all">{sc.hours_evidence}</div>}
        <Row label="Looked at" value={sc.via === "browser" ? "in a real browser" : sc.needs_browser ? "plain download (needs a browser check)" : "plain download"} />
        <Row label="WhatsApp" value={sc.whatsapp_url ?? "none found"} url={sc.whatsapp_url} />
        {links.filter(([, u]) => u).map(([label, u, from]) => (
          <div key={label}>
            <Row label={label} value={u as string} url={u} />
            {from && <div className="pl-28 text-label text-muted break-all">seen on {from}</div>}
          </div>
        ))}
      </div>
      <Screenshot lead={lead as LeadRef} />
      {(sc.facts?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <div className="text-label text-muted font-medium">Website facts</div>
          {sc.facts!.map((f) => (
            <div key={f.key}>
              <Row label={FACT_LABEL[f.key] ?? f.key} value={factResult(f)} url={f.evidence?.url} />
              {f.evidence?.text && <div className="pl-28 text-label text-muted break-all">{f.evidence.text}</div>}
            </div>
          ))}
        </div>
      )}
      {sc.not_home_service && <p className="text-label text-amber-300">Check: may not be a home-service business. {sc.not_home_service}.</p>}
      {sc.lead_gen_listing && <p className="text-label text-amber-300">Check: may be a lead-gen listing. {sc.lead_gen_listing}.</p>}
      <p className="text-label text-muted">Checked {shortDate(sc.checked_at)}. Links only: LinkedIn and Facebook pages are never opened by the app.</p>
    </div>
  );
}
