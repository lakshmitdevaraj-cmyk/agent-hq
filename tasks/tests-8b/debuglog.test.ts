import assert from "node:assert/strict";
import { maskSecrets, debugLine } from "../../netlify/functions/lib/debuglog";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 160)); } };

t("email addresses and key-like strings are masked", () => {
  const s = maskSecrets("Mail jane.doe@acme-hvac.com with key AIzaSyA1234567890abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwx and ahq_pSk7lU0WFWfYA94BV");
  assert.ok(!/@acme/.test(s));
  assert.ok(!/AIza/.test(s));
  assert.ok(!/Bearer abc/.test(s));
  assert.ok(!/ahq_p/.test(s));
  assert.match(s, /\[email\]/);
});
t("a debug line is one JSON line with kind, text and reasons, masked", () => {
  const l = debugLine("review", { lead: "Acme HVAC", status: "check", reasons: ["Greets Jim but jim@acme.com is not the owner"], body: "Hi Jim,\nCall me at x@y.org" });
  assert.ok(l.startsWith("[debug:review] {"));
  assert.ok(!l.includes("\n"));
  assert.ok(!/jim@acme|x@y\.org/.test(l));
  assert.match(l, /Acme HVAC/);
  assert.match(l, /Greets Jim/);
});
console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
