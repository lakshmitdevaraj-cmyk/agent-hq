// Local-only: shows the webhook's event list now and the one that WOULD be sent. With "apply" it proves the local guard refuses to send.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
const api = async (params) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action: "outreach.webhook.events", params }) })).json()).data;
const d = await api({});
const w = d.webhooks[0];
console.log("dry_run:", d.dry_run, "| needs_change:", w.needs_change);
console.log("BEFORE:", w.before.join(", "));
console.log("AFTER :", w.after.join(", "));
console.log("ADDED :", w.added.join(", "));
console.log("BODY WOULD BE SENT:", JSON.stringify(w.body));
const a = await api({ apply: true });
console.log("apply:true on local ->", a.webhooks[0].applied, "|", a.webhooks[0].message);
