// Chunk 11 on Neon dev, every transaction rolled back: resumable jobs (lib/sql/jobs.ts).
// outreach.job.resume: a paused generate job becomes running in ONE update (paused extras gone, resumed_at set, resumes + 1,
// read back), answers {kind, task, params}; not paused is 409 not_paused; a future resume_at is 409 not_due, force works.
// outreach.job.resume_due lists only due paused resumable jobs (not leads / browser_check, not running, not future).
// All data is made up. A real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

let n, jb, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { jb = await import("../../../netlify/functions/lib/sql/jobs.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/jobs.ts did not load: ${loadError.message}`); };
const NOW = new Date("2031-03-10T12:00:00.000Z");
const deps = { now: () => NOW };
const act = (tx, action, p) => jb.runJobAction(tx, action, p, deps);
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); return true; });
}
async function campaign(tx, id) {
  await tx`insert into campaigns (id, blob_key, name, created_at, updated_at, data) values (${id}, ${id}, 'Made-up Campaign', now(), now(), '{}')`;
}
async function job(tx, cid, kind, status, data = {}) {
  await tx`insert into campaign_jobs (campaign_id, kind, status, total, done, made, started_at, progress_at, data)
           values (${cid}, ${kind}, ${status}, 10, 4, 4, '2031-03-10T08:00:00Z', '2031-03-10T09:00:00Z', ${tx.json(data)})`;
}
const paused = (extra = {}) => ({ paused_reason: "daily_limit", resume_at: "2031-03-10T11:00:00.000Z", resume_params: { campaign_id: "zz-j1", only: ["a"] }, message: "Paused", resumes: 1, keep_me: "yes", ...extra });
const read = async (tx, cid, kind) => (await tx`select * from campaign_jobs where campaign_id = ${cid} and kind = ${kind}`)[0];

describe("chunk 11 jobs on SQL", () => {
  test("module loads", () => need());

  test("resume: a paused generate job runs again, extras removed, resumes + 1, answer {kind, task: draft, params}", async () => {
    need();
    await n.callWrite(async (tx) => {
      await campaign(tx, "zz-j1");
      await job(tx, "zz-j1", "generate", "paused", paused());
      const a = await act(tx, "outreach.job.resume", { campaign_id: "zz-j1" });
      assert.equal(a.kind, "generate");
      assert.equal(a.task, "draft");
      assert.equal(JSON.stringify(a.params, Object.keys(a.params).sort()), JSON.stringify({ campaign_id: "zz-j1", only: ["a"] }, ["campaign_id", "only"]));
      const r = await read(tx, "zz-j1", "generate");
      assert.equal(r.status, "running");
      assert.equal(r.progress_at.toISOString(), NOW.toISOString());
      assert.equal(r.data.resumed_at, NOW.toISOString());
      assert.equal(r.data.resumes, 2);
      assert.equal(r.data.keep_me, "yes");
      for (const k of ["paused_reason", "resume_at", "resume_params", "message"]) assert.equal(k in r.data, false, k);
      assert.equal(r.total, 10);
      assert.equal(r.done, 4);
    });
  });

  test("resume: social gives task social, review gives task review; first resume sets resumes to 1", async () => {
    need();
    await n.callWrite(async (tx) => {
      await campaign(tx, "zz-j2");
      await job(tx, "zz-j2", "social", "paused", { resume_at: "2031-03-10T11:00:00Z" });
      assert.equal((await act(tx, "outreach.job.resume", { campaign_id: "zz-j2", kind: "social" })).task, "social");
      assert.equal((await read(tx, "zz-j2", "social")).data.resumes, 1);
      await campaign(tx, "zz-j3");
      await job(tx, "zz-j3", "review", "paused", { resume_at: "2031-03-10T11:00:00Z" });
      const a = await act(tx, "outreach.job.resume", { campaign_id: "zz-j3" });
      assert.equal(a.task, "review");
      assert.equal(JSON.stringify(a.params), "{}");
    });
  });

  test("resume: without a kind, the paused job most recently progressed is taken", async () => {
    need();
    await n.callWrite(async (tx) => {
      await campaign(tx, "zz-j4");
      await job(tx, "zz-j4", "generate", "paused", { resume_at: "2031-03-10T11:00:00Z" });
      await job(tx, "zz-j4", "review", "paused", { resume_at: "2031-03-10T11:00:00Z" });
      await tx`update campaign_jobs set progress_at = '2031-03-10T10:30:00Z' where campaign_id = 'zz-j4' and kind = 'review'`;
      assert.equal((await act(tx, "outreach.job.resume", { campaign_id: "zz-j4" })).kind, "review");
      assert.equal((await read(tx, "zz-j4", "generate")).status, "paused");
    });
  });

  test("not paused: running job, no job, leads job, missing campaign_id", async () => {
    need();
    await n.callWrite(async (tx) => {
      await campaign(tx, "zz-j5");
      await job(tx, "zz-j5", "generate", "running");
      await job(tx, "zz-j5", "leads", "paused", { resume_at: "2031-03-10T11:00:00Z" });
      await refused(act(tx, "outreach.job.resume", { campaign_id: "zz-j5" }), 409, "not_paused");
      await refused(act(tx, "outreach.job.resume", { campaign_id: "zz-j5", kind: "leads" }), 409, "not_paused");
      await refused(act(tx, "outreach.job.resume", { campaign_id: "zz-nothing" }), 409, "not_paused");
      await refused(act(tx, "outreach.job.resume", {}), 400);
      assert.equal((await read(tx, "zz-j5", "generate")).status, "running");
    });
  });

  test("not due: a future resume_at is 409 not_due and changes nothing; force resumes it", async () => {
    need();
    await n.callWrite(async (tx) => {
      await campaign(tx, "zz-j6");
      await job(tx, "zz-j6", "generate", "paused", paused({ resume_at: "2031-03-10T20:00:00.000Z" }));
      await refused(act(tx, "outreach.job.resume", { campaign_id: "zz-j6" }), 409, "not_due");
      const r0 = await read(tx, "zz-j6", "generate");
      assert.equal(r0.status, "paused");
      assert.equal(r0.data.resumes, 1);
      const a = await act(tx, "outreach.job.resume", { campaign_id: "zz-j6", force: true });
      assert.equal(a.task, "draft");
      assert.equal((await read(tx, "zz-j6", "generate")).status, "running");
    });
  });

  test("resume twice: the second is 409 not_paused (one update, guarded by the status)", async () => {
    need();
    await n.callWrite(async (tx) => {
      await campaign(tx, "zz-j7");
      await job(tx, "zz-j7", "generate", "paused", paused());
      await act(tx, "outreach.job.resume", { campaign_id: "zz-j7" });
      await refused(act(tx, "outreach.job.resume", { campaign_id: "zz-j7" }), 409, "not_paused");
      assert.equal((await read(tx, "zz-j7", "generate")).data.resumes, 2);
    });
  });

  test("resume_due: only due paused resumable jobs, oldest first", async () => {
    need();
    await n.callWrite(async (tx) => {
      for (const c of ["zz-d1", "zz-d2", "zz-d3", "zz-d4", "zz-d5", "zz-d6"]) await campaign(tx, c);
      await job(tx, "zz-d1", "generate", "paused", { resume_at: "2031-03-10T10:00:00.000Z" });
      await job(tx, "zz-d2", "review", "paused", { resume_at: "2031-03-09T10:00:00.000Z" });
      await job(tx, "zz-d3", "generate", "paused", { resume_at: "2031-03-11T10:00:00.000Z" }); // not yet
      await job(tx, "zz-d4", "leads", "paused", { resume_at: "2031-03-01T10:00:00.000Z" }); // not a resumable job
      await job(tx, "zz-d4", "browser_check", "paused", { resume_at: "2031-03-01T10:00:00.000Z" });
      await job(tx, "zz-d5", "social", "running", { resume_at: "2031-03-01T10:00:00.000Z" });
      await job(tx, "zz-d6", "social", "paused", {}); // no resume_at
      const a = await act(tx, "outreach.job.resume_due", {});
      assert.deepEqual(Object.keys(a), ["due"]);
      const mine = a.due.filter((d) => d.campaign_id.startsWith("zz-d"));
      assert.equal(JSON.stringify(mine), JSON.stringify([
        { campaign_id: "zz-d2", kind: "review", resume_at: "2031-03-09T10:00:00.000Z" },
        { campaign_id: "zz-d1", kind: "generate", resume_at: "2031-03-10T10:00:00.000Z" },
      ]));
    });
  });
});
