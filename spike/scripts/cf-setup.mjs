// Creates the queue and the Hyperdrive config (caching OFF so timings are real), deploys, then uploads secrets.
// Connection string and secrets never reach the terminal.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { vars, directUrl } from "./env.mjs";

const v = vars();
const url = directUrl();
const secrets = [url, new URL(url).password, decodeURIComponent(new URL(url).password), new URL(url).hostname, v.AGENTMAIL_KEY, v.SPIKE_TOKEN, v.TEST_TO, v.AGENTMAIL_INBOX].filter(Boolean);
const clean = (s) => secrets.reduce((t, x) => t.split(x).join("[hidden]"), s ?? "").replace(/[^\s@]+@[^\s@]+\.[a-z]+/gi, "[email]");
function wrangler(args, input) {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", input });
  const out = clean(`${r.stdout}\n${r.stderr}`);
  console.log(`$ wrangler ${args[0]} ${args[1] ?? ""} → exit ${r.status}`);
  console.log(out.split("\n").filter((l) => l.trim()).slice(-8).join("\n"));
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}

const step = process.argv[2];
if (step === "resources") {
  wrangler(["queues", "create", "alcance-spike-q"]);
  const h = wrangler(["hyperdrive", "create", "alcance-spike-hd", `--connection-string=${url}`, "--caching-disabled"]);
  const id = h.out.match(/\b[0-9a-f]{32}\b/)?.[0];
  if (h.ok && id) {
    writeFileSync("wrangler.jsonc", readFileSync("wrangler.jsonc", "utf8").replace(/("binding": "HYPERDRIVE", "id": ")[0-9a-f]{32}/, `$1${id}`));
    console.log("wrangler.jsonc updated with the Hyperdrive id");
  }
}
if (step === "deploy") {
  const d = wrangler(["deploy"]);
  const workerUrl = d.out.match(/https:\/\/alcance-spike\.[a-z0-9-]+\.workers\.dev/)?.[0];
  if (workerUrl) writeFileSync(".cache/worker-url.txt", workerUrl);
  if (d.ok) wrangler(["secret", "bulk"], JSON.stringify({ SPIKE_TOKEN: v.SPIKE_TOKEN, AGENTMAIL_KEY: v.AGENTMAIL_KEY, AGENTMAIL_INBOX: v.AGENTMAIL_INBOX, TEST_TO: v.TEST_TO }));
}
