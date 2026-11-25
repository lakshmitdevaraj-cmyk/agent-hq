// Fills the table in REPORT-0.75.md (between the <!-- runs --> markers) from the result files, and writes results/verdicts.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const load = (f) => (existsSync(at(`results/${f}`)) ? JSON.parse(readFileSync(at(`results/${f}`), "utf8")) : {});
const first = { ...load("first.json"), ...load("heavy.json") };
const second = load("second.json");
const RANK = { pass: 0, marginal: 1, fail: 2 };
const nums = (r) => (r ? `${r.median} / ${r.p95} / ${r.worst}${r.cut ? ` (cut ${r.cut}/30)` : ""}` : "not re-run (failed)");

const rows = Object.entries(first).map(([key, a]) => {
  const b = second[key];
  const verdict = b && RANK[b.verdict] > RANK[a.verdict] ? b.verdict : a.verdict;
  return { name: a.name, size: a.size, first: a, second: b ?? null, verdict };
});
writeFileSync(at("results/verdicts.json"), JSON.stringify(rows.map((r) => ({ name: r.name, size: r.size, verdict: r.verdict, first: nums(r.first), second: nums(r.second), response_bytes: r.first.bytes })), null, 1));

const table = [
  "| Path and variant | Leads | First run: median / p95 / worst ms | Second run (after the heavy runs) | Response bytes | Verdict (worse run) |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.name} | ${r.size} | ${nums(r.first)} | ${nums(r.second)} | ${r.first.bytes ?? "–"} | **${r.verdict}** |`),
].join("\n");
const calls = [...Object.values(first), ...Object.values(second)];
console.log(rows.length, "cases;", calls.reduce((s, c) => s + c.calls.length, 0), "calls;", calls.reduce((s, c) => s + c.cut, 0), "cut;", "work ok in all:", calls.every((c) => c.work_ok));
for (const r of rows) console.log(`${r.verdict.padEnd(9)}${r.name} d${r.size}  ${nums(r.first)}  |  ${nums(r.second)}`);
if (existsSync(at("REPORT-0.75.md"))) {
  const md = readFileSync(at("REPORT-0.75.md"), "utf8");
  writeFileSync(at("REPORT-0.75.md"), md.replace(/<!-- runs -->[\s\S]*<!-- \/runs -->/, () => `<!-- runs -->\n${table}\n<!-- /runs -->`));
}
