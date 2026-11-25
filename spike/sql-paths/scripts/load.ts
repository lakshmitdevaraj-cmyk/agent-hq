// Creates the s75_ tables, copies the fake data in, and builds each lead's finished row for variant B.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
// @ts-ignore plain .mjs helpers
import { db } from "../../scripts/env.mjs";
// @ts-ignore
import { load } from "../db/data.mjs";
import { buildRows, related } from "../src/prospects";

const SIZES = [25, 100, 500, 1500];
const sql = db();
await sql.unsafe(readFileSync("db/schema.sql", "utf8"));
const out: Record<string, unknown> = {};
for (const size of SIZES) {
  const ds = `d${size}`;
  await load(sql, size);
  const leads = (await sql`select data from spike.s75_leads where ds = ${ds}`).map((r: any) => r.data);
  const rows = buildRows(leads, await related(sql, ds, null));
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500).map((r) => ({ id: r.id, j: JSON.stringify(r) }));
    await sql`update spike.s75_leads l set row_json = x.j from jsonb_to_recordset(${JSON.stringify(part)}::text::jsonb) as x(id text, j text) where l.ds = ${ds} and l.id = x.id`;
  }
  const [n] = await sql`select
    (select count(*)::int from spike.s75_leads where ds = ${ds}) as leads, (select count(*)::int from spike.s75_emails where ds = ${ds}) as emails,
    (select count(*)::int from spike.s75_contacts where ds = ${ds}) as contacts, (select count(*)::int from spike.s75_replies where ds = ${ds}) as replies`;
  out[ds] = n;
  console.log(ds, JSON.stringify(n));
}
for (const t of ["s75_leads", "s75_emails", "s75_contacts", "s75_campaigns"]) await sql.unsafe(`analyze spike.${t}`);
const [s] = await sql`select pg_database_size(current_database())::bigint as db_bytes,
  (select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'spike' and c.relkind = 'r' and c.relname like 's75\_%') as s75_bytes`;
mkdirSync("results", { recursive: true });
writeFileSync("results/data.json", JSON.stringify({ rows: out, db_bytes: Number(s.db_bytes), s75_bytes: Number(s.s75_bytes) }, null, 1));
await sql.end();
