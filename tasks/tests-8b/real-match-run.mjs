// Local store only; AgentMail is only READ. Seeds a stand-in Regal Electrolysis lead + sent email (thread id of the real reply), removes the unmatched local copy of the reply, then syncs twice.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const call = async (action, params = {}) => (await (await fetch("http://localhost:8890/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const THREAD = "e82c2878-45fd-4c08-b029-4a6710797952";
const t0 = "2026-11-21T18:00:00.000Z", camp = "camp-regal-local", lead = "lead-regal-local";
await call("data.import", { store: "agent-hq-outreach-campaigns", overwrite: true, records: [{ key: camp, value: JSON.stringify({ id: camp, name: "Regal local stand-in", status: "completed", created_at: t0, query: "electrolysis", location: "Houston, TX" }) }] });
await call("data.import", { store: "agent-hq-outreach-leads", overwrite: true, records: [{ key: `${camp}/${t0}-${lead}`, value: JSON.stringify({ id: lead, campaign_id: camp, name: "Regal Electrolysis", email: "santhana@regalelectrolysis.com", created_at: t0 }) }] });
await call("data.import", { store: "agent-hq-outreach-emails", overwrite: true, records: [{ key: `${camp}/email-regal-local`, value: JSON.stringify({ id: "email-regal-local", campaign_id: camp, lead_id: lead, to_email: "santhana@regalelectrolysis.com", status: "delivered", sent_at: t0, created_at: t0, agentmail_thread_id: THREAD, subject: "Calls on Monday to Thursday", body_text: "x" }) }] });
const before = ((await call("outreach.replies.list", { limit: 500 })).data ?? []).filter((r) => r.agentmail_thread_id === THREAD);
for (const r of before) console.log("delete old local copy", r.id, (await call("outreach.replies.delete", { id: r.id })).ok);
for (const run of [1, 2]) { const s = (await call("outreach.replies.sync", { days: 14 })).data ?? {}; console.log(`sync ${run}: added ${s.added}, flagged ${s.flagged}, already_have ${s.already_have}`); }
for (const r of ((await call("outreach.replies.list", { limit: 500 })).data ?? []).filter((r) => r.agentmail_thread_id === THREAD)) console.log(r.id, r.flag, "test:", r.is_test, "lead:", r.lead_id, "campaign:", r.campaign_id);
const c = ((await call("outreach.campaign.list")).data ?? []).find((x) => x.id === camp);
console.log("campaign replied counter:", c?.emails_replied ?? c?.counts?.replied ?? JSON.stringify(c).slice(0, 300));
const own = ((await call("outreach.replies.list", { limit: 500 })).data ?? []).filter((r) => /shiftforge\.ai@gmail|lakshmi_devaraj@yahoo/.test(r.from));
console.log("own-address replies:", own.length, "all test:", own.every((r) => r.is_test === true));
