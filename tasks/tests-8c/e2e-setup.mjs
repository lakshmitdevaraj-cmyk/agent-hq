// Creates ONE local campaign with TWO test leads (own plus-addresses, with real facts) and no drafts, for the browser end-to-end test.
// Usage: node tasks/tests-8c/e2e-setup.mjs   -> prints the campaign id.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = "http://localhost:8890";
const call = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
const stamp = Date.now().toString(36), t0 = new Date().toISOString();
const camp = `e2e-${stamp}`;
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: `End-to-end test (local, 2 test leads)`, status: "draft", created_at: t0, query: "plumbing", location: "Katy, TX", any_trade: true, default_sender_name: "Lakshmi Devaraj" }]]);
const lead = (id, name, extra = {}) => ({ id, campaign_id: camp, name, email: `shiftforge.ai+${id}@gmail.com`, is_test: true, created_at: t0, category: "Plumber", address: "1 Main St, Katy, TX 77494", website: `https://${id}.example`, rating: 4.8, reviews_count: 210, gap_score: 70, site_check: { checked_at: t0, via: "browser", facts: [], chat_widget: null, booking_tool: null, has_contact_form: true, request_form: true, form_plugin: null }, social: {}, ...extra });
const A = `ea${stamp}`, B = `eb${stamp}`;
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-a`, lead(A, "Brazos Valley Plumbing", { contact_name: "Sam", owner_name: "Sam", owner_confidence: "high", owner_source: "website" })], [`${camp}/${t0}-b`, lead(B, "Katy Rooter Pros", { rating: 4.6, reviews_count: 88 })]]);
console.log(JSON.stringify({ camp, A, B }));
