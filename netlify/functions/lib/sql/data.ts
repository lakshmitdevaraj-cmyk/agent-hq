// P2 chunk 11: data.counts / data.export / data.import on Postgres (used when DATA_BACKEND=sql; master key only, as today).
//   - The old actions copy whole Blobs stores for a site move. On SQL the names are tables, from an allow-list.
//   - Never exported: service_config (service keys), access_keys (key hashes), config, voice_config (the old key copy; the table is gone since chunk 12),
//     form_links and click_links (link tokens), approvals (her say-so). Webhooks are exported without their signing secret.
//   - data.export pages by primary key (keyset), at most 500 rows a page, as {key, value} like the old answer.
//   - data.import is refused (409 use_p5_import): the P5 import runs from scripts/db with a fresh export, never through
//     the API, so nothing can write rows past the rules in lib/sql.
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export type DataAction = "data.counts" | "data.export" | "data.import";
export const DATA_ACTIONS: DataAction[] = ["data.counts", "data.export", "data.import"];

/** Table → its key column(s). Only these can be counted or exported. */
const EXPORTABLE: Record<string, string[]> = {
  campaigns: ["id"], campaign_jobs: ["campaign_id", "kind"], leads: ["id"], emails: ["id"], social_messages: ["id"], touches: ["id"],
  follow_up_state: ["lead_id", "channel"], follow_ups: ["lead_id", "channel"], replies: ["id"], clicks: ["id"], contacts: ["blob_key"],
  lead_social_links: ["lead_id", "kind"], lead_facts: ["id"], activity: ["id"], webhooks: ["id"], // forms / submissions dropped in chunk 12 (X8)
  webhook_events: ["id"], outreach_settings: ["key"], agents: ["id"], lead_forms: ["slug"], form_submissions: ["id"], link_library: ["id"],
};
const fail = (status: number, message: string, code: string): never => { throw new CampaignError(status, message, { code }); };

async function keyColumns(q: Q, table: string): Promise<string[]> {
  const rows = await q`select a.attname as col from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                       where i.indrelid = ${`public.${table}`}::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`;
  return rows.map((r) => String(r.col));
}

const clean = (table: string, r: Row): Row => {
  if (table !== "webhooks") return r;
  const data = { ...((r.data as Row) ?? {}) };
  delete data.signing_secret;
  delete data.secret;
  return { ...r, data };
};

export async function runDataAction(q: Q, action: DataAction, p: Row): Promise<unknown> {
  if (action === "data.import") return fail(409, "On the database, data is imported by the P5 import scripts from a fresh export, never through the API.", "use_p5_import");
  if (action === "data.counts") {
    const counts: Record<string, number> = {};
    for (const t of Object.keys(EXPORTABLE)) {
      try { counts[t] = Number((await q.unsafe(`select count(*)::int as n from public."${t}"`))[0].n); } catch { /* table not there yet */ }
    }
    return { counts };
  }
  const table = String(p.store ?? "");
  if (!Object.prototype.hasOwnProperty.call(EXPORTABLE, table)) fail(400, "This table cannot be exported (unknown, or it holds keys or link tokens).", "not_exportable");
  const cols = await keyColumns(q, table);
  if (!cols.length) fail(400, "This table has no key to page by.", "not_exportable");
  const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 500);
  let after: unknown[] | null = null;
  if (p.cursor) {
    try { after = JSON.parse(Buffer.from(String(p.cursor), "base64url").toString("utf8")); } catch { fail(400, "bad cursor", "bad_cursor"); }
    if (!Array.isArray(after) || after.length !== cols.length) fail(400, "bad cursor", "bad_cursor");
  }
  const id = (c: string) => `"${c.replace(/"/g, "")}"`;
  const tuple = `(${cols.map(id).join(", ")})`;
  const where = after ? `where ${tuple} > (${cols.map((_, i) => `$${i + 1}`).join(", ")})` : "";
  const rows = await q.unsafe(`select * from public."${table}" ${where} order by ${cols.map(id).join(", ")} limit ${limit + 1}`, (after ?? []) as never[]);
  const page = (rows as unknown as Row[]).slice(0, limit);
  const [{ n }] = await q.unsafe(`select count(*)::int as n from public."${table}"`);
  const keyOf = (r: Row) => cols.map((c) => String(r[c])).join("/");
  const last = page.at(-1);
  return {
    store: table,
    records: page.map((r) => ({ key: keyOf(r), value: JSON.stringify(clean(table, r)) })),
    next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify(cols.map((c) => (last[c] instanceof Date ? (last[c] as Date).toISOString() : last[c])))).toString("base64url") : null,
    total: Number(n),
  };
}
