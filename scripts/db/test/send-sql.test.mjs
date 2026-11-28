// Chunk 6 on Neon dev, every transaction rolled back: the send plan, send.today and emails.send (lib/sql/send.ts, migration 0013).
// All data is made up and inserted inside the transaction. `run = (fn) => fn(tx)` makes every step of send.ts run in the
// test's own transaction. AgentMail is a stub that records each call; a real fetch is refused for the whole file.
// Covers C1 (plan), C2 (send.today), F1 (read back), F7 (bounce is email only), F45 (claim before sending), R2 (a failed
// send is not a bounce), R9 (postal address).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const CID = "s6-camp";
const CID2 = "s6-camp2";
const DAY = "2027-03-15"; // a Monday far from today, no sends on dev
const OWN = "me@madeup-own.test";
let n, send, campaigns, rules;
let seq = 0;
let realFetch;

before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  send = await import("../../../netlify/functions/lib/sql/send.ts");
  campaigns = await import("../../../netlify/functions/lib/sql/campaigns.ts");
  rules = await import("../../../netlify/functions/lib/messagerules.ts");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

// ── fixtures ──────────────────────────────────────────────────────────────

const SETTINGS = { postal_address: "1 Made Up Street, Katy, TX 77449", time_zone: "America/Chicago", daily_send_limit: 30, follow_up_gaps_email: [3, 8, 15] };
const BODY = "Hello Made-up Plumbing team. I noticed your plumbing crew works around Katy. Would you like me to send a short recording of an assistant answering a call?";
const HTML = '<p>Hello Made-up Plumbing team. See <a href="https://madeup-link.test/page">this page</a>.</p>';

async function seed(tx, { settings = {} } = {}) {
  for (const id of [CID, CID2]) {
    await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
             values (${id}, ${id}, ${`Made-up Campaign ${id}`}, 'plumber', 'Katy, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), ${tx.json({})})`;
  }
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ ...SETTINGS, ...settings })}) on conflict (key) do update set data = excluded.data`;
}
let leadN = 0;
async function lead(tx, id, o = {}) {
  const email = o.email === undefined ? `${id}@madeup-test.com` : o.email;
  await tx`insert into leads ${tx({
    id, campaign_id: o.campaign_id ?? CID, blob_key: `${o.campaign_id ?? CID}/${id}`, name: `Made-up Plumbing ${id}`, email, email_key: email, category: "Plumber",
    address: "1 Made Up St, Katy, TX 77449", reviews_count: 20, do_not_contact: o.do_not_contact ?? false, stop_state: o.stop_state ?? "none",
    excluded: o.excluded ?? false, merged_into: o.merged_into ?? null, is_test: o.is_test ?? false, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++leadN)), data: tx.json({}),
  })}`;
  return id;
}
/** A lead and its email row in one go. Defaults: ready, step 1, one-off. */
async function em(tx, o = {}) {
  const id = o.id ?? `s6-m${++seq}`;
  const lead_id = o.lead_id ?? `s6-l-${id.replace(/^s6-/, "")}`;
  if (!o.noLead) await lead(tx, lead_id, { email: o.to_email, campaign_id: o.campaign_id, ...(o.lead ?? {}) });
  const to = o.to_email === undefined ? `${lead_id}@madeup-test.com` : o.to_email;
  const camp = o.campaign_id ?? CID;
  await tx`insert into emails ${tx({
    id, blob_key: `${camp}/${id}`, campaign_id: camp, lead_id, to_email: to, to_key: to ? to.toLowerCase() : null, to_name: "Made-up Plumbing", subject: o.subject ?? "plumbing",
    body_text: o.body_text ?? BODY, body_html: o.body_html ?? HTML, sender_name: "Made-up Sender", step: o.step ?? 1, sequence_total: o.sequence_total ?? 1,
    framework: o.framework ?? "one-off", status: o.status ?? "drafted", review_status: o.review_status === undefined ? "ready" : o.review_status, reviewed_by: "lakshmi",
    rules_version: rules.RULES_VERSION, is_duplicate: o.is_duplicate ?? false, agentmail_message_id: o.msg ?? null, agentmail_inbox_id: o.inbox ?? null,
    sent_at: o.sent_at ?? null, error: o.error ?? null, created_at: o.created_at ?? new Date(Date.UTC(2026, 1, 1, 0, 0, ++seq)), updated_at: new Date(), data: tx.json({}),
  })}`;
  return id;
}
/** A lead that already got email 1 of a four-step sequence (sent_at given), with step 2 (and more) drafted. */
async function fourStep(tx, key, sentAt, steps = [2]) {
  const lead_id = `s6-l-${key}`;
  await em(tx, { id: `s6-${key}-1`, lead_id, step: 1, framework: "four-step", sequence_total: 4, status: "sent", sent_at: sentAt, msg: `msg-${key}-1`, inbox: "inbox-first" });
  const ids = {};
  for (const s of steps) ids[s] = await em(tx, { id: `s6-${key}-${s}`, lead_id, noLead: true, step: s, framework: "four-step", sequence_total: 4, subject: "plumbing calls", to_email: `${lead_id}@madeup-test.com` });
  return { lead_id, ids };
}
// The campaign's status lives in campaign_jobs (kind 'leads'), as lib/sql/campaigns.ts reads it; campaigns has no status column.
const campStatus = async (tx) => (await tx`select status from campaign_jobs where campaign_id = ${CID} and kind = 'leads'`)[0]?.status;
const row = async (tx, id) => (await tx`select * from emails where id = ${id}`)[0];
const withFx = (fn, opts) => n.callWrite(async (tx) => { await seed(tx, opts); return fn(tx); });

function mkDeps(tx, agentmail, extra = {}) {
  let k = 0;
  return { run: (fn) => fn(tx), deps: { agentmail, baseUrl: "https://made-up.test", ownAddresses: [OWN], newId: () => `t-${++seq}-${++k}`, ...extra } };
}
/** AgentMail stand-in. `reply(path, body, callNo)` decides the answer (default: ok with fresh ids). */
function stub(reply) {
  const calls = [];
  return {
    calls,
    inbox: async () => ({ inbox_id: "inbox-made-up", email: "inbox@madeup-own.test", display_name: "Made-up Sender" }),
    setDisplayName: async () => {},
    post: async (path, body) => {
      calls.push({ path, body });
      const no = calls.length;
      return reply ? reply(path, body, no) : { ok: true, message_id: `am-msg-${no}`, thread_id: `am-thread-${no}` };
    },
  };
}
const plan = (tx, params = {}, own = [OWN]) => { const { run, deps } = mkDeps(tx, null, { ownAddresses: own }); return send.runSendAction(run, "outreach.send.plan", { day: DAY, campaign_id: CID, ...params }, deps); };
const today = (tx, own = [OWN]) => { const { run, deps } = mkDeps(tx, null, { ownAddresses: own }); return send.runSendAction(run, "outreach.send.today", {}, deps); };
const doSend = (tx, am, params, extra) => { const { run, deps } = mkDeps(tx, am, extra); return send.runSendAction(run, "outreach.emails.send", { campaign_id: CID, ...params }, deps); };
const ids = (p) => p.items.map((i) => i.email_id);

// ── the network is closed ─────────────────────────────────────────────────

describe("no network", () => {
  test("a real fetch to AgentMail is refused in this file", async () => {
    await assert.rejects(fetch("https://api.agentmail.to/v0/inboxes"), /network refused/);
  });
});

// ── the plan (C1) and send.today (C2) ─────────────────────────────────────

describe("outreach.send.plan", () => {
  test("1. a Saturday, a US holiday (2026-12-25) and a blackout date give no items and working_day false with a reason", () => withFx(async (tx) => {
    await em(tx, { id: "s6-a" });
    const [bo] = await tx`select starts_on::text as d from blackout_dates where country is null or country = 'US' order by starts_on limit 1`;
    const days = [["2027-03-13", "Saturday"], ["2026-12-25", "holiday"]];
    if (bo) days.push([bo.d, "blackout"]);
    else {
      await tx`insert into blackout_dates (country, starts_on, ends_on, note) values ('US', '2027-03-17', '2027-03-17', 'made-up')`;
      days.push(["2027-03-17", "blackout"]);
    }
    for (const [d, what] of days) {
      const p = await plan(tx, { day: d });
      assert.equal(p.working_day, false, `${what} ${d}`);
      assert.ok(p.reason, `${what} has a reason`);
      assert.deepEqual(p.items, [], `${what} has no items`);
    }
    const ok = await plan(tx);
    assert.equal(ok.working_day, true);
    assert.deepEqual(ids(ok), ["s6-a"]);
  }));

  test("2. email 1s first (oldest first), then due follow-ups, never more than the room (limit 3: 2 new then 1 follow-up)", () => withFx(async (tx) => {
    const f1 = await fourStep(tx, "f1", "2027-03-01T12:00:00Z");
    const f2 = await fourStep(tx, "f2", "2027-03-01T12:00:00Z");
    const newer = await em(tx, { id: "s6-new2", created_at: new Date("2026-03-02T00:00:00Z") });
    const older = await em(tx, { id: "s6-new1", created_at: new Date("2026-03-01T00:00:00Z") });
    const p = await plan(tx);
    assert.equal(p.limit, 3);
    assert.equal(p.room, 3);
    assert.deepEqual(ids(p), [older, newer, f1.ids[2]]);
    assert.deepEqual(p.items.map((i) => i.kind), ["new", "new", "follow_up"]);
    assert.ok(f2.ids[2]);
    assert.ok(p.items.length <= p.room);
  }, { settings: { daily_send_limit: 3 } }));

  test("3. follow-up due on email 1's sent day + gap; moved_to overrides; a skipped earlier step does not hold back; an unsent one does", () => withFx(async (tx) => {
    const a = await fourStep(tx, "a", "2027-03-08T15:00:00Z"); // step 2 due 03-11
    assert.ok(!ids(await plan(tx, { day: "2027-03-10" })).includes(a.ids[2]), "a day early: not due");
    const due = await plan(tx, { day: "2027-03-11" });
    assert.ok(ids(due).includes(a.ids[2]), "on day + 3");
    assert.equal(due.items.find((i) => i.email_id === a.ids[2]).due_date, "2027-03-11");

    const m = await fourStep(tx, "m", "2027-03-01T12:00:00Z"); // would be due 03-04, moved to 03-17
    await tx`insert into follow_up_state (lead_id, channel, steps) values (${m.lead_id}, 'email', ${tx.json({ 2: { moved_to: "2027-03-17" } })})`;
    assert.ok(!ids(await plan(tx, { day: "2027-03-16" })).includes(m.ids[2]), "moved_to later: not due before it");
    assert.ok(ids(await plan(tx, { day: "2027-03-17" })).includes(m.ids[2]), "due on moved_to");

    const s = await fourStep(tx, "s", "2027-03-01T12:00:00Z", [2, 3]); // step 2 skipped -> step 3 (gap 8, 03-09) goes
    await tx`insert into follow_up_state (lead_id, channel, steps) values (${s.lead_id}, 'email', ${tx.json({ 2: { skipped: true } })})`;
    const u = await fourStep(tx, "u", "2027-03-01T12:00:00Z", [2, 3]); // step 2 unsent -> step 3 waits
    const p = await plan(tx, { day: DAY });
    assert.ok(ids(p).includes(s.ids[3]), "a skipped earlier step does not hold back the next one");
    assert.ok(!ids(p).includes(s.ids[2]), "the skipped step itself is not planned");
    assert.ok(ids(p).includes(u.ids[2]));
    assert.ok(!ids(p).includes(u.ids[3]), "an unsent earlier step holds the next one back");
  }));

  test("4. stop states, check/blocked drafts and duplicates are never planned (F7: a bounced lead's social messages are untouched)", () => withFx(async (tx) => {
    const ok = await em(tx, { id: "s6-ok" });
    await em(tx, { id: "s6-dnc", lead: { stop_state: "do_not_contact" } });
    await em(tx, { id: "s6-dnc2", lead: { do_not_contact: true } });
    await em(tx, { id: "s6-rep", lead: { stop_state: "replied" } });
    await em(tx, { id: "s6-bou", lead: { stop_state: "bounced" } });
    await em(tx, { id: "s6-exc", lead: { excluded: true } });
    await em(tx, { id: "s6-mrg", lead: { merged_into: "s6-l-ok" } });
    await em(tx, { id: "s6-chk", review_status: "check" });
    await em(tx, { id: "s6-blk", review_status: "blocked" });
    await em(tx, { id: "s6-dup", is_duplicate: true });
    await tx`insert into social_messages ${tx({ id: "s6-l-bou:message", record_id: "s6-l-bou", campaign_id: CID, lead_id: "s6-l-bou", channel: "facebook", step_key: "message", step: 1, body: "Hi there", status: "drafted", review_status: "ready", data: tx.json({}) })}`;
    const before = JSON.stringify(await tx`select * from social_messages where lead_id = 's6-l-bou' order by id`);
    const p = await plan(tx);
    assert.deepEqual(ids(p), [ok]);
    const after = JSON.stringify(await tx`select * from social_messages where lead_id = 's6-l-bou' order by id`);
    assert.equal(after, before, "F7: social rows unchanged");
    assert.equal((await tx`select count(*)::int as c from social_messages where lead_id = 's6-l-bou' and status = 'drafted'`)[0].c, 1);
  }));

  test("5. an address already sent to from another campaign is not a new email 1; a test lead is exempt", () => withFx(async (tx) => {
    await em(tx, { id: "s6-o1", campaign_id: CID2, to_email: "shared@madeup-test.com", status: "sent", sent_at: "2027-03-01T12:00:00Z", msg: "msg-o1" });
    await em(tx, { id: "s6-o2", campaign_id: CID2, to_email: "shared-test@madeup-test.com", status: "sent", sent_at: "2027-03-01T12:00:00Z", msg: "msg-o2" });
    await em(tx, { id: "s6-dupaddr", to_email: "shared@madeup-test.com" });
    const tst = await em(tx, { id: "s6-tst", to_email: "shared-test@madeup-test.com", lead: { is_test: true } });
    const fresh = await em(tx, { id: "s6-fresh" });
    const p = await plan(tx);
    assert.deepEqual(ids(p).sort(), [fresh, tst].sort());
  }));

  test("6. R9: a US campaign with no postal address has no items and postal_address_missing is true", () => withFx(async (tx) => {
    await em(tx, { id: "s6-a" });
    const p = await plan(tx);
    assert.deepEqual(p.items, []);
    assert.equal(p.postal_address_missing, true);
    await tx`update outreach_settings set data = data || ${tx.json({ postal_address: "1 Made Up Street, Katy, TX 77449" })} where key = 'settings'`;
    const ok = await plan(tx);
    assert.equal(ok.postal_address_missing, false);
    assert.equal(ok.items.length, 1);
  }, { settings: { postal_address: "   " } }));
});

describe("outreach.send.today", () => {
  test("7. counts real sends today (Settings time zone); not drafted/failed/sending, mock-, test leads, own addresses (incl. plus-address); sending_unknown counts 'sending'", () => withFx(async (tx) => {
    const own = [OWN, "me@gmail.com"];
    const base = await today(tx, own);
    const now = new Date().toISOString();
    const mk = (id, o) => em(tx, { id, sent_at: now, ...o });
    await mk("s6-t-ok", { status: "sent", msg: "real-1" });
    await mk("s6-t-ok-delivered", { status: "delivered", msg: "real-2" });
    await mk("s6-t-draft", { status: "drafted" });
    await mk("s6-t-fail", { status: "failed" });
    await mk("s6-t-sending", { status: "sending" });
    await mk("s6-t-mock", { status: "sent", msg: "mock-123" });
    await mk("s6-t-test", { status: "sent", msg: "real-3", lead: { is_test: true } });
    await mk("s6-t-own", { status: "sent", msg: "real-4", to_email: OWN });
    await mk("s6-t-plus", { status: "sent", msg: "real-5", to_email: "me+x@gmail.com" });
    await mk("s6-t-old", { status: "sent", msg: "real-6", sent_at: new Date(Date.now() - 3 * 864e5).toISOString() });
    const t = await today(tx, own);
    assert.equal(t.sent_today - base.sent_today, 2, "only the two real sends of today");
    assert.equal(t.sending_unknown - base.sending_unknown, 1);
    assert.equal(t.limit, 30);
    assert.equal(t.time_zone, "America/Chicago");
  }));

  test("7b. 'today' is the Settings time zone's day, not UTC's", () => withFx(async (tx) => {
    await tx`update outreach_settings set data = data || '{"time_zone":"Pacific/Kiritimati"}'::jsonb where key = 'settings'`;
    const base = await today(tx);
    assert.equal(base.time_zone, "Pacific/Kiritimati");
    const [{ inside, outside }] = await tx`select (((now() at time zone 'Pacific/Kiritimati')::date + time '00:30') at time zone 'Pacific/Kiritimati')::text as inside,
                                                  ((((now() at time zone 'Pacific/Kiritimati')::date - 1) + time '23:30') at time zone 'Pacific/Kiritimati')::text as outside`;
    await em(tx, { id: "s6-z-in", status: "sent", msg: "real-in", sent_at: inside });
    await em(tx, { id: "s6-z-out", status: "sent", msg: "real-out", sent_at: outside });
    assert.equal((await today(tx)).sent_today - base.sent_today, 1);
  }));
});

// ── emails.send ───────────────────────────────────────────────────────────

describe("outreach.emails.send", () => {
  test("8. happy path: both drafts sent with ids and sent_at (read back), footer and tracked links in the body, campaign closed, one activity row, contacted_at set", () => withFx(async (tx) => {
    const a = await em(tx, { id: "s6-h1" });
    const b = await em(tx, { id: "s6-h2" });
    const am = stub();
    const r = await doSend(tx, am, {});
    assert.equal(r.sent, 2);
    assert.equal(r.total, 2);
    assert.deepEqual(r.errors, []);
    for (const id of [a, b]) {
      const e = await row(tx, id);
      assert.equal(e.status, "sent");
      assert.match(e.agentmail_message_id, /^am-msg-/);
      assert.match(e.agentmail_thread_id, /^am-thread-/);
      assert.equal(e.agentmail_inbox_id, "inbox-made-up");
      assert.ok(e.sent_at, "sent_at set");
      assert.equal(e.error, null);
    }
    assert.equal(am.calls.length, 2);
    for (const c of am.calls) {
      assert.equal(c.path, "/inboxes/inbox-made-up/messages/send");
      assert.ok(c.body.text.includes("1 Made Up Street, Katy, TX 77449"), "footer has the postal address");
      assert.ok(c.body.html.includes("1 Made Up Street, Katy, TX 77449"));
      assert.ok(c.body.html.includes("https://made-up.test/t/"), "tracked link");
      assert.ok(!c.body.html.includes('href="https://madeup-link.test/page"'), "the raw link is rewritten");
    }
    assert.ok(["completed", "ready"].includes((await campStatus(tx))));
    assert.equal((await campStatus(tx)), "completed");
    assert.equal((await tx`select count(*)::int as c from activity where details->>'campaign_id' = ${CID}`)[0].c, 1);
    for (const l of ["s6-l-h1", "s6-l-h2"]) assert.ok((await tx`select contacted_at from leads where id = ${l}`)[0].contacted_at, "contacted_at set");
  }));

  test("9a. F45: rows are 'sending' while AgentMail is called; a second send from inside the first call sends nothing new", () => withFx(async (tx) => {
    const a = await em(tx, { id: "s6-p1" });
    const b = await em(tx, { id: "s6-p2" });
    const seen = [];
    let inner;
    const am = stub();
    const basePost = am.post;
    am.post = async (path, body) => {
      const [r] = await tx`select id, status from emails where to_key = ${body.to[0]}`;
      seen.push([r.id, r.status]);
      if (!inner) inner = await doSend(tx, am, {});
      return basePost(path, body);
    };
    const r = await doSend(tx, am, {});
    assert.deepEqual(seen.map((s) => s[1]), ["sending", "sending"]);
    assert.equal(inner.sent, 0, "the nested send found nothing to claim");
    assert.equal(inner.total, 0);
    assert.equal(r.sent, 2);
    assert.equal(am.calls.length, 2, "exactly one AgentMail call per email");
    assert.deepEqual((await row(tx, a)).status, "sent");
    assert.deepEqual((await row(tx, b)).status, "sent");
  }));

  test("9b. limit: 1 sends only the oldest; the rest stay drafted and are counted as over the limit", () => withFx(async (tx) => {
    const old = await em(tx, { id: "s6-lim-old", created_at: new Date("2026-03-01T00:00:00Z") });
    const mid = await em(tx, { id: "s6-lim-mid", created_at: new Date("2026-03-02T00:00:00Z") });
    const nw = await em(tx, { id: "s6-lim-new", created_at: new Date("2026-03-03T00:00:00Z") });
    const am = stub();
    const r = await doSend(tx, am, { limit: 1 });
    assert.equal(r.sent, 1);
    assert.equal(r.skipped_over_limit, 2);
    assert.equal((await row(tx, old)).status, "sent");
    assert.equal((await row(tx, mid)).status, "drafted");
    assert.equal((await row(tx, nw)).status, "drafted");
    assert.equal((await campStatus(tx)), "ready", "two ready drafts are still queued");
  }));

  test("9c. email_ids and sequence_position scope the send", () => withFx(async (tx) => {
    const a = await em(tx, { id: "s6-sc1" });
    const b = await em(tx, { id: "s6-sc2" });
    const c = await em(tx, { id: "s6-sc3" });
    let r = await doSend(tx, stub(), { email_ids: [c] });
    assert.equal(r.sent, 1);
    assert.equal((await row(tx, c)).status, "sent");
    assert.equal((await row(tx, a)).status, "drafted");
    assert.equal((await row(tx, b)).status, "drafted");
    r = await doSend(tx, stub(), { email_ids: ["s6-nope"] });
    assert.equal(r.sent, 0);
    assert.ok(r.not_sent.some((x) => x.code === "not_found"));

    // sequence_position: step 2 only, as a reply in email 1's thread; then step 1 only.
    const f = await fourStep(tx, "sp", "2027-03-01T12:00:00Z");
    const am = stub();
    r = await doSend(tx, am, { sequence_position: 2 });
    assert.equal(r.sent, 1);
    assert.equal((await row(tx, f.ids[2])).status, "sent");
    assert.equal(am.calls[0].path, "/inboxes/inbox-first/messages/msg-sp-1/reply");
    assert.ok(!("to" in am.calls[0].body), "a reply has no 'to'");
    assert.equal((await row(tx, a)).status, "drafted", "step 1 drafts were out of scope");
    const am2 = stub();
    r = await doSend(tx, am2, { sequence_position: 1 });
    assert.equal(r.sent, 2);
    assert.ok(am2.calls.every((x) => x.path === "/inboxes/inbox-made-up/messages/send"));
  }));

  test("10a. R2: AgentMail answers 422 -> 'failed' with the reason, lead not bounced, nothing bounced anywhere, listed in errors", () => withFx(async (tx) => {
    const a = await em(tx, { id: "s6-f1" });
    const r = await doSend(tx, stub(() => ({ ok: false, status: 422, text: "bad address" })), {});
    assert.equal(r.sent, 0);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].email_id, a);
    assert.match(r.errors[0].error, /AgentMail send 422/);
    const e = await row(tx, a);
    assert.equal(e.status, "failed");
    assert.match(e.error, /AgentMail send 422: bad address/);
    assert.equal((await tx`select stop_state from leads where id = 's6-l-f1'`)[0].stop_state, "none");
    assert.equal((await tx`select count(*)::int as c from emails where status in ('bounced', 'complained') and campaign_id = ${CID}`)[0].c, 0);
    assert.equal((await tx`select count(*)::int as c from contacts where kind = 'bounced' and email = 's6-l-f1@madeup-test.com'`)[0].c, 0);
    assert.equal((await campStatus(tx)), "failed");
  }));

  test("10b. R2: no answer (throws) -> stays 'sending' with the reason and is not sent again; a failed row goes again only when named", () => withFx(async (tx) => {
    const a = await em(tx, { id: "s6-n1" });
    const r = await doSend(tx, stub(() => { throw new Error("socket hang up"); }), {});
    assert.equal(r.sent, 0);
    assert.equal(r.errors.length, 1);
    const e = await row(tx, a);
    assert.equal(e.status, "sending");
    assert.ok(String(e.error).startsWith("No answer from AgentMail"), e.error);
    const again = stub();
    const r2 = await doSend(tx, again, {});
    assert.equal(r2.sent, 0);
    assert.equal(again.calls.length, 0, "a 'sending' row is never sent again on its own");
    assert.equal((await row(tx, a)).status, "sending");
    assert.equal((await tx`select sending_unknown from (select (send_today('{}'::text[])->>'sending_unknown')::int as sending_unknown) x`)[0].sending_unknown >= 1, true);

    const f = await em(tx, { id: "s6-n2", status: "failed", error: "AgentMail send 422: x" });
    const am = stub();
    const r3 = await doSend(tx, am, {});
    assert.equal(r3.sent, 0, "failed row not sent without being named");
    assert.equal(am.calls.length, 0);
    assert.equal((await row(tx, f)).status, "failed");
    const am2 = stub();
    const r4 = await doSend(tx, am2, { email_ids: [f] });
    assert.equal(r4.sent, 1);
    assert.equal((await row(tx, f)).status, "sent");
  }));

  test("11. R9: US campaign, ready draft, blank postal address -> 409 postal_address_required, AgentMail never called, row still drafted", () => withFx(async (tx) => {
    const a = await em(tx, { id: "s6-pa" });
    const am = stub();
    await assert.rejects(doSend(tx, am, {}), (e) => e instanceof campaigns.CampaignError && e.status === 409 && e.code === "postal_address_required", "expected 409 postal_address_required");
    assert.equal(am.calls.length, 0);
    assert.equal((await row(tx, a)).status, "drafted");
  }, { settings: { postal_address: "" } }));

  test("12a. stop states on send: do_not_contact, bounced and replied drafts are not sent, with their codes", () => withFx(async (tx) => {
    const ok = await em(tx, { id: "s6-ss-ok" });
    const d = await em(tx, { id: "s6-ss-dnc", lead: { stop_state: "do_not_contact" } });
    const b = await em(tx, { id: "s6-ss-bou", lead: { stop_state: "bounced" } });
    const p = await em(tx, { id: "s6-ss-rep", lead: { stop_state: "replied" } });
    const am = stub();
    const r = await doSend(tx, am, {});
    assert.equal(r.sent, 1);
    assert.deepEqual(am.calls.map((c) => c.body.to[0]), ["s6-l-ss-ok@madeup-test.com"]);
    const code = (id) => r.not_sent.find((x) => x.email_id === id)?.code;
    assert.equal(code(b), "bounced");
    assert.equal(code(p), "replied");
    assert.ok(!am.calls.some((c) => c.body.to[0] === "s6-l-ss-dnc@madeup-test.com"), "the do-not-contact draft was not sent (skipped_do_not_contact is only in a nothing-sent answer, as before)");
    for (const id of [d, b, p]) assert.equal((await row(tx, id)).status, "drafted");
    // named by id, the do-not-contact one is listed too.
    const r2 = await doSend(tx, stub(), { email_ids: [d, b, p] });
    assert.equal(r2.sent, 0);
    assert.deepEqual(["do_not_contact", "bounced", "replied"].map((c) => r2.not_sent.find((x) => x.code === c)?.code), ["do_not_contact", "bounced", "replied"]);
    assert.equal((await row(tx, ok)).status, "sent");
  }));

  test("12b. a four-step step 2 with no sent step 1 is not sent ('Send email 1 first') and goes back to drafted", () => withFx(async (tx) => {
    const s2 = await em(tx, { id: "s6-ns2", step: 2, framework: "four-step", sequence_total: 4, subject: "plumbing calls" });
    const am = stub();
    const r = await doSend(tx, am, {});
    assert.equal(r.sent, 0);
    assert.equal(am.calls.length, 0, "AgentMail was not called");
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /Send email 1 first/);
    const e = await row(tx, s2);
    assert.equal(e.status, "drafted");
    assert.match(e.error, /Send email 1 first/);
  }));

  test("13. no AgentMail key -> 400 'AgentMail key not configured'", () => withFx(async (tx) => {
    await em(tx, { id: "s6-nk" });
    await assert.rejects(doSend(tx, null, {}), (e) => e instanceof campaigns.CampaignError && e.status === 400 && /AgentMail key not configured/.test(e.message));
    assert.equal((await row(tx, "s6-nk")).status, "drafted");
  }));
});
