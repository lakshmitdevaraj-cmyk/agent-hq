// Timings for outreach.emails.list on the campaign with the most emails on Neon dev (P2 chunk 5). Read only in effect:
// everything runs in transactions that are rolled back. Nothing is written to a file or to production.
//   (a) the database's own time: EXPLAIN (ANALYZE, BUFFERS) on every statement the action runs (steady state: the stale
//       drafts were already re-checked once), planning + execution summed;
//   (b) wall time from this machine for the whole action in one transaction (rolled back), median of 5.
// Run: node scripts/db/bench-emails.mjs
import "./equiv/ts-ext.mjs";
import postgres from "postgres";
import { localVar } from "./env.mjs";
// The hook above must be registered before the app's files are loaded, so these are dynamic imports.
const { clientOptions, closeDb } = await import("../../netlify/functions/lib/db/client.ts");
const { runEmailAction } = await import("../../netlify/functions/lib/sql/emails.ts");

const url = localVar("DEV_DATABASE_URL");
process.env.DATABASE_URL = url;
const ROLLBACK = Symbol("rollback");
const deps = new Proxy({}, { get: (_, p) => { throw new Error(`deps.${String(p)} is not used by list`); } });
const ctx = { newId: () => "bench", isAgent: false, createdBy: null };
const list = (tx, campaign_id) => runEmailAction(tx, "outreach.emails.list", { campaign_id }, deps, ctx);

const captured = [];
const sql = postgres(url, { ...clientOptions(), max: 1, debug: (_conn, query, parameters) => { captured.push({ query, parameters }); } });

try {
  const [top] = await sql`select campaign_id, count(*)::int as n from emails group by campaign_id order by n desc limit 1`;
  console.log(`campaign with the most emails: ${top.n} emails (id not printed)`);

  // (a) database time
  let rows = 0;
  const parts = [];
  try {
    await sql.begin(async (tx) => {
      await list(tx, top.campaign_id); // first run re-checks and stamps any stale draft
      captured.length = 0;
      rows = (await list(tx, top.campaign_id)).length;
      const statements = captured.filter((c) => /^\s*(select|with|update|insert|delete)\b/i.test(c.query)).map((c) => ({ ...c }));
      for (const s of statements) {
        const plan = (await tx.unsafe(`explain (analyze, buffers) ${s.query}`, s.parameters)).map((r) => r["QUERY PLAN"]);
        const num = (label) => Number((plan.find((l) => l.startsWith(label))?.match(/([\d.]+) ms/) ?? [])[1] ?? 0);
        const hits = plan.map((l) => /shared hit=(\d+)/.exec(l)?.[1]).find(Boolean);
        parts.push({ what: s.query.replace(/\s+/g, " ").slice(0, 70), plan_ms: num("Planning Time"), exec_ms: num("Execution Time"), buffers: hits ?? "?" });
      }
      throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  console.log(`(a) database time, ${rows} rows returned, ${parts.length} statements:`);
  for (const p of parts) console.log(`    plan ${p.plan_ms.toFixed(2)} ms + run ${p.exec_ms.toFixed(2)} ms (shared hits ${p.buffers})  ${p.what}`);
  const total = parts.reduce((a, p) => a + p.plan_ms + p.exec_ms, 0);
  console.log(`    sum: ${total.toFixed(2)} ms (planning + execution, no network)`);

  // (b) wall time from this machine. Each run is its own transaction (as the handler's withTx would open one) that is
  // rolled back afterwards, so dev is never changed. The list is run twice in it: the first run may re-check stale drafts
  // (a one-off per rules change), the second is the steady state; both are reported, the median is of the second.
  const [{ stale }] = await sql`select count(*)::int as stale from emails where campaign_id = ${top.campaign_id} and status = 'drafted' and not is_duplicate and rules_version is distinct from 4`;
  const first = [], steady = [];
  for (let i = 0; i < 6; i++) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local statement_timeout = 8000");
        const t0 = performance.now();
        await list(tx, top.campaign_id);
        const t1 = performance.now();
        const out = await list(tx, top.campaign_id);
        const t2 = performance.now();
        if (out.length !== rows) throw new Error("row count changed between runs");
        if (i > 0) { first.push(t1 - t0); steady.push(t2 - t1); } // run 0 warms the connection
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`(b) wall time from this Mac (whole action, one transaction, 5 runs after a warm-up):`);
  console.log(`    steady state: ${steady.map((t) => t.toFixed(0)).join(", ")} ms; median ${med(steady).toFixed(0)} ms`);
  console.log(`    first load after a rules change (${stale} stale drafts in this campaign now): ${first.map((t) => t.toFixed(0)).join(", ")} ms; median ${med(first).toFixed(0)} ms`);
} finally {
  await sql.end({ timeout: 5 });
  await closeDb();
}
