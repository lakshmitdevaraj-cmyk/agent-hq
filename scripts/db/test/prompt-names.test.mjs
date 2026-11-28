// Chunk 12 sweep: the writer's worked examples used a real prospect and owner. They now use made-up names, and the
// writer's prompt must build exactly as before apart from the names. The fingerprints below were worked out once from
// the text before the change, with the old names replaced by the same placeholders (the old names are not in this repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NEW = [["Bramblecrest AC & Heat", "<B1>"], ["Bramblecrest", "<B1S>"], ["Dorian", "<OWNER>"], ["Quillfield Comfort AC", "<B2>"]];
const norm = (s) => NEW.reduce((t, [a, b]) => t.split(a).join(b), s);
const fp = (s) => createHash("sha256").update(norm(s)).digest("hex");
const BEFORE = {
  system: "98f0dad2e4bb8aa58c7e77f7bbb7021e609cff9a7b02413305a88bc10d7a605d",
  examples: "611cfff88569833b2402c287d47b5d2fa021ddb4c7efdc1f1db41bfd9fc0d922",
  bodies: "2c4ac9779b2305132d706e4bd878842b73fecbf02c60aa885cfb0495f243a407",
  line: "44cbcdf483d3788098c8c8a86084439f6c1734a2d22c9b3d0e94718f1a164a3c",
};

test("the writer's system prompt, its two worked examples and the bodies used by the copy check are the same apart from the names", async () => {
  const p = await import("../../../netlify/functions/lib/prompts.ts");
  assert.equal(fp(p.DRAFT_SYSTEM_PROMPT), BEFORE.system, "DRAFT_SYSTEM_PROMPT changed beyond the names");
  assert.equal(fp(p.DRAFT_EXAMPLES), BEFORE.examples, "DRAFT_EXAMPLES changed beyond the names");
  assert.equal(p.EXAMPLE_BODIES.length, 2);
  assert.equal(fp(p.EXAMPLE_BODIES.join("\n---\n")), BEFORE.bodies, "EXAMPLE_BODIES changed beyond the names");
  assert.ok(p.DRAFT_SYSTEM_PROMPT.endsWith(p.DRAFT_EXAMPLES), "the examples are still the end of the system prompt");
  assert.deepEqual([...p.DRAFT_EXAMPLES.matchAll(/^BUSINESS: (.*)$/gm)].map((m) => m[1]), ["Bramblecrest AC & Heat", "Quillfield Comfort AC"]);
  assert.deepEqual([...p.DRAFT_EXAMPLES.matchAll(/^GREETING: (.*)$/gm)].map((m) => m[1]), ["Hi Dorian", "Hi there"]);
});

test("the command.ts line that builds the writer's TRUE DETAILS / SUBJECT input is the same apart from the names", () => {
  const line = readFileSync(join(ROOT, "netlify/functions/command.ts"), "utf8").split("\n").filter((l) => l.includes("TRUE DETAILS ABOUT THEM (the opening MUST"));
  assert.equal(line.length, 1);
  assert.equal(fp(line[0].trim()), BEFORE.line, "the prompt line changed beyond the names");
});

test("the accuracy test fixture uses the made-up name", () => {
  const t = readFileSync(join(ROOT, "tasks/tests-8b/accuracy.test.ts"), "utf8");
  assert.match(t, /name: "Bramblecrest Air"/);
});
