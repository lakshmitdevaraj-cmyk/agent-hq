// In-memory @netlify/blobs for the local comparison: the real production handlers run on this copy of the fake data.
export const stores = new Map<string, Map<string, string>>();
export function connectLambda(_e: unknown): void {}
const bucket = (name: string) => stores.get(name) ?? stores.set(name, new Map()).get(name)!;
export function getStore(name: string) {
  return {
    async get(key: string) { return bucket(name).get(key) ?? null; },
    async set(key: string, value: string) { bucket(name).set(key, value); },
    async setJSON(key: string, value: unknown) { bucket(name).set(key, JSON.stringify(value)); },
    async delete(key: string) { bucket(name).delete(key); },
    async list(opts?: { prefix?: string }) {
      const p = opts?.prefix ?? "";
      return { blobs: [...bucket(name).keys()].filter((k) => k.startsWith(p)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => ({ key, etag: "" })), directories: [] };
    },
  };
}
