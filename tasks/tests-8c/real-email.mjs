// Writes the Alcance 3-step emails (and, for comparison, one PAS sequence) for TEST leads only and prints every text in full with its
// review status. Nothing is sent: drafts are only written to the LOCAL store. Uses whatever Gemini key is in local Settings.
// Usage: node tasks/tests-8c/real-email.mjs [baseUrl]
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const base = process.argv[2] || "http://localhost:8890";
if (!/^http:\/\/localhost[:/]/.test(base)) throw new Error("local only");
const call = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
const stamp = Date.now().toString(36), t0 = "2026-11-10T10:00:00.000Z";
const mk = async (suffix, name, fw) => {
  const camp = `em-${suffix}-${fw}-${stamp}`;
  await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: `${name} (${fw}, local test)`, status: "ready", created_at: t0, query: "plumbing", location: "Katy, TX", any_trade: true }]]);
  return camp;
};
const lead = (camp, id, name, extra = {}) => ({ id, campaign_id: camp, name, email: `shiftforge.ai+${id}@gmail.com`, is_test: true, created_at: t0, category: "Plumber", address: "1 Main St, Katy, TX 77494", website: `https://${id}.example`, rating: 4.8, reviews_count: 210, gap_score: 70, site_check: { checked_at: t0, via: "browser", facts: [], chat_widget: null, booking_tool: null, has_contact_form: true, request_form: true, form_plugin: null }, social: {}, ...extra });
const LEADS = [
  { id: `own${stamp}`, name: "Brazos Valley Plumbing", extra: { contact_name: "Sam", owner_name: "Sam", owner_confidence: "high", owner_source: "website" } },
  { id: `noo${stamp}`, name: "Katy Rooter Pros", extra: { rating: 4.6, reviews_count: 88 } },
];
const show = (title, r) => { console.log(`\n--- ${title}  [review: ${r.review_status}]`); console.log(`subject: ${r.subject}`); console.log(r.body_text); if (r.review_reasons?.length) console.log("reasons:", r.review_reasons.join(" | ")); };
const bg = (task, params) => fetch(`${base}/.netlify/functions/ai-background`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ task, params }) });
const waitJob = async (camp) => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 3000)); const c = (await call("outreach.campaign.get", { id: camp })).data; if (c?.job?.kind === "generate" && ["done", "stopped", "failed", "paused"].includes(c.job.status)) return c.job; } return null; };
const run = async (fw, ld, label) => {
  const camp = await mk(ld.id.slice(0, 3), ld.name, fw);
  const L = lead(camp, ld.id, ld.name, ld.extra);
  await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-x`, L]]);
  const params = { campaign_id: camp, framework: fw, sender_name: "Lakshmi Devaraj", sender_company: "ShiftForge AI", sender_offer: "We set up an AI assistant that answers calls and website messages for home-service businesses, takes the details and passes them to the owner.", leads: [L] };
  const st = await call("outreach.draft.start", params);
  if (!st.ok) { console.log(`\n${label} could not start: ${st.error}`); return; }
  await bg("draft", params);
  const job = await waitJob(camp);
  if (!job || job.status !== "done") console.log(`\n${label}: job ended as ${job?.status ?? "timeout"} ${job?.message ?? ""} ${JSON.stringify(job?.failures ?? "")}`);
  const rows = ((await call("outreach.emails.list", { campaign_id: camp })).data ?? []).filter((r) => r.lead_id === ld.id).sort((a, b) => (a.sequence_position ?? 1) - (b.sequence_position ?? 1));
  for (const r of rows) show(`${label}, email ${r.sequence_position}`, r);
  if (rows.length === 0) console.log(`\n${label}: no emails were written`);
};
await run("three-step", LEADS[0], "Alcance 3-step, lead WITH owner name (Sam)");
await run("three-step", LEADS[1], "Alcance 3-step, lead WITHOUT owner name");
if (process.argv[3] !== "skip-pas") await run("pas", LEADS[0], "PAS (current prompts, unchanged), same first lead");
console.log("\nNothing was sent anywhere.");
