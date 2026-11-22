// Local-only: removes ONLY the dummy Gemini key (the AgentMail key is left alone).
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
if (!/^http:\/\/localhost[:/]/.test(base)) throw new Error("local only");
const r = await fetch(base + "/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action: "config.clear", params: { service: "gemini" } }) });
console.log("gemini", r.status);
