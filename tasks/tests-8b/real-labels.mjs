// Read-only GETs against AgentMail with the key stored in the LOCAL sandbox (never printed): shows non-sent messages of the last 14 days.
import fs from "node:fs";
import path from "node:path";
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const f = walk(path.resolve(".netlify/blobs-serve")).find((x) => /service-config/.test(x) && /agentmail/.test(x));
const key = JSON.parse(fs.readFileSync(f, "utf8")).key;
const get = async (p) => (await fetch("https://api.agentmail.to/v0" + p, { headers: { Authorization: `Bearer ${key}` } })).json();
const cutoff = Date.now() - 14 * 86400000;
for (const inbox of (await get("/inboxes?limit=100")).inboxes ?? []) {
  const ms = (await get(`/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages?limit=100&include_unauthenticated=true&include_spam=true&include_blocked=true`)).messages ?? [];
  const sets = {}; for (const m of ms) { const k = (m.labels ?? []).join("+"); sets[k] = (sets[k] ?? 0) + 1; }
  console.log(inbox.inbox_id, "label sets:", JSON.stringify(sets));
  for (const m of ms.filter((m) => !(m.labels ?? []).includes("sent") && Date.parse(m.timestamp) > cutoff)) console.log("  ", m.timestamp?.slice(0, 16), (m.labels ?? []).join("+"), "|", String(m.from).slice(0, 45), "|", String(m.subject).slice(0, 40));
}
