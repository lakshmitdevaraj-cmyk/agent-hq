// Shared helpers: call the deployed Worker and collect Cloudflare's own CPU numbers from `wrangler tail`.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { vars } from "./env.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BASE = process.env.SPIKE_URL ?? readFileSync(".cache/worker-url.txt", "utf8").trim();
const token = vars().SPIKE_TOKEN;

export async function call(path, rid, init = {}) {
  const u = new URL(path, BASE);
  if (rid) u.searchParams.set("rid", rid);
  const t = performance.now();
  try {
    const r = await fetch(u, { ...init, headers: { "x-spike-token": token, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(120_000) });
    const text = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t), bytes: text.length, text, headers: Object.fromEntries(r.headers), error1102: /error code: 1102|exceeded resource limits/i.test(text) };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t), text: String(e.cause?.code ?? e.message), headers: {}, bytes: 0 };
  }
}

export async function startTail(name) {
  const file = `.cache/tail-${name}.log`;
  writeFileSync(file, "");
  const child = spawn("npx", ["wrangler", "tail", "alcance-spike", "--format", "json"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; appendFileSync(file, d); });
  child.stderr.on("data", (d) => appendFileSync(file + ".err", d));
  await sleep(10_000);
  const events = () => {
    const out = [];
    let depth = 0, start = -1, str = false, esc = false;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = depth > 0;
      else if (c === "{") { if (depth++ === 0) start = i; }
      else if (c === "}" && depth > 0 && --depth === 0) { try { out.push(JSON.parse(buf.slice(start, i + 1))); } catch { /* partial */ } }
    }
    return out;
  };
  return {
    events,
    /** Cloudflare's record for one request id. */
    byRid: () => Object.fromEntries(events().flatMap((e) => {
      const u = e.event?.request?.url;
      const rid = u ? new URL(u).searchParams.get("rid") : null;
      return rid ? [[rid, { cpu: e.cpuTime, wall: e.wallTime, outcome: e.outcome }]] : [];
    })),
    async stop() { await sleep(12_000); try { process.kill(-child.pid); } catch { /* gone */ } },
  };
}
