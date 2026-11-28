// Chunk 9 on Neon dev: access keys (lib/sql/access.ts, migration 0016). R6: keys with limits (read only / drafts /
// can send), revoke, agent.list never returns a key; keys are stored only as a hash. The bad cases are shown refused:
// in rolled-back transactions for the module, and through the real handler (DATA_BACKEND=sql) on dev, where the test's
// key rows are committed under made-up ids and removed again in `finally`. All keys and names are made up.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
let n, ac, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { ac = await import("../../../netlify/functions/lib/sql/access.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/access.ts did not load: ${loadError.message}`); };
let idn = 0;
const deps = () => ({ newId: () => `a9-id-${++idn}`, newSecret: () => `madeupsecret${String(++idn).padStart(20, "0")}` });
const MASTER = { kind: "master", scope: "full" };
const act = (tx, action, params, identity = MASTER) => ac.runAccessAction(tx, action, params, identity, deps());
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); return true; });
}
/** Starts from no keys at all inside the rolled-back transaction. */
const clean = (tx) => tx`delete from access_keys`;

describe("chunk 9 access keys on SQL", () => {
  test("module loads", () => need());

  test("auth.bootstrap hands out the master key once; then 403 signin_required. The key is stored only as a hash", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      const a = await act(tx, "auth.bootstrap", {}, null);
      assert.match(a.api_key, /^ahq_/);
      await refused(act(tx, "auth.bootstrap", {}, null), 403, "signin_required");
      const rows = await tx`select * from access_keys`;
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows).includes(a.api_key), "the key itself is not stored");
      assert.equal(rows[0].key_hash, ac.hashKey(a.api_key));
      assert.deepEqual(await ac.identify(tx, a.api_key), { kind: "master", scope: "full" });
      assert.equal(await ac.identify(tx, "ahq_not-a-real-key"), null);
      assert.equal(await ac.identify(tx, ""), null);
    });
  });

  test("auth.rotate: master only, confirm needed; the old key is refused at once", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      const { api_key: first } = await act(tx, "auth.bootstrap", {}, null);
      await refused(act(tx, "auth.rotate", {}), 400);
      const { api_key: second } = await act(tx, "auth.rotate", { confirm: true });
      assert.notEqual(second, first);
      assert.equal(await ac.identify(tx, first), null, "the old master key is refused");
      assert.deepEqual(await ac.identify(tx, second), { kind: "master", scope: "full" });
      const agent = await act(tx, "agent.register", { name: "Made-up Helper", scope: "send" });
      await refused(act(tx, "auth.rotate", { confirm: true }, await ac.identify(tx, agent.api_key)), 403);
    });
  });

  test("agent.register (master only, default scope drafts, key shown once); agent.list never returns a key", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      const a = await act(tx, "agent.register", { name: "Made-up Writer" });
      assert.match(a.api_key, /^akey_/);
      assert.equal(a.scope, "drafts");
      const b = await act(tx, "agent.register", { name: "Made-up Reader", scope: "read" });
      await refused(act(tx, "agent.register", { name: "x", scope: "everything" }), 400);
      await refused(act(tx, "agent.register", { name: "Made-up Sneaky" }, await ac.identify(tx, a.api_key)), 403);
      const list = await act(tx, "agent.list", {});
      const text = JSON.stringify(list);
      assert.ok(!text.includes(a.api_key) && !text.includes(b.api_key), "no key in agent.list");
      assert.ok(!/akey_|api_key|key_hash/.test(text), "no key field at all");
      const mine = list.find((x) => x.id === a.id);
      assert.equal(mine.scope, "drafts");
      assert.equal(mine.key_hint, a.api_key.slice(-4));
      assert.equal(mine.revoked, false);
    });
  });

  test("agent.revoke and agent.delete: the key is refused afterwards; agent.set_scope changes what it may do", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      const a = await act(tx, "agent.register", { name: "Made-up A" });
      const b = await act(tx, "agent.register", { name: "Made-up B" });
      assert.ok(await ac.identify(tx, a.api_key));
      await act(tx, "agent.revoke", { id: a.id });
      assert.equal(await ac.identify(tx, a.api_key), null, "a revoked key is refused");
      const del = await act(tx, "agent.delete", { id: b.id });
      assert.equal(del.deleted, true);
      assert.equal(await ac.identify(tx, b.api_key), null, "a deleted agent's key is refused");
      const c = await act(tx, "agent.register", { name: "Made-up C", scope: "read" });
      await act(tx, "agent.set_scope", { id: c.id, scope: "send" });
      assert.equal((await ac.identify(tx, c.api_key)).scope, "send");
      await refused(act(tx, "agent.set_scope", { id: c.id, scope: "full" }), 400);
      await refused(act(tx, "agent.revoke", { id: "no-such-agent" }), 404);
    });
  });

  test("scopes (R6): a read-only key can't draft or send, a drafts key can't send, a send key can send but can't change Settings or keys", () => {
    need();
    const id = (scope) => ({ kind: "agent", agent_id: "a1", sign_in_name: "made-up", scope });
    const no = (scope, action, params = {}) => ac.scopeRefusal(id(scope), action, params);
    assert.equal(no("read", "outreach.emails.list"), null);
    assert.equal(no("read", "outreach.emails.create")?.code, "scope");
    assert.equal(no("read", "outreach.emails.send")?.code, "scope");
    assert.equal(no("drafts", "outreach.emails.create"), null);
    assert.equal(no("drafts", "outreach.emails.send")?.code, "scope");
    assert.equal(no("drafts", "outreach.reply.send")?.code, "scope");
    assert.equal(no("drafts", "outreach.campaign.run")?.code, "scope", "spending money is the send level");
    assert.equal(no("send", "outreach.emails.send"), null);
    for (const a of ["outreach.settings.set", "config.set", "auth.rotate", "agent.register", "webhook.set_secret", "data.export", "outreach.campaign.delete"]) {
      assert.equal(no("send", a)?.code, "scope", `${a} is master only`);
    }
    assert.equal(no("read", "agent.heartbeat", { agent_id: "a1" }), null, "an agent may say it is alive");
    assert.equal(no("read", "agent.heartbeat", { agent_id: "someone-else" })?.code, "scope", "but only for itself");
    assert.equal(ac.scopeRefusal(MASTER, "outreach.emails.send", {}), null);
    assert.equal(ac.scopeRefusal(MASTER, "auth.rotate", {}), null);
    assert.equal(no("drafts", "outreach.some.future_action"), null, "unknown actions are the drafts level (the handler answers unknown)");
  });

  test("every action the handler knows has a class (none is read by accident)", async () => {
    need();
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../netlify/functions/command.ts", import.meta.url), "utf8");
    const actions = [...new Set([...src.matchAll(/case "([a-z0-9_.]+)"/g)].map((m) => m[1]))];
    const counts = {};
    for (const a of actions) counts[ac.actionClass(a)] = (counts[ac.actionClass(a)] ?? 0) + 1;
    console.log(`action classes: ${JSON.stringify(counts)} of ${actions.length}`);
    for (const a of ["outreach.emails.send", "outreach.reply.send", "outreach.webhook.test"]) assert.equal(ac.actionClass(a), "send");
    for (const a of actions.filter((x) => ac.actionClass(x) === "read")) assert.doesNotMatch(a.split(".").at(-1), /^(send|set|create|update|delete|start|run|sync|import|rotate|register|clear|add|write|move|save|mark_sent|record_hand|replied|linkedin|accept|dismiss|generate|resume)/, `${a} is read but its name says it writes`);
  });

  test("through the real handler on dev (DATA_BACKEND=sql): a read-only key sending is 403, a revoked key and an unknown key are 401", { skip: !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found" }, async () => {
    need();
    const { openOld } = await import("../equiv/old-path.mjs");
    const { localVar } = await import("../env.mjs");
    const read = `akey_madeupreadonly${Date.now()}`, gone = `akey_madeuprevoked${Date.now()}`;
    const ids = ["a9-handler-read", "a9-handler-gone"];
    const sql = (await import("../../../netlify/functions/lib/db/client.ts"));
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    const db = sql.db();
    try {
      await db`insert into access_keys (id, key_hash, key_hint, kind, agent_id, scope) values
        (${ids[0]}, ${ac.hashKey(read)}, ${read.slice(-4)}, 'agent', 'a9-agent', 'read'),
        (${ids[1]}, ${ac.hashKey(gone)}, ${gone.slice(-4)}, 'agent', 'a9-agent', 'send')`;
      await db`update access_keys set revoked_at = now() where id = ${ids[1]}`;
      const old = await openOld(EXPORT, { allowDb: true });
      const call = (key, action, params = {}) => old.raw({ httpMethod: "POST", path: "/.netlify/functions/command", headers: { "x-api-key": key }, body: JSON.stringify({ action, params }) });
      const send = await call(read, "outreach.emails.send", { campaign_id: "no-such-campaign" });
      assert.equal(send.status, 403, JSON.stringify(send.body).slice(0, 200));
      assert.equal(send.body.code, "scope");
      const draft = await call(read, "outreach.emails.create", { campaign_id: "x", lead_id: "y" });
      assert.equal(draft.status, 403);
      assert.equal((await call(gone, "outreach.emails.list", { campaign_id: "x" })).status, 401, "a revoked key is refused");
      assert.equal((await call("akey_madeup-unknown", "outreach.emails.list", { campaign_id: "x" })).status, 401, "an unknown key is refused");
      const listed = await call(read, "outreach.campaign.list");
      assert.equal(listed.status, 200, "the read-only key can still read");
      console.log(`handler on dev: read-only key sending → ${send.status} (${send.body.code}); creating a draft → ${draft.status}; revoked → 401; unknown → 401; reading → ${listed.status}`);
    } finally {
      await db`delete from access_keys where id = any(${ids})`;
      delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL;
      await sql.closeDb();
    }
  });
});
