// Checks a saved export without printing any record content: file counts and checksums against the manifest,
// and a search for secrets. Usage: node scripts/db/verify-export.mjs <export folder>
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { localVar } from "./env.mjs";
import { REDACTED, redact } from "./export-lib.mjs";

const dir = process.argv[2];
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const master = localVar("ALCANCE_MASTER_KEY");

const rows = [];
const suspect = new Map(); // "store field" -> { total, redacted, empty }
let masterHits = 0;
let patternHits = 0;
for (const s of manifest.stores) {
  const text = readFileSync(join(dir, `${s.store}.jsonl`), "utf8");
  const records = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  rows.push({
    store: s.store.replace("agent-hq-", ""), counted: s.counted, in_file: records.length, listed: s.listed ?? s.counted,
    unique_keys: new Set(records.map((r) => r.key)).size, calls: s.calls,
    checksum: createHash("sha256").update(text).digest("hex") === s.sha256 ? "ok" : "DIFFERENT",
    mode: (statSync(join(dir, `${s.store}.jsonl`)).mode & 0o777).toString(8),
  });
  if (master && text.includes(master)) masterHits++;
  for (const r of records) {
    // Running the removal again must find nothing left to remove.
    patternHits += redact(s.store, r.value).redacted.length;
    let v; try { v = JSON.parse(r.value); } catch { continue; }
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [k, val] of Object.entries(node)) {
        if (!Array.isArray(node) && /key|secret|token|passw|auth|signature|cookie|credential/i.test(k)) {
          const id = `${s.store.replace("agent-hq-", "")}.${k}`;
          const c = suspect.get(id) ?? { seen: 0, redacted: 0, empty: 0, other: 0 };
          c.seen++;
          if (val === REDACTED) c.redacted++; else if (val === null || val === "") c.empty++; else c.other++;
          suspect.set(id, c);
        }
        walk(val);
      }
    };
    walk(v);
  }
}
console.table(rows);
console.log(`folder mode ${(statSync(dir).mode & 0o777).toString(8)}; files: ${readdirSync(dir).length}`);
console.log(`files containing the master key: ${masterHits}`);
console.log(`secret-shaped values or secret fields still present: ${patternHits}`);
console.log("field names that sound secret (names and counts only):");
console.table(Object.fromEntries(suspect));
