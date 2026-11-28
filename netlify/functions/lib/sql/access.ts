// P2 chunk 9: access keys on Postgres (R6, V8; used when DATA_BACKEND=sql, the Blobs keys stay the default until P5).
//   - A key is stored only as its SHA-256 hash (`access_keys.key_hash`, migration 0016) and shown once, when it is made.
//   - Who is calling: `identify` (one statement, also sets last_used_at). A revoked or unknown key is null, so the handler
//     answers 401 as today.
//   - What a key may do: `scopeRefusal`. master = everything. An agent key is 'read', 'drafts' (the default) or 'send'.
//     Every action has a class (read / drafts / send / master); an unknown action is 'drafts' (the handler answers it).
//   - agent.list never returns a key; agent.delete revokes the agent's keys; agent.revoke and agent.set_scope are new.
//   - auth.bootstrap hands out a master key only while there is none; auth.rotate revokes the old one at once.
import { createHash, randomBytes } from "node:crypto";
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export type Scope = "full" | "read" | "drafts" | "send";
export type Identity = { kind: "master"; scope: "full" } | { kind: "agent"; agent_id: string; sign_in_name: string; scope: Exclude<Scope, "full"> } | null;
export type ActionClass = "read" | "drafts" | "send" | "master";
export type AccessDeps = { newId: () => string; newSecret?: () => string };

const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : undefined); };
export const hashKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");
const secret = (n: number) => randomBytes(n).toString("base64url").slice(0, n);
const AGENT_SCOPES = ["read", "drafts", "send"] as const;

// ── What each action needs ─────────────────────────────────────────────────

/** Read only: answers questions, changes nothing, sends nothing. */
const READ = new Set([
  "activity.list", "agent.heartbeat", "agent.list", "config.status", "followups.list", "form.list", "form.submissions",
  "outreach.analytics.summary", "outreach.browsercheck.plan", "outreach.campaign.get", "outreach.campaign.list", "outreach.emails.list",
  "outreach.footer.preview", "outreach.inboxes.list", "outreach.lead.facts.list", "outreach.lead.screenshot.get", "outreach.lead.touches",
  "outreach.leads.count", "outreach.leads.list", "outreach.prospects.list", "outreach.replies.get", "outreach.replies.list", "outreach.search",
  "outreach.send.plan", "outreach.send.today", "outreach.settings.get", "outreach.social.batch.status", "outreach.social.list", "outreach.social.plan",
  "outreach.social.verify", "webhook.events", "outreach.webhook.events", "webhook.list",
  "links.list", "links.build", // chunk 10
]);
/** Sends email or spends money (lead finding, site and browser checks). */
const SEND = new Set([
  "outreach.emails.send", "outreach.reply.send", "outreach.webhook.test", "outreach.campaign.run", "outreach.campaign.sync",
  "outreach.leads.enrich_one", "outreach.leads.check_site", "outreach.browsercheck.start",
]);
/** Keys, Settings, data moves, webhooks' secrets and deleting whole campaigns or leads: the master key only. */
const MASTER = new Set([
  "auth.rotate", "data.counts", "data.export", "data.import", "config.set", "config.test", "config.clear", "agent.register", "agent.delete",
  "agent.revoke", "agent.set_scope", "webhook.create", "webhook.create_typed", "webhook.delete", "webhook.set_secret", "outreach.settings.set",
  "outreach.campaign.delete", "outreach.leads.delete",
  "form.delete", // chunk 10: a form and its personal links go
  "approval.create", // chunk 11: only her own key can approve a send plan or mark drafts ready
]);

export function actionClass(action: string): ActionClass {
  if (MASTER.has(action)) return "master";
  if (SEND.has(action)) return "send";
  if (READ.has(action)) return "read";
  return "drafts";
}

const RANK: Record<Exclude<Scope, "full">, number> = { read: 0, drafts: 1, send: 2 };
const NEED: Record<Exclude<ActionClass, "master">, number> = { read: 0, drafts: 1, send: 2 };
const SCOPE_TEXT = { read: "read only", drafts: "read and write drafts", send: "read, write drafts and send" };

/** Why this key may not run this action (403, code "scope"), or null when it may. Bootstrap is public (no key). */
export function scopeRefusal(identity: Identity, action: string, params: Row = {}): { status: number; message: string; code: string } | null {
  if (!identity || identity.kind === "master") return null;
  const cls = actionClass(action);
  const no = (why: string) => ({ status: 403, code: "scope", message: `This access key can't do that: ${why}` });
  if (cls === "master") return no(`${action} needs the master key.`);
  if (RANK[identity.scope] < NEED[cls]) return no(`it is ${SCOPE_TEXT[identity.scope]}, and ${action} needs a key that can ${cls === "send" ? "send" : "write drafts"}.`);
  if (action === "agent.heartbeat" && params.agent_id !== identity.agent_id) return no("an agent can only report itself alive.");
  return null;
}

// ── Who is calling ─────────────────────────────────────────────────────────

/** The identity of a key, or null when it is unknown or revoked. One statement; it notes when the key was last used. */
export async function identify(q: Q, key: string | null | undefined): Promise<Identity> {
  if (!key || typeof key !== "string" || key.length > 200) return null;
  const [r] = await q`update access_keys k set last_used_at = now() where key_hash = ${hashKey(key)} and revoked_at is null
                      returning k.kind, k.agent_id, k.scope, (select sign_in_name from agents a where a.id = k.agent_id) as sign_in_name`;
  if (!r) return null;
  if (r.kind === "master") return { kind: "master", scope: "full" };
  return { kind: "agent", agent_id: r.agent_id as string, sign_in_name: (r.sign_in_name as string) ?? "", scope: r.scope as "read" | "drafts" | "send" };
}

// ── Keys and agents ────────────────────────────────────────────────────────

async function newKey(q: Q, deps: AccessDeps, o: { kind: "master" | "agent"; agent_id?: string | null; scope: Scope }): Promise<string> {
  const key = o.kind === "master" ? `ahq_${deps.newSecret?.() ?? secret(32)}` : `akey_${deps.newSecret?.() ?? secret(28)}`;
  await q`insert into access_keys (id, key_hash, key_hint, kind, agent_id, scope) values (${deps.newId()}, ${hashKey(key)}, ${key.slice(-4)}, ${o.kind}, ${o.agent_id ?? null}, ${o.scope})`;
  return key;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "agent";

/** An agent for agent.list: everything but a key. */
function agentView(a: Row, k: Row | undefined): Row {
  const out: Row = { ...((a.data as Row) ?? {}), id: a.id, name: a.name, sign_in_name: a.sign_in_name, role: a.role, status: a.status,
    last_heartbeat: a.last_heartbeat instanceof Date ? a.last_heartbeat.toISOString() : a.last_heartbeat ?? null,
    created_at: a.created_at instanceof Date ? a.created_at.toISOString() : a.created_at ?? null,
    scope: (k?.scope as string) ?? null, key_hint: (k?.key_hint as string) ?? null, key_last_used_at: k?.last_used_at instanceof Date ? k.last_used_at.toISOString() : null, revoked: !k };
  delete out.api_key; // older records kept the key on the agent itself
  return out;
}

async function logActivity(q: Q, deps: AccessDeps, summary: string, agentId: string | null = null): Promise<void> {
  const id = deps.newId(), now = new Date();
  await q`insert into activity (id, blob_key, agent_id, category, summary, details, created_at) values (${id}, ${`${now.toISOString()}-${id}`}, ${agentId}, 'system', ${summary}, '{}', ${now})`;
}

export type AccessAction = "auth.bootstrap" | "auth.rotate" | "agent.register" | "agent.list" | "agent.heartbeat" | "agent.delete" | "agent.revoke" | "agent.set_scope";
export const ACCESS_ACTIONS: AccessAction[] = ["auth.bootstrap", "auth.rotate", "agent.register", "agent.list", "agent.heartbeat", "agent.delete", "agent.revoke", "agent.set_scope"];

export async function runAccessAction(q: Q, action: AccessAction, p: Row, identity: Identity, deps: AccessDeps): Promise<unknown> {
  if (action !== "auth.bootstrap") {
    if (!identity) return fail(401, "Invalid or missing X-API-Key");
    const no = scopeRefusal(identity, action, p);
    if (no) return fail(no.status, no.message, no.code);
  }
  switch (action) {
    case "auth.bootstrap": {
      // First run only: a master key is handed out only while there is none.
      await q`lock table access_keys in share row exclusive mode`;
      const [live] = await q`select 1 from access_keys where kind = 'master' and revoked_at is null limit 1`;
      if (live) return fail(403, "This workspace is already set up. Paste your API key to sign in.", "signin_required");
      return { api_key: await newKey(q, deps, { kind: "master", scope: "full" }) };
    }
    case "auth.rotate": {
      if (identity?.kind !== "master") return fail(403, "Only the master key can rotate the key");
      if (p.confirm !== true) return fail(400, "Pass confirm: true. This invalidates the current key everywhere.");
      await q`update access_keys set revoked_at = now() where kind = 'master' and revoked_at is null`;
      const key = await newKey(q, deps, { kind: "master", scope: "full" });
      await logActivity(q, deps, "Master API key rotated");
      return { api_key: key };
    }
    case "agent.register": {
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name) return fail(400, "name required");
      const scope = (p.scope ?? "drafts") as string;
      if (!(AGENT_SCOPES as readonly string[]).includes(scope)) return fail(400, "scope must be read, drafts or send");
      const id = deps.newId();
      const now = new Date().toISOString();
      const sign_in_name = `${slugify(typeof p.sign_in_name === "string" && p.sign_in_name ? p.sign_in_name : name)}-${id.slice(0, 4)}`;
      const role = typeof p.role === "string" && p.role ? p.role : "Generalist";
      const data = { emoji: typeof p.emoji === "string" ? p.emoji : "🤖", color: typeof p.color === "string" ? p.color : "#00BFFF" };
      await q`insert into agents (id, blob_key, name, sign_in_name, role, status, last_heartbeat, created_at, data) values (${id}, ${id}, ${name}, ${sign_in_name}, ${role}, 'online', ${now}, ${now}, ${q.json(data)})`;
      const api_key = await newKey(q, deps, { kind: "agent", agent_id: id, scope: scope as Scope });
      await logActivity(q, deps, `Agent "${name}" registered as @${sign_in_name} (${SCOPE_TEXT[scope as "read"]})`, id);
      // The key is shown this once; it is never stored or listed.
      return { id, name, sign_in_name, api_key, scope, role, ...data, status: "online", last_heartbeat: now, created_at: now };
    }
    case "agent.list": {
      const rows = await q`select a.*, k.scope, k.key_hint, k.last_used_at from agents a
                           left join lateral (select scope, key_hint, last_used_at from access_keys where agent_id = a.id and revoked_at is null order by created_at desc limit 1) k on true
                           order by a.created_at, a.id`;
      return rows.map((r) => agentView(r, r.scope ? r : undefined));
    }
    case "agent.heartbeat": {
      if (!p.agent_id) return fail(400, "agent_id required");
      const [r] = await q`update agents set status = 'online', last_heartbeat = now() where id = ${p.agent_id as string} returning *`;
      if (!r) return fail(404, "agent not found");
      return agentView(r, (await q`select scope, key_hint, last_used_at from access_keys where agent_id = ${r.id as string} and revoked_at is null order by created_at desc limit 1`)[0]);
    }
    case "agent.revoke":
    case "agent.delete": {
      if (!p.id) return fail(400, "id required");
      const id = p.id as string;
      const revoked = await q`update access_keys set revoked_at = now() where agent_id = ${id} and revoked_at is null returning id`;
      if (action === "agent.revoke") {
        const [a] = await q`select 1 from agents where id = ${id}`;
        if (!a && !revoked.length) return fail(404, "agent not found");
        await logActivity(q, deps, `Agent ${id}: access key revoked`);
        return { id, revoked: revoked.length };
      }
      await q`delete from agents where id = ${id}`;
      await logActivity(q, deps, `Agent ${id} deleted (its access key revoked)`);
      return { id, deleted: true };
    }
    case "agent.set_scope": {
      if (!p.id) return fail(400, "id required");
      if (!(AGENT_SCOPES as readonly string[]).includes(p.scope as string)) return fail(400, "scope must be read, drafts or send");
      const r = await q`update access_keys set scope = ${p.scope as string} where agent_id = ${p.id as string} and revoked_at is null returning id`;
      if (!r.length) return fail(404, "agent has no live key");
      await logActivity(q, deps, `Agent ${p.id}: access key now ${SCOPE_TEXT[p.scope as "read"]}`);
      return { id: p.id, scope: p.scope };
    }
  }
  return fail(400, `Unknown action: ${action}`);
}
