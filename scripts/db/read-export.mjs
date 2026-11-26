// Reads a saved export (outside the repo), checks it against its manifest and works out "today" for it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readExport(folder) {
  const dir = resolve(folder);
  if (dir.startsWith(fileURLToPath(new URL("../..", import.meta.url)))) throw new Error("The export folder must be outside the repo");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const stores = {};
  for (const s of manifest.stores) {
    const text = readFileSync(join(dir, `${s.store}.jsonl`), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== s.sha256) throw new Error(`${s.store}.jsonl differs from the manifest`);
    stores[s.store] = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (stores[s.store].length !== s.count) throw new Error(`${s.store}.jsonl holds ${stores[s.store].length} records, the manifest says ${s.count}`);
  }
  const decisionsFile = join(dir, "decisions.json");
  const decisions = existsSync(decisionsFile) ? JSON.parse(readFileSync(decisionsFile, "utf8")) : {};
  // "Today" for follow-up dates is the day of the export, in the sending time zone, as the app would see it.
  const settings = JSON.parse(stores["agent-hq-outreach-settings"]?.find((r) => r.key === "settings")?.value ?? "{}");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.time_zone || "UTC" }).format(new Date(manifest.exported_at));
  return { dir, manifest, stores, decisions, today };
}
