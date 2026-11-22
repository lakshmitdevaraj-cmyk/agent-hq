import assert from "node:assert/strict";
import { isSystemReply } from "../../netlify/functions/lib/replies";
let n = 0, failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + " -> " + String((e as Error).message).split("\n")[0].slice(0, 200)); } };
t("our own health check is a system message", () => assert.equal(isSystemReply({ from: "lakshmi@team.shiftforge.ai", to: ["lakshmi@team.shiftforge.ai"], subject: "ShiftForge HQ webhook health check" }), true));
t("a health-check subject from a stranger is NOT (a person could write it)", () => assert.equal(isSystemReply({ from: "someone@example.net", subject: "ShiftForge HQ webhook health check" }), false));
t("delivery failure reports are system messages", () => { assert.equal(isSystemReply({ from: "MAILER-DAEMON@x.com", subject: "hi" }), true); assert.equal(isSystemReply({ from: "a@b.com", subject: "Undeliverable: calls" }), true); });
t("a normal reply is not", () => assert.equal(isSystemReply({ from: "Sam <sam@acme.com>", subject: "Re: plumbing calls" }), false));
console.log(`\n${n} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
