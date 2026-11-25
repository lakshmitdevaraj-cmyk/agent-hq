// Test H runner. For each recipe: 1 warm-up + 3 measured calls, CPU taken from `wrangler tail`.
//   node scripts/run-h.mjs light|heavy|stale|literal      (deployed Worker)
//   LOCAL=1 node scripts/run-h.mjs ...                     (one call each at d25, no CPU numbers; checks the recipes)
import { readFileSync, existsSync } from "node:fs";
import { db } from "../../scripts/env.mjs";
import { reset } from "../db/seed-kv.mjs";
import { call, startTail, sleep, save, DIR } from "./lib.mjs";
import { ACTIONS, HANDLERS, BACKGROUND, STALE } from "./actions.mjs";

const LOCAL = !!process.env.LOCAL;
const phase = process.argv[2] ?? "light";
const only = process.argv[3];
const FILE = `h-${phase}${LOCAL ? "-local" : ""}.json`;

// The inventory comes from the source, so an action cannot be missed.
const labels = [...readFileSync(new URL("../../netlify/functions/command.ts", DIR), "utf8").matchAll(/^\s*case "([a-z]+\.[a-zA-Z0-9_.]+)":/gm)].map((m) => m[1]);
const missing = labels.filter((a) => !ACTIONS[a]);
const extra = Object.keys(ACTIONS).filter((a) => !labels.includes(a));
if (missing.length || extra.length) throw new Error(`recipes differ from command.ts. missing: ${missing} extra: ${extra}`);
if (!LOCAL) save("inventory.json", { command_actions: labels, handlers: Object.keys(HANDLERS), background: Object.keys(BACKGROUND) });

const results = existsSync(new URL(`results/${FILE}`, DIR)) && !process.env.FRESH ? JSON.parse(readFileSync(new URL(`results/${FILE}`, DIR), "utf8")) : {};
const sql = db();
const dirty = new Set();
const fresh = async (size) => { await reset(sql, size); dirty.delete(size); };
const tail = LOCAL ? null : await startTail();

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const items = (text) => { try { const j = JSON.parse(text); const d = j.data ?? j; return Array.isArray(d) ? d.length : Array.isArray(d?.rows) ? d.rows.length : Array.isArray(d?.records) ? d.records.length : null; } catch { return null; } };

async function measure(name, rec, size, { mode = "batched", params, stale = false } = {}) {
  const key = `${name}|d${size}|${mode}`;
  if (results[key]) return results[key];
  const ns = `d${size}`;
  const needsReset = rec.reset || dirty.has(size);
  if (needsReset) await fresh(size);
  const calls = [];
  const n = LOCAL ? 1 : stale && size >= 500 ? 2 : 4; // re-checking 500+ leads is thousands of queries (Hyperdrive free: 100,000 a day)
  for (let i = 0; i < n; i++) {
    if (rec.resetEach && i > 0) await fresh(size);
    if (stale) {
      await sql`update spike.kv set value = value - 'rules_version' where store = ${`${ns}/agent-hq-outreach-emails`} and value->>'status' = 'drafted'`;
      dirty.add(size);
    }
    for (const s of rec.setup ?? []) {
      const sr = await call({ ...s, ns });
      if (sr.status !== 200) console.log(`  setup ${s.body.action} → ${sr.status} ${sr.text.slice(0, 200)}`);
    }
    const req = rec.req ? rec.req(i) : { body: { action: name.replace(/^re-check old drafts: /, ""), params: typeof (params ?? rec.params) === "function" ? (params ?? rec.params)(i) : (params ?? rec.params) } };
    if (rec.action) req.body.action = rec.action;
    const r = await call({ ...req, ns, mode, ...(rec.req ? { headers: req.headers } : {}) });
    const expected = [rec.expect ?? 200].flat();
    const ok = expected.includes(r.status);
    if (!ok && i === 0) console.log(`  ${key} → ${r.status} ${r.text.slice(0, 240)}`);
    calls.push({ rid: r.rid, status: r.status, ok, wall_ms: r.ms, bytes: r.bytes, items: items(r.text), queries: r.stats?.queries, rows: r.stats?.rows, outbound: r.stats?.outbound, cold: r.stats?.cold, cf_error: r.cfError });
    if (rec.kind === "write" || stale) dirty.add(size);
  }
  if (tail) {
    const recs = await tail.wait(calls.map((c) => c.rid));
    recs.forEach((t, i) => Object.assign(calls[i], t ? { cpu_ms: t.cpu, outcome: t.outcome, errors: t.errors.length ? t.errors : undefined } : { cpu_ms: null, outcome: "not in tail" }));
  }
  const measured = calls.slice(LOCAL ? 0 : 1);
  const cpus = measured.map((c) => c.cpu_ms).filter((v) => typeof v === "number");
  const out = {
    name, size, mode, kind: rec.kind, note: rec.note,
    cpu_median: median(cpus), cpu_worst: cpus.length ? Math.max(...cpus) : null,
    wall_median: median(measured.map((c) => c.wall_ms)),
    queries: Math.max(0, ...measured.map((c) => c.queries ?? 0)), rows: Math.max(0, ...measured.map((c) => c.rows ?? 0)),
    outbound: Math.max(0, ...measured.map((c) => Object.values(c.outbound ?? {}).reduce((a, b) => a + b, 0))),
    ok: measured.every((c) => c.ok), killed: calls.filter((c) => /exceeded/i.test(c.outcome ?? "") || c.cf_error).length,
    calls: calls.map(({ rid, ...c }) => c),
  };
  results[key] = out;
  save(FILE, results);
  console.log(`${key.padEnd(70)} cpu ${out.cpu_median}/${out.cpu_worst} q=${out.queries} rows=${out.rows} out=${out.outbound} ok=${out.ok}${out.killed ? ` KILLED ${out.killed}` : ""}`);
  return out;
}

async function sweep(name, rec) {
  if (LOCAL) return void (await measure(name, rec, 25));
  const rest = async (o) => { if (rec.heavy || o.killed) await sleep(o.killed ? 60_000 : 10_000); };
  const ref = await measure(name, rec, 500);
  await rest(ref);
  const over = (ref.cpu_median ?? 99) > 8 || ref.killed > 0;
  const sizes = rec.sweep || over ? [100, 25, 1500] : ref.queries > 3 || ref.rows > 100 ? [1500] : [];
  let tooBig = ref.killed >= 3;
  for (const s of sizes) {
    if (s === 1500 && tooBig) continue;
    await rest(await measure(name, rec, s));
  }
  for (const [label, params] of rec.variants ?? []) await rest(await measure(`${name} (${label})`, { ...rec, action: name }, 500, { params }));
}

const all = { ...ACTIONS, ...HANDLERS, ...BACKGROUND };
try {
  // Pre-warm: a freshly started isolate runs the same code several times slower until the engine has compiled it.
  // These calls are not recorded; cold cost is measured on its own (h-cold.json).
  if (!LOCAL) for (let i = 0; i < 40; i++) await call({ ns: "d25", body: { action: ["agent.list", "task.list", "outreach.campaign.get", "outreach.emails.list"][i % 4], params: i % 4 === 2 ? { id: "cbig" } : i % 4 === 3 ? { campaign_id: "cbig" } : {} } });
  if (phase === "light" || phase === "heavy") {
    for (const [name, rec] of Object.entries(all)) {
      if (only && name !== only) continue;
      if (!!rec.heavy !== (phase === "heavy")) continue;
      try { await sweep(name, rec); } catch (e) { console.log(`  ${name} runner error: ${e.message}`); }
    }
  }
  if (phase === "stale") {
    for (const [name, req] of Object.entries(STALE)) {
      for (const size of LOCAL ? [25] : [25, 100, 500]) {
        const o = await measure(name, { kind: "write", params: req.body.params }, size, { stale: true });
        await fresh(size);
        if (!LOCAL) await sleep(o.killed ? 60_000 : 15_000);
        if (o.killed >= 3) break;
      }
    }
  }
  // One query per read, as Netlify Blobs would behave: a few list actions only.
  if (phase === "literal") {
    for (const name of ["outreach.campaign.get", "outreach.leads.list", "outreach.emails.list", "outreach.prospects.list"]) {
      for (const size of LOCAL ? [25] : [25, 100, 500]) {
        const o = await measure(name, ACTIONS[name], size, { mode: "literal" });
        if (!LOCAL) await sleep(o.killed ? 60_000 : 10_000);
        if (o.killed >= 3) break;
      }
    }
  }
  for (const size of [...dirty]) await fresh(size);
} finally {
  tail?.stop();
  await sql.end();
}
process.exit(0);
