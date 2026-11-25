// Test E: the same website check as Test A, run on an ordinary machine (InstaBox), writing results straight to Neon.
// Needs NEON_URL in the environment. Stores counts and presence only: no emails, names or HTML.
import { cpus } from "node:os";
import postgres from "postgres";
import { fetchSite, parsePages, fingerprint, SITE_CHECK_PATHS } from "../lib/analyze";
import { SITES } from "../lib/sites";

const url = process.env.NEON_URL;
if (!url) throw new Error("NEON_URL is not set");
const sql = postgres(url, { max: 1, onnotice: () => {} });
const run = process.env.RUN_ID ?? `instabox-${Date.now()}`;
const started = Date.now();
let loaded = 0, cpuTotal = 0;

for (const host of SITES) {
  const t = performance.now();
  const pages = await fetchSite(host, SITE_CHECK_PATHS, 700);
  const fetchMs = Math.round(performance.now() - t);
  const before = process.cpuUsage();
  const parsed = pages.length ? parsePages(host, pages) : null;
  const used = process.cpuUsage(before);
  const cpuMs = (used.user + used.system) / 1000;
  const kb = Math.round(pages.reduce((s, p) => s + Buffer.byteLength(p.html), 0) / 1024);
  if (pages.length) { loaded++; cpuTotal += cpuMs; }
  await sql`insert into spike.sitecheck_results (run_id, host, pages, kb, fetch_ms, cpu_ms, summary)
    values (${run}, ${host}, ${pages.length}, ${kb}, ${fetchMs}, ${cpuMs}, ${sql.json(parsed ? fingerprint(parsed) : { loaded: false })})
    on conflict do nothing`;
  console.log(`${host} pages=${pages.length} kb=${kb} fetch_ms=${fetchMs} cpu_ms=${cpuMs.toFixed(1)}`);
}
await sql.end();
console.log(JSON.stringify({ run, sites: SITES.length, loaded, total_seconds: (Date.now() - started) / 1000, parse_cpu_ms_total: Math.round(cpuTotal), node: process.version, cpus: cpus().length }));
