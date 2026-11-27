// R13: the equivalence harness. Old path = real command.ts on the P1 export (read only, network blocked);
// new path = SQL on Neon dev (read-only transaction, rolled back). Skipped when the export folder is missing.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff, normalise } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const haveExport = existsSync(join(EXPORT, "manifest.json"));

describe("compare", () => {
  test("ignores key order and timestamps, keeps array order", () => {
    assert.ok(compare({ a: 1, b: { c: 2, d: 3 }, updated_at: "2026-01-01T00:00:00Z" }, { b: { d: 3, c: 2 }, a: 1, updated_at: "2027-05-05T10:00:00Z" }).same);
    assert.ok(compare({ when: "2026-01-01T00:00:00.000Z" }, { when: new Date() }).same, "an ISO string and a Date are both times");
    assert.ok(!compare([1, 2], [2, 1]).same);
    assert.ok(compare({ xs: [1, 2] }, { xs: [2, 1] }, { unordered: ["xs"] }).same);
  });

  test("null and absent are the same by default, but false and absent are not", () => {
    assert.ok(compare({ a: 1 }, { a: 1, b: null }).same);
    assert.ok(!compare({ a: 1 }, { a: 1, b: null }, { nullIsMissing: false }).same);
    const r = compare({ a: 1 }, { a: 1, b: false });
    assert.ok(!r.same);
    assert.equal(r.unexpected[0].path, "$.b");
  });

  test("known differences are reported, never dropped", () => {
    const r = compare({ n: 1 }, { n: 2 }, { known: [{ path: /^\$\.n$/, why: "test" }] });
    assert.ok(r.same);
    assert.equal(r.known.length, 1);
    assert.match(describeDiff(r), /~ \$\.n: old 1 → new 2 \(test\)/);
  });

  test("the printed report masks email addresses", () => {
    assert.doesNotMatch(describeDiff(compare({ to: "someone@example.com" }, { to: "other@example.com" })), /example\.com/);
  });

  test("bigints become numbers", () => assert.deepEqual(normalise({ n: 3n }), { n: 3 }));
});

describe("old path: real command.ts on the export", { skip: !haveExport && "P1 export folder not found" }, () => {
  let old, net, fingerprint;
  const fingerprintExport = () => readdirSync(EXPORT).sort().map((f) => `${f}:${statSync(join(EXPORT, f)).mtimeMs}:${createHash("sha256").update(readFileSync(join(EXPORT, f))).digest("hex")}`).join("\n");

  before(async () => {
    fingerprint = fingerprintExport();
    net = await import("../equiv/old-path.mjs");
    old = await net.openOld(EXPORT);
  });

  test("a network call inside the old code is refused (AgentMail inbox list with a fake key)", async () => {
    old.blobs.getStore("agent-hq-service-config").set("agentmail", JSON.stringify({ key: "fake-key-for-test", updated_at: "2026-11-27T00:00:00Z" }));
    const before = net.blockedCalls.length;
    const res = await old.call("outreach.inboxes.list");
    assert.equal(res.body.ok, false, "the action must fail, not reach AgentMail");
    assert.match(JSON.stringify(res.body), /network access is blocked/);
    const calls = net.blockedCalls.slice(before);
    assert.ok(calls.length >= 1);
    assert.equal(calls[0].what, "fetch");
    assert.match(calls[0].target, /agentmail/i);
    old.blobs.getStore("agent-hq-service-config").delete("agentmail");
  });

  test("global fetch refuses", async () => {
    await assert.rejects(fetch("https://example.com"), (e) => e.code === "EQUIV_NETWORK_BLOCKED");
  });

  test("command.ts's own node:https import was bundled as the blocking stub, and the real module was not", () => {
    assert.ok(net.bundleInputs.includes("equiv:net:node:https"), net.bundleInputs.filter((i) => i.startsWith("equiv:")).join(", "));
    assert.ok(net.bundleInputs.includes("equiv:blobs"));
    assert.ok(!net.bundleInputs.some((i) => /node_modules\/@netlify\/blobs/.test(i)), "the real @netlify/blobs must not be in the bundle");
  });

  for (const [spec, fn] of [["node:https", "request"], ["https", "get"], ["node:http", "request"], ["node:net", "connect"], ["node:tls", "connect"], ["node:child_process", "spawn"]]) {
    test(`a bundled import of ${spec} refuses ${fn}()`, async () => {
      const probe = await net.probeImport(spec, fn);
      assert.throws(() => probe.run(), (e) => e.code === "EQUIV_NETWORK_BLOCKED");
    });
  }

  test("the export folder is unchanged after the old code ran (read only)", () => {
    assert.equal(fingerprintExport(), fingerprint);
  });
});

describe("outreach.campaign.list: old vs new", { skip: !haveExport && "P1 export folder not found" }, () => {
  let old, fresh, cs, oldResult;
  before(async () => {
    cs = await import("../equiv/cases/campaign-list.mjs");
    old = await (await import("../equiv/old-path.mjs")).openOld(EXPORT);
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    const res = await old.call(cs.action, cs.params);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    oldResult = res.body.data;
  });
  after(() => fresh?.close());

  test("the harness fails when the SQL version is wrong", async () => {
    const r = compare(oldResult, await fresh.call(cs.brokenSqlVersion), { known: cs.known });
    assert.equal(r.same, false);
    assert.ok(r.unexpected.some((d) => d.path === "$[0].leads_imported"), describeDiff(r));
  });

  test("the SQL version gives the same answer as the old path", async () => {
    const newResult = await fresh.call(cs.sqlVersion);
    assert.ok(oldResult.length > 0);
    const r = compare(oldResult, newResult, { known: cs.known });
    console.log(describeDiff(r));
    assert.ok(r.same, describeDiff(r));
    // The listed finding must cover exactly the campaigns with no any_trade field, no more.
    assert.equal(r.known.length, oldResult.filter((c) => !("any_trade" in c)).length);
  });

  test("a known difference is matched narrowly: any_trade true → false would still fail", () => {
    const r = compare([{ any_trade: true }], [{ any_trade: false }], { known: cs.known });
    assert.equal(r.same, false);
  });
});
