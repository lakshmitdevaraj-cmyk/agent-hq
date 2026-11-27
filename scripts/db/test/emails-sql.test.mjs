// Chunk 5 on Neon dev, every transaction rolled back: the nine email actions (lib/sql/emails.ts) and the code checks
// (lib/sql/emailchecks.ts). All data is made up and inserted inside the transaction. Nothing here reaches a network:
// the AI writer, the sleep and the clock are stand-ins passed as `deps`.
// Covers A4/F46 (writing by hand never calls AI), F9 (one draft per lead and step, 409 with the id, the race),
// F32/F33 flags (fit_flagged), R9 (footer warning), F1 (every write is read straight back), F17 (merged leads hidden).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const CID = "e5-camp";
const OLD_VERSION = 1;
let n, emails, checks, campaigns, rules, outreach;
let seq = 0;

before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  emails = await import("../../../netlify/functions/lib/sql/emails.ts");
  checks = await import("../../../netlify/functions/lib/sql/emailchecks.ts");
  campaigns = await import("../../../netlify/functions/lib/sql/campaigns.ts");
  rules = await import("../../../netlify/functions/lib/messagerules.ts");
  outreach = await import("../../../netlify/functions/lib/outreach.ts");
});
after(() => n?.close());

// ── fixtures ──────────────────────────────────────────────────────────────

const SETTINGS = { free_asset_1: "a short recording of an assistant answering a call", free_asset_2: "a number you can call to hear it", proof_line: "I built an assistant for my agency's website.", postal_address: "1 Made Up Street, Katy, TX 77449" };
const LEADS = [
  { id: "e5-l1", name: "Made-up Plumbing", email: "owner@madeup-test.com" },
  { id: "e5-l2", name: "Second Made-up Plumbing", email: "second@madeup-test.com" },
  { id: "e5-l3", name: "Third Made-up Plumbing", email: "third@madeup-test.com" },
  { id: "e5-flag", name: "Made-up Roofing Co", email: "flag@madeup-test.com", category: "Roofing contractor", reviews_count: 1500 },
  { id: "e5-kept", name: "Kept Made-up Roofing Co", email: "kept@madeup-test.com", category: "Roofing contractor", reviews_count: 1500, not_fit_kept: true },
  { id: "e5-dnc", name: "Silent Made-up Plumbing", email: "dnc@madeup-test.com", do_not_contact: true, stop_state: "do_not_contact" },
  { id: "e5-noemail", name: "No Email Made-up Plumbing", email: null },
  { id: "e5-merged", name: "Merged Made-up Plumbing", email: "merged@madeup-test.com", merged_into: "e5-l1" },
  { id: "e5-excl", name: "Excluded Made-up Plumbing", email: "excl@madeup-test.com", excluded: true },
];

async function seed(tx, { settings = SETTINGS } = {}) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign', 'plumber', 'Katy, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), ${tx.json({ structured_query: { location: "Katy, TX", searchTerms: ["plumber"] } })})`;
  let i = 0;
  const rows = LEADS.map((l) => ({
    id: l.id, campaign_id: CID, blob_key: `${CID}/${l.id}`, name: l.name, email: l.email, email_key: l.email, category: l.category ?? "Plumber",
    address: "1 Made Up St, Katy, TX 77449", reviews_count: l.reviews_count ?? 20, not_fit_kept: l.not_fit_kept ?? false, do_not_contact: l.do_not_contact ?? false,
    stop_state: l.stop_state ?? "none", excluded: l.excluded ?? false, merged_into: l.merged_into ?? null, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++i)), data: tx.json({}),
  }));
  await tx`insert into leads ${tx(rows)}`; // one statement: every round trip to Neon costs time
  if (settings) await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json(settings)}) on conflict (key) do update set data = excluded.data`;
}

const BODY = "Hello Made-up Plumbing team. I noticed your plumbing crew works around Katy. Would you like me to send a short recording of an assistant answering a call?";
const HARD_BODY = "Quick question about your plumbing crew. Would you like me to send a short recording of an assistant answering a call?";

/** An email row as the P1 import would have made it (every column the code reads). */
async function em(tx, o = {}) {
  const id = o.id ?? `e5-m${++seq}`;
  const to = o.to_email === undefined ? "owner@madeup-test.com" : o.to_email;
  await tx`insert into emails ${tx({
    id, blob_key: `${o.campaign_id ?? CID}/${id}`, campaign_id: o.campaign_id ?? CID, lead_id: o.lead_id === undefined ? "e5-l1" : o.lead_id, to_email: to, to_key: to ? to.toLowerCase() : null,
    to_name: o.to_name ?? "Made-up Plumbing", subject: o.subject ?? "plumbing", body_text: o.body_text ?? BODY, body_html: "<p>x</p>", sender_name: "Made-up Sender", step: o.step ?? 1,
    sequence_total: o.sequence_total ?? 1, framework: o.framework ?? "one-off", status: o.status ?? "drafted", review_status: o.review_status ?? null,
    review_reasons: o.review_reasons ? tx.json(o.review_reasons) : null, reviewed_by: o.reviewed_by ?? null, rules_version: o.rules_version === undefined ? rules.RULES_VERSION : o.rules_version,
    written_by: o.written_by ?? null, written_model: o.written_model ?? null, source: o.source ?? null, is_duplicate: o.is_duplicate ?? false,
    created_at: o.created_at ?? new Date(Date.UTC(2026, 1, 1, 0, 0, ++seq)), updated_at: new Date(), data: tx.json(o.data ?? {}),
  })}`;
  return id;
}
const row = async (tx, id) => (await tx`select * from emails where id = ${id}`)[0];
const social = (tx, o) => tx`insert into social_messages ${tx({ id: `${o.lead_id}:${o.step_key ?? "message"}`, record_id: o.lead_id, campaign_id: CID, lead_id: o.lead_id, channel: o.channel ?? "facebook", step_key: o.step_key ?? "message", step: 1, body: o.body, status: "drafted", data: tx.json({}) })}`;

let ids = 0;
const counter = () => () => `e5-new-${++ids}`; // one counter for the whole file, so two actions in one test never reuse an id
const ctxOf = (isAgent = false) => ({ newId: counter(), isAgent, createdBy: isAgent ? "agent-made-up" : null });
const written = { subject: "plumbing", body_text: BODY, body_html: `<p>${BODY}</p>`, model: "gemini-test-model" };
/** Stand-ins for the AI writer, the pause and the clock. `calls` records every writer call. */
function stubs(extra = {}) {
  const calls = [];
  return Object.assign({ calls, aiAvailable: async () => true, writeDraft: async (input) => { calls.push(input); return { ...written }; }, sleep: async () => {}, now: () => Date.now() }, extra);
}
/** deps that fail on ANY use, even reading a property. */
const forbidden = () => new Proxy({}, { get: (_, p) => { throw new Error(`deps were used: ${String(p)}`); } });
const run = (tx, action, params, deps = stubs(), ctx = ctxOf()) => emails.runEmailAction(tx, `outreach.${action}`, params, deps, ctx);
const refused = (p, status, code, re) => assert.rejects(p, (e) => e instanceof campaigns.CampaignError && e.status === status && (code === undefined || e.code === code) && (!re || re.test(e.message)), `expected ${status} ${code ?? ""}`);
const withFx = (fn, opts) => n.callWrite(async (tx) => { await seed(tx, opts); return fn(tx); });

// ── the code checks (emailchecks.ts) ──────────────────────────────────────

describe("codeCheckDraft: the SQL twin of codeCheckSavedEmail", () => {
  const draft = (o = {}) => ({ id: "e5-x", campaign_id: CID, lead_id: "e5-l1", to_name: "Made-up Plumbing", framework: "one-off", sequence_position: 1, subject: "plumbing", body_text: BODY, ...o });

  test("one-off: a clean draft has no hard hit; a banned opener is a hard hit and blocks; a near-miss is not", () => withFx(async (tx) => {
    const ok = await checks.codeCheckDraft(tx, draft());
    assert.deepEqual(ok.hard, []);
    assert.notEqual(ok.status, "blocked");
    const bad = await checks.codeCheckDraft(tx, draft({ body_text: HARD_BODY }));
    assert.equal(bad.status, "blocked");
    assert.equal(bad.hard.length, 1);
    assert.ok(bad.hits.some((h) => h.id === "quick-ask"));
    const near = await checks.codeCheckDraft(tx, draft({ body_text: BODY.replace("Hello", "A quicker questioning of") }));
    assert.deepEqual(near.hard, [], "'quicker questioning' is not 'quick question'");
  }));

  test("one-off: a fake Re: subject and an empty subject are hard; soft rules are ignored for older frameworks", () => withFx(async (tx) => {
    assert.ok((await checks.codeCheckDraft(tx, draft({ subject: "Re: plumbing" }))).hits.some((h) => h.id === "fake-re"));
    assert.ok((await checks.codeCheckDraft(tx, draft({ subject: "" }))).hits.some((h) => h.id === "empty-subject"));
    const long = await checks.codeCheckDraft(tx, draft({ body_text: `${BODY} ${"More words here. ".repeat(40)}` }));
    assert.ok(long.hits.every((h) => h.level === "hard"), "an older framework counts hard hits only (too-long is soft)");
  }));

  test("four-step: the lead's EARLIER steps are read from SQL (not shorter than email 1); another lead's and later steps are not", () => withFx(async (tx) => {
    await em(tx, { id: "e5-s1", lead_id: "e5-l1", step: 1, framework: "four-step", sequence_total: 4, body_text: "Short first email about your plumbing crew." });
    await em(tx, { id: "e5-other", lead_id: "e5-l2", step: 1, framework: "four-step", sequence_total: 4, body_text: "x" });
    const longer = BODY;
    const two = await checks.codeCheckDraft(tx, draft({ id: "e5-s2", framework: "four-step", sequence_position: 2, subject: "", body_text: longer }));
    assert.ok(two.hits.some((h) => h.id === "not-shorter"), "email 2 is longer than email 1 in SQL");
    const noEarlier = await checks.codeCheckDraft(tx, draft({ id: "e5-s2b", lead_id: "e5-l3", framework: "four-step", sequence_position: 2, subject: "", body_text: longer }));
    assert.ok(!noEarlier.hits.some((h) => h.id === "not-shorter"), "a lead with no email 1 has nothing to compare with");
    const first = await checks.codeCheckDraft(tx, draft({ id: "e5-s1", framework: "four-step", sequence_position: 1, subject: "plumbing", body_text: longer }));
    assert.ok(!first.hits.some((h) => h.id === "not-shorter"), "step 1 has no earlier step");
  }));

  test("rating already used: another message to the lead (social, or an earlier four-step email) counts; another lead's does not", () => withFx(async (tx) => {
    const rated = "Your 4.8 rating on Google is the first thing I read. Would you like me to send a short recording of an assistant answering a call?";
    const alone = await checks.codeCheckDraft(tx, draft({ body_text: rated }));
    assert.ok(!alone.hits.some((h) => h.id === "rating-twice"), "first time: fine");
    await social(tx, { lead_id: "e5-l2", body: "I saw 4.8 stars on your page." });
    assert.ok(!(await checks.codeCheckDraft(tx, draft({ body_text: rated }))).hits.some((h) => h.id === "rating-twice"), "another lead's social message does not count");
    await social(tx, { lead_id: "e5-l1", body: "I saw 4.8 stars on your page." });
    const twice = await checks.codeCheckDraft(tx, draft({ body_text: rated }));
    assert.ok(twice.hits.some((h) => h.id === "rating-twice") && twice.status === "blocked", "the lead's social message used the rating already");
    await tx`delete from social_messages`;
    await em(tx, { id: "e5-r1", lead_id: "e5-l1", step: 1, framework: "four-step", sequence_total: 4, body_text: "Your 4.8 rating is clear. Would you like me to send a short recording?" });
    const viaEarlier = await checks.codeCheckDraft(tx, draft({ id: "e5-r2", framework: "four-step", sequence_position: 2, subject: "", body_text: rated }));
    assert.ok(viaEarlier.hits.some((h) => h.id === "rating-twice"), "an earlier four-step email used it");
    // As today, the lead's OTHER (non-earlier) emails are not read for the rating.
    await em(tx, { id: "e5-r3", lead_id: "e5-l3", step: 3, body_text: "Your 4.8 rating is clear." });
    assert.ok(!(await checks.codeCheckDraft(tx, draft({ lead_id: "e5-l3", id: "e5-r4", body_text: rated }))).hits.some((h) => h.id === "rating-twice"));
  }));

  test("the settings come from outreach_settings: a cleared free asset is a soft 'no asset' hit on a four-step email", () => withFx(async (tx) => {
    await tx`update outreach_settings set data = data || '{"free_asset_1": ""}'::jsonb where key = 'settings'`;
    const r = await checks.codeCheckDraft(tx, draft({ framework: "four-step", sequence_position: 1, body_text: BODY }));
    assert.ok(r.hits.some((h) => h.id === "no-asset"));
  }));
});

describe("recheckStaleDrafts: the twin of recheckDraftRows", () => {
  test("only drafted rows of an older rules version: a hard hit blocks and is saved; a clean one is only stamped; near-misses untouched", () => withFx(async (tx) => {
    const bad = await em(tx, { body_text: HARD_BODY, rules_version: OLD_VERSION, review_status: "ready", review_reasons: null, lead_id: "e5-l1" });
    const clean = await em(tx, { rules_version: null, review_status: "check", lead_id: "e5-l2", to_email: "second@madeup-test.com", step: 1 });
    const current = await em(tx, { body_text: HARD_BODY, rules_version: rules.RULES_VERSION, review_status: "ready", lead_id: "e5-l3", to_email: "third@madeup-test.com" });
    const sent = await em(tx, { body_text: HARD_BODY, rules_version: OLD_VERSION, status: "sent", lead_id: "e5-flag", to_email: "flag@madeup-test.com" });
    const before = await tx`select * from emails where id in (${current}, ${sent}) order by id`;
    const rows = (await tx`select * from emails where campaign_id = ${CID}`).map((r) => ({ ...r, sequence_position: r.step }));
    const out = await checks.recheckStaleDrafts(tx, rows);
    assert.deepEqual(out.map((d) => d.id), [bad], "one downgrade, the hard one");
    assert.equal(out[0].was, "ready");
    const b = await row(tx, bad);
    assert.equal(b.review_status, "blocked");
    assert.equal(b.reviewed_by, "code checks");
    assert.ok(b.reviewed_at && b.review_reasons.length > 0);
    assert.equal(b.rules_version, rules.RULES_VERSION);
    const c = await row(tx, clean);
    assert.equal(c.rules_version, rules.RULES_VERSION);
    assert.equal(c.review_status, "check", "stamped only, status unchanged");
    assert.deepEqual(await tx`select * from emails where id in (${current}, ${sent}) order by id`, before, "current-version and sent rows are not touched");
  }));
});

// ── emails.list ───────────────────────────────────────────────────────────

describe("outreach.emails.list", () => {
  test("same annotations as today: old rows, lead skipped, do-not-contact by lead and by address, contacts; each with a near-miss", () => withFx(async (tx) => {
    const oldRow = await em(tx, { lead_id: "e5-l1", review_status: null });
    const readyWithReasons = await em(tx, { lead_id: "e5-l2", to_email: "second@madeup-test.com", review_status: "ready", review_reasons: ["a reason"], reviewed_by: "gemini-x" });
    const readyByYou = await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com", review_status: "ready", review_reasons: ["a reason"], reviewed_by: "you" });
    const skipped = await em(tx, { lead_id: "e5-excl", to_email: "excl@madeup-test.com" });
    const skippedSent = await em(tx, { lead_id: "e5-excl", to_email: "excl@madeup-test.com", status: "sent", step: 2 });
    const dncById = await em(tx, { lead_id: "e5-dnc", to_email: "somewhere-else@madeup-test.com" });
    const dncByMail = await em(tx, { lead_id: "e5-flag", to_email: "DNC@madeup-test.com" });
    const plain = await em(tx, { lead_id: "e5-kept", to_email: "kept@madeup-test.com" });
    const list = await run(tx, "emails.list", { campaign_id: CID });
    const by = Object.fromEntries(list.map((e) => [e.id, e]));
    assert.equal(by[oldRow].review_status, "check");
    assert.deepEqual(by[oldRow].review_reasons, ["Not reviewed yet"]);
    assert.equal(by[readyWithReasons].review_status, "check", "ready with reasons shows as check");
    assert.equal(by[readyByYou].review_status, "ready", "unless you marked it ready yourself");
    assert.equal(by[skipped].blocked_lead_skipped, true);
    assert.equal(by[skippedSent].blocked_lead_skipped, undefined, "a sent email is not annotated");
    assert.equal(by[dncById].blocked_do_not_contact, true);
    assert.equal(by[dncByMail].blocked_do_not_contact, true, "by address, whatever lead it belongs to");
    assert.equal(by[plain].blocked_do_not_contact, undefined);
    assert.equal(by[plain].blocked_lead_skipped, undefined);
    assert.equal(by[oldRow].sequence_position, 1, "step comes back as sequence_position");
    assert.equal(by[oldRow].step, undefined);
  }));

  test("do-not-contact across campaigns: a lead of ANOTHER campaign with that address blocks it here", () => withFx(async (tx) => {
    await tx`insert into leads (id, campaign_id, name, email, email_key, stop_state, do_not_contact, data) values ('e5-elsewhere', 'e5-other-camp', 'Elsewhere Made-up', 'owner@madeup-test.com', 'owner@madeup-test.com', 'do_not_contact', false, '{}')`;
    const id = await em(tx, { lead_id: "e5-l1" });
    const e = (await run(tx, "emails.list", { campaign_id: CID })).find((x) => x.id === id);
    assert.equal(e.blocked_do_not_contact, true, "stop_state do_not_contact on that address, in another campaign");
    await tx`update leads set stop_state = 'bounced' where id = 'e5-elsewhere'`;
    assert.equal((await run(tx, "emails.list", { campaign_id: CID })).find((x) => x.id === id).blocked_do_not_contact, undefined, "a bounce is not do-not-contact");
  }));

  test("contacts: emailed from ANOTHER campaign blocks, from this one does not; a test lead is not blocked, a bounce always is", () => withFx(async (tx) => {
    await tx`insert into contacts (blob_key, kind, email, campaign_id) values ('sent/second@madeup-test.com/other', 'sent', 'second@madeup-test.com', 'other'), ('sent/third@madeup-test.com/e5-camp', 'sent', 'third@madeup-test.com', ${CID}), ('bounced/owner@madeup-test.com', 'bounced', 'owner@madeup-test.com', '')`;
    const a = await em(tx, { lead_id: "e5-l2", to_email: "second@madeup-test.com" });
    const b = await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com" });
    const c = await em(tx, { lead_id: "e5-l1", to_email: "owner@madeup-test.com" });
    const list = await run(tx, "emails.list", { campaign_id: CID });
    const by = Object.fromEntries(list.map((e) => [e.id, e]));
    assert.match(by[a].blocked_contact, /already contacted in another campaign/);
    assert.equal(by[b].blocked_contact, undefined, "emailed earlier in THIS campaign is a follow-up, not a block");
    assert.match(by[c].blocked_contact, /bounced earlier/);
  }));

  test("merged leads' emails and duplicate rows are left out; newest first; limit defaults to 500 and is honoured", () => withFx(async (tx) => {
    const old = await em(tx, { created_at: new Date("2026-01-01T00:00:00Z"), lead_id: "e5-l1" });
    const mid = await em(tx, { created_at: new Date("2026-02-01T00:00:00Z"), lead_id: "e5-l2", to_email: "second@madeup-test.com" });
    const top = await em(tx, { created_at: new Date("2026-03-01T00:00:00Z"), lead_id: "e5-l3", to_email: "third@madeup-test.com" });
    const merged = await em(tx, { lead_id: "e5-merged", to_email: "merged@madeup-test.com" });
    const dup = await em(tx, { lead_id: "e5-l1", is_duplicate: true });
    const list = await run(tx, "emails.list", { campaign_id: CID });
    assert.deepEqual(list.map((e) => e.id), [top, mid, old]);
    assert.ok(!list.some((e) => e.id === merged || e.id === dup));
    assert.deepEqual((await run(tx, "emails.list", { campaign_id: CID, limit: 2 })).map((e) => e.id), [top, mid]);
    assert.deepEqual(await run(tx, "emails.list", { campaign_id: "no-such-campaign" }), []);
    await refused(run(tx, "emails.list", {}), 400, undefined, /campaign_id required/);
  }));

  test("an older draft is re-checked first and saved (F1: read straight back), once", () => withFx(async (tx) => {
    const bad = await em(tx, { body_text: HARD_BODY, rules_version: OLD_VERSION, review_status: "ready" });
    const e = (await run(tx, "emails.list", { campaign_id: CID })).find((x) => x.id === bad);
    assert.equal(e.review_status, "blocked");
    const r = await row(tx, bad);
    assert.deepEqual([r.review_status, r.reviewed_by, r.rules_version], ["blocked", "code checks", rules.RULES_VERSION]);
    await tx`update emails set review_status = 'check', reviewed_by = null where id = ${bad}`;
    assert.equal((await run(tx, "emails.list", { campaign_id: CID })).find((x) => x.id === bad).review_status, "check", "not re-checked again at the current version");
  }));

  test("the answer carries the old record's fields: dates as text, data fields, written_by as the model name", () => withFx(async (tx) => {
    const id = await em(tx, { written_by: "gemini", written_model: "gemini-test-model", data: { fact_used: 3, original_to_email: "old@madeup-test.com" }, framework: "four-step", sequence_total: 4 });
    const e = (await run(tx, "emails.list", { campaign_id: CID })).find((x) => x.id === id);
    assert.equal(e.fact_used, 3);
    assert.equal(e.original_to_email, "old@madeup-test.com");
    assert.equal(e.written_by, "gemini-test-model");
    assert.equal(e.sequence_total, 4);
    assert.equal(typeof e.created_at, "string");
    assert.equal(e.to_key, undefined, "no database-only columns");
  }));
});

// ── emails.create (A4, F46, F9) ───────────────────────────────────────────

describe("outreach.emails.create", () => {
  const P = { campaign_id: CID, lead_id: "e5-l1", subject: "  plumbing  ", body_text: `  ${BODY}  ` };

  test("never calls AI: deps that throw on any use still let create work, for her and for an agent; both are read straight back (F1)", () => withFx(async (tx) => {
    const mine = await run(tx, "emails.create", P, forbidden(), ctxOf(false));
    assert.equal(mine.status, "drafted");
    assert.equal(mine.subject, "plumbing");
    assert.equal(mine.body_text, BODY);
    assert.equal(mine.sequence_position, 1);
    assert.equal(mine.written_by, "lakshmi");
    assert.equal(mine.source, "hand_written");
    assert.ok(Array.isArray(mine.fit_flags));
    const r = await row(tx, mine.id);
    assert.deepEqual([r.subject, r.body_text, r.status, r.step, r.written_by, r.source, r.to_email, r.lead_id, r.framework], ["plumbing", BODY, "drafted", 1, "lakshmi", "hand_written", "owner@madeup-test.com", "e5-l1", "one-off"]);
    assert.ok(r.body_html.includes("<p>"), "html built from the text");
    const agent = await run(tx, "emails.create", { ...P, lead_id: "e5-l2" }, forbidden(), ctxOf(true));
    const ra = await row(tx, agent.id);
    assert.deepEqual([ra.written_by, ra.source], ["claude", "agent_drafted"]);
    const listed = (await run(tx, "emails.list", { campaign_id: CID })).map((e) => e.id);
    assert.ok(listed.includes(mine.id) && listed.includes(agent.id));
    assert.equal((await tx`select count(*)::int n from activity where details->>'email_id' = ${mine.id}`)[0].n, 1, "an activity entry, as today");
    const c = await campaigns.get(tx, CID);
    assert.equal(c.emails_generated, 2, "the campaign counts it (counted, not stored)");
  }));

  test("validation as today: required fields, campaign, lead, address", () => withFx(async (tx) => {
    await refused(run(tx, "emails.create", { ...P, campaign_id: "" }), 400, undefined, /campaign_id required/);
    await refused(run(tx, "emails.create", { ...P, lead_id: undefined }), 400, undefined, /lead_id required/);
    await refused(run(tx, "emails.create", { ...P, subject: "   " }), 400, undefined, /subject required/);
    await refused(run(tx, "emails.create", { ...P, body_text: "" }), 400, undefined, /body_text required/);
    await refused(run(tx, "emails.create", { ...P, campaign_id: "no-such" }), 404, undefined, /campaign not found/);
    await refused(run(tx, "emails.create", { ...P, lead_id: "no-such" }), 404, undefined, /lead not found/);
    await refused(run(tx, "emails.create", { ...P, lead_id: "e5-merged" }), 404, undefined, /lead not found/);
    await refused(run(tx, "emails.create", { ...P, lead_id: "e5-noemail" }), 400, undefined, /no email address/);
    assert.equal((await tx`select count(*)::int n from emails where campaign_id = ${CID}`)[0].n, 0, "nothing was written by any refusal");
  }));

  test("a do-not-contact lead is refused with code do_not_contact; a lead that is only excluded is not", () => withFx(async (tx) => {
    await refused(run(tx, "emails.create", { ...P, lead_id: "e5-dnc" }, forbidden()), 400, "do_not_contact");
    const ok = await run(tx, "emails.create", { ...P, lead_id: "e5-excl" }, forbidden());
    assert.equal(ok.status, "drafted");
  }));

  test("F46: a flagged lead is refused for an agent (fit_flagged, with the reason), allowed for her with fit_flags; kept leads are allowed for both", () => withFx(async (tx) => {
    await refused(run(tx, "emails.create", { ...P, lead_id: "e5-flag" }, forbidden(), ctxOf(true)), 400, "fit_flagged", /Check first/);
    assert.equal((await tx`select count(*)::int n from emails where lead_id = 'e5-flag'`)[0].n, 0);
    const mine = await run(tx, "emails.create", { ...P, lead_id: "e5-flag" }, forbidden(), ctxOf(false));
    assert.equal(mine.status, "drafted");
    assert.ok(mine.fit_flags.some((f) => f.code === "too_big"), "the flags come back on the answer");
    assert.equal((await row(tx, mine.id)).written_by, "lakshmi");
    const kept = await run(tx, "emails.create", { ...P, lead_id: "e5-kept" }, forbidden(), ctxOf(true));
    assert.equal(kept.status, "drafted", "kept by me: an agent may write it");
    const plain = await run(tx, "emails.create", { ...P, lead_id: "e5-l2" }, forbidden(), ctxOf(true));
    assert.deepEqual(plain.fit_flags, []);
  }));

  test("F9: a second create for a drafted step updates that draft in place (same id, replaced: true, edited, checks re-run); read back", () => withFx(async (tx) => {
    const first = await run(tx, "emails.create", P, forbidden(), ctxOf(true));
    assert.equal(first.replaced, undefined);
    const second = await run(tx, "emails.create", { ...P, subject: "roofing", body_text: HARD_BODY }, forbidden(), ctxOf(false));
    assert.equal(second.id, first.id);
    assert.equal(second.replaced, true);
    const r = await row(tx, first.id);
    assert.deepEqual([r.subject, r.body_text, r.edited, r.written_by, r.source, r.review_status, r.reviewed_by], ["roofing", HARD_BODY, true, "lakshmi", "hand_written", "blocked", "code checks"]);
    assert.equal((await tx`select count(*)::int n from emails where lead_id = 'e5-l1' and step = 1`)[0].n, 1, "still one row for that lead and step");
    const list = await run(tx, "emails.list", { campaign_id: CID });
    assert.equal(list.filter((e) => e.lead_id === "e5-l1").length, 1);
    // A different step of the same lead is a new draft.
    const step2 = await run(tx, "emails.create", { ...P, sequence_position: 2, framework: "four-step" }, forbidden());
    assert.notEqual(step2.id, first.id);
    assert.deepEqual([step2.sequence_position, step2.sequence_total, step2.framework], [2, 4, "four-step"]);
  }));

  test("F9: a step that is already sent refuses with 409 draft_exists and the email id; so does any other non-failed status; a failed one does not block", () => withFx(async (tx) => {
    const sent = await em(tx, { lead_id: "e5-l1", step: 1, status: "sent" });
    await assert.rejects(run(tx, "emails.create", P, forbidden()), (e) => e.status === 409 && e.code === "draft_exists" && e.email_id === sent && e.message.includes(sent));
    await tx`update emails set status = 'delivered' where id = ${sent}`;
    await refused(run(tx, "emails.create", P, forbidden()), 409, "draft_exists");
    await tx`update emails set status = 'failed' where id = ${sent}`;
    const again = await run(tx, "emails.create", P, forbidden());
    assert.equal(again.status, "drafted");
    assert.equal((await tx`select count(*)::int n from emails where lead_id = 'e5-l1' and step = 1`)[0].n, 2, "the failed row is history, the new draft is the live one");
  }));

  test("F9 race: a row that lands between the check and the insert (unique index) answers 409 draft_exists with the id, never a 500", () => withFx(async (tx) => {
    let raced = null;
    // Run the competing insert just before create's own INSERT into emails.
    const proxy = new Proxy(tx, {
      apply(target, thisArg, args) {
        const text = Array.isArray(args[0]) ? args[0].join(" ") : "";
        if (/insert into emails/i.test(text) && !raced) {
          raced = "e5-racer";
          return (async () => { await em(tx, { id: raced, lead_id: "e5-l1", step: 1, status: "sending" }); return Reflect.apply(target, thisArg, args); })();
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    await assert.rejects(run(proxy, "emails.create", P, forbidden()), (e) => e.status === 409 && e.code === "draft_exists" && e.email_id === "e5-racer" && e.message.includes("e5-racer"));
    assert.equal((await tx`select count(*)::int n from emails where lead_id = 'e5-l1' and step = 1 and status <> 'failed'`)[0].n, 1);
  }));

  test("code checks run on save: a hard hit is saved as Blocked by 'code checks'; a clean draft is 'check'", () => withFx(async (tx) => {
    const bad = await run(tx, "emails.create", { ...P, body_text: HARD_BODY }, forbidden());
    assert.equal(bad.review_status, "blocked");
    const r = await row(tx, bad.id);
    assert.deepEqual([r.review_status, r.reviewed_by, r.rules_version], ["blocked", "code checks", rules.RULES_VERSION]);
    assert.ok(r.review_reasons.length > 0);
    const good = await run(tx, "emails.create", { ...P, lead_id: "e5-l2" }, forbidden());
    assert.equal(good.review_status, "check");
    assert.deepEqual(good.review_reasons, ["Not reviewed yet"]);
  }));

  test("it remembers the sender defaults, as the old state did (only the given columns of the campaign; updated_at untouched)", () => withFx(async (tx) => {
    const before = (await tx`select updated_at from campaigns where id = ${CID}`)[0].updated_at;
    await run(tx, "emails.create", { ...P, sender_name: "New Sender", framework: "four-step" }, forbidden());
    const [c] = await tx`select default_sender_name, default_framework, default_sequence_total, updated_at from campaigns where id = ${CID}`;
    assert.deepEqual([c.default_sender_name, c.default_framework, c.default_sequence_total], ["New Sender", "four-step", 4]);
    assert.equal(c.updated_at.getTime(), before.getTime());
  }));
});

// ── emails.update / emails.delete ─────────────────────────────────────────

describe("outreach.emails.update and delete", () => {
  test("update: only drafts; subject, body and html; edited; checks run; each read straight back (F1)", () => withFx(async (tx) => {
    const id = await em(tx, { review_status: "ready", reviewed_by: "gemini-x" });
    const r = await run(tx, "emails.update", { campaign_id: CID, email_id: id, subject: " roofing ", body_text: `${BODY} Thanks.` });
    assert.equal(r.subject, "roofing");
    assert.equal(r.edited, true);
    assert.equal(r.review_status, "check");
    assert.equal(r.reviewed_by, undefined);
    assert.ok(r.review_reasons[0].startsWith("You edited this draft"));
    const db = await row(tx, id);
    assert.deepEqual([db.subject, db.body_text, db.edited, db.review_status, db.reviewed_by, db.reviewed_at], ["roofing", `${BODY} Thanks.`, true, "check", null, null]);
    assert.equal(db.body_html, outreach.textToHtml(`${BODY} Thanks.`), "html rebuilt from the new text");
    await tx`update emails set status = 'sent' where id = ${id}`;
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: id, subject: "x" }), 400, undefined, /only drafted emails can be edited \(this one is sent\)/);
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: "no-such", subject: "x" }), 404, undefined, /email not found/);
    await refused(run(tx, "emails.update", { campaign_id: CID }), 400, undefined, /campaign_id and email_id required/);
  }));

  test("update: a hard hit on edit saves Blocked; refusals for bad input write nothing", () => withFx(async (tx) => {
    const id = await em(tx, { review_status: "check" });
    const r = await run(tx, "emails.update", { campaign_id: CID, email_id: id, body_text: HARD_BODY });
    assert.equal(r.review_status, "blocked");
    assert.equal((await row(tx, id)).reviewed_by, "code checks");
    const before = await row(tx, id);
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: id, review_status: "blocked" }), 400, undefined, /can only be set to "ready"/);
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: id, to_email: "not an address" }), 400, undefined, /not a valid email/);
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: id, subject: "   " }), 400, undefined, /subject cannot be empty/);
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: id, body_text: "  " }), 400, undefined, /body cannot be empty/);
    assert.deepEqual(await row(tx, id), before);
  }));

  test("update: an address change keeps the first address as original_to_email (and not the second time)", () => withFx(async (tx) => {
    const id = await em(tx, {});
    await run(tx, "emails.update", { campaign_id: CID, email_id: id, to_email: " New.Owner@MadeUp-Test.com " });
    let db = await row(tx, id);
    assert.deepEqual([db.to_email, db.to_key, db.data.original_to_email], ["new.owner@madeup-test.com", "new.owner@madeup-test.com", "owner@madeup-test.com"]);
    await run(tx, "emails.update", { campaign_id: CID, email_id: id, to_email: "third.owner@madeup-test.com" });
    db = await row(tx, id);
    assert.equal(db.data.original_to_email, "owner@madeup-test.com");
    const same = await run(tx, "emails.update", { campaign_id: CID, email_id: id, to_email: "third.owner@madeup-test.com" });
    assert.equal(same.to_email, "third.owner@madeup-test.com");
  }));

  test("update: mark ready is refused while a hard hit remains (and the draft is saved as Blocked), allowed when clean; blocked drafts need an edit", () => withFx(async (tx) => {
    const hard = await em(tx, { body_text: HARD_BODY, review_status: "check" });
    await assert.rejects(run(tx, "emails.update", { campaign_id: CID, email_id: hard, review_status: "ready" }), (e) => e.status === 400 && /Cannot mark this ready/.test(e.message) && e.keep === true);
    const db = await row(tx, hard);
    assert.deepEqual([db.review_status, db.reviewed_by], ["blocked", "code checks"], "saved as blocked, as the old code did");
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: hard, review_status: "ready" }), 400, undefined, /Cannot mark this ready/);
    const clean = await em(tx, { lead_id: "e5-l2", to_email: "second@madeup-test.com", review_status: "check" });
    const r = await run(tx, "emails.update", { campaign_id: CID, email_id: clean, review_status: "ready" });
    assert.deepEqual([r.review_status, r.reviewed_by, r.review_reasons], ["ready", "you", []]);
    const c = await row(tx, clean);
    assert.deepEqual([c.review_status, c.reviewed_by, c.edited], ["ready", "you", true]);
    const blockedStored = await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com", review_status: "blocked", review_reasons: ["a stored reason"] });
    await refused(run(tx, "emails.update", { campaign_id: CID, email_id: blockedStored, review_status: "ready" }), 400, undefined, /it is Blocked \(a stored reason\)/);
  }));

  test("delete: only drafts; gone at once (F1); the campaign's emails_generated drops because it is counted, sent emails stay", () => withFx(async (tx) => {
    const a = await em(tx, { lead_id: "e5-l1" });
    const b = await em(tx, { lead_id: "e5-l2", to_email: "second@madeup-test.com" });
    const sent = await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com", status: "sent" });
    assert.equal((await campaigns.get(tx, CID)).emails_generated, 3);
    assert.deepEqual(await run(tx, "emails.delete", { campaign_id: CID, email_id: a }), { deleted: true });
    assert.equal(await row(tx, a), undefined);
    assert.ok(!(await run(tx, "emails.list", { campaign_id: CID })).some((e) => e.id === a));
    assert.equal((await campaigns.get(tx, CID)).emails_generated, 2);
    await refused(run(tx, "emails.delete", { campaign_id: CID, email_id: sent }), 400, undefined, /only drafted emails can be deleted \(this one is sent\)/);
    await refused(run(tx, "emails.delete", { campaign_id: CID, email_id: a }), 404, undefined, /email not found/);
    await refused(run(tx, "emails.delete", { campaign_id: CID }), 400, undefined, /campaign_id and email_id required/);
    assert.ok(await row(tx, b) && await row(tx, sent));
  }));
});

// ── footer.preview (R9) ───────────────────────────────────────────────────

describe("outreach.footer.preview", () => {
  const expected = (body, postal, sender) => { const f = outreach.appendFooter(body, "", postal, sender); return f.text.slice(body.trimEnd().length).trim(); };

  test("the same text as appendFooter (sender from the email, else the campaign's default); no warning when the address is saved", () => withFx(async (tx) => {
    const id = await em(tx, {});
    const r = await run(tx, "footer.preview", { campaign_id: CID, email_id: id });
    assert.equal(r.footer_text, expected(BODY, SETTINGS.postal_address, "Made-up Sender"));
    assert.ok(r.footer_text.includes("1 Made Up Street"));
    assert.equal(r.postal_address_missing, undefined);
    assert.equal(r.warning, undefined);
    await tx`update emails set sender_name = null where id = ${id}`;
    assert.equal((await run(tx, "footer.preview", { campaign_id: CID, email_id: id })).footer_text, expected(BODY, SETTINGS.postal_address, "Made-up Sender"), "campaign default sender");
    await refused(run(tx, "footer.preview", { campaign_id: CID, email_id: "no-such" }), 404, undefined, /email not found/);
    await refused(run(tx, "footer.preview", { campaign_id: CID }), 400, undefined, /campaign_id and email_id required/);
  }));

  test("R9: the US needs a postal address; blank (or only spaces) gives postal_address_missing and a warning, with the same footer text", () => withFx(async (tx) => {
    const id = await em(tx, {});
    await tx`update outreach_settings set data = data || '{"postal_address": "   "}'::jsonb where key = 'settings'`;
    const r = await run(tx, "footer.preview", { campaign_id: CID, email_id: id });
    assert.equal(r.postal_address_missing, true);
    assert.match(r.warning, /postal address/i);
    assert.equal(r.footer_text, expected(BODY, "   ", "Made-up Sender"));
    await tx`delete from outreach_settings where key = 'settings'`;
    assert.equal((await run(tx, "footer.preview", { campaign_id: CID, email_id: id })).postal_address_missing, true, "no settings at all is blank too");
  }));

  test("R9 off: a country that does not need the address gives no warning even when blank; a campaign with no country counts as US", () => withFx(async (tx) => {
    const id = await em(tx, {});
    await tx`update outreach_settings set data = data || '{"postal_address": ""}'::jsonb where key = 'settings'`;
    await tx`update country_profiles set postal_address_required = false where code = 'US'`;
    const off = await run(tx, "footer.preview", { campaign_id: CID, email_id: id });
    assert.equal(off.postal_address_missing, undefined);
    assert.equal(off.warning, undefined);
    await tx`update country_profiles set postal_address_required = true where code = 'US'`;
    await tx`update campaigns set country = null where id = ${CID}`;
    assert.equal((await run(tx, "footer.preview", { campaign_id: CID, email_id: id })).postal_address_missing, true);
  }));
});

// ── generate_one ──────────────────────────────────────────────────────────

describe("outreach.emails.generate_one", () => {
  const P = { campaign_id: CID, lead_id: "e5-l1", sender_name: "Made-up Sender", step: 1, framework: "one-off" };

  test("writes through deps.writeDraft, saves a draft (gemini, the model, 'Not reviewed yet'), and reads straight back (F1); asking again returns it as skipped", () => withFx(async (tx) => {
    const deps = stubs();
    const r = await run(tx, "emails.generate_one", P, deps);
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].lead.id, "e5-l1");
    assert.equal(r.status, "drafted");
    assert.equal(r.skipped, undefined);
    const db = await row(tx, r.id);
    assert.deepEqual([db.subject, db.body_text, db.written_by, db.written_model, db.review_status, db.step, db.to_email, db.framework, db.sequence_total], ["plumbing", BODY, "gemini", "gemini-test-model", "check", 1, "owner@madeup-test.com", "one-off", 1]);
    assert.deepEqual(db.review_reasons, ["Not reviewed yet"]);
    assert.ok((await run(tx, "emails.list", { campaign_id: CID })).some((e) => e.id === r.id));
    const again = await run(tx, "emails.generate_one", P, deps);
    assert.equal(again.id, r.id);
    assert.equal(again.skipped, true);
    assert.equal(deps.calls.length, 1, "no second AI call for a step that already has a draft");
    const sent = await em(tx, { lead_id: "e5-l2", to_email: "second@madeup-test.com", status: "sent", step: 1 });
    const viaSent = await run(tx, "emails.generate_one", { ...P, lead_id: "e5-l2" }, deps);
    assert.deepEqual([viaSent.id, viaSent.skipped], [sent, true]);
    assert.equal(deps.calls.length, 1);
  }));

  test("F32: a flagged lead is refused with fit_flagged BEFORE the writer is called; kept by me is allowed", () => withFx(async (tx) => {
    const deps = stubs();
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-flag" }, deps), 400, "fit_flagged", /Check first/);
    assert.equal(deps.calls.length, 0, "the AI was never called");
    assert.equal((await tx`select count(*)::int n from emails where lead_id = 'e5-flag'`)[0].n, 0);
    const ok = await run(tx, "emails.generate_one", { ...P, lead_id: "e5-kept" }, deps);
    assert.equal(ok.status, "drafted");
    assert.equal(deps.calls.length, 1);
  }));

  test("the old refusals, in the old order: AI missing, ids, campaign, lead, address, do-not-contact, skipped lead, contacts", () => withFx(async (tx) => {
    const deps = stubs();
    await refused(run(tx, "emails.generate_one", P, stubs({ aiAvailable: async () => false })), 400, undefined, /Gemini key not configured/);
    await refused(run(tx, "emails.generate_one", { ...P, campaign_id: "" }, deps), 400, undefined, /campaign_id required/);
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "" }, deps), 400, undefined, /lead_id required/);
    await refused(run(tx, "emails.generate_one", { ...P, campaign_id: "no-such" }, deps), 404, undefined, /campaign not found/);
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "no-such" }, deps), 404, undefined, /lead not found/);
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-merged" }, deps), 404, undefined, /lead not found/);
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-noemail" }, deps), 400, undefined, /no email address/);
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-dnc" }, deps), 400, undefined, /do-not-contact/);
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-excl" }, deps), 400, "excluded", /no draft created/);
    await tx`insert into contacts (blob_key, kind, email, campaign_id) values ('sent/second@madeup-test.com/other', 'sent', 'second@madeup-test.com', 'other')`;
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-l2" }, deps), 400, "already_contacted", /already contacted/);
    await tx`update leads set email = 'dnc@madeup-test.com', email_key = 'dnc@madeup-test.com' where id = 'e5-l3'`;
    await refused(run(tx, "emails.generate_one", { ...P, lead_id: "e5-l3" }, deps), 400, undefined, /asked not to be contacted/);
    assert.equal(deps.calls.length, 0);
    assert.equal((await tx`select count(*)::int n from emails where campaign_id = ${CID}`)[0].n, 0);
  }));

  test("writer failures keep the old mapping (quota 429 with the kind as code, timeout 504, missing asset 400) and write nothing", () => withFx(async (tx) => {
    const fail = (kind, message = "boom") => stubs({ writeDraft: async () => { throw Object.assign(new Error(message), { kind }); } });
    await refused(run(tx, "emails.generate_one", P, fail("daily_quota")), 429, "daily_quota");
    await refused(run(tx, "emails.generate_one", P, fail("rate_limited")), 429, "rate_limited");
    await refused(run(tx, "emails.generate_one", P, fail("unavailable")), 503, "unavailable");
    await refused(run(tx, "emails.generate_one", P, fail("timeout")), 504, "timeout");
    await refused(run(tx, "emails.generate_one", P, fail("auth")), 502, "auth");
    await refused(run(tx, "emails.generate_one", P, stubs({ writeDraft: async () => { throw new Error("add a free asset in Settings"); } })), 400, "settings_missing");
    await refused(run(tx, "emails.generate_one", P, stubs({ writeDraft: async () => { throw new Error("odd"); } })), 500, undefined, /odd/);
    assert.equal((await tx`select count(*)::int n from emails where campaign_id = ${CID}`)[0].n, 0);
  }));

  test("a hard code hit on the written text is saved as Blocked by 'code checks'; the model name is optional", () => withFx(async (tx) => {
    const deps = stubs({ writeDraft: async () => ({ subject: "plumbing", body_text: HARD_BODY }) });
    const r = await run(tx, "emails.generate_one", P, deps);
    const db = await row(tx, r.id);
    assert.deepEqual([db.review_status, db.reviewed_by, db.written_by, db.written_model], ["blocked", "code checks", "gemini", null]);
    assert.ok(db.body_html.includes("<p>"), "html built when the writer gives none");
  }));

  test("four-step: one writer call can return all four steps; the missing ones are saved now, with step 1..4 and total 4; a lead that has step 2 keeps it", () => withFx(async (tx) => {
    await em(tx, { id: "e5-have2", lead_id: "e5-l1", step: 2, framework: "four-step", sequence_total: 4 });
    const deps = stubs({ writeDraft: async (input) => { deps.calls.push(input); return { subject: "plumbing", body_text: BODY, model: "gemini-test-model", steps: [1, 2, 3, 4].map((s) => ({ step: s, subject: s === 1 ? "plumbing" : "", body_text: `Step ${s}: ${BODY}` })) }; } });
    const r = await run(tx, "emails.generate_one", { ...P, framework: "four-step", step: 1 }, deps);
    assert.equal(deps.calls[0].have.includes(2), true, "the writer is told which steps exist");
    assert.equal(r.sequence_position, 1);
    const rows = await tx`select id, step, sequence_total, framework, body_text from emails where lead_id = 'e5-l1' order by step`;
    assert.deepEqual(rows.map((x) => x.step), [1, 2, 3, 4]);
    assert.ok(rows.every((x) => x.sequence_total === 4 && x.framework === "four-step"));
    assert.equal(rows[1].id, "e5-have2", "the existing step 2 was not replaced");
  }));

  test("it remembers the sender defaults on the campaign, like create", () => withFx(async (tx) => {
    await run(tx, "emails.generate_one", { ...P, sender_name: "Another Sender", sender_offer: "an offer" }, stubs());
    const [c] = await tx`select default_sender_name, default_sender_offer, default_framework, default_sequence_total from campaigns where id = ${CID}`;
    assert.deepEqual({ ...c }, { default_sender_name: "Another Sender", default_sender_offer: "an offer", default_framework: "one-off", default_sequence_total: 1 });
  }));
});

// ── generate (the older paced run) ────────────────────────────────────────

describe("outreach.emails.generate", () => {
  const P = { campaign_id: CID, sender_name: "Made-up Sender" };

  test("drafts one email for every sendable lead that has none; flagged leads are skipped and counted; read back (F1)", () => withFx(async (tx) => {
    await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com" }); // already has a draft
    const slept = [];
    const deps = stubs({ sleep: async (ms) => { slept.push(ms); } });
    const r = await run(tx, "emails.generate", P, deps);
    assert.deepEqual([r.generated, r.errors, r.remaining, r.stopped, r.skipped_flagged], [3, [], 0, null, 1]);
    assert.deepEqual(deps.calls.map((c) => c.lead.id).sort(), ["e5-kept", "e5-l1", "e5-l2"], "not flagged, not dnc, not excluded, not merged, not no-email, not already drafted");
    assert.equal(slept.length, 2, "paced: a pause between leads, none before the first");
    const rows = await tx`select lead_id, written_by, review_status, step from emails where campaign_id = ${CID} order by lead_id`;
    assert.deepEqual(rows.map((x) => x.lead_id), ["e5-kept", "e5-l1", "e5-l2", "e5-l3"]);
    assert.ok(rows.filter((x) => x.lead_id !== "e5-l3").every((x) => x.written_by === "gemini" && x.review_status === "check" && x.step === 1));
    assert.equal((await campaigns.get(tx, CID)).emails_generated, 4);
    const second = await run(tx, "emails.generate", P, stubs());
    assert.deepEqual([second.generated, second.skipped_flagged], [0, 1], "nothing new to draft; the flagged lead is still skipped");
  }));

  test("refusals: no AI, no campaign, nothing to draft (400); only flagged leads left answers 0 generated with skipped_flagged", () => withFx(async (tx) => {
    await refused(run(tx, "emails.generate", { campaign_id: "" }), 400, undefined, /campaign_id required/);
    await refused(run(tx, "emails.generate", P, stubs({ aiAvailable: async () => false })), 400, undefined, /Gemini key not configured/);
    await refused(run(tx, "emails.generate", { campaign_id: "no-such" }), 404, undefined, /campaign not found/);
    await tx`delete from leads where id not in ('e5-flag', 'e5-dnc', 'e5-excl')`;
    const only = await run(tx, "emails.generate", P);
    assert.deepEqual([only.generated, only.skipped_flagged], [0, 1]);
    await tx`delete from leads where id = 'e5-flag'`;
    await refused(run(tx, "emails.generate", P), 400, undefined, /No leads with email addresses that still need a draft/);
  }));

  test("time budget: when the next lead does not fit, the rest is reported as remaining; a daily quota stops the run", () => withFx(async (tx) => {
    let t = 0;
    const r = await run(tx, "emails.generate", P, stubs({ now: () => (t += 3000) - 3000 }));
    assert.equal(r.generated, 1, "one lead fits in the 18 s budget with 4.5 s pacing");
    assert.equal(r.remaining, 3, "four sendable leads, one done");
    assert.equal((await tx`select count(*)::int n from emails where campaign_id = ${CID}`)[0].n, 1);
    const quota = await run(tx, "emails.generate", P, stubs({ writeDraft: async () => { throw Object.assign(new Error("daily limit"), { kind: "daily_quota" }); } }));
    assert.deepEqual([quota.generated, quota.stopped, quota.remaining], [0, { code: "daily_quota", message: "daily limit" }, 3]);
    const other = await run(tx, "emails.generate", P, stubs({ writeDraft: async () => { throw new Error("one odd lead"); } }));
    assert.equal(other.errors.length, 3);
    assert.equal(other.errors[0].error, "one odd lead");
  }));
});

// ── draft.start and review.start ──────────────────────────────────────────

describe("outreach.draft.start and outreach.emails.review.start", () => {
  const job = async (tx, kind) => (await tx`select * from campaign_jobs where campaign_id = ${CID} and kind = ${kind}`)[0];

  test("draft.start plans in SQL (flagged, dnc, excluded, merged, no-email leads and existing drafts left out) and records the job; read back (F1)", () => withFx(async (tx) => {
    await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com", step: 1 });
    const r = await run(tx, "draft.start", { campaign_id: CID, framework: "one-off" });
    assert.equal(r.total, 3, "l1, l2 and the kept lead; l3 has its draft, the flagged lead is left out");
    assert.equal(typeof r.started_at, "string");
    const j = await job(tx, "generate");
    assert.deepEqual([j.status, j.total, j.done, j.made], ["running", 3, 0, 0]);
    const c = await campaigns.get(tx, CID);
    assert.deepEqual([c.job.kind, c.job.status, c.job.total], ["generate", "running", 3]);
    const plan = await emails.planDraftPairs(tx, CID, "one-off");
    assert.deepEqual(plan.pairs.map((p) => `${p.lead.id}:${p.step}`).sort(), ["e5-kept:1", "e5-l1:1", "e5-l2:1"]);
  }));

  test("draft.start: PAS has three steps per lead; four-step is one pair per lead lacking any step, with unit leads", () => withFx(async (tx) => {
    await tx`delete from leads where id not in ('e5-l1', 'e5-l2')`;
    await em(tx, { lead_id: "e5-l1", step: 1 });
    const pas = await emails.planDraftPairs(tx, CID, "pas");
    assert.deepEqual(pas.pairs.map((p) => `${p.lead.id}:${p.step}`), ["e5-l2:1", "e5-l1:2", "e5-l2:2", "e5-l1:3", "e5-l2:3"], "all step 1 first, then 2, then 3");
    assert.equal(pas.totalSteps, 3);
    const four = await emails.planDraftPairs(tx, CID, "four-step");
    assert.deepEqual(four.pairs.map((p) => `${p.lead.id}:${p.step}`), ["e5-l2:1", "e5-l1:2"], "one pair per lead, at its first missing step");
    await run(tx, "draft.start", { campaign_id: CID, framework: "four-step" });
    const j = await job(tx, "generate");
    assert.equal(j.total, 2);
    assert.deepEqual([j.data.unit, j.data.emails_per_lead], ["leads", 4]);
  }));

  test("draft.start refusals: AI, ids, campaign, nothing to draft, and 409 job_running while a job made progress in the last 4 minutes", () => withFx(async (tx) => {
    await refused(run(tx, "draft.start", { campaign_id: "" }), 400, undefined, /campaign_id required/);
    await refused(run(tx, "draft.start", { campaign_id: CID }, stubs({ aiAvailable: async () => false })), 400, undefined, /Gemini key not configured/);
    await refused(run(tx, "draft.start", { campaign_id: "no-such" }), 404, undefined, /campaign not found/);
    await run(tx, "draft.start", { campaign_id: CID });
    await refused(run(tx, "draft.start", { campaign_id: CID }), 409, "job_running", /already running/);
    await refused(run(tx, "emails.review.start", { campaign_id: CID }), 409, "job_running");
    await tx`update campaign_jobs set progress_at = now() - interval '5 minutes' where campaign_id = ${CID} and kind = 'generate'`;
    const again = await run(tx, "draft.start", { campaign_id: CID });
    assert.ok(again.total > 0, "a job with no progress for 4 minutes counts as interrupted");
    await tx`update campaign_jobs set status = 'done' where campaign_id = ${CID} and kind = 'generate'`;
    assert.ok((await run(tx, "draft.start", { campaign_id: CID })).total > 0, "a finished job does not block");
    await tx`delete from leads where id <> 'e5-noemail'`;
    await tx`update campaign_jobs set status = 'done' where campaign_id = ${CID}`;
    await refused(run(tx, "draft.start", { campaign_id: CID }), 400, undefined, /Nothing to draft/);
  }));

  test("draft.start restarts the job cleanly: the old run's message and failures are gone", () => withFx(async (tx) => {
    await campaigns.writeJob(tx, CID, "generate", { status: "stopped", total: 9, done: 4, message: "old stop", failures: [{ lead_id: "x" }] });
    await run(tx, "draft.start", { campaign_id: CID });
    const j = await job(tx, "generate");
    assert.deepEqual([j.status, j.done], ["running", 0]);
    assert.equal(j.data.message, undefined);
    assert.equal(j.data.failures, undefined);
  }));

  test("review.start: plans the drafts that are not ready (or the given ids), records a review job; none gives 400; read back (F1)", () => withFx(async (tx) => {
    const a = await em(tx, { lead_id: "e5-l1", review_status: "check" });
    const b = await em(tx, { lead_id: "e5-l2", to_email: "second@madeup-test.com", review_status: null });
    const ready = await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com", review_status: "ready" });
    await em(tx, { lead_id: "e5-l3", to_email: "third@madeup-test.com", step: 2, status: "sent", review_status: "check" });
    const r = await run(tx, "emails.review.start", { campaign_id: CID });
    assert.equal(r.total, 2);
    const j = await job(tx, "review");
    assert.deepEqual([j.status, j.total, j.done], ["running", 2, 0]);
    assert.deepEqual((await emails.planReview(tx, CID)).map((x) => x.id).sort(), [a, b].sort());
    assert.deepEqual((await emails.planReview(tx, CID, [ready, a])).map((x) => x.id).sort(), [a, ready].sort(), "the ticked ones, even a ready one");
    await tx`update campaign_jobs set status = 'done' where campaign_id = ${CID}`;
    const ids = await run(tx, "emails.review.start", { campaign_id: CID, email_ids: [ready, "no-such-id", 5] });
    assert.equal(ids.total, 1);
    await tx`update campaign_jobs set status = 'done' where campaign_id = ${CID}`;
    await tx`update emails set review_status = 'ready' where campaign_id = ${CID}`;
    await refused(run(tx, "emails.review.start", { campaign_id: CID }), 400, undefined, /No drafts to review/);
    await refused(run(tx, "emails.review.start", { campaign_id: "" }), 400, undefined, /campaign_id required/);
    await refused(run(tx, "emails.review.start", { campaign_id: CID }, stubs({ aiAvailable: async () => false })), 400, undefined, /No AI provider is set up/);
    await refused(run(tx, "emails.review.start", { campaign_id: "no-such" }), 404, undefined, /campaign not found/);
  }));

  test("a job write never touches the campaigns row (F2)", () => withFx(async (tx) => {
    await em(tx, { review_status: "check" });
    const snap = async () => JSON.stringify((await tx`select * from campaigns where id = ${CID}`)[0]);
    const before = await snap();
    await run(tx, "emails.review.start", { campaign_id: CID });
    await run(tx, "draft.start", { campaign_id: CID, framework: "one-off" }).catch((e) => { if (e.status !== 409) throw e; });
    assert.equal(await snap(), before);
  }));
});

describe("runEmailAction", () => {
  test("an unknown action is refused, and the nine actions are all exported", async () => {
    assert.deepEqual([...emails.EMAIL_ACTIONS].sort(), ["outreach.draft.start", "outreach.emails.create", "outreach.emails.delete", "outreach.emails.generate", "outreach.emails.generate_one", "outreach.emails.list", "outreach.emails.review.start", "outreach.emails.update", "outreach.footer.preview"]);
    await n.callWrite(async (tx) => { await assert.rejects(emails.runEmailAction(tx, "outreach.emails.nope", {}, stubs(), ctxOf()), (e) => e.status === 400); });
  });
});
