// P2 chunk 9: Settings and service keys on Postgres (used when DATA_BACKEND=sql; the Blobs code stays the default).
//   - R3: a service key lives in one place, `service_config` (Settings → API keys). The Gemini key is never read from or
//     written to the Voice copy (`voice_config`, dropped in chunk 12, X2).
//   - V7: config.set tests a key before it is saved; a failed test saves nothing. config.status shows masked keys only.
//     The tests themselves (calls to Gemini, Apify, AgentMail) come in as deps from command.ts; tests pass stubs.
//   - Settings: command.ts keeps its one copy of the Settings rules; only the storage changes. A write sets only the
//     fields that changed (`data || changes`, removed fields dropped), so a change made meanwhile is kept.
// Keys are stored as text in service_config.data.key, as in Blobs today. Encrypting them at rest needs an app secret
// in the Netlify settings (a decision for Lakshmi, see the chunk 9 report).
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export type KeyTest = (service: string, key: string, model?: string) => Promise<{ ok: boolean; message: string }>;
export type ConfigDeps = { test: KeyTest; services: string[] };
const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };

export function maskKey(raw: string): string {
  if (!raw) return "";
  if (raw.length <= 10) return "•".repeat(raw.length);
  return `${raw.slice(0, 4)}${"•".repeat(Math.max(4, raw.length - 8))}${raw.slice(-4)}`;
}

// ── Settings ───────────────────────────────────────────────────────────────

export async function readSettings(q: Q): Promise<Row> {
  const [r] = await q`select data from outreach_settings where key = 'settings'`;
  return (r?.data as Row) ?? {};
}

/** Saves `next` over `current`: only the fields that differ are written; a field set to undefined is removed. */
export async function writeSettings(q: Q, current: Row, next: Row): Promise<void> {
  const changed: Row = {};
  const removed: string[] = [];
  for (const k of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (next[k] === undefined) { if (k in current && current[k] !== undefined) removed.push(k); continue; }
    if (JSON.stringify(next[k]) !== JSON.stringify(current[k])) changed[k] = next[k];
  }
  if (!Object.keys(changed).length && !removed.length) return;
  await q`insert into outreach_settings (key, data) values ('settings', ${q.json(changed as never)})
          on conflict (key) do update set data = (outreach_settings.data - ${removed}::text[]) || ${q.json(changed as never)}`;
}

// ── Service keys ───────────────────────────────────────────────────────────

export async function readServiceKey(q: Q, service: string): Promise<string | null> {
  const [r] = await q`select data->>'key' as key from service_config where service = ${service}`;
  return (r?.key as string | null) || null;
}

export async function writeServiceKey(q: Q, service: string, key: string, test?: Row): Promise<void> {
  await q`insert into service_config (service, updated_at, last_test, data) values (${service}, now(), ${test ? q.json(test as never) : null}, ${q.json({ key })})
          on conflict (service) do update set updated_at = now(), last_test = excluded.last_test, data = service_config.data || excluded.data`;
}

export type ConfigAction = "config.status" | "config.set" | "config.test" | "config.clear";
export const CONFIG_ACTIONS: ConfigAction[] = ["config.status", "config.set", "config.test", "config.clear"];

export async function runConfigAction(q: Q, action: ConfigAction, p: Row, deps: ConfigDeps): Promise<unknown> {
  const service = p.service as string | undefined;
  if (action !== "config.status" && (!service || !deps.services.includes(service))) return fail(400, `service must be one of: ${deps.services.join(", ")}`);
  const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined;
  switch (action) {
    case "config.status": {
      const rows = await q`select service, updated_at, last_test, data->>'key' as key from service_config where service = any(${deps.services})`;
      const by = new Map(rows.map((r) => [r.service as string, r]));
      return Object.fromEntries(deps.services.map((name) => {
        const r = by.get(name), key = (r?.key as string | null) || null;
        return [name, { configured: !!key, masked: key ? maskKey(key) : null, updated_at: r?.updated_at instanceof Date ? r.updated_at.toISOString() : undefined, last_test: r?.last_test ?? undefined }];
      }));
    }
    case "config.set": {
      if (typeof p.key !== "string" || !p.key.trim()) return fail(400, "key required");
      const key = p.key.trim();
      let test: Row | undefined;
      if (p.skip_test !== true) {
        const r = await deps.test(service!, key, model);
        test = { ok: r.ok, at: new Date().toISOString(), message: r.message };
        if (!r.ok) return fail(400, r.message); // nothing is saved when the test fails
      }
      await writeServiceKey(q, service!, key, test);
      if (service === "gemini" && model) {
        const cur = await readSettings(q);
        await writeSettings(q, cur, { ...cur, gemini_model: model, updated_at: new Date().toISOString() });
      }
      return { configured: true, test };
    }
    case "config.test": {
      const key = await readServiceKey(q, service!);
      if (!key) return fail(404, `${service} key not configured`);
      const r = await deps.test(service!, key, model);
      const last = { ok: r.ok, at: new Date().toISOString(), message: r.message };
      await q`update service_config set last_test = ${q.json(last)} where service = ${service!}`;
      return last;
    }
    case "config.clear": {
      await q`delete from service_config where service = ${service!}`;
      return { cleared: true };
    }
  }
  return fail(400, `Unknown action: ${action}`);
}
