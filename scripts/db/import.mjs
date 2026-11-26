// Loads a saved export into a database branch and writes the full report beside the export (outside the repo).
// Usage: node scripts/db/import.mjs <export folder> [dev|perf]
// Approved clean-up goes in <export folder>/decisions.json; without it nothing is merged or renumbered.
// Only counts are printed here. The report file holds names and addresses.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, describe } from "./env.mjs";
import { fingerprint, GROUPS, load } from "./load.mjs";
import { readExport } from "./read-export.mjs";
import { loadRules } from "./rules.mjs";
import { transform } from "./transform.mjs";

const [folder, branch = "dev"] = process.argv.slice(2);
if (!folder || !["dev", "perf"].includes(branch)) throw new Error("usage: node scripts/db/import.mjs <export folder> [dev|perf]");
const { dir, manifest, stores, decisions, today } = readExport(folder);

const result = transform(stores, { rules: await loadRules(), today, exportedAt: manifest.exported_at, decisions });
const unread = Object.keys(stores).filter((s) => !(s in result.report.stores));
if (unread.length) throw new Error(`No rule for: ${unread.join(", ")}`);

const sql = connect(branch);
try {
  console.log(`Branch ${branch}, region ${describe(branch).region}. Export of ${manifest.exported_at}, today = ${today}. Approved changes: ${decisions.merges?.length ?? 0} merges, ${decisions.email_steps?.length ?? 0} step moves.`);
  await load(sql, result);
  const after = await fingerprint(sql);
  console.table(GROUPS.map(([store, ...tables]) => {
    const r = result.report.stores[`agent-hq-${store}`];
    return {
      store, exported: r?.exported ?? "-", read: r?.records ?? "-", parse_failed: r?.parse_failed ?? "-",
      skipped: r && Object.keys(r.skipped).length ? JSON.stringify(r.skipped) : "",
      rows: tables.map((t) => `${t} ${after[t].rows}`).join(", "),
      sent: tables.map((t) => result.tables[t]?.length ?? 0).join(" / "),
    };
  }));
  const report = { branch, export: manifest.exported_at, today, tables: after, ...result.report };
  writeFileSync(join(dir, `import-report-${branch}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Checksum of all tables: ${createHash("md5").update(JSON.stringify(after)).digest("hex")}`);
  console.log(`Full report: ${join(dir, `import-report-${branch}.json`)}`);
} finally {
  await sql.end();
}
