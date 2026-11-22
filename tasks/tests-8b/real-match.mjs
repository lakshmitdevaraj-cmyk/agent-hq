// Local store only. Lists non-fixture replies (real ones synced from AgentMail), their Test marks, and whether the campaign counters count them.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const call = async (action, params = {}) => (await (await fetch("http://localhost:8890/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const rs = (await call("outreach.replies.list", { limit: 500 })).data ?? [];
for (const r of rs.filter((r) => !String(r.agentmail_message_id).startsWith("in-") && !String(r.agentmail_message_id).startsWith("mock-")))
  console.log(r.id, "|", String(r.from).slice(0, 48), "|", r.flag ?? "-", "| test:", r.is_test, "| thread:", r.agentmail_thread_id, "| lead:", r.lead_id, "| campaign:", r.campaign_id, "| opt_out:", r.opt_out);
