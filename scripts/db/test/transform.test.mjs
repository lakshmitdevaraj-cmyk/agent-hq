// The import's data rules, on made-up records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseSocialUrl } from "../normalise.mjs";
import { loadRules } from "../rules.mjs";
import { transform } from "../transform.mjs";

const rules = await loadRules();
const rec = (key, value) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) });
const camp = (id, over = {}) => rec(id, { id, name: `C ${id}`, query: "hvac", structured_query: { location: "Katy, TX" }, created_at: "2026-11-01T00:00:00Z", ...over });
const lead = (id, over = {}) => rec(`c1/2026-11-01T00:00:00Z-${id}`, { id, campaign_id: "c1", name: `Biz ${id}`, email: `${id}@example.com`, raw: {}, created_at: "2026-11-01T00:00:00Z", ...over });
const email = (id, leadId, over = {}) => rec(`c1/2026-11-02T00:00:00Z-${id}`, { id, campaign_id: "c1", lead_id: leadId, to_email: `${leadId}@example.com`, sequence_position: 1, status: "sent", framework: "four-step", sent_at: "2026-11-02T15:00:00Z", created_at: "2026-11-02T00:00:00Z", ...over });
const reply = (id, over = {}) => rec(`c1/2026-11-03T00:00:00Z-${id}`, { id, campaign_id: "c1", lead_id: null, original_email_id: null, from: "owner@example.com", subject: "Re: calls", text: "Sounds good, call me.", received_at: "2026-11-03T00:00:00Z", opt_out: false, ...over });

const run = (stores, opts = {}) => transform({ "agent-hq-outreach-campaigns": [camp("c1")], ...stores }, { rules, today: "2026-11-10", ...opts });
const row = (out, table, id) => out.tables[table].find((r) => r.id === id);

test("social addresses: lower-case, no www or tracking, profile.php keeps its id", () => {
  const n = (u) => normaliseSocialUrl(u)?.url_norm;
  assert.equal(n("HTTP://WWW.Facebook.com/MadeUpShop/?ref=page&fbclid=1"), "https://facebook.com/madeupshop");
  assert.equal(n("https://m.facebook.com/profile.php?id=100064&mibextid=x"), "https://facebook.com/profile.php?id=100064");
  assert.equal(n("instagram.com/Some.Shop/"), "https://instagram.com/some.shop");
  assert.notEqual(n("https://search.google.com/local/reviews?placeid=A&utm_source=x"), n("https://search.google.com/local/reviews?placeid=B"));
  assert.equal(normaliseSocialUrl("not a url"), null);
});

test("two leads that share a page point to one page", () => {
  const out = run({ "agent-hq-outreach-leads": [
    lead("a", { social: { facebook: "https://www.facebook.com/Shared/" }, site_check: { via: "browser" } }),
    lead("b", { social: { facebook: "https://facebook.com/shared?ref=1" }, site_check: { via: "raw" } }),
  ] });
  assert.equal(out.tables.social_pages.length, 1);
  assert.deepEqual(out.tables.lead_social_links.map((l) => [l.lead_id, l.url_norm, l.source]), [["a", "https://facebook.com/shared", "browser"], ["b", "https://facebook.com/shared", "site_check"]]);
});

const states = (out) => Object.fromEntries(out.tables.leads.map((l) => [l.id, l.stop_state]));

test("stop states: each rule, first match wins", () => {
  const out = run({
    "agent-hq-outreach-leads": ["dnc", "optout", "spam", "person", "hand", "bounce", "report", "index", "plain", "failed", "mine"].map((id) => lead(id, id === "dnc" ? { do_not_contact: true } : {})),
    "agent-hq-outreach-emails": [
      email("e-spam", "spam", { status: "complained" }),
      email("e-bounce", "bounce", { status: "bounced" }),
      email("e-report", "report", { status: "replied" }), // today "replied" only because the bounce report came in as a reply
      email("e-failed", "failed", { status: "failed", error: "network error" }),
      email("e-mine", "mine", { status: "replied" }),
    ],
    "agent-hq-outreach-replies": [
      reply("r1", { lead_id: "optout", opt_out: true, text: "no thanks" }),
      reply("r2", { lead_id: "person" }),
      reply("r3", { lead_id: "report", original_email_id: "e-report", from: "mailer-daemon@example.com", subject: "Delivery Status Notification (Failure)" }),
      reply("r4", { lead_id: "mine", original_email_id: "e-mine", from: "shiftforge.ai@gmail.com" }),
    ],
    "agent-hq-outreach-followups": [rec("hand/all", { lead_id: "hand", channel: "all", replied_by_hand: "2026-11-04T00:00:00Z" })],
    "agent-hq-outreach-contacts": [rec("bounced/index@example.com", "1"), rec("bounced/failed@example.com", "1")],
  });
  assert.deepEqual(states(out), { dnc: "do_not_contact", optout: "do_not_contact", spam: "do_not_contact", person: "replied", hand: "replied", bounce: "bounced", report: "bounced", index: "bounced", plain: "none", failed: "none", mine: "none" });
  assert.deepEqual(out.report.failed_emails.map((f) => [f.email_id, f.error]), [["e-failed", "network error"]]);
  const changed = Object.fromEntries(out.report.state_changes.map((c) => [c.lead_id, [c.today_prospects, c.after]]));
  assert.deepEqual(changed.report, ["replied", "bounced"]);
  assert.deepEqual(changed.failed, ["bounced", "none"]);
});

test("a bounce of an old address does not stop the new one", () => {
  const out = run({
    "agent-hq-outreach-leads": [lead("a", { email: "new@example.com", email_source: "manual" })],
    "agent-hq-outreach-emails": [email("e1", "a", { status: "bounced", to_email: "old@example.com" })],
  });
  assert.equal(states(out).a, "none");
  assert.equal(out.report.bounced_old_address.length, 1);
});

test("two drafts for one step: both kept, the older marked and reported", () => {
  const out = run({ "agent-hq-outreach-leads": [lead("a")], "agent-hq-outreach-emails": [
    email("old", "a", { status: "drafted", sent_at: undefined, created_at: "2026-11-01T00:00:00Z" }),
    email("new", "a", { status: "drafted", sent_at: undefined, created_at: "2026-11-05T00:00:00Z" }),
  ] });
  assert.deepEqual([row(out, "emails", "old").is_duplicate, row(out, "emails", "new").is_duplicate], [true, false]);
  assert.equal(out.report.duplicate_drafts.length, 1);
});

test("secrets marked at export never reach a row; other fields are kept", () => {
  const out = run({
    "agent-hq-agents": [rec("a1", { id: "a1", name: "Agent", api_key: "[redacted]", emoji: "x" })],
    "agent-hq-voice-config": [rec("config", { gemini_key: "[redacted]", updated_at: "2026-11-01T00:00:00Z" })],
    "agent-hq-webhook-events": [rec("w1/2026-11-01T00:00:00Z-x", { id: "x", webhook_id: "w1", headers: { "svix-signature": "[redacted]", "content-type": "application/json" }, body: { a: 1 }, received_at: "2026-11-01T00:00:00Z" })],
  });
  assert.ok(!JSON.stringify(out.tables).includes("[redacted]"));
  assert.equal(out.tables.agents[0].data.emoji, "x");
  assert.deepEqual(out.tables.webhook_events[0].headers, { "content-type": "application/json" });
});

test("lead basics: keys, source, country, time zone, city, unknown fields kept", () => {
  const out = run({ "agent-hq-outreach-leads": [
    lead("a", { email: "Owner@Example.com", website: "https://www.Acme.com/x", address: "1 Main St, El Paso, TX 79901, United States", raw: { emails: ["owner@example.com"], city: "El Paso" }, weird_field: 7 }),
    lead("b", { address: null, email_source: "manual" }),
  ] });
  const a = row(out, "leads", "a");
  assert.deepEqual([a.email_key, a.website_key, a.city, a.email_source, a.data.weird_field], ["owner@example.com", "acme.com", "El Paso", "google_maps", 7]);
  assert.equal(a.time_zone, "America/Chicago");
  assert.equal(row(out, "leads", "b").time_zone, "America/Chicago", "falls back to the campaign");
  assert.equal(row(out, "leads", "b").email_source, "manual");
  assert.equal(out.tables.campaigns[0].country, "US");
});

test("job progress goes to campaign_jobs, never the campaign row; saved state wins", () => {
  const out = run({
    "agent-hq-outreach-campaigns": [camp("c1", { status: "ready", apify_run_id: "run1", default_sender_name: "Old", job: { kind: "generate", status: "running" } })],
    "agent-hq-outreach-campaign-state": [rec("c1", { default_sender_name: "New", job: { kind: "social", status: "done", total: 3, done: 3 }, browser_checked_ids: ["a"] })],
  });
  const c = out.tables.campaigns[0];
  assert.equal(c.default_sender_name, "New");
  assert.ok(!("job" in c.data) && !("apify_run_id" in c.data) && !("status" in c.data));
  assert.deepEqual(out.tables.campaign_jobs.map((j) => j.kind).sort(), ["browser_check", "leads", "social"]);
});

test("social record becomes one row per step", () => {
  const out = run({ "agent-hq-outreach-leads": [lead("a")], "agent-hq-outreach-social": [rec("c1/a/facebook", { id: "a-facebook", campaign_id: "c1", lead_id: "a", channel: "facebook", url: "u", status: "drafted", type: "sequence", written_by: "gemini-2.5-flash", parts: [{ key: "message", text: "hi" }, { key: "follow_up", text: "again" }] })] });
  assert.deepEqual(out.tables.social_messages.map((m) => [m.id, m.step, m.written_by, m.written_model]), [["a-facebook:message", 1, "gemini", "gemini-2.5-flash"], ["a-facebook:follow_up", 2, "gemini", "gemini-2.5-flash"]]);
});

test("follow-up due date uses the live rule: 3 days after the first email", () => {
  const out = run({ "agent-hq-outreach-leads": [lead("a")], "agent-hq-outreach-emails": [email("e1", "a"), email("e2", "a", { sequence_position: 2, status: "drafted", sent_at: undefined })] });
  assert.deepEqual(out.tables.follow_ups.map((f) => [f.lead_id, f.channel, f.step_key, f.due_date, f.stopped_reason]), [["a", "email", "2", "2026-11-05", null]]);
});

test("F17 duplicate leads are proposed, and merged only when approved", () => {
  const stores = { "agent-hq-outreach-leads": [lead("with", { name: "Acme Air LLC" }), lead("without", { name: "ACME Air", email: null })], "agent-hq-outreach-social": [rec("c1/without/facebook", { id: "without-facebook", campaign_id: "c1", lead_id: "without", channel: "facebook", parts: [{ key: "message", text: "hi" }] })] };
  const before = run(stores);
  assert.deepEqual(before.report.duplicate_leads.map((d) => [d.keep, d.merge]), [["with", "without"]]);
  assert.equal(row(before, "leads", "without").merged_into, null);
  const after = run(stores, { decisions: { merges: [{ keep: "with", merge: "without" }] } });
  assert.equal(row(after, "leads", "without").merged_into, "with");
  assert.equal(after.tables.social_messages[0].lead_id, "with");
});

test("F19: a first send stored at position 2 is proposed, and moved only when approved", () => {
  const stores = { "agent-hq-outreach-leads": [lead("a")], "agent-hq-outreach-emails": [email("e1", "a", { status: "drafted", sent_at: undefined }), email("e2", "a", { sequence_position: 2 })] };
  assert.deepEqual(run(stores).report.first_send_at_later_step.map((x) => [x.lead_id, x.email_id, x.step]), [["a", "e2", 2]]);
  const after = run(stores, { decisions: { email_steps: [{ email_id: "e2", step: 1 }, { email_id: "e1", step: 2 }] } });
  assert.deepEqual([row(after, "emails", "e2").step, row(after, "emails", "e1").step], [1, 2]);
});

test("orphans are kept and listed; unreadable values are counted", () => {
  const out = run({ "agent-hq-outreach-emails": [email("e1", "gone"), rec("c1/bad", "{not json")], "agent-hq-outreach-replies": [reply("r1", { campaign_id: null })] });
  assert.equal(out.tables.emails.length, 1);
  assert.deepEqual(out.report.orphans.emails_without_lead, ["e1"]);
  assert.deepEqual(out.report.orphans.replies_without_campaign, ["r1"]);
  assert.equal(out.report.stores["agent-hq-outreach-emails"].parse_failed, 1);
});

test("postal address is reported as yes or no only", () => {
  const out = run({ "agent-hq-outreach-settings": [rec("settings", { postal_address: "1 Secret Road" })] });
  assert.equal(out.report.postal_address_filled, true);
  assert.ok(!JSON.stringify(out.report).includes("Secret Road"));
});

test("F19: a bounced first try does not count as the first send; the fix keeps it, marked as superseded", () => {
  const stores = {
    "agent-hq-outreach-leads": [lead("a", { email: "new@example.com" })],
    "agent-hq-outreach-emails": [
      email("e1", "a", { status: "bounced", to_email: "old@example.com", framework: "one-off", sequence_total: 1, created_at: "2026-11-01T00:00:00Z" }),
      email("e2", "a", { status: "delivered", to_email: "new@example.com", framework: "one-off", sequence_total: 2, sequence_position: 2, created_at: "2026-11-05T00:00:00Z" }),
    ],
  };
  const before = run(stores);
  assert.deepEqual(before.report.first_send_at_later_step.map((p) => [p.email_id, p.step]), [["e2", 2]]);
  const after = run(stores, { decisions: { email_steps: [{ email_id: "e2", step: 1, sequence_total: 1 }] } });
  assert.deepEqual([row(after, "emails", "e2").step, row(after, "emails", "e2").sequence_total, row(after, "emails", "e2").is_duplicate], [1, 1, false]);
  assert.equal(row(after, "emails", "e1").is_duplicate, true);
});

test("a + in a contact key that came out as a space is put back", () => {
  const out = run({ "agent-hq-outreach-contacts": [rec("sent/me b@example.com/c1", "1")] });
  assert.deepEqual([out.tables.contacts[0].email, out.tables.contacts[0].blob_key], ["me+b@example.com", "sent/me b@example.com/c1"]);
  assert.equal(out.report.contact_plus_restored, 1);
});

test("any_trade: a campaign with no value imports as true (as the live app reads it); an explicit value is kept", () => {
  const out = run({ "agent-hq-outreach-campaigns": [camp("c1"), camp("c2", { any_trade: false }), camp("c3", { any_trade: true })] });
  assert.equal(row(out, "campaigns", "c1").any_trade, true);
  assert.equal(row(out, "campaigns", "c2").any_trade, false);
  assert.equal(row(out, "campaigns", "c3").any_trade, true);
});
