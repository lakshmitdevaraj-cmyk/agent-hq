// Local-only: deletes webhooks named "AgentMail regression" (left behind by the regression runs) from the LOCAL sandbox store.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
if (!/^http:\/\/localhost[:/]/.test(base)) throw new Error("local only");
const api = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const list = (await api("webhook.list")).data ?? [];
const mine = list.filter((w) => w.name === "AgentMail regression");
console.log(`before: ${list.length} webhooks, ${mine.length} named "AgentMail regression"`);
for (const w of mine) { const r = await api("webhook.delete", { id: w.id }); if (!r.ok) console.log("delete failed:", r.error); }
const after = (await api("webhook.list")).data ?? [];
console.log(`after: ${after.length} webhooks, ${after.filter((w) => w.name === "AgentMail regression").length} named "AgentMail regression"; others kept: ${after.map((w) => w.name).join(", ") || "none"}`);
