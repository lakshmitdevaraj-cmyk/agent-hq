// Test A, part 1: fetch each site once (cached in .cache/, git-ignored), then time the parsing only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchSite, parsePages, fingerprint, VARIANTS, type Page } from "../lib/analyze";
import { SITES } from "../lib/sites";

const cpuMs = (fn: () => unknown) => { const a = process.cpuUsage(); const out = fn(); const d = process.cpuUsage(a); return { ms: (d.user + d.system) / 1000, out }; };
const median = (n: number[]) => [...n].sort((a, b) => a - b)[Math.floor(n.length / 2)];
const kb = (pages: Page[]) => Math.round(pages.reduce((s, p) => s + Buffer.byteLength(p.html), 0) / 1024);
const isContact = (p: Page) => /\/contact(-us)?\/?$/i.test(new URL(p.url).pathname);

function measure(host: string, pages: Page[]) {
  const runs: number[] = [];
  let out: ReturnType<typeof parsePages> | null = null;
  for (let i = 0; i < 5; i++) { const m = cpuMs(() => parsePages(host, pages)); runs.push(m.ms); out = m.out as ReturnType<typeof parsePages>; }
  return { kb: kb(pages), first_ms: runs[0], median_ms: median(runs), fp: fingerprint(out!) };
}

const rows = [];
for (const host of SITES) {
  const file = `.cache/${host}.json`;
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(await fetchSite(host, undefined, 700)));
  const pages: Page[] = JSON.parse(readFileSync(file, "utf8"));
  if (!pages.length) { rows.push({ host, loaded: false }); console.log(host, "did not load"); continue; }
  const full = measure(host, pages);
  const lite = measure(host, pages.filter((p, i) => i === 0 || isContact(p)));
  const trim = measure(host, pages.map(VARIANTS.trim));
  const strip = measure(host, pages.map(VARIANTS.strip));
  const perPage = pages.map((p) => measure(host, [p]));
  const diff = (v: typeof full) => Object.keys(full.fp).filter((k) => (v.fp as Record<string, unknown>)[k] !== (full.fp as Record<string, unknown>)[k]);
  rows.push({
    host, loaded: true, pages: pages.length, full, lite: { ...lite, lost: diff(lite) }, trim: { ...trim, lost: diff(trim) }, strip: { ...strip, lost: diff(strip) },
    per_page: { max_kb: Math.max(...perPage.map((x) => x.kb)), max_median_ms: Math.max(...perPage.map((x) => x.median_ms)), max_first_ms: Math.max(...perPage.map((x) => x.first_ms)) },
  });
  console.log(`${host.padEnd(30)} pages=${pages.length} kb=${full.kb} full=${full.median_ms.toFixed(1)}ms (first ${full.first_ms.toFixed(1)}) lite=${lite.median_ms.toFixed(1)} trim=${trim.median_ms.toFixed(1)}[${diff(trim)}] strip=${strip.median_ms.toFixed(1)}[${diff(strip)}] 1page=${Math.max(...perPage.map((x) => x.median_ms)).toFixed(1)}`);
}
writeFileSync("results/a-local.json", JSON.stringify({ node: process.version, arch: process.arch, rows }, null, 1));
