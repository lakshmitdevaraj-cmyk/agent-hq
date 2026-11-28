// Chunk 9 on Neon dev, every transaction rolled back: Settings and service keys (lib/sql/settings.ts).
// R3: the Gemini key lives in one place (service_config, "Settings → API keys"); a Voice copy is never read or written.
// V7: a key is tested before it is saved and nothing is saved when the test fails; config.status shows masked keys only.
// Settings writes change only the fields that changed. All keys are made up; the key tests are stubs (no network).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

let n, st, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { st = await import("../../../netlify/functions/lib/sql/settings.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/settings.ts did not load: ${loadError.message}`); };
const GOOD = "AIzaMadeUpGoodKey000000000000000000", BAD = "AIzaMadeUpBadKey0000000000000000000";
const tests = [];
const deps = { test: async (service, key, model) => { tests.push({ service, model }); return key === BAD ? { ok: false, message: "made-up: key refused" } : { ok: true, message: "made-up: ok" }; }, services: ["gemini", "apify", "agentmail", "ai2"] };
const act = (tx, action, params) => st.runConfigAction(tx, action, params, deps);
async function refused(p, status) { await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); return true; }); }
const clean = async (tx) => { await tx`delete from service_config`; }; // voice_config is gone (chunk 12, X2)

describe("chunk 9 settings and service keys on SQL", () => {
  test("module loads", () => need());

  test("R3: the Gemini key is read from service_config only (the Voice copy and its table are gone, chunk 12 X2)", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      assert.equal(await st.readServiceKey(tx, "gemini"), null);
      await act(tx, "config.set", { service: "gemini", key: GOOD });
      assert.equal(await st.readServiceKey(tx, "gemini"), GOOD);
      assert.equal((await tx`select to_regclass('public.voice_config')::text as r`)[0].r, null, "no Voice table to write to");
    });
  });

  test("V7: config.set tests the key first; a failed test saves nothing and says why; skip_test saves without a test", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      await refused(act(tx, "config.set", { service: "gemini", key: BAD }), 400);
      assert.equal(await st.readServiceKey(tx, "gemini"), null, "nothing saved after a failed test");
      const ok = await act(tx, "config.set", { service: "apify", key: "apify_api_madeup0000000000000000" });
      assert.equal(ok.configured, true);
      assert.equal(ok.test.ok, true);
      await refused(act(tx, "config.set", { service: "openai", key: GOOD }), 400);
      await refused(act(tx, "config.set", { service: "gemini", key: "   " }), 400);
      const before = tests.length;
      await act(tx, "config.set", { service: "agentmail", key: "am_madeup000000000000", skip_test: true });
      assert.equal(tests.length, before, "skip_test runs no test");
    });
  });

  test("config.status shows masked keys only (never the key), config.test re-tests, config.clear removes", async () => {
    need();
    await n.callWrite(async (tx) => {
      await clean(tx);
      await act(tx, "config.set", { service: "gemini", key: GOOD, model: "gemini-made-up" });
      const s = await act(tx, "config.status", {});
      assert.ok(!JSON.stringify(s).includes(GOOD), "the raw key is never returned");
      assert.equal(s.gemini.configured, true);
      assert.equal(s.gemini.masked, `${GOOD.slice(0, 4)}${"•".repeat(GOOD.length - 8)}${GOOD.slice(-4)}`);
      assert.equal(s.apify.configured, false);
      const [set] = await tx`select data->>'gemini_model' as m from outreach_settings where key = 'settings'`;
      assert.equal(set.m, "gemini-made-up", "the model goes to Settings");
      const t = await act(tx, "config.test", { service: "gemini" });
      assert.equal(t.ok, true);
      await refused(act(tx, "config.test", { service: "apify" }), 404);
      assert.deepEqual(await act(tx, "config.clear", { service: "gemini" }), { cleared: true });
      assert.equal(await st.readServiceKey(tx, "gemini"), null);
    });
  });

  test("Settings: read back straight away (F1); a write changes only the fields that changed", async () => {
    need();
    await n.callWrite(async (tx) => {
      await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ postal_address: "1 Made Up Street", time_zone: "America/Chicago", daily_send_limit: 20 })})
               on conflict (key) do update set data = excluded.data`;
      const cur = await st.readSettings(tx);
      assert.equal(cur.postal_address, "1 Made Up Street");
      // Another writer changes the daily limit after this page read Settings: a write of the postal address keeps it.
      await tx`update outreach_settings set data = data || '{"daily_send_limit": 35}' where key = 'settings'`;
      await st.writeSettings(tx, cur, { ...cur, postal_address: "2 Made Up Avenue", updated_at: "2026-11-28T10:00:00.000Z" });
      const back = await st.readSettings(tx);
      assert.equal(back.postal_address, "2 Made Up Avenue");
      assert.equal(back.daily_send_limit, 35, "a field this write did not change is kept");
      await st.writeSettings(tx, back, { ...back, booking_link: undefined, daily_send_limit: 40 });
      assert.equal((await st.readSettings(tx)).daily_send_limit, 40);
    });
  });
});
