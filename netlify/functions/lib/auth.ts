import { nanoid } from "nanoid";
import { store, readJson, writeJson } from "./blobs";

const CONFIG_STORE = "agent-hq-config";
const AGENT_KEYS_STORE = "agent-hq-agent-keys";
const API_KEY_KEY = "api-key";

type ApiKeyRecord = { key: string; created_at: string };
type AgentKeyRecord = { agent_id: string; sign_in_name: string; created_at: string };

export async function getOrCreateApiKey(): Promise<string> {
  const s = store(CONFIG_STORE);

  // Try up to 3 reads with short delays. Eventual consistency means a concurrent
  // writer may have JUST stored the key — wait briefly before giving up and
  // writing a new one.
  for (let i = 0; i < 3; i++) {
    const existing = await readJson<ApiKeyRecord>(s, API_KEY_KEY);
    if (existing?.key) return existing.key;
    if (i < 2) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }

  const key = `ahq_${nanoid(32)}`;
  await writeJson<ApiKeyRecord>(s, API_KEY_KEY, { key, created_at: new Date().toISOString() });

  // Re-read after writing — if another caller raced us and their key is now
  // stored, return their key instead. This keeps bootstrap idempotent across
  // tabs/concurrent first visits.
  await new Promise((r) => setTimeout(r, 500));
  const stored = await readJson<ApiKeyRecord>(s, API_KEY_KEY);
  return stored?.key ?? key;
}

export type ApiKeyIdentity =
  | { kind: "master" }
  | { kind: "agent"; agent_id: string; sign_in_name: string }
  | null;

export async function identifyApiKey(provided: string | null): Promise<ApiKeyIdentity> {
  if (!provided) return null;
  const master = await readJson<ApiKeyRecord>(store(CONFIG_STORE), API_KEY_KEY);
  if (master && master.key === provided) return { kind: "master" };
  const agentRecord = await readJson<AgentKeyRecord>(store(AGENT_KEYS_STORE), provided);
  if (agentRecord) {
    return { kind: "agent", agent_id: agentRecord.agent_id, sign_in_name: agentRecord.sign_in_name };
  }
  return null;
}

export async function createAgentKey(agent_id: string, sign_in_name: string): Promise<string> {
  const key = `akey_${nanoid(28)}`;
  await writeJson<AgentKeyRecord>(store(AGENT_KEYS_STORE), key, {
    agent_id,
    sign_in_name,
    created_at: new Date().toISOString(),
  });
  return key;
}

/** True once a master key has been issued (bootstrap is then closed). */
export async function hasApiKey(): Promise<boolean> {
  const rec = await readJson<ApiKeyRecord>(store(CONFIG_STORE), API_KEY_KEY);
  return !!rec?.key;
}

/** Replace the master key with a fresh one. Caller must already be authenticated as master. */
export async function rotateApiKey(): Promise<string> {
  const key = `ahq_${nanoid(32)}`;
  await writeJson<ApiKeyRecord>(store(CONFIG_STORE), API_KEY_KEY, { key, created_at: new Date().toISOString() });
  return key;
}
