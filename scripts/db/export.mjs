// One read-only export of the live data. Only data.counts and data.export are ever called.
//   node scripts/db/export.mjs counts   shows the stores, record counts and the estimated calls
//   node scripts/db/export.mjs export   writes <store>.jsonl + manifest.json to ~/agent-hq-backups/p1-<date>/
// The master key is read from db/local/.env (ALCANCE_MASTER_KEY) and never printed.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localVar } from "./env.mjs";
import { estimateCalls, exportStore, redact } from "./export-lib.mjs";

const SITE = "https://shiftforge-hq.netlify.app";
const ALLOWED = new Set(["data.counts", "data.export"]);

const key = localVar("ALCANCE_MASTER_KEY");
if (!key) { console.log("ALCANCE_MASTER_KEY is empty in db/local/.env"); process.exit(1); }

let made = 0;
async function call(action, params = {}) {
  if (!ALLOWED.has(action)) throw new Error(`refusing to call ${action}: this script only reads`);
  made++;
  const r = await fetch(`${SITE}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ action, params }),
  });
  const body = await r.json().catch(() => null);
  // Only the status and the server's short error text: never the body.
  if (!r.ok || !body?.ok) throw new Error(`${action} failed: HTTP ${r.status}${body?.error ? ` (${String(body.error).slice(0, 120)})` : ""}`);
  return body.data;
}

const mode = process.argv[2];
if (mode !== "counts" && mode !== "export") { console.log("Usage: node scripts/db/export.mjs counts|export"); process.exit(1); }

try {
  const { counts } = await call("data.counts");
  console.table(Object.entries(counts).map(([store, records]) => ({ store, records })));
  console.log(`${Object.keys(counts).length} stores, ${Object.values(counts).reduce((a, b) => a + b, 0)} records, at least ${estimateCalls(counts)} data.export calls`);

  if (mode === "export") {
    const day = new Date().toLocaleDateString("en-CA"); // local date, YYYY-MM-DD
    const dir = join(homedir(), "agent-hq-backups", `p1-${day}`);
    if (existsSync(join(dir, "manifest.json"))) throw new Error(`${dir} already holds an export; it is not overwritten`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const manifest = { site: SITE, exported_at: new Date().toISOString(), stores: [] };
    for (const [store, counted] of Object.entries(counts)) {
      const { records, calls, total } = await exportStore(call, store);
      const removed = {};
      const text = records.map((rec) => {
        const clean = redact(store, rec.value);
        for (const f of clean.redacted) removed[f] = (removed[f] ?? 0) + 1;
        return JSON.stringify({ key: rec.key, value: clean.value });
      }).join("\n") + (records.length ? "\n" : "");
      writeFileSync(join(dir, `${store}.jsonl`), text, { mode: 0o600 });
      const entry = { store, source: "data.export", count: records.length, counted, listed: total, calls, sha256: createHash("sha256").update(text).digest("hex"), redacted: removed };
      manifest.stores.push(entry);
      console.log(`${store}: ${records.length} of ${counted} records, ${calls} call(s)${Object.keys(removed).length ? `, removed ${JSON.stringify(removed)}` : ""}`);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(`saved to ${dir}`);
  }
  console.log(`calls made to the live site: ${made}`);
} catch (e) {
  console.log(e.message);
  process.exit(1);
}
