// Chunk 11 on Neon dev, read only or rolled back: data.counts / data.export / data.import on SQL (lib/sql/data.ts).
// An export never returns a key or a link token: service_config, access_keys, config, voice_config, form_links and
// click_links are refused, and webhooks come without their signing secret. data.import is refused on SQL (the P5
// import runs from the scripts, never through the API). Assertion messages never print exported rows.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

let n, data, loadError;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  try { data = await import("../../../netlify/functions/lib/sql/data.ts"); } catch (e) { loadError = e; }
});
after(() => n?.close());
const need = () => { if (loadError) throw new Error(`lib/sql/data.ts did not load: ${loadError.message}`); };
const act = (tx, action, p) => data.runDataAction(tx, action, p);
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code, e.message); return true; });
}

describe("data.* on SQL", () => {
  test("data.counts: a count for each exportable table, none for the secret ones", () => n.call(async (tx) => {
    need();
    const r = await act(tx, "data.counts", {});
    assert.equal(typeof r.counts.leads, "number");
    for (const t of ["service_config", "access_keys", "config", "voice_config", "form_links", "click_links"]) assert.ok(!(t in r.counts), t);
  }));

  test("data.export: pages through a table by its key, every row once", () => n.call(async (tx) => {
    need();
    const [{ total }] = await tx`select count(*)::int as total from campaigns`;
    const seen = new Set();
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const page = await act(tx, "data.export", { store: "campaigns", cursor, limit: 7 });
      for (const r of page.records) { assert.ok(!seen.has(r.key), "no row twice"); seen.add(r.key); }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.equal(seen.size, total);
  }));

  test("data.export refuses the tables that hold keys or link tokens (the bad case), and an unknown table", () => n.call(async (tx) => {
    need();
    for (const t of ["service_config", "access_keys", "config", "voice_config", "form_links", "click_links", "pg_user", "leads; drop table leads"]) {
      await refused(act(tx, "data.export", { store: t }), 400, "not_exportable");
    }
  }));

  test("data.export of webhooks never carries a signing secret", () => n.callWrite(async (tx) => {
    need();
    await tx`insert into webhooks (id, blob_key, name, service, event_count, created_at, data) values ('d11-hook', 'd11-hook', 'Made-up hook', 'agentmail', 0, now(), ${tx.json({ description: "", signing_secret: "whsec_bm90LXJlYWw=" })})`;
    let cursor = null, found = false;
    for (let i = 0; i < 50; i++) {
      const page = await act(tx, "data.export", { store: "webhooks", cursor, limit: 100 });
      assert.ok(!JSON.stringify(page).includes("whsec_"), "no signing secret in an export page");
      found ||= page.records.some((r) => r.key === "d11-hook");
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.ok(found);
  }));

  test("data.import is refused on SQL and writes nothing", () => n.callWrite(async (tx) => {
    need();
    const [{ c }] = await tx`select count(*)::int as c from campaigns`;
    await refused(act(tx, "data.import", { store: "campaigns", records: [{ key: "x", value: "{}" }] }), 409, "use_p5_import");
    assert.equal((await tx`select count(*)::int as c from campaigns`)[0].c, c);
  }));
});

describe("chunk 11 through the real handler on dev (DATA_BACKEND=sql): the actions really go to SQL", { skip: !(await import("node:fs")).existsSync((await import("node:path")).join((await import("node:os")).homedir(), "agent-hq-backups", "p1-2026-11-26", "manifest.json")) && "P1 export folder not found" }, () => {
  test("activity.list returns a row written on dev just now; data.import is refused (on Blobs it would write); approval.create makes a dev row (master)", async () => {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { openOld } = await import("../equiv/old-path.mjs");
    const { localVar } = await import("../env.mjs");
    const ID = `d11h-${Date.now().toString(36)}`;
    await n.commit((tx) => tx`insert into activity (id, agent_id, category, summary, details, created_at, data) values (${ID}, null, 'system', 'Made-up handler entry', '{}', now() + interval '1 minute', '{}')`);
    const [e] = await n.call((tx) => tx`select id from emails order by id limit 1`);
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    let approvalId = null;
    try {
      const h = await openOld(join(homedir(), "agent-hq-backups", "p1-2026-11-26"), { allowDb: true });
      const list = await h.call("activity.list", { limit: 3 });
      assert.equal(list.status, 200);
      assert.equal(list.body.data[0].id, ID, "the newest activity row comes from dev");
      const imp = await h.call("data.import", { store: "agent-hq-forms", records: [{ key: "x", value: "{}" }] });
      assert.equal(imp.status, 409);
      assert.equal(imp.body.code, "use_p5_import");
      const ap = await h.call("approval.create", { kind: "mark_ready", email_ids: [e.id] });
      assert.equal(ap.status, 200, JSON.stringify(ap.body).slice(0, 120));
      approvalId = ap.body.data.id;
      assert.equal((await n.call((tx) => tx`select kind from approvals where id = ${approvalId}`))[0].kind, "mark_ready");
    } finally {
      delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL;
      await n.commit(async (tx) => { await tx`delete from activity where id = ${ID}`; if (approvalId) await tx`delete from approvals where id = ${approvalId}`; });
    }
  });
});
