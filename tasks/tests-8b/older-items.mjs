// Local-only checks of three older fixes: a setting changed while a job runs is not overwritten, campaign cards show the right lead count,
// and a draft for an excluded lead is never sent. Needs the mock Gemini and mock AgentMail (see mock-*.mjs). Sends nothing real.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
const call = async (action, params = {}) => { const r = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) }); const j = await r.json(); return { status: r.status, ...j }; };
let bad = 0;
const out = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const camp = "count-local";

// 1. setting vs running job
await call("outreach.campaign.update", { id: camp, name: "Count test (local)", any_trade: false });
const w = await call("outreach.social.write", { campaign_id: camp, lead_ids: ["c1", "c2"], regenerate: true });
await fetch(`${base}/.netlify/functions/ai-background`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ task: "social", params: w.data.params }) });
await new Promise((r) => setTimeout(r, 2500));
await call("outreach.campaign.update", { id: camp, any_trade: true, name: "Renamed while the job runs" });
let done = false;
for (let i = 0; i < 20 && !done; i++) { await new Promise((r) => setTimeout(r, 3000)); const c = await call("outreach.campaign.get", { id: camp }); done = c.data?.job?.status === "done"; }
const c1 = (await call("outreach.campaign.get", { id: camp })).data;
out("job finished", done);
out("a setting changed while the job ran is still there afterwards", c1.any_trade === true && c1.name === "Renamed while the job runs", `any_trade=${c1.any_trade} name=${c1.name}`);
await call("outreach.campaign.update", { id: camp, name: "Count test (local)", any_trade: false });

// 2. campaign card lead counts
const list = await call("outreach.campaign.list");
const row = (list.data ?? []).find((c) => c.id === camp);
out("campaign card shows the right lead count (2 leads)", row && (row.lead_count === 2 || row.leads_imported === 2), JSON.stringify({ lead_count: row?.lead_count, leads_imported: row?.leads_imported }));

// 3. excluded lead's draft is not sent
const t0 = "2026-11-10T10:00:00.000Z";
await call("data.import", { store: "agent-hq-outreach-emails", overwrite: true, records: [{ key: `${camp}/ex1`, value: JSON.stringify({ id: "ex1", campaign_id: camp, lead_id: "c2", to_email: "owner@noemail-heating.com", to_name: "No Email Heating", subject: "hi", body_text: "hello", body_html: "<p>hello</p>", status: "drafted", review_status: "ready", sequence_position: 1, created_at: t0 }) }] });
await call("outreach.leads.update", { campaign_id: camp, lead_id: "c2", excluded: true, excluded_reason: "other" });
const before = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/mock-agentmail-requests.log", "utf8").split("\n").filter((l) => l.startsWith("POST")).length;
const s = await call("outreach.emails.send", { campaign_id: camp, email_ids: ["ex1"] });
const after = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/mock-agentmail-requests.log", "utf8").split("\n").filter((l) => l.startsWith("POST")).length;
out("a draft for an excluded lead is not sent (no send request reached AgentMail)", after === before, `sent=${s.data?.sent ?? JSON.stringify(s).slice(0, 120)}`);
await call("outreach.leads.update", { campaign_id: camp, lead_id: "c2", excluded: false });
await call("outreach.emails.delete", { campaign_id: camp, email_id: "ex1" });
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
