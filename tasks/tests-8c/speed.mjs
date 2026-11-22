// Times the heavy reads against the LOCAL sandbox with ~400 seeded test leads (3 emails each for 100 of them). Usage: node tasks/tests-8c/speed.mjs [seed]
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = "http://localhost:8890";
const call = async (action, params = {}) => { const t = Date.now(); const r = await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json(); return { r, ms: Date.now() - t }; };
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
const camp = "speed-test-8c", t0 = "2026-11-10T10:00:00.000Z";
if (process.argv[2] === "seed") {
  await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Speed test (local)", status: "ready", created_at: t0, query: "plumbing", location: "Katy, TX" }]]);
  const leads = Array.from({ length: 400 }, (_, i) => [`${camp}/${t0}-${i}`, { id: `sp${i}`, campaign_id: camp, name: `Speed Lead ${i}`, email: `shiftforge.ai+sp${i}@gmail.com`, is_test: true, created_at: t0, category: "Plumber", address: "1 Main St, Katy, TX 77494", website: `https://sp${i}.example`, rating: 4.5, reviews_count: 40 + i, gap_score: 60, site_check: { checked_at: t0, facts: [] }, social: i % 3 ? {} : { facebook: `https://facebook.com/sp${i}` } }]);
  for (let i = 0; i < leads.length; i += 100) await imp("agent-hq-outreach-leads", leads.slice(i, i + 100));
  const em = []; for (let i = 0; i < 100; i++) for (let p = 1; p <= 3; p++) em.push([`${camp}/2026-11-10T10:00:0${p}.${String(i).padStart(3, "0")}Z-e${i}-${p}`, { id: `e${i}-${p}`, campaign_id: camp, lead_id: `sp${i}`, to_email: `shiftforge.ai+sp${i}@gmail.com`, subject: "calls", body_text: "x".repeat(300), status: p === 1 ? "sent" : "drafted", sent_at: p === 1 ? t0 : undefined, framework: "three-step", sequence_position: p, sequence_total: 3, review_status: "ready", created_at: `2026-11-10T10:00:0${p}.${String(i).padStart(3, "0")}Z` }]);
  for (let i = 0; i < em.length; i += 100) await imp("agent-hq-outreach-emails", em.slice(i, i + 100));
  console.log("seeded 400 leads, 300 emails");
}
for (const [label, action, params] of [["campaign.get", "outreach.campaign.get", { id: camp }], ["prospects.list", "outreach.prospects.list", {}], ["leads.list", "outreach.leads.list", { campaign_id: camp }], ["emails.list", "outreach.emails.list", { campaign_id: camp }], ["followups.list", "followups.list", {}], ["replies.list", "outreach.replies.list", { limit: 200 }]]) {
  const t = []; for (let i = 0; i < 3; i++) t.push((await call(action, params)).ms);
  console.log(label.padEnd(16), t.join(" / "), "ms (3 runs)");
}
