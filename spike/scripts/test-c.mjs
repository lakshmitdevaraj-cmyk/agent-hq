// Test C: warm timings, a correctness check of the follow-up rules, then one call after each 6.5-minute silence.
import { writeFileSync } from "node:fs";
import { call, startTail, sleep } from "./remote.mjs";
import { db } from "./env.mjs";

const ENDPOINTS = {
  prospects_no_email_social: "/q/prospects?filter=no_email_social",
  prospects_emailed_no_reply: "/q/prospects?filter=emailed_no_reply",
  prospects_due_today: "/q/prospects?filter=due_today",
  followups: "/q/followups",
  campaign_page: "/q/campaign?id=c1",
};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const stats = (a) => ({ n: a.length, median: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? Math.max(...a) : null });
const out = { at: new Date().toISOString(), warm: {}, cold: {}, checks: {} };
const save = () => writeFileSync("results/c-queries.json", JSON.stringify(out, null, 1));
let n = 0;

const tail = await startTail("c");
const warmIds = {};
for (const [name, path] of Object.entries(ENDPOINTS)) {
  await call(path); // warm up, not counted
  const calls = [];
  for (let i = 0; i < 20; i++) { const rid = `c${++n}`; const r = await call(path, rid); calls.push({ rid, ...r }); await sleep(250); }
  warmIds[name] = calls;
}
await sleep(12_000);
let cf = tail.byRid();
for (const [name, calls] of Object.entries(warmIds)) {
  const cpu = calls.map((c) => cf[c.rid]?.cpu).filter((x) => x !== undefined);
  out.warm[name] = {
    rows: Number(calls[0].headers["x-rows"]), response_kb: Math.round(calls[0].bytes / 1024), statuses: [...new Set(calls.map((c) => c.status))],
    client_ms: stats(calls.map((c) => c.ms)), db_ms: stats(calls.map((c) => Number(c.headers["x-db-ms"]))), cpu_ms: stats(cpu),
    outcomes: [...new Set(calls.map((c) => cf[c.rid]?.outcome).filter(Boolean))], subrequests: "0 external fetches; 1 SQL query via Hyperdrive",
  };
  console.log("warm", name, JSON.stringify(out.warm[name]));
}

// Independent check of the follow-up rules, in JavaScript, against what the SQL returned.
const rows = JSON.parse((await call(ENDPOINTS.followups)).text);
const sql = db();
const ids = rows.map((r) => r.lead_id);
const bad = await sql`select count(*)::int as n from spike.leads l where l.id in ${sql(ids)} and (l.do_not_contact
  or exists (select 1 from spike.replies r where r.lead_id = l.id) or exists (select 1 from spike.emails e where e.lead_id = l.id and e.status = 'bounced'))`;
const weekdaysSince = (iso) => { let c = 0; const end = new Date().toISOString().slice(0, 10); for (let d = new Date(iso.slice(0, 10) + "T12:00:00Z"); ;) { d.setUTCDate(d.getUTCDate() + 1); if (d.toISOString().slice(0, 10) > end) return c; if (d.getUTCDay() % 6 !== 0) c++; } };
out.checks = { followup_rows: rows.length, rows_that_should_be_skipped: bad[0].n, min_weekdays_since_previous: Math.min(...rows.map((r) => weekdaysSince(r.last_sent_at))) };
await sql.end();
console.log("checks", JSON.stringify(out.checks));
save();

for (const name of ["prospects_emailed_no_reply", "followups", "campaign_page"]) {
  console.log("sleeping 390 s before cold call:", name);
  await sleep(390_000);
  const rid = `c${++n}`;
  const cold = await call(ENDPOINTS[name], rid);
  const again = await call(ENDPOINTS[name], `c${++n}`);
  const probe = db();
  const [{ up }] = await probe`select extract(epoch from now() - pg_postmaster_start_time())::int as up`;
  await probe.end();
  await sleep(12_000);
  cf = tail.byRid();
  out.cold[name] = { status: cold.status, client_ms: cold.ms, db_ms: Number(cold.headers["x-db-ms"] ?? NaN), cpu_ms: cf[rid]?.cpu ?? null, outcome: cf[rid]?.outcome ?? null, error: cold.status === 200 ? null : cold.text.slice(0, 200), next_call_ms: again.ms, neon_uptime_s_after: up, neon_had_slept: up < 120 };
  console.log("cold", name, JSON.stringify(out.cold[name]));
  save();
  // The tail connection can drop during long silences; keep it alive.
  await call("/nothing");
}
await tail.stop();
const s = db();
const [size] = await s`select pg_database_size(current_database())::bigint as db_bytes, (select sum(pg_total_relation_size(c.oid))::bigint from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'spike' and c.relkind = 'r') as spike_bytes`;
await s.end();
out.storage = size;
save();
console.log("storage", JSON.stringify(size));
