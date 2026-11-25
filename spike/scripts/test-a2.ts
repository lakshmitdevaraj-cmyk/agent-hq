// Test A, optimisation re-measure after the Worker had rested: one pass per variant, smallest site first.
// Uses the cached HTML, so no prospect website is visited.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SITES } from "../lib/sites";
import { packPages, type Page } from "../lib/analyze";
// @ts-expect-error plain JS helper
import { call, startTail, sleep } from "./remote.mjs";

const loaded = SITES.filter((h) => existsSync(`.cache/${h}.json`))
  .map((host) => ({ host, pages: JSON.parse(readFileSync(`.cache/${host}.json`, "utf8")) as Page[] }))
  .filter((s) => s.pages.length)
  .sort((a, b) => packPages(a.pages).length - packPages(b.pages).length);

const tail = await startTail("a2");
const sent: Array<{ rid: string; host: string; mode: string; kchars: number; status: number }> = [];
let n = 0;
for (const mode of ["onepage-strip", "strip"]) {
  for (const { host, pages } of loaded) {
    const set = mode === "strip" ? pages : [[...pages].sort((a, b) => b.html.length - a.html.length)[0]];
    const body = packPages(set);
    const rid = `v${++n}`;
    const r = await call(`/parse?host=${host}&variant=strip`, rid, { method: "POST", body });
    sent.push({ rid, host, mode, kchars: Math.round(body.length / 1024), status: r.status });
    await sleep(3000);
  }
  if (mode === "onepage-strip") await sleep(60_000);
}
await tail.stop();
const cf = tail.byRid();
const rows = sent.map((s) => ({ ...s, cpu_ms: cf[s.rid]?.cpu ?? null, outcome: cf[s.rid]?.outcome ?? "not-in-tail" }));
writeFileSync("results/a-worker-variants.json", JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
for (const mode of ["onepage-strip", "strip"]) {
  const m = rows.filter((r) => r.mode === mode);
  console.log(mode, `ok=${m.filter((r) => r.status === 200).length}/${m.length}`, m.map((r) => `${r.kchars}k:${r.status}:${r.cpu_ms ?? "?"}`).join(" "));
}
