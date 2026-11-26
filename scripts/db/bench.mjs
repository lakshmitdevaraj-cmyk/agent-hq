// Times the five queries on the perf branch: 30 runs each from this Mac, median and worst, and the database's own time.
// Writes ../p1-reports/timings.md. Usage: node scripts/db/bench.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, describe } from "./env.mjs";
import { explain, QUERIES, sampleArgs } from "./queries.mjs";

const RUNS = 30;
const sql = connect("perf", { direct: false });
try {
  const [{ leads, emails }] = await sql`select (select count(*) from leads)::int as leads, (select count(*) from emails)::int as emails`;
  const args = await sampleArgs(sql, new Date().toISOString().slice(0, 10));
  const rows = [], plans = [];
  await sql`select 1`; // open the connection before timing
  const median = (t) => (t[RUNS / 2 - 1] + t[RUNS / 2]) / 2;
  const time = async (fn) => {
    const t = [];
    for (let i = 0; i < RUNS; i++) { const start = performance.now(); await fn(); t.push(performance.now() - start); }
    return t.sort((a, b) => a - b);
  };
  const trip = await time(() => sql`select 1`);
  rows.push(["empty query (the network alone)", "-", median(trip), trip.at(-1), "-", "-"]);
  for (const q of QUERIES) {
    let found = 0;
    const t = await time(async () => { found = (await sql.unsafe(q.text, q.args.map((a) => args[a]))).length; });
    const plan = await explain(sql, q, args);
    const own = Number(/Execution Time: ([\d.]+)/.exec(plan.join("\n"))?.[1]);
    rows.push([q.name, found, median(t), t.at(-1), own, plan.some((l) => l.includes(q.index)) ? q.index : `not ${q.index}`]);
    plans.push(`### ${q.name}`, "```\n" + plan.join("\n") + "\n```");
    if (!plan.some((l) => l.includes(q.index))) {
      const forced = await explain(sql, q, args, { indexOnly: true });
      plans.push(`Postgres chose another way at this size. With whole-table reads off (${forced.some((l) => l.includes(q.index)) ? `${q.index} serves it` : `${q.index} still not used`}):`, "```\n" + forced.join("\n") + "\n```");
    }
  }
  const ms = (v) => (typeof v === "number" ? v.toFixed(v < 10 ? 2 : 0) : v);
  const table = ["| Query | Rows | Median ms | Worst ms | Database's own ms | Index used |", "|---|---|---|---|---|---|", ...rows.map(([n, found, ...rest]) => `| ${n} | ${found} | ${rest.map(ms).join(" | ")} |`)].join("\n");
  const head = `# Timings on the perf branch\n\n${leads} made-up leads, ${emails} made-up emails. ${RUNS} runs per query from this Mac to ${describe("perf", false).region} (pooled connection). Median and worst include the network: a query with values takes two round trips on this connection. The name search asks for one whole business name.`;
  const out = fileURLToPath(new URL("../../../p1-reports/timings.md", import.meta.url));
  writeFileSync(out, [head, table, "## Plans", ...plans].join("\n\n") + "\n", { mode: 0o600 });
  console.log(table);
  console.log(out);
} finally {
  await sql.end();
}
