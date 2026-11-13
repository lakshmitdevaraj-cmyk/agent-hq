import { getStore } from "@netlify/blobs";

export type Store = ReturnType<typeof getStore>;

// Stores the app reads straight after writing (leads, drafts, campaigns,
// replies, settings). Strong consistency makes a new item show up in the next
// list/get instead of ~1 minute later.
const STRONG = new Set([
  "agent-hq-outreach-campaigns",
  "agent-hq-outreach-leads",
  "agent-hq-outreach-emails",
  "agent-hq-outreach-replies",
  "agent-hq-outreach-settings",
]);

export function store(name: string): Store {
  return STRONG.has(name) ? getStore({ name, consistency: "strong" }) : getStore(name);
}

export async function readJson<T>(s: Store, key: string): Promise<T | null> {
  const raw = await s.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw as string) as T;
  } catch {
    return null;
  }
}

export async function writeJson<T>(s: Store, key: string, value: T): Promise<void> {
  await s.set(key, JSON.stringify(value));
}

export async function listJson<T>(s: Store, prefix?: string): Promise<T[]> {
  const { blobs } = await s.list(prefix ? { prefix } : undefined);
  const out: T[] = [];
  for (const b of blobs) {
    const v = await readJson<T>(s, b.key);
    if (v) out.push(v);
  }
  return out;
}
