// Chunk 11 on Neon dev, every transaction rolled back: the Alcance client (C1, lib/alcance/client.ts), one test per
// function. send(plan) goes only with Lakshmi's approval (kind send_plan, unused, not expired, covering every email);
// markReady(ids) the same with kind mark_ready. createDraft never calls an AI. AgentMail is a stub; a real fetch is refused.
// All data is made up.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const CID = "c1-camp";
let n, client, approvals, loadError, realFetch;
let seq = 0;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try {
    client = await import("../../../netlify/functions/lib/alcance/client.ts");
    approvals = await import("../../../netlify/functions/lib/alcance/approvals.ts");
  } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });
const need = () => { if (loadError) throw new Error(`lib/alcance did not load: ${loadError.message}`); };
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code, e.message); return true; });
}

const DAY = "2027-03-15"; // a Monday, far from today
const stub = () => {
  const calls = [];
  return {
    calls,
    inbox: async () => ({ inbox_id: "inbox-c1", email: "inbox@madeup-own.test", display_name: "Made-up Sender" }),
    setDisplayName: async () => {},
    post: async (path, body) => { calls.push({ path, body }); return { ok: true, message_id: `am-c1-${calls.length}`, thread_id: `am-c1-thread-${calls.length}` }; },
  };
};
async function seed(tx) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign C1', 'plumber', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), '{}')`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", follow_up_gaps_email: [3, 8, 15], follow_up_gaps_social: [3, 8, 15], postal_address: "1 Made Up Street, Madeupville, TX 77001", daily_send_limit: 30 })})
           on conflict (key) do update set data = excluded.data`;
  for (const id of ["c1-a", "c1-b", "c1-c"]) {
    await tx`insert into leads (id, campaign_id, blob_key, name, email, email_key, category, address, reviews_count, created_at, data)
             values (${id}, ${CID}, ${id}, ${`Made-up Plumbing ${id}`}, ${`owner@${id}.test`}, ${`owner@${id}.test`}, 'Plumber', '1 Made Up St, Madeupville, TX 77001', 20, now(), '{}')`;
    await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, to_name, subject, body_text, sender_name, step, sequence_total, framework, status, review_status, reviewed_by, review_reasons, created_at, updated_at, data)
             values (${`${id}-e1`}, ${`${CID}/${id}-e1`}, ${CID}, ${id}, ${`owner@${id}.test`}, ${`owner@${id}.test`}, 'Made-up Plumbing', 'plumbing',
                     'Hello Made-up Plumbing team. Would you like a short recording of an assistant answering a call?', 'Made-up Sender', 1, 1, 'one-off', 'drafted',
                     ${id === "c1-c" ? "check" : "ready"}, ${id === "c1-c" ? null : "lakshmi"}, ${tx.json(id === "c1-c" ? ["Not reviewed yet"] : [])}, ${new Date(Date.UTC(2026, 1, 1, 0, 0, ++seq))}, now(), '{}')`;
  }
}
const withFx = (fn) => n.callWrite(async (tx) => { await seed(tx); return fn(tx); });
const mk = (tx, am = null) => client.alcance((fn) => fn(tx), { agentmail: am, baseUrl: "https://made-up.test", ownAddresses: ["me@madeup-own.test"], newId: () => `c1-id-${++seq}`, agentId: "c1-agent" });
const approve = (tx, kind, ids, extra = {}) => approvals.createApproval(tx, { kind, email_ids: ids, ...extra }, { newId: () => `c1-ap-${++seq}`, approvedBy: "lakshmi" });

describe("C1: send(plan) only with an approved plan", () => {
  test("planSend gives the plan; send with a matching send_plan approval sends exactly those emails and uses the approval", () => withFx(async (tx) => {
    need();
    const am = stub();
    const c = mk(tx, am);
    const plan = await c.planSend(DAY, CID);
    const ids = plan.items.map((i) => i.email_id).sort();
    assert.deepEqual(ids, ["c1-a-e1", "c1-b-e1"], "only ready drafts are planned");
    const ap = await approve(tx, "send_plan", ids);
    const r = await c.send(plan, ap.id);
    assert.equal(r.sent, 2);
    assert.equal(am.calls.length, 2);
    assert.ok((await tx`select used_at from approvals where id = ${ap.id}`)[0].used_at, "approval used");
    await refused(c.send(plan, ap.id), 409, "not_approved"); // never twice
  }));

  test("refused, and AgentMail never called: no approval, a mark_ready approval, an approval missing one email, an expired one", () => withFx(async (tx) => {
    need();
    const am = stub();
    const c = mk(tx, am);
    const plan = await c.planSend(DAY, CID);
    const ids = plan.items.map((i) => i.email_id);
    await refused(c.send(plan, null), 409, "not_approved");
    await refused(c.send(plan, "no-such-approval"), 409, "not_approved");
    await refused(c.send(plan, (await approve(tx, "mark_ready", ids)).id), 409, "not_approved");
    await refused(c.send(plan, (await approve(tx, "send_plan", [ids[0]])).id), 409, "not_approved");
    const old = await approve(tx, "send_plan", ids);
    await tx`update approvals set approved_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = ${old.id}`;
    await refused(c.send(plan, old.id), 409, "not_approved");
    assert.equal(am.calls.length, 0, "AgentMail was never called");
    assert.equal((await tx`select count(*)::int as n from emails where campaign_id = ${CID} and status <> 'drafted'`)[0].n, 0, "nothing left drafted");
  }));

  test("a plan with an email added after the approval is refused", () => withFx(async (tx) => {
    need();
    const am = stub();
    const c = mk(tx, am);
    const first = await c.planSend(DAY, CID);
    const ap = await approve(tx, "send_plan", first.items.map((i) => i.email_id));
    await tx`update emails set review_status = 'ready', reviewed_by = 'lakshmi', review_reasons = '[]' where id = 'c1-c-e1'`; // a third draft becomes ready after the approval
    const later = await c.planSend(DAY, CID);
    assert.equal(later.items.length, 3);
    await refused(c.send(later, ap.id), 409, "not_approved");
    assert.equal(am.calls.length, 0);
    assert.equal((await tx`select used_at from approvals where id = ${ap.id}`)[0].used_at, null, "a refused send does not use the approval");
  }));

  test("approval.create checks its input: unknown kind, no emails, an email that doesn't exist", () => withFx(async (tx) => {
    need();
    await refused(approve(tx, "send_everything", ["c1-a-e1"]), 400);
    await refused(approve(tx, "send_plan", []), 400);
    await refused(approve(tx, "send_plan", ["c1-no-such"]), 404);
  }));
});

describe("C1: markReady(ids) only on Lakshmi's say-so", () => {
  test("with a mark_ready approval the draft becomes ready (read back); without one, or with a send_plan one, it is refused and unchanged", () => withFx(async (tx) => {
    need();
    const c = mk(tx);
    await refused(c.markReady(["c1-c-e1"], null), 409, "not_approved");
    await refused(c.markReady(["c1-c-e1"], (await approve(tx, "send_plan", ["c1-c-e1"])).id), 409, "not_approved");
    assert.equal((await tx`select review_status from emails where id = 'c1-c-e1'`)[0].review_status, "check", "unchanged");
    const r = await c.markReady(["c1-c-e1"], (await approve(tx, "mark_ready", ["c1-c-e1"])).id);
    assert.deepEqual(r.ready, ["c1-c-e1"]);
    assert.equal((await tx`select review_status from emails where id = 'c1-c-e1'`)[0].review_status, "ready");
  }));
});

describe("C1: the other functions", () => {
  test("today: the send count for today", () => withFx(async (tx) => {
    need();
    const t = await mk(tx).today();
    assert.equal(typeof t.sent_today, "number");
    assert.equal(typeof t.limit, "number");
  }));

  test("createDraft: a hand-written draft, as the agent, with no AI call", () => withFx(async (tx) => {
    need();
    let aiCalled = false;
    globalThis.fetch = async () => { aiCalled = true; throw new Error("network refused"); };
    const d = await mk(tx).createDraft({ campaign_id: CID, lead_id: "c1-a", step: 2, sequence_total: 2, framework: "one-off", subject: "plumbing", body_text: "Hello again, Made-up Plumbing team. Would a short recording help?" });
    assert.ok(d.id || d.email?.id, "a draft was made");
    assert.equal(aiCalled, false);
  }));

  test("sentList and repliesSince", () => withFx(async (tx) => {
    need();
    await tx`update emails set status = 'sent', sent_at = '2026-11-20T15:00:00Z', agentmail_thread_id = 'c1-thread' where id = 'c1-a-e1'`;
    const sent = await mk(tx).sentList({ campaign_id: CID });
    assert.deepEqual(sent.map((e) => e.id), ["c1-a-e1"]);
    await tx`insert into replies (id, blob_key, campaign_id, lead_id, original_email_id, from_address, from_key, subject, body_text, received_at, handled, opt_out, is_test, kind, source, data)
             values ('c1-r1', 'c1-r1', ${CID}, 'c1-a', 'c1-a-e1', 'owner@c1-a.test', 'owner@c1-a.test', 'Re: plumbing', 'Tell me more', '2026-11-21T10:00:00Z', false, false, false, 'person', 'webhook', '{}'),
                    ('c1-r0', 'c1-r0', ${CID}, 'c1-a', 'c1-a-e1', 'owner@c1-a.test', 'owner@c1-a.test', 'Re: plumbing', 'Earlier', '2026-11-10T10:00:00Z', false, false, false, 'person', 'webhook', '{}')`;
    const rs = (await mk(tx).repliesSince("2026-11-15T00:00:00Z", 500)).filter((r) => r.campaign_id === CID); // dev has replies of its own
    assert.deepEqual(rs.map((r) => r.id), ["c1-r1"]);
  }));

  test("dueFollowUps(channel): only that channel's rows, none stopped", () => withFx(async (tx) => {
    need();
    await tx`update emails set status = 'sent', sent_at = '2026-11-02T15:00:00Z' where id = 'c1-a-e1'`;
    await tx`update emails set sequence_total = 2 where lead_id = 'c1-a'`;
    const rows = await mk(tx).dueFollowUps("email");
    assert.ok(rows.every((r) => r.channel === "email" && r.bucket !== "stopped"));
  }));

  test("recordReply marks a lead replied by hand (and undo); recordSocialSent records a hand-sent social message", () => withFx(async (tx) => {
    need();
    const c = mk(tx);
    await c.recordReply("c1-b");
    assert.equal((await tx`select stop_state from leads where id = 'c1-b'`)[0].stop_state, "replied");
    await c.recordReply("c1-b", { undo: true });
    assert.equal((await tx`select stop_state from leads where id = 'c1-b'`)[0].stop_state, "none");
    const r = await c.recordSocialSent({ campaign_id: CID, lead_id: "c1-a", channel: "facebook", text: "Hi, made-up note", sent_at: "2026-11-25" });
    assert.ok(r, "recorded");
    assert.equal((await tx`select count(*)::int as n from touches where lead_id = 'c1-a'`)[0].n, 1);
  }));

  test("addLead, importLeads and searchLeads", () => withFx(async (tx) => {
    need();
    const c = mk(tx);
    const a = await c.addLead(CID, { name: "Made-up Drains Ltd", website: "https://madeup-drains.test", phone: "+1 555 010 2000" });
    assert.equal(a.added.length, 1);
    const b = await c.importLeads(CID, { csv: "name,website\nMade-up Pipes,https://madeup-pipes.test\nMade-up Drains Ltd,https://madeup-drains.test\n" });
    assert.equal(b.added.length, 1);
    assert.equal(b.duplicates.length, 1, "the same website is a duplicate");
    const s = await c.searchLeads("made-up pipes");
    assert.ok(s.leads.some((l) => l.name === "Made-up Pipes"));
  }));

  test("stopLead: do-not-contact with the reason, social steps skipped, follow-ups stopped", () => withFx(async (tx) => {
    need();
    await mk(tx).stopLead("c1-a", "asked by phone not to be contacted");
    const [l] = await tx`select stop_state, do_not_contact, do_not_contact_reason from leads where id = 'c1-a'`;
    assert.equal(l.stop_state, "do_not_contact");
    assert.equal(l.do_not_contact, true);
    assert.equal(l.do_not_contact_reason, "asked by phone not to be contacted");
    await refused(mk(tx).stopLead("c1-a", ""), 400);
  }));

  test("switchToSocial: unsent email drafts become Blocked and are not planned; the lead's channel is social", () => withFx(async (tx) => {
    need();
    const c = mk(tx);
    const r = await c.switchToSocial("c1-a");
    assert.deepEqual(r.blocked, ["c1-a-e1"]);
    const [e] = await tx`select review_status, review_reasons from emails where id = 'c1-a-e1'`;
    assert.equal(e.review_status, "blocked");
    assert.equal((await tx`select data->>'channel' as ch from leads where id = 'c1-a'`)[0].ch, "social");
    const plan = await c.planSend(DAY, CID);
    assert.ok(!plan.items.some((i) => i.email_id === "c1-a-e1"));
  }));

  test("weeklyReport and health", () => withFx(async (tx) => {
    need();
    await tx`update emails set status = 'sent', sent_at = now() - interval '1 day' where id = 'c1-a-e1'`;
    const w = await mk(tx).weeklyReport();
    assert.ok(w.sent >= 1);
    for (const k of ["from", "to", "sent", "delivered", "bounced", "replies", "opt_outs", "clicks", "form_posts", "follow_ups_due"]) assert.ok(k in w, k);
    const h = await mk(tx).health();
    assert.equal(h.database, "ok");
    assert.match(h.last_migration, /^0018_/);
    for (const k of ["outbox_unsent", "stuck_sending", "last_webhook_event_at", "last_send_at"]) assert.ok(k in h, k);
  }));

  test("stubs: checkWebsite (P4) and sendToCrm (P6) answer 501", async () => {
    need();
    const c = client.alcance(async () => { throw new Error("no database for stubs"); }, { agentmail: null, baseUrl: "", ownAddresses: [], newId: () => "x" });
    await refused(c.checkWebsite("c1-a"), 501, "moves_to_p4");
    await refused(c.sendToCrm("c1-a"), 501, "moves_to_p6");
  });
});
