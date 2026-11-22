// Local-only timing of the three heavy reads (Outreach list, one campaign, Prospects). Usage: node tasks/tests-8b/timing.mjs http://localhost:8890 <campaign_id>
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2], camp = process.argv[3];
const t = async (action, params = {}) => { const s = performance.now(); const r = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) }); const j = await r.json(); return [performance.now() - s, r.status, JSON.stringify(j).length]; };
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [label, action, params] of [["Outreach (campaign list)", "outreach.campaign.list", {}], ["One campaign (get)", "outreach.campaign.get", { id: camp }], ["One campaign (leads)", "outreach.leads.list", { campaign_id: camp }], ["One campaign (emails)", "outreach.emails.list", { campaign_id: camp }], ["Prospects", "outreach.prospects.list", {}]]) {
  await t(action, params);
  const runs = []; let size = 0, st = 0;
  for (let i = 0; i < 7; i++) { const [ms, s, sz] = await t(action, params); runs.push(ms); size = sz; st = s; }
  console.log(`${label.padEnd(26)} median ${Math.round(med(runs))} ms  (min ${Math.round(Math.min(...runs))}, max ${Math.round(Math.max(...runs))})  status ${st}  ${Math.round(size / 1024)} KB`);
}
