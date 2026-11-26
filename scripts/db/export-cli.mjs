// The four stores data.export cannot reach, read with the Netlify CLI (blobs:list / blobs:get only).
//   node scripts/db/export-cli.mjs list <export folder>     counts and estimated calls
//   node scripts/db/export-cli.mjs export <export folder>   saves them beside the other stores, adds them to manifest.json
// Keys can contain email addresses, so only counts are printed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./export-lib.mjs";
import { listKeys, netlify, withRegion } from "./netlify-read.mjs";

export const CLI_STORES = ["agent-hq-outreach-contacts", "agent-hq-outreach-campaign-state", "agent-hq-lead-screenshots", "agent-hq-webhook-events"];

const [mode, dir] = process.argv.slice(2);
if (!["list", "export"].includes(mode) || !dir) { console.log("Usage: node scripts/db/export-cli.mjs list|export <export folder>"); process.exit(1); }

const manifestFile = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const campaignIds = new Set(readFileSync(join(dir, "agent-hq-outreach-campaigns.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key));

// Find the region that holds the live data: its campaign list must match the campaigns data.export returned.
async function findRegion() {
  for (const region of ["", "us-east-2", "us-east-1"]) {
    try {
      const ids = await listKeys("agent-hq-outreach-campaigns", region);
      const same = ids.length === campaignIds.size && ids.every((k) => campaignIds.has(k));
      console.log(`region ${region || "default"}: ${ids.length} campaign keys, ${same ? "same as" : "NOT the same as"} data.export`);
      if (same) return region;
    } catch (e) {
      console.log(`region ${region || "default"}: ${e.message}`);
    }
  }
  throw new Error("no region returned the live campaigns; nothing else was read");
}

try {
  const region = await findRegion();
  const keys = {};
  for (const store of CLI_STORES) keys[store] = await listKeys(store, region);
  console.table(CLI_STORES.map((store) => ({
    store, records: keys[store].length,
    // contacts are facts held in the key itself ("sent/…", "bounced/…"); the value is still read, as it is data
    blobs_get_calls: keys[store].length,
  })));
  const total = CLI_STORES.reduce((n, s) => n + keys[s].length, 0);
  console.log(`list calls made now: ${CLI_STORES.length}; export would make ${CLI_STORES.length} list + ${total} get = ${total + CLI_STORES.length} calls`);
  const kinds = {};
  for (const k of keys["agent-hq-outreach-contacts"]) { const kind = k.split("/")[0]; kinds[kind] = (kinds[kind] ?? 0) + 1; }
  console.log("contact entries by kind:", JSON.stringify(kinds));
  // Proof this is the live site: campaign-state is keyed by campaign id.
  const state = keys["agent-hq-outreach-campaign-state"];
  console.log(`campaign-state keys that match a campaign from data.export: ${state.filter((k) => campaignIds.has(k)).length} of ${state.length} (${campaignIds.size} campaigns exported)`);

  if (mode === "export") {
    for (const store of CLI_STORES) {
      const file = join(dir, `${store}.jsonl`);
      if (existsSync(file)) throw new Error(`${file} already exists; it is not overwritten`);
      const lines = new Array(keys[store].length);
      const removed = {};
      let next = 0, failed = 0;
      const tmpFiles = join(dir, ".tmp-get");
      const worker = async (w) => {
        const tmp = `${tmpFiles}-${w}`;
        while (next < keys[store].length) {
          const i = next++;
          const key = keys[store][i];
          try {
            rmSync(tmp, { force: true });
            await netlify(withRegion(["blobs:get", store, key, "--output", tmp], region));
            const clean = redact(store, readFileSync(tmp, "utf8"));
            for (const f of clean.redacted) removed[f] = (removed[f] ?? 0) + 1;
            lines[i] = JSON.stringify({ key, value: clean.value });
          } catch { failed++; }
        }
        rmSync(tmp, { force: true });
      };
      await Promise.all([0, 1, 2, 3].map(worker));
      const text = lines.filter(Boolean).map((l) => `${l}\n`).join("");
      writeFileSync(file, text, { mode: 0o600 });
      const count = lines.filter(Boolean).length;
      manifest.stores.push({ store, source: "netlify blobs:get", count, counted: keys[store].length, failed, calls: keys[store].length + 1, sha256: createHash("sha256").update(text).digest("hex"), redacted: removed });
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      console.log(`${store}: ${count} of ${keys[store].length} records, ${failed} failed${Object.keys(removed).length ? `, removed ${JSON.stringify(removed)}` : ""}`);
    }
  }
} catch (e) {
  console.log(e.message);
  process.exit(1);
}
