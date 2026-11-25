// node scripts/deploy.mjs deploy  -> deploy to workers.dev, upload SPIKE_TOKEN (the only Worker secret)
// node scripts/deploy.mjs cold    -> three fresh deploys; first and second request each (a tracking link click)
// node scripts/deploy.mjs delete  -> remove the Worker, then confirm it is gone
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { vars, directUrl } from "../../scripts/env.mjs";
import { DIR, WORKER, call, startTail, sleep, save } from "./lib.mjs";
import { db } from "../../scripts/env.mjs";
import { reset } from "../db/data.mjs";

const v = vars();
const neon = new URL(directUrl());
const secrets = [v.NEON_URL, neon.password, neon.hostname, v.SQL_PATHS_TOKEN].filter(Boolean);
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
  if (!v.SQL_PATHS_TOKEN) throw new Error("no token");
  const d = wrangler(["deploy"]);
  if (!d.ok) process.exit(1);
  const url = d.raw.match(new RegExp(`https://${WORKER}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0];
  if (url) writeFileSync(new URL(".cache/worker-url.txt", DIR), url);
  save("deploy.json", { at: new Date().toISOString(), ...info(d.raw) });
  if (!wrangler(["secret", "put", "SPIKE_TOKEN"], v.SQL_PATHS_TOKEN).ok) process.exit(1);
}
if (step === "cold") {
  const sql = db();
  await reset(sql, 500);
  const emails = await sql`select id, lead_id from spike.s75_emails where ds = 'd500' and message_id is not null order by key limit 6`;
  const path = (e) => `/t/${Buffer.from(JSON.stringify({ c: "cbig", l: e.lead_id, e: e.id, u: "https://cal.example.test/fake" })).toString("base64url")}`;
  const runs = [];
  for (let n = 1; n <= 3; n++) {
    const d = wrangler(["deploy", "--var", `BUILD:cold${n}-${Date.now()}`]);
    await sleep(20_000);
    const tail = await startTail();
    const calls = [];
    for (let i = 0; i < 2; i++) calls.push(await call({ path: path(emails[(n - 1) * 2 + i]), method: "GET" }));
    const t = await tail.wait(calls.map((c) => c.rid), 20_000);
    tail.stop();
    runs.push({ run: n, startup_ms_reported_by_wrangler: info(d.raw).startup_ms, calls: calls.map((c, i) => ({ status: c.status, redirected: c.location === "https://cal.example.test/fake", isolate_was_cold: c.stats?.cold ?? null, cpu_ms: t[i]?.cpu ?? null, wall_ms: c.ms, outcome: t[i]?.outcome ?? "not in tail" })) });
    console.log(JSON.stringify(runs.at(-1)));
    save("cold.json", { at: new Date().toISOString(), path: "GET /t/:token, 500 leads", runs });
  }
  const [{ n }] = await sql`select count(*)::int as n from spike.s75_clicks where ds = 'd500' and data->>'user_agent' = 'spike'`;
  console.log("clicks recorded:", n);
  save("cold.json", { at: new Date().toISOString(), path: "GET /t/:token, 500 leads", clicks_recorded: n, runs });
  await reset(sql, 500);
  await sql.end();
}
// Extra diagnostic, not part of the pass bar: a fresh isolate answering a request that does no work (401, no database).
// It shows how much of the cold-start CPU comes before any of our path code runs.
if (step === "cold-idle") {
  const runs = [];
  for (let n = 1; n <= 3; n++) {
    wrangler(["deploy", "--var", `BUILD:idle${n}-${Date.now()}`]);
    await sleep(20_000);
    const tail = await startTail();
    const calls = [await call({ noAuth: true }), await call({ noAuth: true })];
    const t = await tail.wait(calls.map((c) => c.rid), 20_000);
    tail.stop();
    runs.push({ run: n, calls: calls.map((c, i) => ({ status: c.status, cpu_ms: t[i]?.cpu ?? null, outcome: t[i]?.outcome ?? "not in tail" })) });
    console.log(JSON.stringify(runs.at(-1)));
    save("cold-idle.json", { at: new Date().toISOString(), path: "request refused with 401: no database, no path code", runs });
  }
}
if (step === "delete") {
  const del = wrangler(["delete", "--name", WORKER, "--force"]);
  await sleep(20_000);
  const gone = wrangler(["deployments", "list", "--name", WORKER]);
  let address = null;
  try { address = (await fetch(readFileSync(new URL(".cache/worker-url.txt", DIR), "utf8").trim(), { signal: AbortSignal.timeout(20_000) })).status; } catch { address = "unreachable"; }
  const out = { at: new Date().toISOString(), worker_delete_ok: del.ok, worker_reported_missing: !gone.ok && /does not exist|10007/.test(gone.raw), address_status: address };
  save("cleanup.json", out);
  console.log(out);
}
process.exit(0);
