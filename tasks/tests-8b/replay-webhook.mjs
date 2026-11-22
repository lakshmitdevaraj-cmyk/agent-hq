// Local-only: seeds a LOCAL sandbox (test campaign, test leads, sent emails) and POSTs copies of AgentMail events at the
// local webhook endpoint. Usage: node tasks/tests-8b/replay-webhook.mjs http://localhost:8890
// Prints no keys. Never talks to AgentMail or the live site.
const base = process.argv[2] || "http://localhost:8890";
let KEY = null;
async function api(action, params = {}) {
  const r = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { "X-API-Key": KEY } : {}) }, body: JSON.stringify({ action, params }) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(`${action}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data ?? j;
}
const out = (name, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

// sign in (first run claims the key; later runs reuse the one saved in the scratch file next to this script's TMP dir)
import fs from "node:fs";
const keyFile = (process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt";
if (fs.existsSync(keyFile)) KEY = fs.readFileSync(keyFile, "utf8").trim();
else { const b = await api("auth.bootstrap"); KEY = b.api_key; fs.writeFileSync(keyFile, KEY, { mode: 0o600 }); }

const hook = await api("webhook.create_typed", { name: "AgentMail events (test)", service: "agentmail" });
const stamp = Date.now().toString(36);
const camp = `camp-${stamp}`;
const t0 = "2026-11-22T01:00:00.000Z";
const people = [
  { key: "normal", lead: "Normal Reply HVAC", from: "tester.normal@example.net", ev: "message.received", labels: ["received", "unread"], text: "Thanks, tell me more about the call please." },
  { key: "unauth", lead: "Regal Electrolysis (test)", from: "Santhana Test <tester.santhana@example.net>", ev: "message.received.unauthenticated", labels: ["received", "unread", "unauthenticated"], text: "Got it", auth: { dkim: "none", dmarc: "none", spf: "none" } },
  { key: "spam", lead: "Spam Filed Plumbing", from: "tester.spam@example.net", ev: "message.received.spam", labels: ["received", "spam"], text: "Yes I am interested, call me." },
  { key: "blocked", lead: "Blocked Roofing", from: "tester.blocked@example.net", ev: "message.received.blocked", labels: ["received", "blocked"], text: "Sounds good." },
  { key: "optout", lead: "Optout Landscaping", from: "tester.optout@example.net", ev: "message.received.unauthenticated", labels: ["received", "unauthenticated"], text: "No thanks, please do not email me again.", auth: { dkim: "none" } },
  { key: "own", lead: "Own Test Lead", from: "shiftforge.ai+owntest@gmail.com", ev: "message.received", labels: ["received"], text: "test reply from me" },
];
const mk = (k, rows) => rows.map((v, i) => ({ key: k(i), value: JSON.stringify(v) }));
await api("data.import", { store: "agent-hq-outreach-campaigns", overwrite: true, records: [{ key: camp, value: JSON.stringify({ id: camp, name: "Webster test (local)", status: "completed", created_at: t0, query: "hvac", location: "Webster, TX" }) }] });
await api("data.import", { store: "agent-hq-outreach-settings", overwrite: true, records: [{ key: "settings", value: JSON.stringify({ reply_alert_email: "shiftforge.ai@gmail.com", sending_inbox_id: "lakshmi@team.shiftforge.ai" }) }] });
const leads = people.map((p, i) => ({ id: `lead-${stamp}-${p.key}`, campaign_id: camp, name: p.lead, email: p.from.replace(/.*<|>.*/g, ""), is_test: true, created_at: `2026-11-22T01:0${i}:00.000Z` }));
await api("data.import", { store: "agent-hq-outreach-leads", overwrite: true, records: leads.map((l) => ({ key: `${camp}/${l.created_at}-${l.id}`, value: JSON.stringify(l) })) });
const emails = people.map((p, i) => ({ id: `email-${stamp}-${p.key}`, campaign_id: camp, lead_id: leads[i].id, to_email: leads[i].email, to_name: p.lead, status: "delivered", sent_at: t0, created_at: t0, agentmail_message_id: `sent-${stamp}-${p.key}`, agentmail_thread_id: `thread-${stamp}-${p.key}`, agentmail_inbox_id: "lakshmi@team.shiftforge.ai", subject: "hello", body_text: "hi" }));
await api("data.import", { store: "agent-hq-outreach-emails", overwrite: true, records: emails.map((e) => ({ key: `${camp}/${e.id}`, value: JSON.stringify(e) })) });

async function post(p, i, dupe = false) {
  const body = { event_type: p.ev, event_id: `evt-${stamp}-${p.key}`, message: { message_id: `in-${stamp}-${p.key}`, thread_id: `thread-${stamp}-${p.key}`, inbox_id: "lakshmi@team.shiftforge.ai", from: p.from, to: ["lakshmi@team.shiftforge.ai"], subject: "Re: hello", text: p.text, timestamp: `2026-11-22T02:0${i}:00.000Z`, labels: p.labels, ...(p.auth ? { authentication_results: p.auth } : {}) } };
  const r = await fetch(`${base}/api/webhook/${hook.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.status;
}
for (const [i, p] of people.entries()) out(`POST ${p.ev} (${p.key})`, (await post(p, i)) === 200);
out("POST duplicate of the unauthenticated event", (await post(people[1], 1)) === 200);

const replies = (await api("outreach.replies.list", { campaign_id: camp, limit: 50 }));
const by = (k) => replies.find((r) => r.agentmail_message_id === `in-${stamp}-${k}`);
out("6 distinct replies stored (duplicate stored once)", replies.length === 6, `count=${replies.length}`);
out("normal reply: no flag, matched to its lead", by("normal")?.flag === null && by("normal")?.lead_id === leads[0].id);
out("unauthenticated: flag + auth results saved, matched to lead", by("unauth")?.flag === "unauthenticated" && by("unauth")?.authentication_results?.dkim === "none" && by("unauth")?.lead_id === leads[1].id);
out("spam flag", by("spam")?.flag === "spam");
out("blocked flag", by("blocked")?.flag === "blocked");
out("opt-out sent as unauthenticated: flagged AND opt_out", by("optout")?.flag === "unauthenticated" && by("optout")?.opt_out === true);
out("own address reply marked test", by("own")?.is_test === true);

const prospects = await api("outreach.prospects.list");
const lead = (k) => prospects.find((p) => p.id === `lead-${stamp}-${k}`);
out("opt-out lead is do-not-contact", lead("optout")?.email_status === "do_not_contact");
out("normal lead shows replied", lead("normal")?.email_status === "replied");
out("own test lead does NOT show replied", lead("own")?.email_status !== "replied");
const c = await api("outreach.campaign.get", { id: camp });
out("campaign replied counter = 5 real replies (own test excluded)", c.emails_replied === 5, `emails_replied=${c.emails_replied}`);
console.log(JSON.stringify({ campaign_id: camp, webhook_id: hook.id, replies: replies.map((r) => ({ from: r.from, flag: r.flag, test: r.is_test, optout: r.opt_out })) }, null, 1));
