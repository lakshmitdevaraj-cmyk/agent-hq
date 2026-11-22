// Writes Facebook (all steps), Instagram and LinkedIn runs for ONE TEST lead with real Gemini (local server). Nothing is sent. Usage: node tasks/tests-8c/real-social.mjs
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = "http://localhost:8890";
const call = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
const stamp = Date.now().toString(36), t0 = "2026-11-10T10:00:00.000Z", camp = `soc-${stamp}`, id = `s${stamp}`;
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Social sample (local test)", status: "ready", created_at: t0, query: "plumbing", location: "Katy, TX", any_trade: true }]]);
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-l`, { id, campaign_id: camp, name: "Brazos Valley Plumbing", email: "shiftforge.ai+soc@gmail.com", is_test: true, created_at: t0, category: "Plumber", address: "1 Main St, Katy, TX 77494", website: "https://brazos.example", rating: 4.8, reviews_count: 210, gap_score: 70, owner_name: "Sam", contact_name: "Sam", owner_confidence: "high", social: { facebook: "https://facebook.com/brazosvalleyplumbing", instagram: "https://instagram.com/brazosvalleyplumbing", linkedin_person: "https://linkedin.com/in/sam-test" }, site_check: { checked_at: t0, via: "browser", facts: [], chat_widget: null, booking_tool: null, has_contact_form: true, request_form: true, form_plugin: null } }]]);
for (const ch of ["facebook", "instagram", "linkedin"]) {
  const r = await call("outreach.social.write", { campaign_id: camp, lead_ids: [id], channels: [ch], regenerate: true, type: "sequence", manual_start: true });
  if (!r.ok) { console.log(ch, "could not start:", r.error); continue; }
  await fetch(`${base}/.netlify/functions/ai-background`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ task: "social", params: r.data.params }) });
  for (let i = 0; i < 60; i++) { await new Promise((x) => setTimeout(x, 3000)); const c = (await call("outreach.campaign.get", { id: camp })).data; if (c?.job?.kind === "social" && c.job.status !== "running") { if (c.job.message || c.job.failures) console.log("job:", c.job.status, c.job.message ?? "", JSON.stringify(c.job.failures ?? "")); break; } }
  for (const row of (await call("outreach.social.list", { campaign_id: camp, lead_id: id })).data.filter((x) => x.channel === ch)) {
    console.log(`\n=== ${ch.toUpperCase()}  [record: ${row.review_status}]`);
    for (const p of row.parts) { console.log(`--- ${p.label}  [${p.review_status}]  (${p.text.length} chars, ${p.text.trim().split(/\s+/).length} words)`); console.log(p.text); if (p.review_reasons?.length) console.log("reasons:", p.review_reasons.join(" | ")); }
  }
}
console.log("\nNothing was sent anywhere.");
