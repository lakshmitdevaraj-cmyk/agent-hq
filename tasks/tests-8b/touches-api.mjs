// Local-only API check of contact history, mark sent / undo / record by hand, plan and Facebook-checked marks.
// Usage: node tasks/tests-8b/touches-api.mjs http://localhost:8890   (seeds test data in the LOCAL sandbox only; no AI calls, no sends)
import fs from "node:fs";
const base = process.argv[2] || "http://localhost:8890";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
async function api(action, params = {}, allowFail = false) {
  const r = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) });
  const j = await r.json();
  if (!allowFail && (!r.ok || j.ok === false)) throw new Error(`${action}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return allowFail ? { status: r.status, ...j } : (j.data ?? j);
}
let bad = 0;
const out = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const stamp = Date.now().toString(36);
const camp = `tc-${stamp}`, L1 = `l1-${stamp}`, L2 = `l2-${stamp}`;
const t0 = "2026-11-10T10:00:00.000Z";
const setup = async (store, rows) => api("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
await setup("agent-hq-outreach-campaigns", [[camp, { id: camp, name: "Touch test (local)", status: "completed", created_at: t0, query: "hvac", location: "Webster, TX" }]]);
const lead = (id, name, extra) => ({ id, campaign_id: camp, name, is_test: true, created_at: t0, category: "HVAC contractor", address: "1 Main St, Webster, TX 77598", website: "https://x.example", gap_score: 60, site_check: { checked_at: t0, via: "browser", facts: [] }, social: { facebook: `https://facebook.com/${id}` }, ...extra });
await setup("agent-hq-outreach-leads", [[`${camp}/${t0}-${L1}`, lead(L1, "Emailed Then Facebook HVAC", { email: "tester.one@example.net" })], [`${camp}/${t0}-${L2}`, lead(L2, "No Email Plumbing", { email: null })]]);
await setup("agent-hq-outreach-emails", [[`${camp}/e1`, { id: "e1", campaign_id: camp, lead_id: L1, to_email: "tester.one@example.net", status: "delivered", sequence_position: 1, subject: "hello", body_text: "first email body", sent_at: "2026-11-12T15:00:00.000Z", created_at: t0 }]]);
const rec = (lead_id, over = {}) => ({ id: `${lead_id}-facebook`, campaign_id: camp, lead_id, channel: "facebook", url: `https://facebook.com/${lead_id}`, parts: [{ key: "message", label: "Message", text: "Hi there, a first message." }], status: "drafted", review_status: "ready", review_reasons: [], reviewed_by: "x", rewrites_used: 0, fact_used: null, draft_facts: [], angle: "x", written_by: "x", created_at: t0, updated_at: t0, sent_at: null, type: "first", ...over });
await setup("agent-hq-outreach-social", [[`${camp}/${L1}/facebook`, rec(L1)]]);

let st = await api("outreach.lead.touches", { campaign_id: camp, lead_id: L1 });
out("derived: the sent email is one touch (Email x1)", st.touches.length === 1 && st.summary.counts.email === 1);

const bad1 = await api("outreach.social.mark_sent", { campaign_id: camp, lead_id: L1, channel: "facebook", sent_on: "2999-01-01" }, true);
out("a future date is refused", bad1.status === 400);
const m = await api("outreach.social.mark_sent", { campaign_id: camp, lead_id: L1, channel: "facebook", sent_on: "2026-11-14" });
out("mark sent on an earlier day: touch added, Facebook x1", m.summary.counts.facebook === 1 && m.summary.counts.email === 1 && m.touches.some((t) => t.channel === "facebook" && t.sent_at.startsWith("2026-11-14") && t.kind === "first"));
out("last touch is the newest date", m.summary.last_at.startsWith("2026-11-14"));
const slot = await api("outreach.social.list", { campaign_id: camp, lead_id: L1 });
out("draft slot is cleared after marking sent", slot.length === 0);

const plan = await api("outreach.social.plan", { leads: [{ campaign_id: camp, lead_id: L1 }, { campaign_id: camp, lead_id: L2 }], channels: ["facebook"] });
out("plan: both leads qualify (emailed or not); the Facebook follow-up counts", plan.total === 2 && plan.by_channel.facebook === 2, JSON.stringify(plan));

// undo restores the draft
const un = await api("outreach.social.mark_sent", { campaign_id: camp, lead_id: L1, channel: "facebook", sent: false, touch_id: m.touch_id });
out("undo: Facebook x0 again, draft restored", un.summary.counts.facebook === 0 && un.restored === true);
const slot2 = await api("outreach.social.list", { campaign_id: camp, lead_id: L1 });
out("restored draft is a drafted message with its text", slot2.length === 1 && slot2[0].status === "drafted" && /first message/.test(slot2[0].parts[0].text));

// record by hand
const h = await api("outreach.social.record_hand", { campaign_id: camp, lead_id: L2, channel: "facebook", text: "Hi, I messaged you on Facebook last week.", sent_on: "2026-11-20" });
out("record by hand: touch with source manual", h.touches.length === 1 && h.touches[0].source === "manual" && h.touches[0].channel === "facebook");
const h2 = await api("outreach.social.record_hand", { campaign_id: camp, lead_id: L2, channel: "facebook", text: "Second nudge.", sent_on: "2026-11-21" });
out("a second message on the same channel is a follow-up", h2.touches.some((t) => t.kind === "follow_up"));
const empty = await api("outreach.social.record_hand", { campaign_id: camp, lead_id: L2, channel: "facebook", text: "  " }, true);
out("empty text is refused", empty.status === 400);

// follow-up planning after a sent message
const plan2 = await api("outreach.social.plan", { leads: [{ campaign_id: camp, lead_id: L2 }], channels: ["facebook"] });
out("plan after a sent Facebook message: follow-up (no first-touch duplicate skip)", plan2.total === 1);
const planE = await api("outreach.social.plan", { leads: [{ campaign_id: camp, lead_id: L2 }], channels: ["facebook"], type: "follow_up_email" });
out("'mention my email' is skipped for a lead with no email sent", planE.total === 0 && Object.keys(planE.skip_reasons).some((k) => /No email has been sent/.test(k)), JSON.stringify(planE.skip_reasons));

// Facebook checked
const fc = await api("outreach.lead.fb_checked", { campaign_id: camp, lead_id: L2, result: "gone", note: "page deleted" });
out("Facebook checked: result and date saved", fc.fb_checked.result === "gone" && !!fc.fb_checked.at);
const pr = await api("outreach.prospects.list");
const p1 = pr.find((p) => p.id === L1), p2 = pr.find((p) => p.id === L2);
out("prospects.list: touches summary, draft list and fb mark", p1.touches.counts.email === 1 && p1.social_drafts.length === 1 && p2.touches.counts.facebook === 2 && p2.fb_checked?.result === "gone");
const bad2 = await api("outreach.lead.fb_checked", { campaign_id: camp, lead_id: L2, result: "maybe" }, true);
out("an unknown result is refused", bad2.status === 400);
const clr = await api("outreach.lead.fb_checked", { campaign_id: camp, lead_id: L2, result: null });
out("clearing the mark", clr.fb_checked === null);

// Two emails + two Facebook messages on one lead, kept in order; a legacy "sent" Facebook message carries over
const L3 = `l3-${stamp}`;
await setup("agent-hq-outreach-leads", [[`${camp}/${t0}-${L3}`, lead(L3, "Two And Two Heating", { email: "owner@twoandtwo-heating.com" })]]);
await setup("agent-hq-outreach-emails", [
  [`${camp}/e3a`, { id: "e3a", campaign_id: camp, lead_id: L3, to_email: "owner@twoandtwo-heating.com", status: "delivered", sequence_position: 1, subject: "first", body_text: "email one", sent_at: "2026-11-05T15:00:00.000Z", created_at: t0 }],
  [`${camp}/e3b`, { id: "e3b", campaign_id: camp, lead_id: L3, to_email: "owner@twoandtwo-heating.com", status: "delivered", sequence_position: 2, subject: "second", body_text: "email two", sent_at: "2026-11-15T15:00:00.000Z", created_at: t0 }],
]);
await setup("agent-hq-outreach-social", [[`${camp}/${L3}/facebook`, rec(L3, { status: "sent", sent_at: "2026-11-22T09:30:00.000Z", parts: [{ key: "message", label: "Message", text: "Legacy message marked sent on 22 Nov." }] })]]);
const h3 = await api("outreach.social.record_hand", { campaign_id: camp, lead_id: L3, channel: "facebook", text: "Earlier Facebook note.", sent_on: "2026-11-08" });
out("legacy sent Facebook message (22 Nov) still shows, once", h3.touches.filter((t) => /Legacy message/.test(t.text)).length === 1);
out("2 emails + 2 Facebook messages, all kept, in date order", h3.touches.map((t) => t.channel + ":" + t.sent_at.slice(5, 10)).join(",") === "email:11-05,facebook:11-08,email:11-15,facebook:11-22", h3.touches.map((t) => t.channel + ":" + t.sent_at.slice(5, 10)).join(","));
out("summary: Email x2, Facebook x2, last 22 Nov", h3.summary.counts.email === 2 && h3.summary.counts.facebook === 2 && h3.summary.last_at.startsWith("2026-11-22"));

// reply stops social planning
await setup("agent-hq-outreach-replies", [[`r-${stamp}`, { id: `r-${stamp}`, campaign_id: camp, lead_id: L1, original_email_id: "e1", from: "tester.one@example.net", is_test: false, received_at: t0, agentmail_message_id: `m-${stamp}` }]]);
const plan3 = await api("outreach.social.plan", { leads: [{ campaign_id: camp, lead_id: L1 }], channels: ["facebook"], regenerate: true });
out("a lead that replied is skipped (Already replied)", plan3.total === 0 && Object.keys(plan3.skip_reasons).some((k) => /replied/i.test(k)), JSON.stringify(plan3.skip_reasons));
console.log(JSON.stringify({ campaign_id: camp, leads: [L1, L2] }));
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
