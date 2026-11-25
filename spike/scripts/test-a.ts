// Test A on Cloudflare. Real site fetches: 3 runs per site (1 for sites that block us). Variants re-use the cached HTML.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SITES } from "../lib/sites";
import { packPages, fingerprint, parsePages, type Page } from "../lib/analyze";
// @ts-expect-error plain JS helper
import { call, startTail, sleep } from "./remote.mjs";

const tail = await startTail("a");
const sent: Array<{ rid: string; host: string; mode: string; status: number; ms: number; err1102?: boolean; body?: Record<string, unknown> }> = [];
let n = 0;
async function run(host: string, mode: string, path: string, init?: RequestInit) {
  const rid = `a${++n}`;
  const r = await call(path, rid, init);
  let body: Record<string, unknown> | undefined;
  try { body = JSON.parse(r.text); } catch { /* error page */ }
  sent.push({ rid, host, mode, status: r.status, ms: r.ms, err1102: r.error1102, body });
  return { status: r.status, body };
}

const local: Record<string, Page[]> = Object.fromEntries(SITES.map((h) => [h, existsSync(`.cache/${h}.json`) ? JSON.parse(readFileSync(`.cache/${h}.json`, "utf8")) : []]));
for (let round = 1; round <= 3; round++) {
  for (const host of SITES) {
    if (!local[host].length && round > 1) continue;
    const r = await run(host, "live", `/site?host=${host}`);
    console.log(round, host, r.status, r.body?.loaded ?? "");
    await sleep(1500);
  }
}
for (const host of SITES) {
  const pages = local[host];
  if (!pages.length) continue;
  const isContact = (p: Page) => /\/contact(-us)?\/?$/i.test(new URL(p.url).pathname);
  const biggest = [...pages].sort((a, b) => b.html.length - a.html.length)[0];
  const modes: Array<[string, string, Page[]]> = [["full", "full", pages], ["lite", "full", pages.filter((p, i) => i === 0 || isContact(p))], ["trim", "trim", pages], ["strip", "strip", pages], ["onepage", "full", [biggest]], ["onepage-strip", "strip", [biggest]]];
  for (const [mode, variant, set] of modes) for (let i = 0; i < 3; i++) { await run(host, mode, `/parse?host=${host}&variant=${variant}`, { method: "POST", body: packPages(set) }); await sleep(150); }
  console.log("variants done", host);
}
await tail.stop();
const cf = tail.byRid();

const rows = SITES.map((host) => {
  const modes: Record<string, unknown> = {};
  for (const mode of ["live", "full", "lite", "trim", "strip", "onepage", "onepage-strip"]) {
    const mine = sent.filter((s) => s.host === host && s.mode === mode);
    if (!mine.length) continue;
    const cpu = mine.map((s) => cf[s.rid]?.cpu).filter((x) => x !== undefined) as number[];
    modes[mode] = { runs: mine.length, statuses: mine.map((s) => s.status), outcomes: mine.map((s) => cf[s.rid]?.outcome ?? "not-in-tail"), cpu_ms: cpu, max_cpu_ms: cpu.length ? Math.max(...cpu) : null, err1102: mine.filter((s) => s.err1102).length, wall_ms: mine.map((s) => s.ms) };
  }
  const live = sent.filter((s) => s.host === host && s.mode === "live" && s.body?.loaded);
  const expected = local[host].length ? fingerprint(parsePages(host, local[host])) : null;
  const got = live[0]?.body?.fp as Record<string, unknown> | undefined;
  return { host, loaded_local: local[host].length > 0, loaded_worker: live.length > 0, differs_from_local: got && expected ? Object.keys(expected).filter((k) => got[k] !== (expected as Record<string, unknown>)[k]) : null, modes };
});
writeFileSync("results/a-worker.json", JSON.stringify({ at: new Date().toISOString(), tail_events: Object.keys(cf).length, requests: sent.length, rows }, null, 1));

console.log(`requests=${sent.length} matched_in_tail=${Object.keys(cf).length}`);
for (const r of rows) {
  const m = r.modes as Record<string, { max_cpu_ms: number | null; outcomes: string[]; statuses: number[] }>;
  const bad = (x: string) => m[x]?.outcomes.filter((o) => o !== "ok").length ?? 0;
  console.log(r.host.padEnd(30), `loaded=${r.loaded_worker}`, Object.keys(m).map((k) => `${k}=${m[k].max_cpu_ms ?? "?"}${bad(k) ? `(${bad(k)}x ${m[k].outcomes.find((o) => o !== "ok")})` : ""}`).join(" "), r.differs_from_local?.length ? `differs:${r.differs_from_local}` : "");
}
