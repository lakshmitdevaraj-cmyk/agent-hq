// Local-only: shows which service keys exist in the local sandbox (names only, never values).
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const r = await fetch((process.argv[2] || "http://localhost:8890") + "/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action: "config.status", params: {} }) });
const j = await r.json();
const d = j.data ?? j;
console.log(JSON.stringify(Object.fromEntries(Object.entries(d?.services ?? d ?? {}).map(([k, v]) => [k, typeof v === "object" && v ? { configured: v.configured ?? !!v.key } : v])), null, 1).slice(0, 600));
