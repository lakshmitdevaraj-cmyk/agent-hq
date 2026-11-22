// Local-only small checks: clear an email, Settings save (merge-only), Inbox delete. Sends nothing.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
const call = async (action, params = {}) => { const r = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) }); const j = await r.json(); return { status: r.status, ...j }; };
let bad = 0;
const out = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
// clear an email: lead keeps everything else, its unsent draft is removed, sent history stays
const camp = "clear-local", t0 = "2026-11-10T10:00:00.000Z";
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Clear test (local)", status: "ready", created_at: t0, query: "hvac", location: "Webster, TX" }]]);
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-z1`, { id: "z1", campaign_id: camp, name: "Placeholder Email HVAC", email: "filler@godaddy.com", website: "https://real-hvac.example", created_at: t0, is_test: true }]]);
await imp("agent-hq-outreach-emails", [[`${camp}/zd`, { id: "zd", campaign_id: camp, lead_id: "z1", to_email: "filler@godaddy.com", status: "drafted", subject: "x", body_text: "y", created_at: t0 }], [`${camp}/zs`, { id: "zs", campaign_id: camp, lead_id: "z1", to_email: "filler@godaddy.com", status: "delivered", subject: "old", body_text: "old", sent_at: t0, created_at: t0 }]]);
const bad1 = await call("outreach.lead.set_email", { campaign_id: camp, lead_id: "z1", email: "yourname@example.org" });
out("placeholder yourname@example.org is rejected", bad1.status === 400, bad1.error);
const bad2 = await call("outreach.lead.set_email", { campaign_id: camp, lead_id: "z1", email: "filler@godaddy.com" });
out("placeholder filler@godaddy.com is rejected", bad2.status === 400, bad2.error);
const clr = await call("outreach.lead.set_email", { campaign_id: camp, lead_id: "z1", email: "" });
const left = (await call("outreach.emails.list", { campaign_id: camp })).data ?? [];
const lead = ((await call("outreach.leads.list", { campaign_id: camp })).data ?? []).find((l) => l.id === "z1");
out("clear email: address removed, lead kept, unsent draft removed, sent email kept", clr.ok && lead && !lead.email && lead.name === "Placeholder Email HVAC" && left.length === 1 && left[0].id === "zs", JSON.stringify({ drafts_removed: clr.data?.drafts_removed, emails_left: left.map((e) => e.id) }));
// Settings save only changes what was sent
const before = (await call("outreach.settings.get")).data;
const keep = before.default_sender_company;
const s1 = await call("outreach.settings.set", { default_sender_name: "Lakshmi (batch 8b check)" });
const after = (await call("outreach.settings.get")).data;
out("Settings save changes only the field sent", s1.ok && after.default_sender_name === "Lakshmi (batch 8b check)" && after.default_sender_company === keep, `company kept=${after.default_sender_company === keep}`);
await call("outreach.settings.set", { default_sender_name: before.default_sender_name ?? "" });
// Inbox delete
await imp("agent-hq-outreach-replies", [["del-1", { id: "del-1", campaign_id: null, lead_id: null, from: "x@example.net", subject: "Re: x", text: "t", received_at: t0, agentmail_message_id: "del-msg-1", is_test: false }]]);
const d = await call("outreach.replies.delete", { id: "del-1" });
const list = (await call("outreach.replies.list", { limit: 200 })).data ?? [];
out("Inbox delete removes the reply", d.ok && !list.some((r) => r.id === "del-1"));
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
