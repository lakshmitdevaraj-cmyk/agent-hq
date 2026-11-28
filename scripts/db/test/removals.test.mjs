// Chunk 12 (run F): the removals and the sweep.
//   X1 Tasks, X2 Voice, X3 Pages (+ R5: no public HTML), X8 the old April forms, D2 ("ShiftForge HQ" leftovers).
// Archives were saved outside the repo first (~/agent-hq-backups/p2-removals-2026-11-28/).
// Removed actions answer 410 "removed" on both backends, after the key check, and write nothing.
// All data here is made up.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../equiv/ts-ext.mjs"; // lets Node load lib/ files with extension-less imports

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const noExport = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
const src = (p) => readFileSync(join(ROOT, p), "utf8");

export const REMOVED_BY_ID = {
  X1: ["task.create", "task.list", "task.move", "task.delete", "outreach.replies.convert_to_task"],
  X2: [
    "voice.config.check", "voice.config.get", "voice.config.set", "voice.config.clear",
    "voice.session.save", "voice.session.list", "voice.session.get", "voice.session.delete",
    "voice.invitation.create", "voice.invitation.list", "voice.invitation.get", "voice.invitation.dismiss", "voice.invitation.accept",
  ],
  X3: ["page.create", "page.list", "page.get", "page.update", "page.delete"],
};
const ALL = Object.values(REMOVED_BY_ID).flat();
const idOf = (a) => Object.keys(REMOVED_BY_ID).find((k) => REMOVED_BY_ID[k].includes(a));
/** Plausible params, so an action that still existed would do its work rather than fail on a missing field. */
const PARAMS = {
  "task.create": { title: "Made-up task" }, "task.move": { id: "made-up", status: "done" }, "task.delete": { id: "made-up" },
  "outreach.replies.convert_to_task": { id: "made-up" },
  "voice.config.set": { gemini_key: "AIzaMadeUpVoiceKey0000000000000000000" }, "voice.session.save": { started_at: "2026-11-28T00:00:00Z", transcripts: [] },
  "voice.session.get": { id: "made-up" }, "voice.session.delete": { id: "made-up" },
  "voice.invitation.create": { topic: "Made-up" }, "voice.invitation.get": { id: "made-up" }, "voice.invitation.dismiss": { id: "made-up" }, "voice.invitation.accept": { id: "made-up" },
  "page.create": { slug: "made-up-page", title: "Made-up", html_body: "<p>x</p>" }, "page.get": { slug: "made-up-page" },
  "page.update": { slug: "made-up-page", title: "x" }, "page.delete": { slug: "made-up-page" },
};
const OLD_STORES = ["agent-hq-tasks", "agent-hq-pages", "agent-hq-voice-config", "agent-hq-voice-sessions", "agent-hq-voice-invitations", "agent-hq-forms", "agent-hq-submissions", "agent-hq-activity"];
const storeMap = (blobs, name) => (blobs.getStore(name), blobs.stores.get(name));
const snapshot = (blobs) => JSON.stringify(OLD_STORES.map((s) => [s, [...storeMap(blobs, s)].sort()]));

describe("chunk 12: what is removed, in the code", () => {
  test("lib/removed.ts lists exactly the 23 removed actions, each a 410 'removed' with its scope id", async () => {
    const { REMOVED, removedAction } = await import("../../../netlify/functions/lib/removed.ts");
    assert.deepEqual(Object.keys(REMOVED).sort(), [...ALL].sort());
    for (const a of ALL) {
      const r = removedAction(a);
      assert.equal(r.status, 410, a);
      assert.equal(r.code, "removed", a);
      assert.equal(r.scope_id, idOf(a), a);
      assert.match(r.error, /removed/i, a);
    }
    for (const kept of ["config.status", "form.list", "form.create", "activity.list", "outreach.replies.list", "nope.nothing"]) assert.equal(removedAction(kept), null, kept);
  });

  test("command.ts has no case for a removed action; access.ts names none of them", () => {
    const cmd = src("netlify/functions/command.ts"), access = src("netlify/functions/lib/sql/access.ts");
    for (const a of ALL) {
      assert.ok(!cmd.includes(`case "${a}"`), `command.ts still has case ${a}`);
      assert.ok(!access.includes(`"${a}"`), `access.ts still lists ${a}`);
    }
  });

  test("X2: the Gemini key is never written to the Voice copy any more (writeServiceKey)", () => {
    const cmd = src("netlify/functions/command.ts");
    const body = cmd.slice(cmd.indexOf("async function writeServiceKey"), cmd.indexOf("\n}\n", cmd.indexOf("async function writeServiceKey")));
    assert.ok(body.length > 50 && !body.includes("VOICE_CONFIG"), "writeServiceKey still mirrors the key into voice-config");
  });

  test("X3 / R5: page-serve.ts is gone and netlify.toml has no /p/* route", () => {
    assert.ok(!existsSync(join(ROOT, "netlify/functions/page-serve.ts")), "page-serve.ts still exists");
    const toml = src("netlify.toml");
    assert.ok(!/page-serve/.test(toml), "netlify.toml still routes to page-serve");
    assert.ok(!/from\s*=\s*"\/p\//.test(toml), "netlify.toml still has a /p/* redirect");
  });

  test("X8: lib/sql/forms.ts no longer reads the old April forms tables", () => {
    const f = src("netlify/functions/lib/sql/forms.ts");
    assert.ok(!/\b(from|into|join)\s+(forms|submissions)\b/.test(f), "forms.ts still reads forms / submissions");
    assert.ok(!/legacyRecord/.test(f), "forms.ts still builds legacy records");
  });

  test("D2: the health check subject is Alcance; the reply filter on the old path knows both subjects; command.ts keeps the old name only for the inbox it may create", async () => {
    const r = await import("../../../netlify/functions/lib/replies.ts");
    assert.equal(r.HEALTH_CHECK_SUBJECT, "Alcance webhook health check");
    assert.equal(r.isHealthCheckMessage("Alcance webhook health check"), true);
    assert.equal(r.isHealthCheckMessage("Re: ShiftForge HQ webhook health check"), true, "a check sent before the change is still a check");
    assert.equal(r.isHealthCheckMessage("Our webhook is broken"), false);
    const left = src("netlify/functions/command.ts").split("\n").filter((l) => /ShiftForge HQ/.test(l));
    assert.equal(left.length, 1, `command.ts lines still saying ShiftForge HQ: ${left.length}`);
    assert.match(left[0], /getOrCreateCampaignInbox\(agentmailKey, "ShiftForge HQ Health Check"/, "only the inbox name (AgentMail display name on create) keeps the old text");
  });

  test("sweep: the lead-gen domain comments use made-up domains only", () => {
    for (const file of ["netlify/functions/lib/leadflags.ts", "netlify/functions/lib/sitecheck.ts"]) {
      const comments = src(file).split("\n").filter((l) => /^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
      const hosts = [...comments.matchAll(/"([a-z0-9-]+\.[a-z]{2,})"/g)].map((m) => m[1]);
      for (const h of hosts) assert.match(h, /madeup|mock|example/, `${file}: comment quotes ${h.length}-char host that is not marked made up`);
    }
  });

  test("sweep: .claude/settings.local.json is ignored by git and not tracked", () => {
    assert.match(src(".gitignore"), /^\.claude\/settings\.local\.json$/m);
    execFileSync("git", ["check-ignore", "-q", ".claude/settings.local.json"], { cwd: ROOT }); // throws when not ignored
    assert.equal(execFileSync("git", ["ls-files", ".claude/settings.local.json"], { cwd: ROOT, encoding: "utf8" }).trim(), "");
  });
});

describe("chunk 12 through the real handler on the old path (Blobs)", { skip: noExport }, () => {
  let openOld;
  before(async () => { ({ openOld } = await import("../equiv/old-path.mjs")); });

  test("every removed action answers 410 'removed' and writes nothing; unknown is still unknown; no key is still 401", async () => {
    const old = await openOld(EXPORT);
    const was = snapshot(old.blobs);
    for (const a of ALL) {
      const r = await old.call(a, PARAMS[a] ?? {});
      assert.equal(r.status, 410, `${a} → ${r.status}`);
      assert.equal(r.body.ok, false, a);
      assert.equal(r.body.code, "removed", a);
      assert.equal(r.body.scope_id, idOf(a), a);
    }
    assert.equal(snapshot(old.blobs), was, "a removed action wrote to a store");
    const unknown = await old.call("nope.nothing", {});
    assert.deepEqual([unknown.status, unknown.body.error], [400, "Unknown action: nope.nothing"]);
    const anon = await old.raw({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "task.list", params: {} }) });
    assert.equal(anon.status, 401, "the key check comes before the removed answer");
  });

  test("X2: the Gemini key moves from the Voice copy to Settings on first read; config.clear leaves no copy that comes back", async () => {
    const KEY = "AIzaMadeUpMoveKey00000000000000000000";
    const old = await openOld(EXPORT, { seed: { "agent-hq-voice-config": { config: { gemini_key: KEY, updated_at: "2026-11-01T00:00:00Z" } } } });
    storeMap(old.blobs, "agent-hq-service-config").delete("gemini");
    const s1 = await old.call("config.status", {});
    assert.equal(s1.status, 200);
    assert.equal(s1.body.data.gemini.configured, true, "the key is still found");
    assert.ok(!JSON.stringify(s1.body).includes(KEY), "never returned in full");
    const moved = JSON.parse(storeMap(old.blobs, "agent-hq-service-config").get("gemini") ?? "null");
    assert.equal(moved?.key, KEY, "the key is now in Settings (service config)");
    assert.equal(storeMap(old.blobs, "agent-hq-voice-config").has("config"), false, "the Voice copy is gone after the move");
    const c = await old.call("config.clear", { service: "gemini" });
    assert.equal(c.status, 200);
    const s2 = await old.call("config.status", {});
    assert.equal(s2.body.data.gemini.configured, false, "a cleared key does not come back");
  });

  test("X2: with a key in both places, Settings wins (before, the Voice copy won)", async () => {
    const A = "AIzaMadeUpSettingsKey0000000000000000", B = "AIzaMadeUpVoiceOnly00000000000000000000";
    const old = await openOld(EXPORT, { seed: { "agent-hq-voice-config": { config: { gemini_key: B } }, "agent-hq-service-config": { gemini: { key: A, updated_at: "2026-11-02T00:00:00Z" } } } });
    const s = await old.call("config.status", {});
    assert.equal(s.body.data.gemini.masked, `${A.slice(0, 4)}${"•".repeat(A.length - 8)}${A.slice(-4)}`);
    assert.equal(JSON.parse(storeMap(old.blobs, "agent-hq-service-config").get("gemini")).key, A);
  });
});

describe("chunk 12 on Neon dev", () => {
  let n;
  before(async () => { n = (await import("../equiv/new-path.mjs")).openNew("dev"); });
  after(() => n?.close());

  test("migration 0019: the 7 old tables are gone; the A2 form tables and the rest stay", () => n.call(async (tx) => {
    const reg = async (t) => (await tx`select to_regclass(${`public.${t}`})::text as r`)[0].r;
    for (const t of ["tasks", "pages", "voice_config", "voice_sessions", "voice_invitations", "forms", "submissions"]) assert.equal(await reg(t), null, `${t} still exists`);
    for (const t of ["lead_forms", "form_links", "form_submissions", "leads", "emails", "activity", "service_config", "approvals"]) assert.equal(await reg(t), t, `${t} is missing`);
  }));

  test("X8: form.list on SQL has no old April form (legacy) and an old slug answers 404", () => n.call(async (tx) => {
    const forms = await import("../../../netlify/functions/lib/sql/forms.ts");
    const list = await forms.runFormAction(tx, "form.list", {}, { newId: () => "x" });
    assert.ok(Array.isArray(list));
    assert.ok(list.every((f) => f.legacy !== true), "an old April form is still listed");
    const r = await forms.submit(tx, { slug: "made-up-old-april", method: "GET", token: null, body: "" }, { newId: () => "x" });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(await forms.runFormAction(tx, "form.submissions", { slug: "made-up-old-april" }, { newId: () => "x" }), []);
  }));
});

describe("chunk 12 through the real handler on dev (DATA_BACKEND=sql)", { skip: noExport }, () => {
  test("every removed action answers 410 'removed' on SQL too", async () => {
    const { openOld } = await import("../equiv/old-path.mjs");
    const { localVar } = await import("../env.mjs");
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    try {
      const h = await openOld(EXPORT, { allowDb: true });
      for (const a of ALL) {
        const r = await h.call(a, PARAMS[a] ?? {});
        assert.equal(r.status, 410, `${a} → ${r.status}`);
        assert.equal(r.body.code, "removed", a);
      }
      const kept = await h.call("activity.list", { limit: 1 });
      assert.equal(kept.status, 200, "a kept action still works on SQL");
    } finally {
      delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL;
    }
  });
});
