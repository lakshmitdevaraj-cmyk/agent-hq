// Writes THREE social messages for TEST leads only and prints them in full. Nothing is sent: messages are only written, and the first
// Facebook message is "marked as sent" by hand in the LOCAL store so the follow-up can be written after it. The "sent email" is a record
// written straight into the local store (no email goes anywhere). Uses whatever Gemini key is in local Settings (real or the mock).
// Usage: node tasks/tests-8b/real-social.mjs [baseUrl]
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
if (!/^http:\/\/localhost[:/]/.test(base)) throw new Error("local only");
const call = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const bg = (task, params) => fetch(`${base}/.netlify/functions/ai-background`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ task, params }) });
const waitJob = async (camp) => { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 3000)); const c = (await call("outreach.campaign.get", { id: camp })).data; if (c?.job?.kind === "social" && ["done", "failed", "error", "paused"].includes(c.job.status)) return c.job; } return null; };
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
const stamp = Date.now().toString(36), camp = `soc-${stamp}`, t0 = "2026-11-10T10:00:00.000Z";
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Social wording test (local)", status: "ready", created_at: t0, query: "hvac", location: "Webster, TX", any_trade: true }]]);
const lead = (id, name, extra = {}) => ({ id, campaign_id: camp, name, owner_name: null, email: null, is_test: true, created_at: t0, category: "HVAC contractor", address: "1 Main St, Webster, TX 77598", website: `https://${id}.example`, rating: 4.8, reviews_count: 61, gap_score: 70, site_check: { checked_at: t0, via: "browser", facts: [] }, social: { facebook: `https://facebook.com/${id}`, instagram: null, linkedin: null, whatsapp: null }, ...extra });
const A = `a-${stamp}`, B = `b-${stamp}`;
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-a`, lead(A, "Bayou City Heating & Air")], [`${camp}/${t0}-b`, lead(B, "Gulf Coast Cooling", { email: `shiftforge.ai+soc${stamp}@gmail.com` })]]);
// Lead B already got an email (a record in the local store only; nothing is sent).
await imp("agent-hq-outreach-emails", [[`${camp}/${B}-1`, { id: `em-${stamp}`, campaign_id: camp, lead_id: B, to: `shiftforge.ai+soc${stamp}@gmail.com`, status: "sent", sent_at: "2026-11-18T15:00:00.000Z", created_at: "2026-11-18T14:00:00.000Z", sequence_position: 1, subject: "Missed calls at Gulf Coast Cooling", body_text: "Hi there,\n\nWhen the crew is on a roof the phone keeps ringing. An assistant can answer and pass you the details. Open to a 30-minute free call?" }]]);
const write = async (lead_id, type, regenerate = false) => {
  const w = await call("outreach.social.write", { campaign_id: camp, lead_id, channels: ["facebook"], type, regenerate, manual_start: true });
  if (!w.ok) throw new Error(`write failed: ${w.error}`);
  await bg("social", w.data.params);
  const j = await waitJob(camp);
  if (!j || j.status !== "done") throw new Error(`job ended as ${j?.status ?? "timeout"}: ${j?.message ?? ""}`);
  const rec = ((await call("outreach.social.list", { campaign_id: camp })).data ?? []).find((r) => r.lead_id === lead_id && r.channel === "facebook");
  return rec;
};
const show = (title, rec) => { console.log(`\n=== ${title} (type: ${rec.type}) ===`); for (const p of rec.parts) console.log(p.text); console.log(); };
const first = await write(A, "first"); show("1. Facebook first message, Bayou City Heating & Air", first);
const ms = await call("outreach.social.mark_sent", { campaign_id: camp, lead_id: A, channel: "facebook", sent: true, sent_on: "2026-11-15" });
if (!ms.ok) throw new Error("mark_sent failed: " + ms.error);
const fu = await write(A, undefined); show("2. Facebook follow-up after it (marked sent 15 Nov by hand)", fu);
const fe = await write(B, "follow_up_email"); show('3. "Follow-up (mention my email)", Gulf Coast Cooling (email sent 18 Nov: "Missed calls at Gulf Coast Cooling")', fe);
console.log("Nothing was sent anywhere. Campaign (local only):", camp);
