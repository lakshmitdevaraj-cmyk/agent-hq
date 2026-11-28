// R13, chunk 10: form.list and form.submissions, old path (Blobs, the P1 export) vs SQL (Neon dev, read only).
// Intended differences (listed, never hidden):
//   - form.list on SQL lists the A2 forms first, then the old April forms with legacy: true, and adds description /
//     thank_you / active / campaign_id / legacy keys (the old April forms keep their slug, title and fields).
//   - form.submissions on SQL adds lead_id (null for the old forms) and spam (false), and is newest first.
// The comparison is on slug, title and fields (forms) and on id, form_slug, data and received_at (submissions).
// Assertion messages never print a submission (they may hold a real person's details).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
let n, forms, old;
before(async () => {
  if (skip) return;
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  forms = await import("../../../netlify/functions/lib/sql/forms.ts");
  old = await (await import("../equiv/old-path.mjs")).openOld(EXPORT);
});
after(() => n?.close());
const sqlAct = (action, p) => n.call((tx) => forms.runFormAction(tx, action, p, { newId: () => "x" }));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v); // jsonb keeps its own key order

describe("chunk 10 forms: old vs new", { skip }, () => {
  test("form.list: every old April form is listed on SQL with legacy: true and the same slug, title and fields", async () => {
    const was = (await old.call("form.list")).body.data;
    const now = await sqlAct("form.list", {});
    const legacy = now.filter((f) => f.legacy);
    assert.equal(legacy.length, was.length, "same number of old forms");
    for (const w of was) {
      const x = legacy.find((f) => f.slug === w.slug);
      assert.ok(x, `form ${String(w.slug).slice(0, 40)} is listed`);
      assert.equal(x.title, w.title);
      assert.deepEqual(x.fields, w.fields ?? []);
    }
    console.log(`form.list: ${was.length} old forms, the same on SQL (legacy); ${now.length - legacy.length} A2 forms on dev`);
  });

  test("form.submissions: each old form's submissions are the same rows (id, form, data, time), newest first on SQL", async () => {
    const was = (await old.call("form.list")).body.data;
    let total = 0;
    for (const f of was) {
      const a = (await old.call("form.submissions", { slug: f.slug })).body.data;
      const b = await sqlAct("form.submissions", { slug: f.slug });
      const key = (s) => JSON.stringify([s.id, s.form_slug, sorted(s.data), iso(s.received_at)]);
      assert.ok(JSON.stringify(b.map(key).sort()) === JSON.stringify(a.map(key).sort()), `submissions of ${String(f.slug).slice(0, 40)} (${a.length} vs ${b.length})`);
      assert.ok(b.every((s) => s.lead_id === null && s.spam === false), "old submissions have no lead and are not spam");
      for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].received_at >= b[i].received_at, "newest first");
      total += a.length;
    }
    console.log(`form.submissions: ${total} old submissions, the same on SQL`);
  });
});
