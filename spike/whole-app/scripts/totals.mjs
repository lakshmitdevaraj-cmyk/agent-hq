// Totals over every measured call on Cloudflare, from the result files.
import { readFileSync } from "node:fs";
import { save } from "./lib.mjs";
const out = { by_file: {}, calls: 0, cut_off: 0, queries_logged: 0, max_outbound_in_one_call: 0 };
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
for (const f of ["h-light", "h-heavy", "h-stale", "h-literal", "h-confirm", "h-send"]) {
  const rows = Object.values(JSON.parse(readFileSync(new URL(`../results/${f}.json`, import.meta.url), "utf8")));
  const calls = rows.flatMap((r) => r.calls);
  const cut = calls.filter((c) => c.status === 503 || /exceeded/i.test(c.outcome ?? "")).length;
  const queries = calls.reduce((a, c) => a + (c.queries ?? 0), 0);
  for (const c of calls) out.max_outbound_in_one_call = Math.max(out.max_outbound_in_one_call, typeof c.outbound === "number" ? c.outbound : sum(c.outbound));
  for (const r of rows) if (typeof r.outbound === "number") out.max_outbound_in_one_call = Math.max(out.max_outbound_in_one_call, r.outbound);
  out.by_file[f] = { rows: rows.length, calls: calls.length, cut_off: cut, queries_logged: queries };
  out.calls += calls.length; out.cut_off += cut; out.queries_logged += queries;
}
save("h-totals.json", out);
console.log(JSON.stringify(out));
