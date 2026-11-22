// Deploy step 2: GET the webhook(s) that point at the live site, show before/after, then (with "apply") PATCH. Keeps every current event.
// Needs the dev server started with ALLOW_WEBHOOK_PATCH=1. Prints no keys.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const apply = process.argv[2] === "apply";
const r = await (await fetch("http://localhost:8890/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action: "outreach.webhook.events", params: { apply, url_contains: "shiftforge-hq.netlify.app" } }) })).json();
if (!r.ok) { console.log("ERROR", r.error); process.exit(1); }
for (const w of r.data.webhooks) { console.log(`url: ${w.url.replace(/\/[A-Za-z0-9_-]{6,}$/, "/<id>")}\nneeds_change: ${w.needs_change}\nBEFORE: ${w.before.join(", ")}\nAFTER : ${w.after.join(", ")}\nADDED : ${w.added.join(", ")}\napplied: ${w.applied}\nmessage: ${w.message}\n`); }
if (!r.data.webhooks.length) console.log("no webhook points at the live site");
