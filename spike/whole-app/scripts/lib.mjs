// Shared helpers: call the Worker (deployed or local) and read Cloudflare's CPU numbers from `wrangler tail`.
// Raw tail events carry request headers, so they stay in memory and are never written to disk.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { vars } from "../../scripts/env.mjs";
import { apiKey } from "../db/seed-kv.mjs";

export const DIR = new URL("..", import.meta.url);
export const WORKER = "alcance-whole-app";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const save = (name, data) => writeFileSync(new URL(`results/${name}`, DIR), JSON.stringify(data, null, 1));
export const baseUrl = () => process.env.SPIKE_URL ?? readFileSync(new URL(".cache/worker-url.txt", DIR), "utf8").trim();
export const token = () => process.env.SPIKE_LOCAL_TOKEN ?? vars().WHOLE_APP_TOKEN;

let rid = 0;
export async function call({ path = "/api/command", method = "POST", ns = "d500", mode = "batched", body, headers = {}, noAuth = false }) {
  const id = `r${Date.now().toString(36)}-${++rid}`;
  const u = new URL(path, baseUrl());
  u.searchParams.set("rid", id);
  const t = performance.now();
  try {
    const r = await fetch(u, {
      method, signal: AbortSignal.timeout(180_000),
      headers: { ...(noAuth ? {} : { "x-spike-token": token(), "x-api-key": apiKey() }), "x-spike-ns": ns, "x-spike-mode": mode, "content-type": "application/json", ...headers },
      body: method === "GET" ? undefined : body === undefined ? "{}" : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await r.text();
    let stats = null;
    try { stats = JSON.parse(r.headers.get("x-spike-stats")); } catch { /* killed or rejected requests have none */ }
    return { rid: id, status: r.status, ms: Math.round(performance.now() - t), bytes: text.length, text, stats, cfError: /error code: (1101|1102)|exceeded (cpu|resource)/i.exec(text)?.[0] };
  } catch (e) {
    return { rid: id, status: 0, ms: Math.round(performance.now() - t), bytes: 0, text: String(e.cause?.code ?? e.message), stats: null };
  }
}

export async function startTail() {
  const byRid = new Map();
  const others = []; // Workflow and /slow invocations (no request id): CPU, wall time and outcome only
  let buf = "";
  const child = spawn("npx", ["wrangler", "tail", WORKER, "--format", "json"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const drain = () => {
    let depth = 0, start = -1, str = false, esc = false, consumed = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = depth > 0;
      else if (c === "{") { if (depth++ === 0) start = i; }
      else if (c === "}" && depth > 0 && --depth === 0) {
        try {
          const e = JSON.parse(buf.slice(start, i + 1));
          const u = e.event?.request?.url ? new URL(e.event.request.url) : null;
          const id = u?.searchParams.get("rid") ?? null;
          if (!u || u.pathname === "/slow") others.push({ kind: u ? "/slow request" : e.entrypoint ? `entrypoint ${e.entrypoint}` : "non-HTTP event", cpu_ms: e.cpuTime, wall_ms: e.wallTime, outcome: e.outcome });
          if (id) byRid.set(id, { cpu: e.cpuTime, wall: e.wallTime, outcome: e.outcome, errors: (e.exceptions ?? []).map((x) => String(x.message).slice(0, 160)) });
        } catch { /* partial */ }
        consumed = i + 1;
      }
    }
    if (consumed) buf = buf.slice(consumed);
  };
  child.stdout.on("data", (d) => { buf += d; drain(); });
  await sleep(8000);
  return {
    /** Wait for Cloudflare's records of these request ids. */
    async wait(ids, ms = 15_000) {
      const t = Date.now();
      while (Date.now() - t < ms && !ids.every((i) => byRid.has(i))) await sleep(500);
      return ids.map((i) => byRid.get(i) ?? null);
    },
    others: () => others,
    stop() { try { process.kill(-child.pid); } catch { /* gone */ } },
  };
}
