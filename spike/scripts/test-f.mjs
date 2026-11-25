// Test F: run the whole spike locally with `wrangler dev` against Neon. Dry run: the local queue never sends email.
// Because the home router's DNS refuses the Neon host and wrangler dev uses the system resolver, a tiny local
// proxy listens on 127.0.0.1 and forwards to Neon over TLS (name looked up via 1.1.1.1 by env.mjs).
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { directUrl, vars, db } from "./env.mjs";
import { call, sleep } from "./remote.mjs";

const upstream = new URL(directUrl());
const proxy = net.createServer((client) => {
  client.pause();
  const raw = net.connect({ host: upstream.hostname, port: 5432, lookup: dns.lookup });
  const die = () => { client.destroy(); raw.destroy(); };
  client.on("error", die); raw.on("error", die);
  raw.once("connect", () => {
    raw.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])); // Postgres SSLRequest
    raw.once("data", (d) => {
      if (d[0] !== 83) return die(); // 'S'
      const secure = tls.connect({ socket: raw, servername: upstream.hostname }, () => { client.pipe(secure); secure.pipe(client); client.resume(); });
      secure.on("error", die);
    });
  });
});
await new Promise((r) => proxy.listen(54329, "127.0.0.1", r));

const local = new URL(upstream);
local.hostname = "127.0.0.1"; local.port = "54329"; local.search = "?sslmode=disable";
writeFileSync(".cache/wrangler-dev.log", "");
const child = spawn("npx", ["wrangler", "dev", "--port", "8799", "--var", "DRY_RUN:1"], {
  detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: local.toString() },
});
const secrets = [local.password, upstream.hostname, vars().AGENTMAIL_KEY, vars().SPIKE_TOKEN, vars().TEST_TO];
const log = (d) => appendFileSync(".cache/wrangler-dev.log", secrets.reduce((t, s) => t.split(s).join("[hidden]"), String(d)));
child.stdout.on("data", log); child.stderr.on("data", log);

const BASE = "http://127.0.0.1:8799";
const get = (path, init) => call(new URL(path, BASE).toString(), null, init);
const J = (r) => { try { return JSON.parse(r.text); } catch { return { raw: r.text.slice(0, 200) }; } };
const results = {};
try {
  for (let i = 0; i < 60; i++) { if ((await get("/nothing")).status === 404) break; await sleep(1000); }
  const site = await get("/site?host=bosworthac.com");
  results.site_check = { status: site.status, loaded: J(site).loaded, ms: site.ms };
  for (const [name, path] of [["prospects", "/q/prospects?filter=emailed_no_reply"], ["followups", "/q/followups"], ["campaign", "/q/campaign?id=c1"]]) {
    const r = await get(path);
    results[name] = { status: r.status, rows: r.headers["x-rows"], ms: r.ms, error: r.status === 200 ? undefined : r.text.slice(0, 200) };
  }
  const sql = db();
  await sql`delete from spike.send_status where run_id = 'dry'`;
  const q = await get("/queue/start", { method: "POST" });
  let rows = [];
  const qStart = Date.now();
  while (Date.now() - qStart < 120_000 && !(rows.length === 10 && rows.every((r) => r.status === "sent"))) {
    await sleep(5000);
    rows = J(await get("/queue/status?run=dry")).rows ?? [];
  }
  results.queue_dry_run = { start: q.status, sent: rows.filter((r) => r.status === "sent").length, details: [...new Set(rows.map((r) => r.detail))] };
  const w = J(await get("/workflow/start", { method: "POST" }));
  let s = {};
  for (let i = 0; i < 20; i++) { await sleep(20_000); s = J(await get(`/workflow/status?id=${w.id}`)); if (s.instance?.status === "complete" || s.instance?.status === "errored") break; }
  results.workflow = { status: s.instance?.status, steps: s.steps?.length };
  await sql.end();
} finally {
  try { process.kill(-child.pid); } catch { /* gone */ }
  proxy.close();
}
writeFileSync("results/f-local.json", JSON.stringify({ at: new Date().toISOString(), ...results }, null, 1));
console.log(JSON.stringify(results, null, 1));
process.exit(0);
