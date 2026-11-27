// An in-memory stand-in for @netlify/blobs, filled from a P1 export folder. The export is only ever READ
// (one readFileSync per store); writes made by the old code stay in memory and vanish with the process.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function fakeBlobs(exportDir, seed = {}) {
  const stores = new Map();
  const load = (name) => {
    if (stores.has(name)) return stores.get(name);
    const map = new Map();
    const file = join(exportDir, `${name}.jsonl`);
    if (existsSync(file)) {
      for (const line of readFileSync(file, { encoding: "utf8", flag: "r" }).split("\n")) {
        if (!line.trim()) continue;
        const { key, value } = JSON.parse(line);
        map.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    for (const [key, value] of Object.entries(seed[name] ?? {})) map.set(key, typeof value === "string" ? value : JSON.stringify(value));
    stores.set(name, map);
    return map;
  };

  const store = (name) => {
    const map = load(name);
    const api = {
      async get(key, opts = {}) {
        if (!map.has(key)) return null;
        const raw = map.get(key);
        if (opts.type === "json") return JSON.parse(raw);
        if (opts.type && opts.type !== "text") throw new Error(`fake blobs: get type ${opts.type} is not supported`);
        return raw;
      },
      async getWithMetadata(key, opts = {}) {
        const data = await api.get(key, opts);
        return data === null ? null : { data, etag: `"${key}"`, metadata: {} };
      },
      async getMetadata(key) { return map.has(key) ? { etag: `"${key}"`, metadata: {} } : null; },
      async set(key, value) { map.set(key, typeof value === "string" ? value : String(value)); return { modified: true }; },
      async setJSON(key, value) { map.set(key, JSON.stringify(value)); return { modified: true }; },
      async delete(key) { map.delete(key); },
      async list({ prefix = "" } = {}) {
        const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { blobs: keys.map((key) => ({ key, etag: `"${key}"` })), directories: [] };
      },
    };
    // Anything else the old code calls is unknown here: fail loudly rather than return something made up.
    return new Proxy(api, { get: (t, p) => (p in t ? t[p] : typeof p === "string" && p !== "then" ? () => { throw new Error(`fake blobs: ${p}() is not supported`); } : undefined) });
  };

  return { getStore: (nameOrOpts) => store(typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name), connectLambda: () => {}, stores };
}
