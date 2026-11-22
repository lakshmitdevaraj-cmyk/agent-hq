// Local-only: lists the type of every social message written in the local sandbox and whether it mentions an email.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
const api = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json()).data;
const prospects = await api("outreach.prospects.list");
const camps = [...new Set(prospects.map((p) => p.campaign_id).filter(Boolean))];
const rows = [];
for (const c of camps) for (const r of await api("outreach.social.list", { campaign_id: c })) {
  const p = prospects.find((x) => x.id === r.lead_id);
  rows.push({ lead: p?.name, emailed: (p?.touches?.counts.email ?? 0) > 0, type: r.type, status: r.status, review: r.review_status, mentionsEmail: /e-?mail/i.test(r.parts.map((x) => x.text).join(" ")) });
}
console.table(rows);
const firsts = rows.filter((r) => r.type === "first");
console.log("first messages mentioning an email:", firsts.filter((r) => r.mentionsEmail).length, "of", firsts.length);
console.log("emailed leads that got a FIRST message:", rows.filter((r) => r.emailed && r.type === "first").length);
