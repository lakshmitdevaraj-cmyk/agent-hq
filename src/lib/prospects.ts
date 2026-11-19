import type { LeadInfo } from "@/lib/leadInfo";

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
};

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
  const head = ["Business", "Owner", "Owner confidence", "Campaign", "Niche", "Area", "Address", "Email", "Phone", "Gap score", "Gap reasons", "Email status", "Emailed on", "Website", "LinkedIn company", "LinkedIn person", "Facebook", "Instagram", "WhatsApp", "Contact form", "Yelp", "Nextdoor", "Google reviews", "Google Maps"];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    const so = r.social ?? {};
    lines.push(
      [
        r.name, r.owner_name, r.owner_confidence, r.campaign_name, r.category, areaOf(r.address), r.address, r.email, r.phone,
        r.gap_score, (r.gap_reasons ?? []).join("; "), STATUS_LABEL[r.email_status], r.emailed_at ? r.emailed_at.slice(0, 10) : "", r.website,
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
