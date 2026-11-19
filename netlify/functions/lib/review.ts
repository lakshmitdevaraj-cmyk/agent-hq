/**
 * Review helpers (pure): the saved evidence the reviewer sees, code-only
 * safety checks that never depend on a model, and reading the reviewer's JSON.
 */

export type ReviewStatus = "ready" | "check" | "blocked";
export type Verdict = { status: ReviewStatus; reasons: string[]; problem: "none" | "wording" | "facts"; rewrite: { subject: string; body: string } | null };

const FORMER_WORDS = /\b(retired|former(?:ly)?|sold the|the late|passed away|stepped down|previous owner)\b/i;

export type ReviewLead = {
  name?: string | null;
  category?: string | null;
  contact_name?: string | null;
  is_test?: boolean;
  owner_name?: string | null;
  owner_confidence?: string | null;
  owner_evidence?: string | null;
  owner_source?: string | null;
  owner_source_url?: string | null;
  site_check?: {
    error?: string;
    via?: string;
    chat_widget?: string | null;
    booking_tool?: string | null;
    has_contact_form?: boolean;
    request_form?: boolean;
    hours_usable?: boolean;
    hours_evidence?: string | null;
    needs_browser?: boolean;
    evidence?: Record<string, string>;
    not_home_service?: string | null;
    lead_gen_listing?: string | null;
  } | null;
  hours_summary?: string | null;
};

/** Everything the reviewer may rely on, as a compact JSON object. */
export function evidenceFor(lead: ReviewLead): Record<string, unknown> {
  const sc = lead.site_check ?? {};
  return {
    business: lead.name ?? null,
    category: lead.category ?? null,
    owner: lead.owner_name ? { name: lead.owner_name, confidence: lead.owner_confidence ?? null, evidence_sentence: lead.owner_evidence ?? null, source: lead.owner_source ?? null } : null,
    website_checked: !!lead.site_check && !sc.error,
    checked_in_browser: sc.via === "browser",
    still_needs_browser_check: !!sc.needs_browser && sc.via !== "browser",
    live_chat: sc.chat_widget ?? "none found",
    online_booking: sc.booking_tool ?? "none found",
    contact_or_request_form: !!(sc.has_contact_form || sc.request_form),
    google_opening_hours: lead.hours_summary ?? null,
    opening_hours_may_be_used: sc.hours_usable !== false,
    site_says_open_any_time: sc.hours_usable === false ? sc.hours_evidence ?? true : false,
    evidence: sc.evidence ?? {},
    fit_warnings: [sc.not_home_service, sc.lead_gen_listing].filter(Boolean),
  };
}

/** Safety checks that never depend on a model. */
export function codeReview(lead: ReviewLead, greeting: string | null, usedFact: boolean): { blocked: string[]; check: string[] } {
  const blocked: string[] = [];
  const check: string[] = [];
  const sc = lead.site_check;
  const named = !!greeting && !/^hi there$/i.test(greeting);
  if (named) {
    const manual = lead.owner_source === "manual" || lead.is_test === true;
    if (!manual) {
      if (lead.owner_evidence && FORMER_WORDS.test(lead.owner_evidence) && !/purchased|bought|took over|now owns|current owner/i.test(lead.owner_evidence)) blocked.push(`Greets ${greeting.replace(/^Hi /, "")}, but the owner evidence suggests they are not the current owner.`);
      else if (lead.owner_confidence && lead.owner_confidence !== "high") blocked.push("Greets a name that is only a low-confidence guess for the owner.");
      else if (!lead.owner_evidence) check.push("The owner's name has no saved evidence (checked before evidence was recorded). Re-check the website.");
    }
  }
  if (usedFact && (!sc || sc.error)) blocked.push("Mentions something about the website, but the website was never checked.");
  if (usedFact && sc?.needs_browser && sc.via !== "browser") blocked.push("Mentions a website gap, but the site still needs a browser check.");
  if (sc?.not_home_service) check.push("May not be a home-service business.");
  if (sc?.lead_gen_listing) check.push("May be a lead-gen listing, not a real company.");
  return { blocked, check };
}

/** Read the reviewer's JSON; anything malformed becomes "check". */
export function parseVerdict(raw: unknown): Verdict {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = String(o.verdict ?? "").toLowerCase();
  const status: ReviewStatus = v === "ready" || v === "blocked" ? v : "check";
  const problem = o.problem === "facts" || o.problem === "wording" ? o.problem : "none";
  const reasons = Array.isArray(o.reasons) ? o.reasons.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 5) : [];
  const rw = o.rewrite && typeof o.rewrite === "object" ? (o.rewrite as Record<string, unknown>) : null;
  const rewrite = rw && typeof rw.subject === "string" && typeof rw.body === "string" && rw.body.trim() ? { subject: rw.subject.trim(), body: rw.body.trim() } : null;
  if (!("verdict" in o)) return { status: "check", reasons: ["The reviewer's answer could not be read."], problem: "none", rewrite: null };
  return { status, reasons, problem, rewrite };
}
