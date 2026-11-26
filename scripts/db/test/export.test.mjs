import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, exportStore, estimateCalls } from "../export-lib.mjs";

// Made-up values shaped like real keys.
const GEMINI = "AIza" + "x".repeat(35);
const AGENT = "akey_" + "y".repeat(28);

test("voice config and agent records lose their key values", () => {
  const voice = redact("agent-hq-voice-config", JSON.stringify({ gemini_key: GEMINI, updated_at: "2026-01-01" }));
  assert.ok(!voice.value.includes(GEMINI));
  assert.deepEqual(voice.redacted, ["gemini_key"]);
  assert.equal(JSON.parse(voice.value).updated_at, "2026-01-01");
  const agent = redact("agent-hq-agents", JSON.stringify({ id: "a1", name: "Test", api_key: AGENT }));
  assert.ok(!agent.value.includes(AGENT));
  assert.deepEqual(agent.redacted, ["api_key"]);
});

test("a key pasted into free text or a non-JSON value is removed too", () => {
  assert.ok(!redact("agent-hq-tasks", JSON.stringify({ notes: [`use ${GEMINI} here`] })).value.includes(GEMINI));
  assert.ok(!redact("agent-hq-tasks", `plain ${AGENT}`).value.includes(AGENT));
});

test("webhook event headers that carry credentials are removed", () => {
  const r = redact("agent-hq-webhook-events", JSON.stringify({ headers: { authorization: "Bearer abc", "svix-signature": "v1,abc", "content-type": "application/json" } }));
  const h = JSON.parse(r.value).headers;
  assert.equal(h.authorization, "[redacted]");
  assert.equal(h["svix-signature"], "[redacted]");
  assert.equal(h["content-type"], "application/json");
});

test("a record with nothing secret is kept byte for byte", () => {
  const raw = '{"key":"message",  "token":"tracking-123", "parts":[{"key":"dm"}]}';
  assert.equal(redact("agent-hq-outreach-clicks", raw).value, raw);
  assert.equal(redact("agent-hq-outreach-contacts", "1").value, "1");
});

test("export follows next_cursor to the end", async () => {
  const pages = { first: { records: [{ key: "a", value: "1" }], next_cursor: "a", total: 2 }, a: { records: [{ key: "b", value: "2" }], next_cursor: null, total: 2 } };
  const asked = [];
  const call = async (action, params) => { asked.push([action, params.cursor]); return pages[params.cursor ?? "first"]; };
  const out = await exportStore(call, "s");
  assert.deepEqual(out.records.map((r) => r.key), ["a", "b"]);
  assert.deepEqual(asked, [["data.export", null], ["data.export", "a"]]);
});

test("export stops if the cursor does not move", async () => {
  const call = async () => ({ records: [], next_cursor: "same", total: 1 });
  await assert.rejects(exportStore(call, "s"), /cursor/);
});

test("estimated calls: one per 100 records, at least one per store", () => {
  assert.equal(estimateCalls({ a: 0, b: 100, c: 101 }), 4);
});
