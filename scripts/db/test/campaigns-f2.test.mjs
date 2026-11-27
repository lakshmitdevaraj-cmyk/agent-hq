// F2: a running job never undoes a setting the user changed. In SQL, settings live in `campaigns` and job
// progress in `campaign_jobs`; job writers (writeJob, writeLeadsJob) never read or write the campaigns row.
// All on Neon dev, every transaction rolled back. The bad case is the old whole-record pattern, shown on Blobs.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLLBACK = Symbol("rollback");
const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
let m, sql, other, closeDb, id;

async function inTx(client, fn) {
  let out;
  try { await client.begin(async (tx) => { out = await fn(tx); throw ROLLBACK; }); } catch (e) { if (e !== ROLLBACK) throw e; }
  return out;
}

before(async () => {
  const env = await import("../env.mjs");
  process.env.DATABASE_URL = env.localVar("DEV_DATABASE_URL");
  const client = await import("../../../netlify/functions/lib/db/client.ts");
  sql = client.db();
  closeDb = client.closeDb;
  other = env.connect("dev", { direct: false, max: 1 }); // a second, separate connection
  m = await import("../../../netlify/functions/lib/sql/campaigns.ts");
  id = (await sql`select id from campaigns order by created_at limit 1`)[0].id;
});
after(async () => { await other?.end({ timeout: 5 }); await closeDb?.(); });

describe("F2", () => {
  test("a job that read the campaign before a settings change writes its progress, and the change survives", () => inTx(sql, async (tx) => {
    const snapshot = await m.get(tx, id);                                   // the job reads the campaign
    await m.update(tx, { id, any_trade: !snapshot.any_trade, name: "Changed while a job ran" }); // the user changes settings
    await m.writeLeadsJob(tx, id, { status: "searching", apify_status: "RUNNING", total_leads_found: 40 }); // the job writes
    await m.writeJob(tx, id, "generate", { status: "running", total: 10, done: 3 });
    const now = await m.get(tx, id);
    assert.equal(now.any_trade, !snapshot.any_trade, "the setting survived");
    assert.equal(now.name, "Changed while a job ran");
    assert.equal(now.apify_status, "RUNNING");
    assert.equal(now.total_leads_found, 40);
    assert.equal(now.job.kind, "generate");
    assert.equal(now.job.done, 3);
  }));

  test("job writers merge their fields and never touch the campaigns row", () => inTx(sql, async (tx) => {
    const [before] = await tx`select * from campaigns where id = ${id}`;
    await m.writeJob(tx, id, "generate", { status: "running", total: 10, done: 1, note: "a" });
    await m.writeJob(tx, id, "generate", { done: 2 });
    await m.writeLeadsJob(tx, id, { error_message: "x" });
    const [after] = await tx`select * from campaigns where id = ${id}`;
    assert.deepEqual(after, before);
    const [job] = await tx`select status, total, done, data from campaign_jobs where campaign_id = ${id} and kind = 'generate'`;
    assert.equal(job.status, "running");
    assert.equal(job.total, 10);
    assert.equal(job.done, 2);
    assert.equal(job.data.note, "a", "an earlier field is kept");
  }));

  test("two connections: while a job's write is open, a settings change goes through without waiting", async () => {
    await inTx(sql, async (jobTx) => {
      await m.writeJob(jobTx, id, "generate", { status: "running", done: 1 });
      await m.writeLeadsJob(jobTx, id, { apify_status: "RUNNING" });
      await inTx(other, async (userTx) => {
        await userTx`set local lock_timeout = '500ms'`;
        const c = await m.update(userTx, { id, any_trade: false, default_sender_name: "Test" });
        assert.equal(c.any_trade, false);
      });
    });
  });

  test("bad case for the two-connection check: two settings writes on the same row DO wait, so the check can see a lock", async () => {
    await inTx(sql, async (a) => {
      await m.update(a, { id, name: "holding the row" });
      await assert.rejects(inTx(other, async (b) => {
        await b`set local lock_timeout = '500ms'`;
        await m.update(b, { id, name: "second writer" });
      }), (e) => e.code === "55P03", "lock_not_available");
    });
  });
});

describe("F2 bad case: the old whole-record write (command.ts campaign.sync) undoes the change", { skip: !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found" }, () => {
  test("read, user change, write { ...snapshot, apify_status } → the setting is lost", async () => {
    const old = await (await import("../equiv/old-path.mjs")).openOld(EXPORT);
    const s = old.blobs.getStore("agent-hq-outreach-campaigns");
    const snapshot = JSON.parse(await s.get(id));                         // sync reads the campaign
    const r = await old.call("outreach.campaign.update", { id, any_trade: false }); // Lakshmi turns "any trade" off
    assert.equal(r.body.data.any_trade, false);
    await s.set(id, JSON.stringify({ ...snapshot, apify_status: "SUCCEEDED" })); // the pattern at command.ts:4160/4280
    const after = (await old.call("outreach.campaign.get", { id })).body.data;
    assert.notEqual(after.any_trade, false, "the old pattern undid the change: this is the F2 bug");
  });
});
