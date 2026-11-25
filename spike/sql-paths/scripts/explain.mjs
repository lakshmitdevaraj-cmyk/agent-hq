// Does the name search use the trigram index? Planner choice as-is, then with plain scans switched off.
import { writeFileSync } from "node:fs";
import { db } from "../../scripts/env.mjs";
const sql = db();
const out = [];
for (const [q, off] of [["%air 12%", false], ["%air 12%", true], ["%heating & air 1234%", false], ["%heating & air 1234%", true], ["%12%", false], ["%12%", true]]) {
  const rows = await sql.begin(async (tx) => {
    if (off) await tx`set local enable_seqscan = off`;
    // No ds filter here, so the choice is between the text index and a full scan.
    return tx.unsafe(`explain (analyze, timing off, costs off) select id from spike.s75_leads where search like '${q}'`);
  });
  const plan = rows.map((r) => r["QUERY PLAN"].trim());
  out.push({ pattern: q, plain_scans_off: off, uses_trigram_index: plan.some((l) => l.includes("s75_leads_search")), plan: plan.slice(0, 6) });
  console.log(q, off ? "(scan off)" : "", out.at(-1).uses_trigram_index ? "INDEX" : "no index", "|", plan[0]);
}
writeFileSync(new URL("../results/search-explain.json", import.meta.url), JSON.stringify(out, null, 1));
await sql.end();
