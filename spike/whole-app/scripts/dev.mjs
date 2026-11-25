// Local smoke test: `wrangler dev` (no CPU limit) against Neon, then every recipe once at d25.
// The home router refuses *.neon.tech, so a small local proxy forwards to Neon (same approach as Step 0 scripts/test-f.mjs).
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { directUrl } from "../../scripts/env.mjs";
import { DIR, sleep } from "./lib.mjs";

const upstream = new URL(directUrl());
const proxy = net.createServer((client) => {
  client.pause();
  const raw = net.connect({ host: upstream.hostname, port: 5432, lookup: dns.lookup });
  const die = () => { client.destroy(); raw.destroy(); };
  client.on("error", die); raw.on("error", die);
  raw.once("connect", () => {
    raw.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])); // Postgres SSLRequest
    raw.once("data", (d) => {
      if (d[0] !== 83) return die();
      const secure = tls.connect({ socket: raw, servername: upstream.hostname }, () => { client.pipe(secure); secure.pipe(client); client.resume(); });
      secure.on("error", die);
    });
  });
});
await new Promise((r) => proxy.listen(54329, "127.0.0.1", r));
const local = new URL(upstream);
local.hostname = "127.0.0.1"; local.port = "54329"; local.search = "?sslmode=disable";

mkdirSync(new URL(".cache/", DIR), { recursive: true });
const logFile = new URL(".cache/wrangler-dev.log", DIR);
writeFileSync(logFile, "");
const LOCAL_TOKEN = "local-only-token";
const child = spawn("npx", ["wrangler", "dev", "--port", "8799", "--var", `SPIKE_TOKEN:${LOCAL_TOKEN}`], {
  cwd: DIR, detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: local.toString() },
});
const log = (d) => appendFileSync(logFile, [local.password, upstream.hostname].reduce((t, s) => t.split(s).join("[hidden]"), String(d)));
child.stdout.on("data", log); child.stderr.on("data", log);
const BASE = "http://127.0.0.1:8799";
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(BASE)).status === 401; } catch { await sleep(1000); } }
  console.log("401 without token:", up);
  for (const phase of (process.argv[2] ?? "light,heavy,stale,literal").split(",")) {
    console.log(`--- ${phase}`);
    await new Promise((resolve) => spawn("node", ["scripts/run-h.mjs", phase, ...(process.argv[3] ? [process.argv[3]] : [])], {
      cwd: DIR, stdio: "inherit", env: { ...process.env, LOCAL: "1", FRESH: "1", SPIKE_URL: BASE, SPIKE_LOCAL_TOKEN: LOCAL_TOKEN },
    }).on("exit", resolve));
  }
} finally {
  try { process.kill(-child.pid); } catch { /* gone */ }
  proxy.close();
}
process.exit(0);
