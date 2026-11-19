import { Facebook, FileText, Globe, Instagram, Linkedin, MapPin, MessageCircle, Phone } from "lucide-react";

/** What the website check stores on a lead (all optional: older leads have none of it). */
export type LeadInfo = {
  website?: string | null;
  maps_url?: string | null;
  email?: string | null;
  phone?: string | null;
  owner_name?: string | null;
  owner_confidence?: "high" | "low" | null;
  owner_source_url?: string | null;
  owner_evidence?: string | null; // the sentence on the website that shows who the current owner is
  gap_score?: number | null;
  gap_reasons?: string[];
  social?: {
    linkedin_company?: string | null;
    linkedin_person?: string | null;
    facebook?: string | null;
    instagram?: string | null;
    yelp?: string | null;
    nextdoor?: string | null;
    google_reviews?: string | null;
  } | null;
  site_check?: {
    checked_at?: string;
    chat_widget?: string | null;
    booking_tool?: string | null;
    has_contact_form?: boolean;
    whatsapp_url?: string | null;
    contact_form_url?: string | null;
    request_form?: boolean; // "Schedule Now" that only opens the site's own contact form
    request_form_url?: string | null;
    sources?: Record<string, string>;
    evidence?: Record<string, string>;
    via?: "raw" | "browser";
    needs_browser?: boolean;
    needs_browser_reason?: string | null;
    hours_usable?: boolean;
    advertises_emergency?: boolean;
    hours_evidence?: string | null;
    not_home_service?: string | null;
    lead_gen_listing?: string | null;
    error?: string;
  } | null;
};

export type LinkItem = { kind: string; label: string; url: string };

/** Every clickable link we know for a lead, in a fixed order. */
export function leadLinks(l: LeadInfo): LinkItem[] {
  const out: LinkItem[] = [];
  const so = l.social ?? {};
  const sc = l.site_check ?? {};
  if (so.linkedin_company) out.push({ kind: "linkedin", label: "LinkedIn (company)", url: so.linkedin_company });
  if (so.linkedin_person) out.push({ kind: "linkedin", label: "LinkedIn (person)", url: so.linkedin_person });
  if (so.facebook) out.push({ kind: "facebook", label: "Facebook", url: so.facebook });
  if (so.instagram) out.push({ kind: "instagram", label: "Instagram", url: so.instagram });
  if (sc.whatsapp_url) out.push({ kind: "whatsapp", label: "WhatsApp", url: sc.whatsapp_url });
  if (sc.contact_form_url) out.push({ kind: "form", label: "Contact form", url: sc.contact_form_url });
  if (l.website) out.push({ kind: "website", label: "Website", url: l.website });
  if (l.maps_url) out.push({ kind: "maps", label: "Google Maps", url: l.maps_url });
  return out;
}

/** The ways to reach a lead that has no usable email (form, Facebook, Instagram, LinkedIn, WhatsApp). */
export function reachAnotherWay(l: LeadInfo): LinkItem[] {
  const out = leadLinks(l).filter((x) => ["linkedin", "facebook", "instagram", "whatsapp", "form"].includes(x.kind));
  if (l.phone) out.push({ kind: "phone", label: `Call them: ${l.phone}`, url: `tel:${l.phone.replace(/[^\d+]/g, "")}` });
  return out;
}

const ICONS: Record<string, typeof Globe> = { linkedin: Linkedin, facebook: Facebook, instagram: Instagram, whatsapp: MessageCircle, form: FileText, website: Globe, maps: MapPin, phone: Phone };

export function LinkIcons({ items, size = 12 }: { items: LinkItem[]; size?: number }) {
  return (
    <>
      {items.map((x, i) => {
        const Icon = ICONS[x.kind] ?? Globe;
        return (
          <a
            key={`${x.kind}-${i}`}
            href={x.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={x.label}
            aria-label={x.label}
            className="w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white flex items-center justify-center transition"
          >
            <Icon size={size} />
          </a>
        );
      })}
    </>
  );
}

/** Score pill: red = big gap (good prospect), grey = small gap. The reasons show on hover and next to it. */
export function GapBadge({ score, reasons }: { score: number | null | undefined; reasons?: string[] }) {
  if (typeof score !== "number") return <span className="text-[10px] font-mono text-white/35">not checked</span>;
  const tone = score >= 70 ? "bg-red-500/15 border-red-500/40 text-red-300" : score >= 40 ? "bg-amber-500/15 border-amber-500/40 text-amber-300" : "bg-white/10 border-white/20 text-white/70";
  return (
    <span title={(reasons ?? []).join(" · ")} className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-mono font-bold ${tone}`}>
      Gap {score}
    </span>
  );
}

/** "Dana Reyes" or "Dana Reyes (unconfirmed)" when the match was weak and is not used in greetings. */
export function ownerText(l: LeadInfo): string | null {
  if (!l.owner_name) return null;
  return l.owner_confidence === "low" ? `${l.owner_name} (unconfirmed)` : l.owner_name;
}

/** "LinkedIn and Facebook" for the links we found (website/maps/form excluded). */
export function foundSocialText(l: LeadInfo): string {
  const so = l.social ?? {};
  const names = [so.linkedin_company || so.linkedin_person ? "LinkedIn" : null, so.facebook ? "Facebook" : null, so.instagram ? "Instagram" : null, l.site_check?.whatsapp_url ? "WhatsApp" : null].filter(Boolean) as string[];
  if (names.length === 0) return "";
  return `${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`} found`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
