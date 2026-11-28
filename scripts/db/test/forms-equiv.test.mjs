// R13, chunks 10 and 12: form.list and form.submissions, old path (Blobs, the P1 export) vs SQL (Neon dev, read only).
// Intended differences (listed, never hidden):
//   - X8 (chunk 12): the old April forms and their submission are archived and gone from SQL; the old path (Blobs,
//     the live form system until P5) still has them. So every old form is missing on SQL, on purpose, and its
//     submissions are an empty list there. SQL lists only A2 forms (legacy: false).
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

describe("forms: old vs new", { skip }, () => {
  test("form.list: the old April forms are on the old path and, on purpose (X8), none of them is on SQL", async () => {
    const was = (await old.call("form.list")).body.data;
    const now = await sqlAct("form.list", {});
    assert.ok(was.length >= 1, "the export still has the old forms");
    assert.ok(now.every((f) => f.legacy === false), "SQL lists A2 forms only");
    for (const w of was) assert.ok(!now.some((f) => f.slug === w.slug), `old form ${String(w.slug).slice(0, 40)} is still on SQL`);
    console.log(`form.list: ${was.length} old forms on Blobs, 0 on SQL (X8, intended); ${now.length} A2 forms on dev`);
  });

  test("form.submissions: each old form's submissions exist on the old path and are an empty list on SQL (X8)", async () => {
    const was = (await old.call("form.list")).body.data;
    let total = 0;
    for (const f of was) {
      total += (await old.call("form.submissions", { slug: f.slug })).body.data.length;
      const onSql = (await sqlAct("form.submissions", { slug: f.slug })).length; // a count only: a row may hold a person's details
      assert.ok(onSql === 0, `submissions of ${String(f.slug).slice(0, 40)} on SQL: ${onSql}`);
    }
    console.log(`form.submissions: ${total} old submissions on Blobs, 0 on SQL (X8, intended)`);
  });
});
