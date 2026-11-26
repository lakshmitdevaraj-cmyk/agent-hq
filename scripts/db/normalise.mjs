// Address and name normalisation used by the import.

const TRACKING = /^(utm_\w+|fbclid|gclid|igsh|igshid|mibextid|ref|refid|hl|_rdr|trk|originalSubdomain)$/i;
// On these, everything after "?" is tracking (except the id of profile.php) and handles ignore case.
const PROFILE_SITES = ["facebook.com", "instagram.com", "linkedin.com"];

/** F12: one form per page. Returns { platform, url_norm } or null when it is not a web address. */
export function normaliseSocialUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /\s/.test(text)) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  let host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, "");
  if (!host.includes(".")) return null;
  if (host === "fb.com") host = "facebook.com";
  const profileSite = PROFILE_SITES.find((s) => host === s || host.endsWith(`.${s}`));
  let path = u.pathname.replace(/\/+$/, "");
  let query = "";
  if (profileSite) {
    path = path.toLowerCase();
    if (path.endsWith("/profile.php") && u.searchParams.get("id")) query = `?id=${u.searchParams.get("id")}`;
  } else {
    const kept = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    if (kept.length) query = `?${new URLSearchParams(kept)}`;
  }
  const platform = profileSite ? profileSite.split(".")[0] : host;
  return { platform, url_norm: `https://${host}${path}${query}` };
}

/** A business name for comparing: lower case, no punctuation or company ending. */
export const nameKey = (name) => String(name ?? "").toLowerCase().replace(/&/g, " and ").replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(llc|inc|co|ltd|corp|company)\b/g, " ").replace(/\s+/g, " ").trim();

export const phoneKey = (phone) => { const d = String(phone ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };

const STATE_NAMES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };

/** "Katy, TX" or "Pearland, Texas, USA" → { country: "US", state: "TX" }. Anything else → nulls (reported). */
export function areaCountry(area, stateZones) {
  const parts = String(area ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (/^(usa|us|united states)$/i.test(parts.at(-1) ?? "")) parts.pop();
  const last = parts.length > 1 ? parts.at(-1) : "";
  const state = stateZones[last.toUpperCase()] ? last.toUpperCase() : STATE_NAMES[last.toLowerCase()] ?? null;
  return state ? { country: "US", state } : { country: null, state: null };
}
