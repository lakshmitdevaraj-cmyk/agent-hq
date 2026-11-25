// Fair re-measure of borderline rows. Cloudflare gets stricter after over-limit calls, so small actions measured after
// heavy ones can be cut off unfairly. Run after a rest: every action whose 500-lead median is 15 ms or less but did not
// clearly fit (worst over 10, median over 8, or a cut-off) is measured again, 8 calls, spaced out.
import { readFileSync, existsSync } from "node:fs";
import { call, startTail, sleep, save } from "./lib.mjs";
import { ACTIONS, HANDLERS } from "./actions.mjs";
import { db } from "../../scripts/env.mjs";
import { reset } from "../db/seed-kv.mjs";

const read = (f) => (existsSync(new URL(`../results/${f}`, import.meta.url)) ? Object.values(JSON.parse(readFileSync(new URL(`../results/${f}`, import.meta.url), "utf8"))) : []);
const rows = [...read("h-light.json"), ...read("h-heavy.json")].filter((o) => o.size === 500 && o.mode === "batched");
const all = { ...ACTIONS, ...HANDLERS };
const todo = rows.filter((o) => all[o.name] && (o.cpu_median ?? 99) <= 15 && (o.cpu_median > 8 || o.cpu_worst > 10 || o.killed));
console.log(`re-measuring ${todo.length}`);

const sql = db();
await reset(sql, 500);
const tail = await startTail();
const out = {};
for (let i = 0; i < 40; i++) await call({ ns: "d25", body: { action: ["agent.list", "task.list"][i % 2] } });
await sleep(30_000);
for (const o of todo) {
  const rec = all[o.name];
  if (rec.reset) await reset(sql, 500);
  const calls = [];
  for (let i = 0; i < 8; i++) {
    const n = i % 4; // recipes are written for call numbers 0..3
    if ((rec.reset && n === 0 && i > 0) || (rec.resetEach && i > 0)) await reset(sql, 500);
    const req = rec.req ? rec.req(n) : { body: { action: o.name, params: typeof rec.params === "function" ? rec.params(n) : rec.params } };
    const r = await call({ ...req, ns: "d500" });
    calls.push({ rid: r.rid, status: r.status, ok: [rec.expect ?? 200].flat().includes(r.status) });
    await sleep(700);
  }
  const t = await tail.wait(calls.map((c) => c.rid));
  calls.forEach((c, i) => Object.assign(c, { cpu_ms: t[i]?.cpu ?? null, outcome: t[i]?.outcome ?? "not in tail" }));
  const measured = calls.slice(1);
  const cpus = measured.map((c) => c.cpu_ms).filter((v) => v != null).sort((a, b) => a - b);
  out[o.name] = { name: o.name, size: 500, cpu_median: cpus[Math.floor((cpus.length - 1) / 2)] ?? null, cpu_worst: cpus.at(-1) ?? null, killed: calls.filter((c) => /exceeded/.test(c.outcome)).length, ok: measured.every((c) => c.ok), first_pass: { cpu_median: o.cpu_median, cpu_worst: o.cpu_worst, killed: o.killed }, calls: calls.map(({ rid, ...c }) => c) };
  console.log(`${o.name.padEnd(45)} ${o.cpu_median}/${o.cpu_worst}x${o.killed} -> ${out[o.name].cpu_median}/${out[o.name].cpu_worst}x${out[o.name].killed}`);
  save("h-confirm.json", out);
  await sleep(5000);
}
await reset(sql, 500);
tail.stop();
await sql.end();
process.exit(0);
