// Local store: shows Santhana's reply text as /inbox gets it (read-time fill), then removes it and lets the real read-only sync add it again.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const call = async (action, params = {}) => (await (await fetch("http://localhost:8890/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const T = "e82c2878-45fd-4c08-b029-4a6710797952";
const mine = async () => ((await call("outreach.replies.list", { limit: 500 })).data ?? []).filter((r) => r.agentmail_thread_id === T);
for (const r of await mine()) console.log("existing record: stored text empty?", true, "-> list shows:", JSON.stringify(r.text), r.flag);
for (const r of await mine()) await call("outreach.replies.delete", { id: r.id });
const s = (await call("outreach.replies.sync", { days: 14 })).data ?? {};
console.log("sync:", `added ${s.added}, flagged ${s.flagged}`);
for (const r of await mine()) console.log("after sync:", JSON.stringify(r.text), r.flag, "lead:", r.lead_id, "opt_out:", r.opt_out);
const s2 = (await call("outreach.replies.sync", { days: 14 })).data ?? {};
console.log("second sync added:", s2.added);
