// Local server + REAL AgentMail, read-only toward AgentMail: sync twice (writes only the local store), then the webhook dry run. Prints no keys.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const call = async (action, params = {}) => { const r = await fetch(`http://localhost:8890/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) }); return { status: r.status, ...(await r.json()) }; };
for (const run of [1, 2]) {
  const s = await call("outreach.replies.sync", { days: 14 });
  const d = s.data ?? {};
  console.log(`sync run ${run}: status ${s.status}`, JSON.stringify(d, null, 1).slice(0, 1800), s.error ?? "");
}
const w = await call("outreach.webhook.events", {});
for (const h of w.data?.webhooks ?? []) console.log("webhook", h.url.replace(/\/[^/]+$/, "/…"), "\nBEFORE:", h.before.join(", "), "\nAFTER :", h.after.join(", "), "\nBODY  :", JSON.stringify(h.body), "\nneeds_change:", h.needs_change);
if (w.error) console.log("webhook error:", w.error);
