// P2 chunk 4, A1: add leads by hand (one, a pasted list, or a CSV). Before anything is added, each row is checked
// across ALL campaigns on its email, website, phone and link (a Google Maps link or a Facebook / Instagram / LinkedIn
// page); a duplicate is not added and the answer says which lead it matched and on what. Nothing is ever fetched:
// a LinkedIn link (or any other) is only stored, as a hand-typed link (source 'manual', protected by 0007).
import { CampaignError } from "./campaigns.ts";
import { leadRecord, type Q } from "./leads.ts";
import { emailKey, websiteKey, cleanEmail, isJunkEmail, isGovEduEmail } from "../outreach.ts";

type Row = Record<string, unknown>;
const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };

// ── Keys (TypeScript copies of scripts/db/normalise.mjs; the test checks they give the same answers) ──

const TRACKING = /^(utm_\w+|fbclid|gclid|igsh|igshid|mibextid|ref|refid|hl|_rdr|trk|originalSubdomain)$/i;
const PROFILE_SITES = ["facebook.com", "instagram.com", "linkedin.com"];

/** F12: one form per page. { platform, url_norm }, or null when it is not a web address. */
export function normaliseSocialUrl(raw: unknown): { platform: string; url_norm: string } | null {
  const text = String(raw ?? "").trim();
  if (!text || /\s/.test(text)) return null;
  let u: URL;
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

export const phoneKey = (phone: unknown): string | null => { const d = String(phone ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };

/** What a link is: a Google Maps link (with its place id when the link has one), a social page, or nothing we know. */
function linkInfo(link: unknown): { maps?: { url: string; placeId: string | null }; social?: { kind: string; url: string; url_norm: string; platform: string } } {
  if (typeof link !== "string" || !link.trim()) return {};
  const url = link.trim();
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { return {}; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (/^(google\.[a-z.]+|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$/.test(host) && (host.startsWith("maps") || u.pathname.startsWith("/maps") || host.includes("goo.gl"))) {
    return { maps: { url, placeId: u.searchParams.get("query_place_id") } };
  }
  const n = normaliseSocialUrl(url);
  if (!n || !["facebook", "instagram", "linkedin"].includes(n.platform)) return {};
  const kind = n.platform !== "linkedin" ? n.platform : /\/in\//.test(n.url_norm) ? "linkedin_person" : "linkedin_company";
  return { social: { kind, url, url_norm: n.url_norm, platform: n.platform } };
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** Splits one line on commas, keeping quoted fields whole ("a, b" stays one field; "" is a quote). */
function splitCommas(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const isEmailish = (s: string) => /@/.test(s) && !/\s/.test(s);
const isLinkish = (s: string) => /(^|\/\/|\.)(google\.[a-z.]+\/maps|maps\.google|maps\.app\.goo\.gl|goo\.gl\/maps|facebook\.com|fb\.com|instagram\.com|linkedin\.com)/i.test(s);
const isPhoneish = (s: string) => !/[a-z]/i.test(s) && s.replace(/\D/g, "").length >= 10;
const isWebish = (s: string) => /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s);

/** A pasted list: one lead per line, tab- or comma-separated, fields recognised by what they look like. */
export function parsePaste(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = (line.includes("\t") ? line.split("\t").map((s) => s.trim()) : splitCommas(line)).filter(Boolean);
    const row: Row = {};
    const rest: string[] = [];
    for (const f of fields) {
      if (!row.email && isEmailish(f)) row.email = f;
      else if (!row.link && isLinkish(f)) row.link = f;
      else if (!row.phone && isPhoneish(f)) row.phone = f;
      else if (!row.website && isWebish(f)) row.website = f;
      else rest.push(f);
    }
    if (rest.length) row.name = rest[0];
    rows.push(Object.fromEntries(["name", "website", "phone", "email", "link"].filter((k) => row[k] !== undefined).map((k) => [k, row[k]])));
  }
  return rows;
}

const HEADERS: Record<string, string> = {
  name: "name", business: "name", "business name": "name", company: "name",
  website: "website", site: "website", url: "website",
  phone: "phone", "phone number": "phone", telephone: "phone",
  email: "email", "e-mail": "email", "email address": "email",
  link: "link", maps: "link", "google maps": "link", facebook: "link", instagram: "link", linkedin: "link",
  address: "address", category: "category",
};

/** CSV with a header row (any order and case). Quotes, "" escapes, commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = "", rec: string[] = [], q = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { rec.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; rec.push(field); records.push(rec); rec = []; field = ""; }
    else field += ch;
  }
  if (field !== "" || rec.length) { rec.push(field); records.push(rec); }
  const [head, ...body] = records;
  if (!head) return [];
  const cols = head.map((h) => HEADERS[h.trim().toLowerCase()] ?? null);
  const rows: Row[] = [];
  for (const r of body) {
    if (r.every((v) => !v.trim())) continue;
    const row: Row = {};
    cols.forEach((c, i) => { const v = (r[i] ?? "").trim(); if (c && v && row[c] === undefined) row[c] = v; });
    rows.push(row);
  }
  return rows;
}

// ── The duplicate check ────────────────────────────────────────────────────

export type DupMatch = { lead_id: string; campaign_id: string | null; campaign_name: string | null; name: string | null; on: "email" | "website" | "phone" | "link" };
type Keys = { email: string | null; website: string | null; phone: string | null; placeId: string | null; mapsUrl: string | null; socialNorm: string | null };

const keysOf = (r: Row): Keys => {
  const li = linkInfo(r.link);
  return { email: emailKey(r.email as string | null), website: websiteKey(r.website as string | null), phone: phoneKey(r.phone), placeId: li.maps?.placeId ?? null, mapsUrl: li.maps ? li.maps.url : null, socialNorm: li.social?.url_norm ?? null };
};

/** For each row, an existing lead (any campaign, not merged) it duplicates, or null. Four queries in all. */
export async function findDuplicates(sql: Q, rows: Row[]): Promise<Array<DupMatch | null>> {
  const keys = rows.map(keysOf);
  const list = (k: keyof Keys) => [...new Set(keys.map((x) => x[k]).filter((v): v is string => !!v))];
  const cols = sql`l.id, l.campaign_id, c.name as campaign_name, l.name`;
  const [byEmail, byWebsite, byPhone, byLink] = await Promise.all([
    sql`select ${cols}, l.email_key as k from leads l left join campaigns c on c.id = l.campaign_id where l.merged_into is null and l.email_key = any(${list("email")}) order by l.created_at, l.id`,
    sql`select ${cols}, l.website_key as k from leads l left join campaigns c on c.id = l.campaign_id where l.merged_into is null and l.website_key = any(${list("website")}) order by l.created_at, l.id`,
    sql`select ${cols}, right(regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g'), 10) as k from leads l left join campaigns c on c.id = l.campaign_id
        where l.merged_into is null and right(regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g'), 10) = any(${list("phone")}) order by l.created_at, l.id`,
    sql`select ${cols}, 'p:' || (l.data->'raw'->>'placeId') as k from leads l left join campaigns c on c.id = l.campaign_id where l.merged_into is null and (l.data->'raw'->>'placeId') = any(${list("placeId")})
        union all select ${cols}, 'm:' || (l.data->>'maps_url') from leads l left join campaigns c on c.id = l.campaign_id where l.merged_into is null and (l.data->>'maps_url') = any(${list("mapsUrl")})
        union all select ${cols}, 's:' || p.url_norm from lead_social_links k join social_pages p on p.id = k.page_id join leads l on l.id = k.lead_id left join campaigns c on c.id = l.campaign_id
          where l.merged_into is null and p.url_norm = any(${list("socialNorm")})`,
  ]);
  const first = (rs: Row[]) => { const m = new Map<string, Row>(); for (const r of rs) if (!m.has(r.k as string)) m.set(r.k as string, r); return m; };
  const [e, w, p, l] = [first(byEmail), first(byWebsite), first(byPhone), first(byLink)];
  const match = (r: Row | undefined, on: DupMatch["on"]): DupMatch | null => r ? { lead_id: r.id as string, campaign_id: (r.campaign_id as string | null) ?? null, campaign_name: (r.campaign_name as string | null) ?? null, name: (r.name as string | null) ?? null, on } : null;
  return keys.map((k) =>
    match(k.email ? e.get(k.email) : undefined, "email") ?? match(k.website ? w.get(k.website) : undefined, "website") ?? match(k.phone ? p.get(k.phone) : undefined, "phone")
    ?? match((k.placeId && l.get(`p:${k.placeId}`)) || (k.mapsUrl && l.get(`m:${k.mapsUrl}`)) || (k.socialNorm && l.get(`s:${k.socialNorm}`)) || undefined, "link"));
}

// ── Adding ─────────────────────────────────────────────────────────────────

export const ADD_FORMATS = ["single", "paste", "csv"] as const;
const MAX_ROWS = 500;

/** outreach.leads.add (A1). The caller passes a transaction: every row of one request is added together or not at all. */
export async function addLeads(sql: Q, params: Row, ctx: { newId: () => string }): Promise<{ added: Row[]; duplicates: Row[]; refused: Row[] }> {
  const { campaign_id, format } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  if (!(ADD_FORMATS as readonly unknown[]).includes(format)) fail(400, `format must be one of: ${ADD_FORMATS.join(", ")}`);
  const raw: Row[] = format === "single" ? (params.lead && typeof params.lead === "object" ? [params.lead as Row] : []) : format === "paste" ? parsePaste(String(params.text ?? "")) : parseCsv(String(params.text ?? ""));
  if (!raw.length) fail(400, "nothing to add");
  if (raw.length > MAX_ROWS) fail(400, `at most ${MAX_ROWS} leads at a time`);
  const [camp] = await sql`select id from campaigns where id = ${campaign_id as string}`;
  if (!camp) fail(404, "campaign not found");

  const refused: Row[] = [], duplicates: Row[] = [];
  const clean: Array<{ i: number; row: Row }> = [];
  raw.forEach((r, i) => {
    const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).replace(/\s+/g, " ").trim() : "") || null;
    const row: Row = { name: str("name"), website: str("website"), phone: str("phone"), email: str("email"), link: str("link"), address: str("address"), category: str("category") };
    if (!row.name) return refused.push({ row: i, name: null, reason: "a name is needed" });
    if (!row.website && !row.phone && !row.email && !row.link) return refused.push({ row: i, name: row.name, reason: "a website, phone, email or link is needed" });
    if (row.email) {
      const e = cleanEmail(row.email as string);
      if (!e || isJunkEmail(e)) return refused.push({ row: i, name: row.name, reason: "that is not a valid email address" });
      if (isGovEduEmail(e)) return refused.push({ row: i, name: row.name, reason: "a .gov or .edu address is never used as a sales contact" });
      row.email = e;
    }
    clean.push({ i, row });
  });

  const found = await findDuplicates(sql, clean.map((c) => c.row));
  const seen = new Map<string, number>(); // key → row index, for repeats inside this request
  const toAdd: Array<{ i: number; row: Row; keys: Keys }> = [];
  clean.forEach(({ i, row }, j) => {
    if (found[j]) return duplicates.push({ row: i, name: row.name, match: found[j] });
    const keys = keysOf(row);
    const mine = ([["email", keys.email], ["website", keys.website], ["phone", keys.phone], ["link", keys.placeId ?? keys.mapsUrl ?? keys.socialNorm]] as const).filter(([, v]) => v).map(([on, v]) => [on, `${on}:${v}`] as const);
    const hit = mine.find(([, k]) => seen.has(k));
    if (hit) return duplicates.push({ row: i, name: row.name, match: { row: seen.get(hit[1]), on: hit[0] } });
    for (const [, k] of mine) seen.set(k, i);
    toAdd.push({ i, row, keys });
  });

  const added: Row[] = [];
  const now = new Date();
  for (const { row, keys } of toAdd) {
    const id = ctx.newId();
    const li = linkInfo(row.link);
    const data: Row = { source: "added_by_hand", added_as: format, raw: { source: "added_by_hand", ...(keys.placeId ? { placeId: keys.placeId } : {}) }, ...(li.maps ? { maps_url: li.maps.url } : {}) };
    await sql`insert into leads ${sql({
      id, campaign_id: campaign_id as string, name: row.name as string, email: (row.email as string | null) ?? null, email_key: keys.email, email_source: row.email ? "manual" : null,
      phone: (row.phone as string | null) ?? null, website: (row.website as string | null) ?? null, website_key: keys.website, address: (row.address as string | null) ?? null,
      category: (row.category as string | null) ?? null, status: "new", created_at: now, updated_at: now, data: sql.json(data as never) as never,
    })}`;
    if (li.social) {
      await sql`insert into social_pages (platform, url_norm, url) values (${li.social.platform}, ${li.social.url_norm}, ${li.social.url}) on conflict (url_norm) do nothing`;
      await sql`insert into lead_social_links (lead_id, kind, page_id, url, source)
                select ${id}, ${li.social.kind}, id, ${li.social.url}, 'manual' from social_pages where url_norm = ${li.social.url_norm}`;
    }
    const [r] = await sql`select * from leads where id = ${id}`;
    added.push(leadRecord(r));
  }
  return { added, duplicates, refused };
}
