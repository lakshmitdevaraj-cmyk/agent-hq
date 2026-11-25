// Test E: upload the bundled worker to the existing InstaBox machine, run it from here, remove it.
// NEON_URL goes in on stdin for that one run only: not on the command line, not stored on the machine.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { vars, db } from "./env.mjs";

const MACHINE = process.argv[2] ?? "shiftforge";
const FILE = "/tmp/alcance-spike-worker.mjs";
const url = vars().NEON_URL;
const u = new URL(url);
const clean = (s) => [url, u.password, u.hostname].filter(Boolean).reduce((t, x) => t.split(x).join("[hidden]"), s ?? "");
function box(args, input) {
  const t = Date.now();
  const r = spawnSync("npx", ["-y", "instabox@latest", ...args], { encoding: "utf8", input, maxBuffer: 20e6, timeout: 700_000 });
  return { code: r.status, out: clean(r.stdout), err: clean(r.stderr), seconds: (Date.now() - t) / 1000 };
}

const up = box(["exec", MACHINE, "--stdin", "--timeout", "120", "--", `cat > ${FILE}`], readFileSync(".cache/worker.mjs", "utf8"));
console.log("upload exit", up.code, `${up.seconds}s`, up.err.slice(0, 200));
if (up.code !== 0) process.exit(1);
const runId = `instabox-${Date.now()}`;
const run = box(["exec", MACHINE, "--stdin", "--timeout", "600", "--", `IFS= read -r NEON_URL; export NEON_URL; RUN_ID=${runId} node ${FILE}`], url + "\n");
console.log(run.out.trim());
if (run.code !== 0) console.log("run exit", run.code, run.err.slice(0, 400));
const rm = box(["exec", MACHINE, "--", `rm -f ${FILE}; test ! -e ${FILE} && echo removed`]);
console.log("cleanup:", rm.out.trim());

const sql = db();
const rows = await sql`select host, pages, kb, fetch_ms::float, cpu_ms::float from spike.sitecheck_results where run_id = ${runId} order by host`;
await sql.end();
let totals = {};
try { totals = JSON.parse(run.out.trim().split("\n").at(-1)); } catch { /* no totals line */ }
writeFileSync("results/e-instabox.json", JSON.stringify({ at: new Date().toISOString(), upload_seconds: up.seconds, run_seconds_seen_from_mac: run.seconds, exit: run.code, totals, rows_in_neon: rows.length, rows }, null, 1));
console.log("rows in Neon:", rows.length, "run seconds:", run.seconds);
