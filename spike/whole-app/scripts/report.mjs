// Builds the action inventory (results/inventory-verdicts.json) from the result files and writes it into REPORT-0.5.md
// between the <!-- inventory --> markers. Every number in the table comes from a file in results/.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const load = (f) => (existsSync(at(`results/${f}`)) ? JSON.parse(readFileSync(at(`results/${f}`), "utf8")) : {});
const inv = load("inventory.json");
const rows = [...Object.values(load("h-light.json")), ...Object.values(load("h-heavy.json"))];
const confirm = load("h-confirm.json");
const mac = load("h-local-cpu.json").results ?? [];
const names = [...inv.command_actions, ...inv.handlers, ...inv.background, "outreach.leads.check_site (300 KB pages)", "outreach.leads.check_site (1 MB pages)"];
const SIZES = [25, 100, 500, 1500];

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const killedCall = (c) => c.status === 503 || /exceeded/i.test(c.outcome ?? "");
/** CPU of the measured calls Cloudflare did NOT cut off; cut-off calls are counted, their CPU is not a measure of the work. */
function stat(row, skipFirst = true) {
  const calls = row.calls.slice(skipFirst ? 1 : 0);
  const done = calls.filter((c) => !killedCall(c) && typeof c.cpu_ms === "number");
  // A recipe that points at a record a small dataset does not have answers 404: not a measurement.
  const usable = done.filter((c) => c.ok);
  return { n: usable.length, median: median(usable.map((c) => c.cpu_ms)), worst: usable.length ? Math.max(...usable.map((c) => c.cpu_ms)) : null, cut: row.calls.filter(killedCall).length, of: row.calls.length };
}

// Verdicts that the numbers alone cannot give.
const RUNNER = "Move to runner";
const CHUNK = "Needs chunking";
const REWRITE = "Needs rewrite";
const MANUAL = {
  "outreach.leads.check_site": [RUNNER, "parses whole web pages"],
  "outreach.leads.check_site (300 KB pages)": [RUNNER, "parses whole web pages"],
  "outreach.leads.check_site (1 MB pages)": [RUNNER, "parses whole web pages"],
  "outreach.leads.enrich_one": [RUNNER, "same website check"],
  "ai-background browsercheck (1 lead)": [RUNNER, "parses rendered pages"],
  "data.import": [CHUNK, "one query per record: bulk insert, or fewer per call"],
  "data.export": [REWRITE, "inflated by the test shim, which loads all values when only keys are asked for; a keys-only query is not measured"],
  "data.counts": [REWRITE, "inflated by the test shim (values loaded just to count); SQL count not measured"],
  "outreach.leads.count": [REWRITE, "inflated by the test shim (values loaded just to count); SQL count not measured"],
  "outreach.campaign.sync": [CHUNK, "writes one record per query: bulk insert"],
  "outreach.campaign.delete": [CHUNK, "deletes one record per query: one SQL delete"],
  "outreach.emails.send": [CHUNK, "one email per queue message, plus SQL instead of store scans"],
  "outreach.emails.generate": [CHUNK, "drafts many leads in one request: one lead per step"],
  "outreach.replies.sync": [CHUNK, "one inbound message per step, plus SQL lookups"],
  "outreach.social.write": [CHUNK, "plans several leads in one request"],
  "outreach.social.batch.start": [CHUNK, "plans several leads in one request"],
  "ai-background draft (10 leads)": [CHUNK, "one lead per Workflow step"],
  "ai-background review (3 drafts)": [CHUNK, "one draft group per Workflow step, plus SQL lookups"],
  "ai-background social (3 leads)": [CHUNK, "one lead per Workflow step"],
  "ai-background social_batch (3 leads)": [CHUNK, "one lead per Workflow step"],
  "ai-background preview": [CHUNK, "run as a Workflow step"],
};
const PARTIAL = {
  "auth.bootstrap": "only the closed (already set up) path",
  "auth.rotate": "only the refusal path; a real rotation would break the test key",
  "outreach.job.resume": "only the nothing-paused path",
  "outreach.social.batch.resume": "only the nothing-paused path",
  "webhook.delete": "only an id that does not exist",
  "outreach.emails.send": "first-pass numbers are with every draft stopped by the send checks (nothing sent); with passing drafts one email at 25 leads took 33 / 42 ms and every larger case was cut off (h-send.json)",
  "ai-background draft (10 leads)": "not measured at 500 leads: the start step before it was cut off",
};

const out = names.map((name) => {
  const mine = SIZES.map((size) => rows.find((r) => r.name === name && r.size === size)).filter(Boolean);
  if (!mine.length) return { name, verdict: "Not tested", why: "no result" };
  const per = Object.fromEntries(mine.map((r) => [r.size, { ...stat(r), rows: r.rows, queries: r.queries, outbound: r.outbound }]));
  let ref = per[500] ?? mine.map((r) => per[r.size])[0];
  const refSize = per[500] ? 500 : mine[0].size;
  const c = confirm[name];
  let source = "first pass";
  // The re-measure replaces the first pass only where it produced real measurements (heavy actions were all cut off in it).
  if (c) {
    const s = stat(c);
    if (s.n >= 4) { ref = { ...ref, median: s.median, worst: s.worst, cut: s.cut, of: s.of, n: s.n }; source = "re-measured"; }
  }
  const m = Object.fromEntries(mac.filter((r) => r.name === name && !r.error).map((r) => [r.size, r.mac_cpu_ms_median]));
  const anyCut = ref.cut > 0;
  const fits = ref.n > 0 && !anyCut && ref.median <= 8 && ref.worst <= 10 && (ref.outbound ?? 0) <= 50;
  const flat = Object.values(per).every((p) => p.median == null || p.median <= 12);
  const marginal = !fits && ref.n > 0 && ref.median <= 10 && flat && ref.cut <= 2;
  const crosses = SIZES.find((s) => per[s] && (per[s].cut > 0 || per[s].median > 10));
  let verdict, why = "";
  if (MANUAL[name] && !fits) [verdict, why] = MANUAL[name];
  else if (fits) verdict = "Fits Worker";
  else if (marginal) { verdict = "Fits Worker (marginal)"; why = "single-record work; some calls over 10 ms"; }
  else if ((ref.rows ?? 0) > 200) { verdict = REWRITE; why = "reads whole stores: filter and sort in SQL"; }
  else { verdict = REWRITE; why = "over without a large scan: trim the work or split it"; }
  if (PARTIAL[name]) { why = [why, PARTIAL[name]].filter(Boolean).join("; "); }
  return { name, verdict, why, ref_size: refSize, source, ref, crosses: crosses ?? null, per, mac_cpu_ms: m };
});
writeFileSync(at("results/inventory-verdicts.json"), JSON.stringify(out, null, 1));

const num = (p) => (!p ? "–" : p.n ? `${p.median} / ${p.worst}${p.cut ? ` (cut ${p.cut}/${p.of})` : ""}` : p.cut ? `cut ${p.cut}/${p.of}` : "–");
const table = [
  "| Action or handler | Verdict | CPU ms median / worst at 500 leads | At 1,500 leads | Mac ms 500 / 1,500 (local) | Over from | Rows read, queries, outside calls at 500 | Note |",
  "|---|---|---|---|---|---|---|---|",
  ...out.map((o) => `| \`${o.name}\` | ${o.verdict} | ${num(o.ref)}${o.source === "re-measured" ? " ®" : ""} | ${num(o.per?.[1500])} | ${o.mac_cpu_ms?.[500] ?? (o.mac_cpu_ms?.[25] ?? "–")} / ${o.mac_cpu_ms?.[1500] ?? "–"} | ${o.crosses ? `${o.crosses} leads` : "–"} | ${o.ref ? `${o.ref.rows}, ${o.ref.queries}, ${o.ref.outbound}` : "–"} | ${o.why ?? ""} |`),
].join("\n");
const count = {};
for (const o of out) count[o.verdict] = (count[o.verdict] ?? 0) + 1;
console.log(out.length, count);

if (existsSync(at("REPORT-0.5.md"))) {
  const md = readFileSync(at("REPORT-0.5.md"), "utf8");
  writeFileSync(at("REPORT-0.5.md"), md.replace(/<!-- inventory -->[\s\S]*<!-- \/inventory -->/, () => `<!-- inventory -->\n${table}\n<!-- /inventory -->`));
} else writeFileSync(at(".cache/table.md"), table);
