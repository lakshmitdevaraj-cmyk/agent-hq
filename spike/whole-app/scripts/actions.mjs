// One request recipe per command action and per other handler. `i` is the call number (0 = warm-up), so writes hit fresh records.
// kind: read | write. reset: reseed the dataset first. sweep: always measure every size. heavy: run last, with rests.
import { apiKey } from "../db/seed-kv.mjs";

const R = (params, extra = {}) => ({ kind: "read", params, ...extra });
const W = (params, extra = {}) => ({ kind: "write", params, ...extra });
const cid = "cbig";
const l = (i) => `l${i + 1}`; // unsent drafts exist for every lead (at least step 4)
const social = (i) => `l${(i + 1) * 5}`;
const draftId = (i) => `e-l${i + 1}-4`;
const emailTo = (i) => `edited${i}@fake.example.test`;
const cnewLeads = ["n1", "n2", "n3"];

export const ACTIONS = {
  "auth.bootstrap": R({}, { expect: 403 }),
  "auth.rotate": W({ confirm: false }, { expect: 400, note: "refusal path only: rotating would invalidate the test key" }),
  "data.counts": R({}, { sweep: true }),
  "data.export": R({ store: "agent-hq-outreach-emails" }, { sweep: true, note: "one page (100 records)" }),
  "data.import": W((i) => ({ store: "agent-hq-outreach-leads", overwrite: true, records: Array.from({ length: 100 }, (_, n) => ({ key: `cimp/x${i}-${n}`, value: JSON.stringify({ id: `x${i}-${n}`, campaign_id: "cimp", name: "Imported", pad: "x".repeat(3000) }) })) }), { note: "100 records per call" }),
  "agent.register": W((i) => ({ name: `Spike agent ${i}`, sign_in_name: `spike${i}`, role: "helper" })),
  "agent.list": R({}),
  "agent.heartbeat": W({ agent_id: "a1" }),
  "agent.delete": W((i) => ({ id: `a${i + 2}` })),
  "task.create": W((i) => ({ title: `Spike task ${i}` })),
  "task.list": R({}),
  "task.move": W((i) => ({ id: `t${i + 1}`, status: "doing" })),
  "task.delete": W((i) => ({ id: `t${i + 10}` })),
  "activity.log": W({ category: "system", summary: "spike" }),
  "activity.list": R({}, { sweep: true }),
  "form.create": W((i) => ({ slug: `spike-${i}`, title: "Spike", fields: [{ name: "a", label: "A", type: "text" }] })),
  "form.list": R({}),
  "form.submissions": R({ slug: "contact" }),
  "webhook.create": W((i) => ({ name: `Spike hook ${i}` })),
  "webhook.list": R({}),
  "webhook.events": R({ id: "hook1" }),
  "voice.config.check": R({}),
  "voice.config.get": R({}),
  "voice.config.set": W({ gemini_key: "fake-gemini-key-not-real" }, { reset: true }),
  "voice.config.clear": W({}, { reset: true }),
  "config.status": R({}),
  "config.set": W({ service: "apify", key: "fake-apify-key-not-real" }),
  "config.test": W({ service: "agentmail" }),
  "config.clear": W({ service: "apify" }, { reset: true }),
  "voice.session.save": W({ started_at: "2026-11-25T06:00:00Z", ended_at: "2026-11-25T06:05:00Z", transcripts: [{ role: "user", text: "hello" }], tools: [] }),
  "voice.session.list": R({}),
  "voice.session.get": R({ id: "v1" }),
  "voice.session.delete": W((i) => ({ id: `v${i + 2}` })),
  "voice.invitation.create": W({ reason: "spike", agent_name: "Spike" }),
  "voice.invitation.list": R({}),
  "voice.invitation.get": R({ id: "i1" }),
  "voice.invitation.dismiss": W((i) => ({ id: `i${i + 1}` })),
  "voice.invitation.accept": W((i) => ({ id: `i${i + 10}` })),
  "page.create": W((i) => ({ slug: `spike-${i}`, title: "Spike", html_body: "<h1>x</h1>" })),
  "page.list": R({}),
  "page.get": R({ slug: "hello" }),
  "page.update": W({ slug: "hello", title: "Hello again" }),
  "page.delete": W((i) => ({ slug: `spike-${i}` })),
  "outreach.preview": R({ query: "hvac in Faketown TX" }),
  "outreach.preview.start": W({ query: "hvac in Faketown TX" }),
  "outreach.preview.result": R({ id: "spikepreview" }),
  "outreach.social.write": W({ campaign_id: "cnew", lead_ids: cnewLeads, channels: ["facebook"] }, { reset: true, resetEach: true }),
  "outreach.social.list": R({ campaign_id: cid }, { sweep: true }),
  "outreach.social.update": W((i) => ({ campaign_id: cid, lead_id: social(i), channel: "facebook", parts: { follow_up: "Hi again, still happy to send that short note if useful." } }), { reset: true }),
  "outreach.social.verify": R((i) => ({ campaign_id: cid, lead_id: social(i), channel: "facebook" })),
  "outreach.social.mark_sent": W((i) => ({ campaign_id: cid, lead_id: social(i), channel: "facebook", sent: true, part: "follow_up" }), { reset: true }),
  "outreach.social.record_hand": W((i) => ({ campaign_id: cid, lead_id: l(i), channel: "linkedin", text: "Sent by hand.", kind: "first" })),
  "outreach.touch.delete": W((i) => ({ lead_id: `l${(i + 1) * 20}`, touch_id: `t${(i + 1) * 20}` }), { reset: true }),
  "outreach.lead.touches": R({ campaign_id: cid, lead_id: "l5" }, { sweep: true }),
  "outreach.lead.fb_checked": W((i) => ({ campaign_id: cid, lead_id: l(i), result: "real" })),
  "outreach.social.plan": R({ leads: Array.from({ length: 25 }, (_, n) => ({ campaign_id: cid, lead_id: l(n) })), channels: ["facebook"] }, { sweep: true }),
  "outreach.social.batch.start": W({ leads: cnewLeads.map((id) => ({ campaign_id: "cnew", lead_id: id })), channels: ["facebook"] }, { reset: true, resetEach: true }),
  "outreach.social.batch.status": R({}),
  "outreach.social.batch.resume": W({}, { expect: [200, 400, 409], note: "nothing paused" }),
  "outreach.social.delete": W((i) => ({ campaign_id: cid, lead_id: social(i), channel: "facebook" }), { reset: true }),
  "outreach.job.resume": W({ campaign_id: "cbig", force: true }, { expect: [200, 400, 409], note: "nothing paused" }),
  "outreach.job.resume_due": R({}),
  "outreach.emails.review.start": W({ campaign_id: cid, email_ids: [draftId(0)] }, { reset: true, resetEach: true }),
  "outreach.browsercheck.plan": R({ campaign_id: cid }, { sweep: true }),
  "outreach.browsercheck.start": W({ campaign_id: "cnew", lead_id: "n1" }, { reset: true, resetEach: true }),
  "outreach.draft.start": W({ campaign_id: "cnew", framework: "four-step" }, { reset: true, resetEach: true }),
  "outreach.campaign.create": W((i) => ({ name: `Spike ${i}`, query: "hvac" })),
  "outreach.campaign.list": R({}, { sweep: true }),
  "outreach.campaign.get": R({ id: cid }, { sweep: true }),
  "outreach.campaign.update": W({ id: cid, description: "spike" }),
  "outreach.campaign.delete": W({ id: cid }, { reset: true, resetEach: true, sweep: true, heavy: true }),
  "outreach.campaign.run": W({ id: "cnew" }),
  "outreach.campaign.sync": W({ id: "csearch" }, { reset: true, resetEach: true, sweep: true, note: "imports 50 places into a workspace of the stated size" }),
  "outreach.leads.list": R({ campaign_id: cid }, { sweep: true }),
  "outreach.lead.set_email": W((i) => ({ campaign_id: cid, lead_id: l(i), email: emailTo(i) }), { sweep: true, reset: true }),
  "outreach.leads.update": W((i) => ({ campaign_id: cid, lead_id: l(i), excluded: true }), { sweep: true, reset: true }),
  "outreach.prospects.list": R({}, { sweep: true, heavy: true }),
  "outreach.lead.screenshot.get": R({ campaign_id: cid, lead_id: "l1" }),
  "outreach.leads.count": R({ campaign_id: cid }, { sweep: true }),
  "outreach.leads.add_test": W((i) => ({ campaign_id: cid, name: "Test", email: `t${i}@fake.example.test` })),
  "outreach.leads.delete": W((i) => ({ campaign_id: cid, lead_id: l(i) }), { sweep: true, reset: true }),
  "outreach.leads.enrich_one": W({ campaign_id: "cnew", lead_id: "w100" }, { reset: true, resetEach: true, note: "synthetic 100 KB pages" }),
  "outreach.leads.check_site": W({ campaign_id: "cnew", lead_id: "w100" }, { reset: true, resetEach: true, note: "synthetic 100 KB pages", variants: [["300 KB pages", { campaign_id: "cnew", lead_id: "w300" }], ["1 MB pages", { campaign_id: "cnew", lead_id: "w1000" }]], heavy: true }),
  "outreach.emails.generate_one": W({ campaign_id: "cnew", lead_id: "n1", framework: "four-step" }, { reset: true, resetEach: true }),
  "outreach.emails.create": W((i) => ({ campaign_id: cid, lead_id: l(i), subject: "after hours calls", body_text: "Hi there,\n\nA short note about after hours calls.\n\nLakshmi" }), { sweep: true, reset: true }),
  "outreach.emails.generate": W({ campaign_id: "cnew" }, { reset: true, resetEach: true, note: "10 leads, 4.5 s pacing between them", heavy: true }),
  "outreach.emails.list": R({ campaign_id: cid }, { sweep: true, heavy: true }),
  "outreach.emails.update": W((i) => ({ campaign_id: cid, email_id: draftId(i), subject: "after hours calls" }), { sweep: true, reset: true }),
  "outreach.emails.delete": W((i) => ({ campaign_id: cid, email_id: draftId(i) }), { sweep: true, reset: true }),
  "outreach.footer.preview": R({ campaign_id: cid, email_id: draftId(0) }, { sweep: true }),
  "outreach.settings.get": R({}),
  "outreach.inboxes.list": R({}),
  "outreach.settings.set": W({ default_sender_name: "Lakshmi" }),
  "outreach.emails.send": W({ campaign_id: cid, limit: 10 }, { sweep: true, reset: true, resetEach: true, heavy: true, note: "limit 10, AgentMail faked" }),
  "outreach.replies.list": R({}, { sweep: true }),
  "outreach.replies.delete": W((i) => ({ id: `r${(i + 1) * 10}` }), { reset: true, sweep: true }),
  "outreach.replies.get": R({ id: "r10" }, { sweep: true }),
  "outreach.send.today": R({}, { sweep: true }),
  "followups.list": R({}, { sweep: true, heavy: true }),
  "followups.update": W((i) => ({ lead_id: l(i), channel: "email", step_key: "4", op: "note", value: "spike" })),
  "followups.replied": W((i) => ({ lead_id: l(i) })),
  "followups.linkedin": W((i) => ({ lead_id: l(i), op: "accepted" })),
  "outreach.reply.draft": W({ id: "r10" }, { sweep: true }),
  "outreach.reply.send": W((i) => ({ id: `r${(i * 2 + 1) * 10}`, text: "Hi,\n\nThanks, here are some times that could work.\n\nLakshmi" }), { reset: true, sweep: true }),
  "outreach.replies.convert_to_task": W({ id: "r10" }),
  "outreach.analytics.summary": R({}, { sweep: true, heavy: true }),
  "outreach.replies.sync": W({ days: 14, max_new: 40 }, { reset: true, resetEach: true, sweep: true, heavy: true, note: "20 fake inbound messages" }),
  "outreach.webhook.events": R({}),
  "outreach.webhook.test": W({ webhook_id: "hook1", wait_s: 1 }),
  "webhook.create_typed": W((i) => ({ name: `Typed ${i}`, service: "agentmail" })),
  "webhook.delete": W((i) => ({ id: `nope${i}` }), { expect: [200, 404] }),
};

const trackToken = Buffer.from(JSON.stringify({ c: cid, l: "l1", e: "e-l1-1", u: "https://cal.example.test/fake" })).toString("base64url");
const amEvent = (type, i) => type === "received"
  ? { event_type: "message.received", message: { message_id: `spike-in-${Date.now()}-${i}`, thread_id: `th-e${i + 1}-1`, inbox_id: "fake@agentmail.example.test", from: `Owner <owner${i + 1}@fake${i + 1}.example.test>`, to: ["fake@agentmail.example.test"], subject: "Re: after hours calls", text: "Sounds good, tell me more." } }
  : { event_type: `message.${type}`, [type === "delivered" ? "delivery" : "bounce"]: { message_id: `msg-e${i * 4 + 1}-1`, thread_id: `th-e${i * 4 + 1}-1` } };

// Everything that is not /api/command. `req` returns what lib.call() needs.
const H = (req, extra = {}) => ({ kind: "write", req, ...extra });
export const HANDLERS = {
  "page-serve GET /p/hello": H(() => ({ path: "/p/hello", method: "GET" }), { kind: "read" }),
  "track-click GET /t/:token": H(() => ({ path: `/t/${trackToken}`, method: "GET" }), { expect: 302, sweep: true }),
  "form-submit GET /api/form/contact": H(() => ({ path: "/api/form/contact", method: "GET" }), { kind: "read" }),
  "form-submit POST /api/form/contact": H(() => ({ path: "/api/form/contact", body: { name: "Spike" } })),
  "webhook-receive message.delivered": H((i) => ({ path: "/api/webhook/hook1", body: amEvent("delivered", i) }), { sweep: true, reset: true, heavy: true }),
  "webhook-receive message.bounced": H((i) => ({ path: "/api/webhook/hook1", body: amEvent("bounced", i) }), { sweep: true, reset: true, heavy: true }),
  "webhook-receive message.received": H((i) => ({ path: "/api/webhook/hook1", body: amEvent("received", i) }), { sweep: true, reset: true, heavy: true }),
};

const bg = (task, params) => ({ path: "/.netlify/functions/ai-background", body: { task, params } });
const cmd = (action, params) => ({ body: { action, params } });
// ai-background tasks: `setup` calls record the job first (as the page does), then the task is timed.
export const BACKGROUND = {
  "ai-background draft (10 leads)": H(() => bg("draft", { campaign_id: "cnew", framework: "four-step", leads: [] }), { setup: [cmd("outreach.draft.start", { campaign_id: "cnew", framework: "four-step" })], reset: true, resetEach: true, expect: 202, heavy: true, sweep: true, note: "job drafts the 10 undrafted leads of cnew" }),
  "ai-background review (3 drafts)": H(() => bg("review", { campaign_id: cid, email_ids: [draftId(0), draftId(1), draftId(2)] }), { setup: [cmd("outreach.emails.review.start", { campaign_id: cid, email_ids: [draftId(0), draftId(1), draftId(2)] })], reset: true, resetEach: true, expect: 202, sweep: true, heavy: true }),
  "ai-background social (3 leads)": H(() => bg("social", { campaign_id: "cnew", lead_ids: cnewLeads, channels: ["facebook"] }), { setup: [cmd("outreach.social.write", { campaign_id: "cnew", lead_ids: cnewLeads, channels: ["facebook"] })], reset: true, resetEach: true, expect: 202, sweep: true, heavy: true }),
  "ai-background social_batch (3 leads)": H(() => bg("social_batch", {}), { setup: [cmd("outreach.social.batch.start", { leads: cnewLeads.map((id) => ({ campaign_id: "cnew", lead_id: id })), channels: ["facebook"] })], reset: true, resetEach: true, expect: 202, heavy: true }),
  "ai-background browsercheck (1 lead)": H(() => bg("browsercheck", { campaign_id: "cnew", lead_ids: ["n1"] }), { setup: [cmd("outreach.browsercheck.start", { campaign_id: "cnew", lead_id: "n1" })], reset: true, resetEach: true, expect: 202, heavy: true, note: "fake Apify returns 100 KB pages" }),
  "ai-background preview": H(() => bg("preview", { id: "spikepreview", query: "hvac in Faketown TX" }), { expect: 202 }),
};

// Re-checking old drafts: the same list pages when every unsent draft carries an old rules version.
export const STALE = {
  "re-check old drafts: outreach.emails.list": cmd("outreach.emails.list", { campaign_id: cid }),
  "re-check old drafts: followups.list": cmd("followups.list", {}),
  "re-check old drafts: outreach.prospects.list": cmd("outreach.prospects.list", {}),
};

export const testKey = apiKey;
