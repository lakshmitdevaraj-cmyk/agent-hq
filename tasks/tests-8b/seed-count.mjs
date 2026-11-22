// Local-only: a campaign with two NON-test leads (one with an email, one without), both with a Facebook page, for the "Write social messages (N)" count.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
const api = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const camp = "count-local", t0 = "2026-11-10T10:00:00.000Z";
const imp = (store, rows) => api("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Count test (local)", status: "completed", created_at: t0, query: "hvac", location: "Webster, TX" }]]);
const lead = (id, name, email) => ({ id, campaign_id: camp, name, email, created_at: t0, category: "HVAC contractor", address: "1 Main St, Webster, TX 77598", website: "https://real-hvac.example", gap_score: 60, site_check: { checked_at: t0, via: "browser", facts: [] }, social: { facebook: `https://facebook.com/${id}` } });
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-c1`, lead("c1", "Has Email Cooling", "owner@hasemail-cooling.com")], [`${camp}/${t0}-c2`, lead("c2", "No Email Heating", null)]]);
console.log("seeded", camp);
