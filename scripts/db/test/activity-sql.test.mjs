// Chunk 11 on Neon dev, every transaction rolled back: the activity log (lib/sql/activity.ts).
// activity.log then activity.list reads it straight back first (F1), missing category or summary is 400, limits on
// length and size, limit and `before` paging, the category filter, agent_id from the key wins over the one in params.
// All data is made up. A real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

let n, ac, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { ac = await import("../../../netlify/functions/lib/sql/activity.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/activity.ts did not load: ${loadError.message}`); };
let seq = 0;
const deps = (agentId) => ({ newId: () => `act-test-${++seq}`, agentId });
const act = (tx, action, params, d = deps()) => ac.runActivityAction(tx, action, params, d);
async function refused(p, status, text) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (text) assert.match(e.message, text); return true; });
}
// Rows with set times, so paging is exact. Written straight to the table (inside the rolled-back transaction).
async function seed(tx, count, category = "zz-test") {
  for (let i = 1; i <= count; i++) {
    await tx`insert into activity (id, blob_key, agent_id, category, summary, details, created_at, data)
             values (${`zz-seed-${category}-${i}`}, ${`zz-seed-${category}-${i}`}, null, ${category}, ${`Made-up entry ${i}`}, ${tx.json({ i })}, ${new Date(Date.UTC(2031, 0, 1, 0, 0, i))}, '{}')`;
  }
}

describe("chunk 11 activity on SQL", () => {
  test("module loads", () => need());

  test("F1: activity.log answers {logged: true, id}, then activity.list returns it first", async () => {
    need();
    await n.callWrite(async (tx) => {
      const a = await act(tx, "activity.log", { category: "zz-test", summary: "Made-up thing happened", details: { x: 1, nested: { y: [1, 2] } }, agent_id: "agent-from-params" });
      assert.equal(a.logged, true);
      assert.equal(typeof a.id, "string");
      const l = await act(tx, "activity.list", { limit: 5 });
      assert.ok(Array.isArray(l));
      assert.equal(l[0].id, a.id);
      assert.deepEqual(Object.keys(l[0]).sort(), ["agent_id", "category", "created_at", "details", "id", "summary"]);
      assert.equal(l[0].category, "zz-test");
      assert.equal(l[0].summary, "Made-up thing happened");
      assert.equal(l[0].agent_id, "agent-from-params");
      assert.equal(typeof l[0].created_at, "string");
      assert.equal(new Date(l[0].created_at).toISOString(), l[0].created_at);
      assert.equal(JSON.stringify(l[0].details.nested), JSON.stringify({ y: [1, 2] }));
    });
  });

  test("agent_id: the key's agent wins over params; none gives null; no details gives null", async () => {
    need();
    await n.callWrite(async (tx) => {
      const a = await act(tx, "activity.log", { category: "zz-test", summary: "One", agent_id: "from-params" }, deps("from-key"));
      const b = await act(tx, "activity.log", { category: "zz-test", summary: "Two" });
      const l = await act(tx, "activity.list", { category: "zz-test", limit: 10 });
      assert.equal(l.find((x) => x.id === a.id).agent_id, "from-key");
      const two = l.find((x) => x.id === b.id);
      assert.equal(two.agent_id, null);
      assert.equal(two.details, null);
    });
  });

  test("missing summary or category is 400 'category and summary required'", async () => {
    need();
    await n.callWrite(async (tx) => {
      await refused(act(tx, "activity.log", { category: "zz-test" }), 400, /category and summary required/);
      await refused(act(tx, "activity.log", { summary: "No category" }), 400, /category and summary required/);
      await refused(act(tx, "activity.log", { category: "", summary: "" }), 400, /category and summary required/);
      await refused(act(tx, "activity.log", {}), 400, /category and summary required/);
    });
  });

  test("category over 40 characters, summary over 500, details over 10 KB or not an object are 400; the limits themselves pass", async () => {
    need();
    await n.callWrite(async (tx) => {
      await refused(act(tx, "activity.log", { category: "c".repeat(41), summary: "x" }), 400);
      await refused(act(tx, "activity.log", { category: "zz-test", summary: "s".repeat(501) }), 400);
      await refused(act(tx, "activity.log", { category: "zz-test", summary: "x", details: { big: "d".repeat(10 * 1024) } }), 400);
      await refused(act(tx, "activity.log", { category: "zz-test", summary: "x", details: "just text" }), 400);
      const ok = await act(tx, "activity.log", { category: "c".repeat(40), summary: "s".repeat(500), details: { small: "d".repeat(1000) } });
      assert.equal(ok.logged, true);
    });
  });

  test("limit: default 100, max 500, an explicit limit is honoured", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx, 7);
      assert.equal((await act(tx, "activity.list", { category: "zz-test", limit: 3 })).length, 3);
      assert.equal((await act(tx, "activity.list", { category: "zz-test" })).length, 7);
      assert.ok((await act(tx, "activity.list", { limit: 100000 })).length <= 500);
      assert.ok((await act(tx, "activity.list", {})).length <= 100);
    });
  });

  test("order and paging: newest first; `before` the last created_at gives the next page, no gaps or repeats", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx, 7);
      const p1 = await act(tx, "activity.list", { category: "zz-test", limit: 3 });
      assert.deepEqual(p1.map((x) => x.summary), ["Made-up entry 7", "Made-up entry 6", "Made-up entry 5"]);
      const p2 = await act(tx, "activity.list", { category: "zz-test", limit: 3, before: p1[2].created_at });
      assert.deepEqual(p2.map((x) => x.summary), ["Made-up entry 4", "Made-up entry 3", "Made-up entry 2"]);
      const p3 = await act(tx, "activity.list", { category: "zz-test", limit: 3, before: p2[2].created_at });
      assert.deepEqual(p3.map((x) => x.summary), ["Made-up entry 1"]);
      await refused(act(tx, "activity.list", { before: "not a date" }), 400);
    });
  });

  test("category filter: only that category", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx, 3, "zz-aaa");
      await seed(tx, 2, "zz-bbb");
      const a = await act(tx, "activity.list", { category: "zz-aaa" });
      assert.equal(a.length, 3);
      assert.ok(a.every((x) => x.category === "zz-aaa"));
      const b = await act(tx, "activity.list", { category: "zz-bbb" });
      assert.equal(b.length, 2);
      assert.equal((await act(tx, "activity.list", { category: "zz-nothing" })).length, 0);
    });
  });
});
