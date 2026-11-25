// node scripts/deploy.mjs deploy  -> deploy to workers.dev, upload SPIKE_TOKEN (the only Worker secret)
// node scripts/deploy.mjs cold    -> test H1: three forced fresh isolates, CPU of the first request from `wrangler tail`
// node scripts/deploy.mjs delete  -> remove the Workflow and the Worker, then confirm both are gone
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { vars, directUrl } from "../../scripts/env.mjs";
import { DIR, WORKER, call, startTail, sleep, save } from "./lib.mjs";

const v = vars();
const neon = new URL(directUrl());
const secrets = [v.NEON_URL, neon.password, neon.hostname, v.WHOLE_APP_TOKEN].filter(Boolean);
// Account names and e-mail addresses are removed from anything printed or saved.
const clean = (s) => secrets.reduce((t, x) => t.split(x).join("[hidden]"), s ?? "").replace(/[^\s@]+@[^\s@]+\.[a-z]+/gi, "[email]").replace(/\.[a-z0-9-]+\.workers\.dev/g, ".[account].workers.dev").replace(/accounts\/[0-9a-f]{32}/g, "accounts/[id]");
function wrangler(args, input) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: DIR, encoding: "utf8", input });
  const raw = `${r.stdout}\n${r.stderr}`;
  console.log(`$ wrangler ${args.slice(0, 3).join(" ")} → exit ${r.status}`);
  console.log(clean(raw).split("\n").filter((l) => l.trim()).slice(-10).join("\n"));
  return { ok: r.status === 0, raw };
}
const info = (raw) => ({
  startup_ms: Number(/Worker Startup Time:\s*(\d+)\s*ms/i.exec(raw)?.[1] ?? NaN),
  upload: /Total Upload:\s*([\d.]+ \wiB)\s*\/\s*gzip:\s*([\d.]+ \wiB)/i.exec(raw)?.slice(1, 3),
});

const step = process.argv[2];
mkdirSync(new URL(".cache/", DIR), { recursive: true });
if (step === "deploy") {
  if (!v.WHOLE_APP_TOKEN) throw new Error("no token");
  const d = wrangler(["deploy"]);
  if (!d.ok) process.exit(1);
  const url = d.raw.match(new RegExp(`https://${WORKER}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0];
  if (url) writeFileSync(new URL(".cache/worker-url.txt", DIR), url);
  save("g-deploy.json", { at: new Date().toISOString(), ...info(d.raw) });
  if (!wrangler(["secret", "put", "SPIKE_TOKEN"], v.WHOLE_APP_TOKEN).ok) process.exit(1);
}
if (step === "cold") {
  const runs = [];
  for (let n = 1; n <= 3; n++) {
    const d = wrangler(["deploy", "--var", `BUILD:cold${n}-${Date.now()}`]);
    await sleep(20_000);
    const tail = await startTail();
    // The first real request a fresh isolate serves: a small authenticated read.
    const first = await call({ ns: "d25", body: { action: "agent.list" } });
    const second = await call({ ns: "d25", body: { action: "agent.list" } });
    const [a, b] = await tail.wait([first.rid, second.rid], 20_000);
    tail.stop();
    runs.push({ run: n, startup_ms_reported_by_wrangler: info(d.raw).startup_ms, first: { status: first.status, isolate_was_cold: first.stats?.cold, cpu_ms: a?.cpu, wall_ms: first.ms, outcome: a?.outcome }, second: { status: second.status, isolate_was_cold: second.stats?.cold, cpu_ms: b?.cpu, wall_ms: second.ms } });
    console.log(JSON.stringify(runs.at(-1)));
    save("h-cold.json", { at: new Date().toISOString(), runs });
  }
}
if (step === "delete") {
  const wf = wrangler(["workflows", "delete", `${WORKER}-wf`]);
  const del = wrangler(["delete", "--name", WORKER, "--force"]);
  await sleep(20_000);
  const gone = wrangler(["deployments", "list", "--name", WORKER]);
  const list = wrangler(["workflows", "list"]);
  let address = null;
  try { address = (await fetch(readFileSync(new URL(".cache/worker-url.txt", DIR), "utf8").trim(), { signal: AbortSignal.timeout(20_000) })).status; } catch { address = "unreachable"; }
  const out = { at: new Date().toISOString(), workflow_delete_ok: wf.ok, worker_delete_ok: del.ok, worker_reported_missing: !gone.ok && /does not exist|10007/.test(gone.raw), workflow_still_listed: list.raw.includes(`${WORKER}-wf`), address_status: address };
  save("cleanup.json", out);
  console.log(out);
}
