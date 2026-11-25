// Fake Alcance records in the shapes the handlers read, written ONLY to spike.kv. Reserved .example.test addresses.
// Datasets: d25 / d100 / d500 / d1500 = leads in the one big campaign "cbig" (4 emails each).
//   node db/seed-kv.mjs            -> create the table and seed every dataset
//   node db/seed-kv.mjs d500       -> reset one dataset
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { db } from "../../scripts/env.mjs";

export const SIZES = [25, 100, 500, 1500];
const RULES_VERSION = Number(/RULES_VERSION\s*=\s*(\d+)/.exec(readFileSync(new URL("../../../netlify/functions/lib/messagerules.ts", import.meta.url), "utf8"))?.[1] ?? NaN)
  || /RULES_VERSION\s*=\s*["']([^"']+)["']/.exec(readFileSync(new URL("../../../netlify/functions/lib/messagerules.ts", import.meta.url), "utf8"))?.[1];

const cache = new URL("../.cache/", import.meta.url);
mkdirSync(cache, { recursive: true });
const keyFile = new URL("api-key.txt", cache);
export const apiKey = () => {
  if (!existsSync(keyFile)) writeFileSync(keyFile, `ahq_${randomBytes(24).toString("base64url")}`, { mode: 0o600 });
  return readFileSync(keyFile, "utf8").trim();
};

const iso = (daysAgo, i = 0) => new Date(Date.UTC(2026, 10, 25, 6, 0, 0) - daysAgo * 86_400_000 + i * 1000).toISOString();
const BODY = (n) => `Hi there,\n\nI noticed Fake Heating & Air ${n} has no online booking, so people who call after hours have to ring back the next day.\n\nI put together a short note on how other HVAC teams catch those calls.\n\nWould it help if I sent it over?\n\nLakshmi`;
const CHECK = (n) => ({
  checked_at: iso(5), pages: 5, details: "detail ".repeat(60),
  facts: ["no_online_booking", "has_contact_form", "no_chat", "hours"].map((key) => ({ key, value: true, evidence: { url: `https://fake${n}.example.test/`, text: "Request service. Call us to book. Mon-Fri 8am-5pm." } })),
});

export function build(size) {
  const out = [];
  const put = (store, key, value) => out.push({ store: `d${size}/${store}`, key, value });
  put("agent-hq-config", "api-key", { key: apiKey(), created_at: iso(200) });
  for (const s of ["gemini", "apify", "agentmail"]) put("agent-hq-service-config", s, { key: `fake-${s}-key-not-real`, updated_at: iso(100) });
  put("agent-hq-outreach-settings", "settings", {
    postal_address: "1 Fake Street, Faketown, TX 75000", default_sender_name: "Lakshmi", default_sender_company: "Fake Co", default_sender_offer: "a free 30 minute call",
    booking_link: "https://cal.example.test/fake", time_zone: "Asia/Kolkata", reply_alert_email: "alerts@fake.example.test", sending_inbox_id: "fake@agentmail.example.test",
  });

  const campaign = (id, name, leads, extra = {}) => put("agent-hq-outreach-campaigns", id, {
    id, name, query: "hvac in Faketown TX", description: "fake", status: "ready", any_trade: true, leads_imported: leads,
    structured_query: { location: "Faketown, TX", searchTerms: ["hvac"], maxResults: 50 }, created_at: iso(60), updated_at: iso(1), ...extra,
  });
  const lead = (cid, id, n, extra = {}) => put("agent-hq-outreach-leads", `${cid}/${id}`, {
    id, campaign_id: cid, name: `Fake Heating & Air ${n}`, email: `owner${n}@fake${n}.example.test`, phone: "(555) 010-2000",
    website: `https://fake${n}.example.test`, address: `${n} Fake St, Faketown, TX 75000`, category: "HVAC contractor",
    rating: 3.5 + (n % 15) / 10, reviews_count: 5 + (n % 300), maps_url: `https://maps.example.test/${n}`, created_at: iso(50, n),
    social: { facebook: `https://facebook.com/fake${n}`, instagram: n % 3 ? null : `https://instagram.com/fake${n}`, linkedin: n % 5 ? null : `https://linkedin.com/company/fake${n}` },
    owner_name: n % 2 ? "Sam Fake" : null, owner_confidence: n % 2 ? "high" : null, gap_score: n % 100, gap_reasons: ["No online booking"], site_check: CHECK(n),
    raw: { state: "Texas", about: "about ".repeat(100), hours: ["Mon 8-5", "Tue 8-5", "Wed 8-5", "Thu 8-5", "Fri 8-5"] }, ...extra,
  });
  const email = (cid, leadId, n, step, extra = {}) => {
    const id = `e-${leadId}-${step}`, created_at = iso(40, n * 4 + step);
    put("agent-hq-outreach-emails", `${cid}/${created_at}-${id}`, {
      id, campaign_id: cid, lead_id: leadId, to_email: `owner${n}@fake${n}.example.test`, to_name: `Fake Heating & Air ${n}`,
      subject: "after hours calls", body_text: BODY(n), framework: "four-step", sequence_position: step, total_steps: 4, status: "drafted",
      review_status: ["ready", "check", "blocked"][n % 3], review_reasons: n % 3 ? ["Check the wording"] : [], reviewed_by: "ai", rules_version: RULES_VERSION,
      click_count: 0, created_at, updated_at: created_at, ...extra,
    });
  };

  put("agent-hq-outreach-contacts", "meta/built", iso(1));
  put("agent-hq-voice-config", "config", { gemini_key: "fake-gemini-key-not-real", updated_at: iso(100) });
  put("agent-hq-outreach-settings", "preview/spikepreview", { status: "done", result: { location: "Faketown, TX", searchTerms: ["hvac"] }, finished_at: iso(1) });

  campaign("cbig", `Fake big campaign (${size} leads)`, size);
  for (let n = 1; n <= size; n++) {
    const leadId = `l${n}`;
    const sentSteps = n % 4; // 0..3 of the 4 emails already sent
    lead("cbig", leadId, n, { do_not_contact: n % 41 === 0, excluded: n % 29 === 0 });
    for (let step = 1; step <= 4; step++) {
      const sent = step <= sentSteps;
      email("cbig", leadId, n, step, sent
        ? { status: n % 53 === 0 && step === 1 ? "bounced" : "delivered", sent_at: iso(30 - step * 3 + (n % 20)), review_status: "ready", agentmail_message_id: `msg-e${n}-${step}`, agentmail_thread_id: `th-e${n}-${step}`, agentmail_inbox_id: "fake@agentmail.example.test", click_count: n % 7 === 0 ? 1 : 0 }
        : {});
    }
    if (n % 5 === 0) {
      for (const channel of ["facebook"]) {
        put("agent-hq-outreach-social", `cbig/${leadId}/${channel}`, {
          id: `${leadId}-${channel}`, campaign_id: "cbig", lead_id: leadId, channel, url: `https://facebook.com/fake${n}`, type: "sequence",
          parts: ["message", "follow_up", "last"].map((key, i) => ({ key, label: `Message ${i + 1}`, text: ["Hi there, I noticed your website has no online booking, so people who call after hours have to ring back the next day. Does that happen much for your team?", "Hi again, still happy to send the short note if useful.", "Last note from me, no worries."][i], sent_at: i === 0 ? iso(10) : null, review_status: "ready" })),
          status: "drafted", review_status: "ready", review_reasons: [], reviewed_by: "ai", rewrites_used: 0, fact_used: null, draft_facts: [], angle: "booking", written_by: "fake", rules_version: RULES_VERSION, created_at: iso(12), updated_at: iso(10),
        });
      }
    }
    if (n % 10 === 0) {
      put("agent-hq-outreach-replies", `r${n}`, {
        id: `r${n}`, campaign_id: "cbig", lead_id: leadId, original_email_id: `e-${leadId}-1`, agentmail_message_id: `msg-r${n}`, agentmail_thread_id: `th-e${n}-1`,
        from: `Owner <owner${n}@fake${n}.example.test>`, to: ["fake@agentmail.example.test"], subject: "Re: after hours calls", text: "Sounds good, tell me more about it. ".repeat(6), html: null,
        received_at: iso(n % 20, n), handled: false, opt_out: false, flag: null, labels: ["received"], authentication_results: null, is_test: false, source: "webhook",
      });
    }
    // The contacts index, in the exact shape lib/contacts.ts writes (plain strings).
    if (sentSteps > 0) put("agent-hq-outreach-contacts", `sent/owner${n}@fake${n}.example.test/cbig`, "1");
    if (sentSteps > 0 && n % 53 === 0) put("agent-hq-outreach-contacts", `bounced/owner${n}@fake${n}.example.test`, "1");
    if (n % 25 === 0) put("agent-hq-outreach-followups", `${leadId}/email`, { lead_id: leadId, channel: "email", steps: { 4: { note: "call first" } }, updated_at: iso(2) });
    if (n % 20 === 0) put("agent-hq-outreach-touches", `${leadId}/${iso(9)}-t${n}`, { id: `t${n}`, lead_id: leadId, campaign_id: "cbig", channel: "linkedin", kind: "first", sent_at: iso(9), text: "Hello", source: "manual" });
    if (n % 10 === 0) put("agent-hq-outreach-clicks", `cbig/${iso(3, n)}-c${n}`, { id: `c${n}`, campaign_id: "cbig", lead_id: leadId, email_id: `e-${leadId}-1`, url: "https://cal.example.test/fake", clicked_at: iso(3, n) });
  }

  // Small campaign with nothing drafted yet: drafting, social writing, website checks, browser check.
  campaign("cnew", "Fake new campaign", 10);
  for (let i = 1; i <= 10; i++) lead("cnew", `n${i}`, 90000 + i, { site_check: CHECK(90000 + i) });
  for (const [id, host] of [["w100", "site"], ["w300", "big300"], ["w1000", "big1000"]]) {
    lead("cnew", id, 91000 + id.length, { email: null, website: `https://${host}.example.test`, site_check: undefined, social: {} });
  }
  // Campaign with an Apify run that has just finished (campaign.sync imports its places).
  campaign("csearch", "Fake searching campaign", 0, { status: "searching", apify_run_id: "fakerun", apify_dataset_id: "fakeset" });

  // Everything else in the app: small, fixed amounts.
  for (let i = 1; i <= 20; i++) {
    put("agent-hq-agents", `a${i}`, { id: `a${i}`, name: `Agent ${i}`, sign_in_name: `agent${i}`, role: "helper", status: "idle", created_at: iso(30, i), last_seen: iso(1, i) });
    put("agent-hq-tasks", `t${i}`, { id: `t${i}`, title: `Task ${i}`, description: "fake", status: "todo", priority: "medium", created_at: iso(20, i), updated_at: iso(2, i) });
    put("agent-hq-voice-sessions", `v${i}`, { id: `v${i}`, started_at: iso(5, i), ended_at: iso(5, i + 60), transcripts: [{ role: "user", text: "hello ".repeat(40) }], tools: [], created_at: iso(5, i) });
    put("agent-hq-voice-invitations", `i${i}`, { id: `i${i}`, agent_name: "Agent", reason: "talk", status: "pending", created_at: iso(3, i) });
    put("agent-hq-submissions", `contact/${iso(4, i)}-s${i}`, { id: `s${i}`, form_slug: "contact", data: { name: "Fake" }, received_at: iso(4, i) });
    put("agent-hq-webhook-events", `hook1/${iso(2, i)}-w${i}`, { id: `w${i}`, webhook_id: "hook1", headers: {}, body: { fake: true }, received_at: iso(2, i) });
  }
  for (let i = 1; i <= Math.max(100, size); i++) put("agent-hq-activity", `${iso(10, i)}-x${i}`, { id: `x${i}`, agent_id: null, category: "system", summary: `Fake activity ${i}`, details: {}, created_at: iso(10, i) });
  put("agent-hq-forms", "contact", { slug: "contact", title: "Contact", description: "fake", fields: [{ name: "name", label: "Name", type: "text", required: true }], created_at: iso(30) });
  put("agent-hq-pages", "hello", { slug: "hello", title: "Hello", html_body: `<h1>Hello</h1><p>${"fake page ".repeat(200)}</p>{{form:contact}}`, linked_form_slug: "contact", created_at: iso(20), updated_at: iso(20) });
  put("agent-hq-webhooks", "hook1", { id: "hook1", name: "AgentMail", description: "fake", service: "agentmail", event_count: 20, created_at: iso(30) });
  put("agent-hq-lead-screenshots", "cbig/l1", { jpeg_base64: "A".repeat(80_000), saved_at: iso(5), bytes: 60_000 });
  return out;
}

/** Writes the pristine copy of a dataset (store prefix "pristine-dN/") once; reset() copies it back inside the database. */
export async function seed(sql, size) {
  const rows = build(size).map((r) => ({ ...r, store: `pristine-${r.store}` }));
  await sql`delete from spike.kv where store like ${`pristine-d${size}/%`}`;
  for (let i = 0; i < rows.length; i += 1000) {
    await sql`insert into spike.kv (store, key, value) select store, key, value from jsonb_to_recordset(${JSON.stringify(rows.slice(i, i + 1000))}::text::jsonb) as r(store text, key text, value jsonb)`;
  }
  await reset(sql, size);
  return rows.length;
}

export async function reset(sql, size) {
  await sql.begin(async (tx) => {
    await tx`delete from spike.kv where store like ${`d${size}/%`}`;
    await tx`insert into spike.kv (store, key, value) select substring(store from 10), key, value from spike.kv where store like ${`pristine-d${size}/%`}`;
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/ /g, "%20")}`) {
  const sql = db();
  await sql`create schema if not exists spike`;
  await sql`create table if not exists spike.kv (store text collate "C" not null, key text collate "C" not null, value jsonb not null, primary key (store, key))`;
  const only = process.argv[2];
  for (const size of SIZES.filter((s) => !only || only === `d${s}`)) console.log(`d${size}: ${await seed(sql, size)} records`);
  await sql`analyze spike.kv`;
  const [c] = await sql`select count(*)::int as records, pg_total_relation_size('spike.kv')::bigint as bytes, pg_database_size(current_database())::bigint as db_bytes from spike.kv`;
  console.log("rules_version:", RULES_VERSION, c);
  writeFileSync(new URL("../results/seed.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), sizes: SIZES, records_including_pristine_copy: c.records, kv_bytes: Number(c.bytes), db_bytes: Number(c.db_bytes) }, null, 2));
  await sql.end();
}
