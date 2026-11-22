// Local-only: stores a DUMMY Gemini key in the local sandbox so the mock Gemini (mock-gemini.mjs) is used. Not a real key.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const r = await fetch((process.argv[2] || "http://localhost:8890") + "/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action: "config.set", params: { service: process.argv[3] || "gemini", key: "mock-local-test-key" } }) });
console.log(r.status, (await r.text()).slice(0, 300));
