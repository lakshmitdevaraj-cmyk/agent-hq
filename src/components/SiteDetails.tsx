import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import { GapBadge, shortDate, type LeadInfo } from "@/lib/leadInfo";

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

/** Everything the website check found, with the page each item came from. */
export function SiteDetails({ lead }: { lead: LeadInfo }) {
  const sc = lead.site_check;
  const so = lead.social ?? {};
  const src = sc?.sources ?? {};
  if (!sc?.checked_at) return <p className="text-xs text-white/50">Website not checked yet. Use "Check websites" on the campaign.</p>;
  if (sc.error) return <p className="text-xs text-white/50">Checked {shortDate(sc.checked_at)}: {sc.error}.</p>;
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
        <Row label="Online booking" value={sc.booking_tool ?? "none found"} url={src.booking_tool} />
        <Row label="Contact form" value={sc.has_contact_form ? "yes" : "none found"} url={sc.contact_form_url} />
        <Row label="WhatsApp" value={sc.whatsapp_url ?? "none found"} url={sc.whatsapp_url} />
        {links.filter(([, u]) => u).map(([label, u, from]) => (
          <div key={label}>
            <Row label={label} value={u as string} url={u} />
            {from && <div className="pl-28 text-[10px] text-white/35 break-all">seen on {from}</div>}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-white/35">Checked {shortDate(sc.checked_at)}. Links only: LinkedIn and Facebook pages are never opened by the app.</p>
    </div>
  );
}
