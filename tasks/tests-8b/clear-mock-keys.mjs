// Local-only: removes the DUMMY keys that set-mock-key.mjs stored, so the local server talks to the real services again.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
for (const service of ["gemini", "agentmail"]) {
  const r = await fetch((process.argv[2] || "http://localhost:8890") + "/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action: "config.clear", params: { service } }) });
  console.log(service, r.status);
}
