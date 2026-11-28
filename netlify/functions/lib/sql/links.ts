// P2 chunk 10: the links library (A3) on Postgres (used when DATA_BACKEND=sql). One table, `link_library`: a named link
// (site, booking page, demo, video, doc) with optional default UTM tags. `links.build` adds utm_* tags to a link for an
// email without ever overwriting a tag already in the link. Only http: and https: links are stored or built, so a
// javascript:, data:, mailto: or ftp: link can never reach an email.
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export type LinkAction = "links.list" | "links.create" | "links.update" | "links.delete" | "links.build";
export const LINK_ACTIONS: LinkAction[] = ["links.list", "links.create", "links.update", "links.delete", "links.build"];
export type LinkDeps = { newId: () => string };
export const LINK_TYPES = ["site", "booking", "demo", "video", "doc", "other"] as const;
export type Utm = { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;

const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };
const iso = (v: unknown): string | null => (typeof v === "string" ? new Date(v).toISOString() : v instanceof Date ? v.toISOString() : null);

export function isHttpUrl(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > 2000) return false;
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

export function withUtm(url: string, utm: Utm): string {
  if (!isHttpUrl(url)) return fail(400, "A link must start with http:// or https://");
  const u = new URL(url);
  for (const k of UTM_KEYS) {
    const v = utm[k];
    if (typeof v === "string" && v.trim() && !u.searchParams.has(`utm_${k}`)) u.searchParams.set(`utm_${k}`, v.trim());
  }
  return u.toString();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function cleanUtm(v: unknown): Utm {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) return fail(400, "utm must be an object");
  const out: Utm = {};
  for (const [k, val] of Object.entries(v as Row)) {
    if (!(UTM_KEYS as readonly string[]).includes(k)) return fail(400, `Unknown utm key: ${k}`);
    if (typeof val !== "string" || val.length > 100) return fail(400, `utm ${k} must be text of at most 100 characters`);
    if (val.trim()) out[k as keyof Utm] = val.trim();
  }
  return out;
}

function optText(p: Row, key: string, max: number): string | null | undefined {
  if (!(key in p)) return undefined;
  const v = p[key];
  if (v === null || v === "") return null;
  if (typeof v !== "string") return fail(400, `${key} must be text`);
  const t = v.trim();
  if (t.length > max) return fail(400, `${key} must be at most ${max} characters`);
  return t || null;
}

/** Validated fields that were given (all of them for a create). */
function fieldsOf(p: Row, creating: boolean): Row {
  const f: Row = {};
  if (creating || "name" in p) {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name || name.length > 120) return fail(400, "A link needs a name of 1 to 120 characters");
    f.name = name;
  }
  if (creating || "url" in p) {
    if (!isHttpUrl(p.url)) return fail(400, "A link must start with http:// or https://");
    f.url = p.url;
  }
  if ("type" in p || creating) {
    const t = p.type === undefined || p.type === null || p.type === "" ? "other" : p.type;
    if (!(LINK_TYPES as readonly unknown[]).includes(t)) return fail(400, `type must be one of ${LINK_TYPES.join(", ")}`);
    if (creating || "type" in p) f.type = t;
  }
  const niche = optText(p, "niche", 200); if (niche !== undefined) f.niche = niche;
  const note = optText(p, "note", 1000); if (note !== undefined) f.note = note;
  if ("utm" in p) f.utm = cleanUtm(p.utm);
  else if (creating) f.utm = {};
  return f;
}

function shape(r: Row): Row {
  return { id: r.id, name: r.name, type: r.type, url: r.url, niche: r.niche ?? null, note: r.note ?? null, utm: (r.utm as Row) ?? {}, created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
}

export async function runLinkAction(q: Q, action: LinkAction, p: Record<string, unknown>, deps: LinkDeps): Promise<unknown> {
  switch (action) {
    case "links.list": {
      const type = typeof p.type === "string" && p.type ? p.type : null;
      const niche = typeof p.niche === "string" && p.niche ? p.niche : null;
      const term = typeof p.q === "string" && p.q.trim() ? `%${p.q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
      const rows = await q`select * from link_library
        where (${type}::text is null or type = ${type}::text)
          and (${niche}::text is null or niche = ${niche}::text)
          and (${term}::text is null or name ilike ${term}::text or url ilike ${term}::text or note ilike ${term}::text)
        order by lower(name), id`;
      return { links: (rows as unknown as Row[]).map(shape) };
    }
    case "links.create": {
      const f = fieldsOf(p, true);
      const row = { id: deps.newId(), ...f, utm: q.json(f.utm as never) };
      const [r] = await q`insert into link_library ${q(row as never)} returning *`;
      return shape(r as Row);
    }
    case "links.update": {
      const id = String(p.id ?? "");
      const f = fieldsOf(p, false);
      const [cur] = await q`select id from link_library where id = ${id} for update`;
      if (!cur) return fail(404, "Link not found");
      const row: Row = { ...f };
      if (f.utm !== undefined) row.utm = q.json(f.utm as never);
      if (!Object.keys(row).length) return shape(((await q`update link_library set updated_at = clock_timestamp() where id = ${id} returning *`)[0]) as Row);
      const [r] = await q`update link_library set ${q(row as never)}, updated_at = clock_timestamp() where id = ${id} returning *`;
      return shape(r as Row);
    }
    case "links.delete": {
      const id = String(p.id ?? "");
      const gone = await q`delete from link_library where id = ${id} returning id`;
      if (!gone.length) return fail(404, "Link not found");
      return { deleted: true, id };
    }
    case "links.build": {
      let base: string;
      let libUtm: Utm = {};
      if (typeof p.id === "string" && p.id) {
        const [r] = await q`select url, utm from link_library where id = ${p.id}`;
        if (!r) return fail(404, "Link not found");
        base = String(r.url);
        libUtm = (r.utm as Utm) ?? {};
      } else if (typeof p.url === "string" && p.url) base = p.url;
      else return fail(400, "links.build needs an id or a url");
      if (!isHttpUrl(base)) return fail(400, "A link must start with http:// or https://");
      const utm: Utm = { source: "alcance", medium: "email" };
      if (typeof p.campaign_id === "string" && p.campaign_id) {
        const [c] = await q`select name from campaigns where id = ${p.campaign_id}`;
        const s = c ? slug(String(c.name ?? "")) : "";
        if (s) utm.campaign = s;
      }
      Object.assign(utm, libUtm, cleanUtm(p.utm));
      return { url: withUtm(base, utm) };
    }
    default:
      return fail(400, `Unknown links action: ${String(action)}`);
  }
}
