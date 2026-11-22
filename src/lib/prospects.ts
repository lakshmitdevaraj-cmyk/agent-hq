import { factResult, type LeadInfo } from "@/lib/leadInfo";

export type EmailState = "not_emailed" | "emailed" | "replied" | "bounced" | "do_not_contact";

export type Prospect = LeadInfo & {
  id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  name: string;
  category: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  rating: number | null;
  reviews_count: number | null;
  is_test: boolean;
  email_status: EmailState;
  emailed_at: string | null;
  hours_summary: string | null;
  checked_at: string | null;
  owner_source?: string | null;
  review_status?: "ready" | "check" | "blocked" | null;
  social_sent?: Array<{ channel: string; sent_at: string }>;
  excluded?: boolean;
  excluded_reason?: string | null;
  excluded_note?: string | null;
  auto_not_fit?: { code: string; detail: string } | null;
  not_fit_kept?: boolean;
  email_source?: string | null;
  /** A known look-alike of a real mail/ISP domain (consolidate.net for consolidated.net). A flag only. */
  email_typo?: { domain: string; suggestion: string } | null;
  email_manual_at?: string | null;
};

/** HQ's own flags that hide a lead like a ticked Not a fit (until you keep it). Other automatic skips (state, trade, bad address) are only labelled. */
const AUTO_HIDE = ["wholesaler", "lead_gen", "not_home_service", "chain"];
export const autoHidden = (r: Prospect): boolean => !r.excluded && !r.not_fit_kept && !!r.auto_not_fit && AUTO_HIDE.includes(r.auto_not_fit.code);
/** Hidden by default: ticked by you, or flagged by HQ and not kept. */
export const isNotFit = (r: Prospect): boolean => !!r.excluded || autoHidden(r);

/** Why a lead is "Not a fit" (the dropdown). The code is what is stored on the lead. */
export const NOT_FIT_REASONS: Array<{ code: string; label: string }> = [
  { code: "wholesaler", label: "Wholesaler / supplier" },
  { code: "lead_gen", label: "Lead-gen listing" },
  { code: "not_home_service", label: "Not home service" },
  { code: "has_chat_booking", label: "Already has chat + booking" },
  { code: "chain", label: "Chain / franchise" },
  { code: "other", label: "Other" },
];
export const reasonLabel = (code: string | null | undefined): string => NOT_FIT_REASONS.find((r) => r.code === code)?.label ?? "";

/** Gap scores under this get a grey "Low gap" hint. A hint only: nothing is skipped because of it, except the bulk social run. */
export const LOW_GAP = 30;

/** Every channel we contacted the lead on, oldest first: Email from sent emails, the rest from "Mark as sent". */
export function contactedList(r: Prospect): Array<{ channel: string; at: string }> {
  const label: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
  const out: Array<{ channel: string; at: string }> = [];
  if (r.emailed_at) out.push({ channel: "Email", at: r.emailed_at });
  for (const x of r.social_sent ?? []) out.push({ channel: label[x.channel] ?? x.channel, at: x.sent_at });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
const dayMonth = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
/** "Email 21 Nov · Facebook 22 Nov" (empty when nothing was sent). */
export const contactedText = (r: Prospect): string => contactedList(r).map((c) => `${c.channel} ${dayMonth(c.at)}`).join(" · ");

export type HasKey = "linkedin" | "facebook" | "instagram" | "whatsapp" | "form" | "email" | "phone";
export const HAS_OPTIONS: { key: HasKey; label: string }[] = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "form", label: "Contact form" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

export function hasChannel(r: Prospect, k: HasKey): boolean {
  const so = r.social ?? {};
  switch (k) {
    case "linkedin": return !!(so.linkedin_company || so.linkedin_person);
    case "facebook": return !!so.facebook;
    case "instagram": return !!so.instagram;
    case "whatsapp": return !!r.site_check?.whatsapp_url;
    case "form": return !!r.site_check?.contact_form_url;
    case "email": return !!r.email;
    case "phone": return !!r.phone;
  }
}

export const REVIEW_LABEL: Record<string, string> = { ready: "Ready", check: "Check", blocked: "Blocked" };

/** Warning labels from the website check (empty when nothing looks off). */
export function fitLabels(r: Prospect): string[] {
  const out: string[] = [];
  if (r.site_check?.not_home_service) out.push("Check: may not be a home-service business");
  if (r.site_check?.lead_gen_listing) out.push("Check: may be a lead-gen listing");
  return out;
}

export const STATUS_LABEL: Record<EmailState, string> = {
  not_emailed: "Not emailed",
  emailed: "Emailed",
  replied: "Replied",
  bounced: "Bounced",
  do_not_contact: "Do not contact",
};

/** Town from a Google Maps address: "12 Main St, Sugar Land, TX 77478, USA" -> "Sugar Land". */
export function areaOf(address: string | null | undefined): string {
  const parts = (address ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const last = parts[parts.length - 1];
  const idx = /^(USA|US|United States)$/i.test(last) ? parts.length - 3 : parts.length - 2;
  const town = parts[Math.max(0, idx)];
  return /\d/.test(town) && parts.length > 2 ? parts[Math.max(0, idx - 1)] ?? town : town;
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  // Stop spreadsheet formulas: a cell starting with = + - @ is shown as text.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function prospectsToCsv(rows: Prospect[]): string {
  const head = ["Business", "Owner", "Owner confidence", "Campaign", "Niche", "Area", "Address", "Email", "Phone", "Gap score", "Gap reasons", "Email status", "Draft review", "Warnings", "Not a fit", "Not a fit reason", "Not a fit note", "Contacted", "Emailed on", "Social messages sent", "Website", "Mobile friendly", "Tap-to-call link", "Secure (https)", "Copyright year", "LinkedIn company", "LinkedIn person", "Facebook", "Instagram", "WhatsApp", "Contact form", "Yelp", "Nextdoor", "Google reviews", "Google Maps"];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    const so = r.social ?? {};
    lines.push(
      [
        r.name, r.owner_name, r.owner_confidence, r.campaign_name, r.category, areaOf(r.address), r.address, r.email, r.phone,
        r.gap_score, (r.gap_reasons ?? []).join("; "), STATUS_LABEL[r.email_status], r.review_status ? REVIEW_LABEL[r.review_status] : "", fitLabels(r).join("; "), isNotFit(r) ? "Yes" : "", r.excluded ? reasonLabel(r.excluded_reason) : (r.auto_not_fit ? `${reasonLabel(r.auto_not_fit.code) || "Other"} (automatic)` : (r.not_fit_kept ? "Kept by me" : "")), r.excluded ? (r.excluded_note ?? "") : "", contactedText(r), r.emailed_at ? r.emailed_at.slice(0, 10) : "", (r.social_sent ?? []).map((x) => `${x.channel} ${x.sent_at.slice(0, 10)}`).join("; "), r.website,
        ...["not_mobile_friendly", "phone_not_tappable", "no_https", "old_copyright"].map((k) => { const f = r.site_check?.facts?.find((x) => x.key === k); return f ? factResult(f) : ""; }),
        so.linkedin_company, so.linkedin_person, so.facebook, so.instagram, r.site_check?.whatsapp_url, r.site_check?.contact_form_url,
        so.yelp, so.nextdoor, so.google_reviews, r.maps_url,
      ].map(csvCell).join(","),
    );
  }
  // BOM so Excel and Google Sheets read accents correctly.
  return "﻿" + lines.join("\r\n");
}

export function downloadCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
