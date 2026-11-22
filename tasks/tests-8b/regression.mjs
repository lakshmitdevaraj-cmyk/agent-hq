// Local-only regression: draft (generate) -> review -> ready -> send selected -> footer -> bounce handling, using the mock Gemini and
// mock AgentMail. Test leads with Lakshmi's own plus-addresses only; nothing real is sent. Usage: node tasks/tests-8b/regression.mjs
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
const mockLog = (process.env.TMPDIR || "/tmp") + "/mock-agentmail-requests.log";
const call = async (action, params = {}) => { const r = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) }); const j = await r.json(); return { status: r.status, ...j }; };
const bg = (task, params) => fetch(`${base}/.netlify/functions/ai-background`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ task, params }) });
let bad = 0;
const out = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const waitJob = async (camp, kind) => { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 3000)); const c = (await call("outreach.campaign.get", { id: camp })).data; if (c?.job?.kind === kind && ["done", "stopped", "paused"].includes(c.job.status)) return c.job; } return null; };
const stamp = Date.now().toString(36), camp = `reg-${stamp}`, t0 = "2026-11-20T10:00:00.000Z";
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Regression (local)", status: "ready", created_at: t0, query: "hvac", location: "Webster, TX", any_trade: true }]]);
const lead = (id, name, email) => ({ id, campaign_id: camp, name, email, is_test: true, created_at: t0, category: "HVAC contractor", address: "1 Main St, Webster, TX 77598", website: "https://reg-hvac.example", gap_score: 60, site_check: { checked_at: t0, via: "browser", facts: [] }, social: { facebook: `https://facebook.com/${id}` } });
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-r1`, lead(`r1-${stamp}`, "Regression Cooling", `shiftforge.ai+reg${stamp}a@gmail.com`)], [`${camp}/${t0}-r2`, lead(`r2-${stamp}`, "Regression Heating", `shiftforge.ai+reg${stamp}b@gmail.com`)]]);

// generate
const d = await call("outreach.draft.start", { campaign_id: camp });
out("generate: job recorded for 2 leads", d.ok && d.data.total === 2, JSON.stringify(d.data ?? d.error));
await bg("draft", { campaign_id: camp, sender_name: "Lakshmi", sender_company: "ShiftForge AI" });
const gj = await waitJob(camp, "generate");
const emails = (await call("outreach.emails.list", { campaign_id: camp })).data ?? [];
out("generate: 2 drafts written", gj?.status === "done" && emails.filter((e) => e.status === "drafted").length === 2, `job=${gj?.status} drafts=${emails.length} message=${gj?.message ?? ""}`);
// review
const r = await call("outreach.emails.review.start", { campaign_id: camp });
await bg("review", { campaign_id: camp });
const rj = await waitJob(camp, "review");
const reviewed = ((await call("outreach.emails.list", { campaign_id: camp })).data ?? []);
out("review: both drafts Ready", reviewed.length === 2 && reviewed.every((e) => e.review_status === "ready"), reviewed.map((e) => e.review_status).join(","));
// send selected
const ids = reviewed.map((e) => e.id);
const sent = await call("outreach.emails.send", { campaign_id: camp, email_ids: ids });
const log = fs.readFileSync(mockLog, "utf8").split("\n");
const bodies = log.filter((l) => l.startsWith("BODY ")).map((l) => JSON.parse(l.slice(5))).filter((b) => JSON.stringify(b).includes(`shiftforge.ai+reg${stamp}`));
out("send selected: 2 sends, to the test addresses only", bodies.length === 2 && bodies.every((b) => [].concat(b.to).every((a) => /^shiftforge\.ai\+reg[a-z0-9]+[ab]@gmail\.com$/.test(String(a).replace(/.*<|>.*/g, "")))), `to=${bodies.map((b) => JSON.stringify(b.to)).join(" ")} result=${JSON.stringify(sent.data ?? sent.error).slice(0, 100)}`);
const text = String(bodies[0]?.text ?? "");
out("footer added at send time (sign-off with name and company)", /Best,?\s*\n\s*Lakshmi/i.test(text) && /ShiftForge AI/.test(text), JSON.stringify(text.slice(-90)));
// bounce handling
const hook = (await call("webhook.create_typed", { name: "AgentMail regression", service: "agentmail" })).data;
const first = (await call("outreach.emails.list", { campaign_id: camp })).data.find((e) => e.status !== "drafted");
await fetch(`${base}/api/webhook/${hook.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event_type: "message.bounced", event_id: `bounce-${stamp}`, bounce: { message_id: first?.agentmail_message_id, type: "Permanent", recipients: [{ address: first?.to_email }] }, message: { message_id: first?.agentmail_message_id, inbox_id: "lakshmi@team.shiftforge.ai", to: [first?.to_email] } }) });
await new Promise((r) => setTimeout(r, 2500));
const after = (await call("outreach.emails.list", { campaign_id: camp })).data.find((e) => e.id === first?.id);
out("bounce: the email shows bounced", after?.status === "bounced", `status=${after?.status}`);
console.log(JSON.stringify({ camp }));
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
