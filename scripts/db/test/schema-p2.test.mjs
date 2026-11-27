// P2 migrations 0008–0010 on dev. Every write runs in a transaction that is rolled back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../env.mjs";

let sql;
before(() => { sql = connect("dev"); });
after(() => sql.end());

const ROLLBACK = new Error("rollback");
async function rolledBack(fn) {
  await assert.rejects(sql.begin(async (tx) => { await fn(tx); throw ROLLBACK; }), (e) => { if (e !== ROLLBACK) throw e; return true; });
}

test("R9 / V3: a US footer needs a postal address", async () => {
  const [us] = await sql`select postal_address_required from country_profiles where code = 'US'`;
  assert.equal(us.postal_address_required, true);
});

test("R12: outbox rows start unsent with no tries, and attempts can't go below zero", () => rolledBack(async (tx) => {
  const [row] = await tx`insert into outbox (kind, payload) values ('test.kind', ${tx.json({ lead: "t-lead" })}) returning *`;
  assert.equal(row.sent_at, null);
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, null);
  assert.ok(row.created_at instanceof Date);
  assert.deepEqual(row.payload, { lead: "t-lead" });
  await assert.rejects(tx.savepoint((s) => s`update outbox set attempts = -1 where id = ${row.id}`), (e) => e.code === "23514");
  const [{ count }] = await tx`select count(*)::int as count from outbox where sent_at is null and kind = 'test.kind'`;
  assert.equal(count, 1);
}));

test("V9: purge keeps and deletes exactly by age and kind", () => rolledBack(async (tx) => {
  const asOf = new Date("2030-01-01T00:00:00Z");
  const ago = (days) => new Date(asOf.getTime() - days * 86400000);
  const hook = (id, days) => tx`insert into webhook_events (id, received_at) values (${id}, ${ago(days)})`;
  const act = (id, category, summary, details, days) =>
    tx`insert into activity (id, category, summary, details, created_at) values (${id}, ${category}, ${summary}, ${details === null ? null : tx.json(details)}, ${ago(days)})`;
  const RECEIVED = 'Webhook "AgentMail events" received an event';

  await hook("t-wh-31", 31);
  await hook("t-wh-29", 29);
  await act("t-rcv-31", "system", RECEIVED, { event_id: "e1", service: "agentmail" }, 31);
  await act("t-rcv-29", "system", RECEIVED, { event_id: "e2", service: "agentmail" }, 29);
  await act("t-rcv-no-event-id-60", "system", RECEIVED, { service: "agentmail" }, 60);   // not the webhook kind: 90 days
  await act("t-sys-91", "system", "Settings changed", {}, 91);
  await act("t-sys-89", "system", "Settings changed", {}, 89);
  await act("t-sys-60", "system", "Settings changed", {}, 60);
  await act("t-sys-blank-91", "system", null, null, 91);                                   // blank summary still purged
  await act("t-out-400", "outreach", "Campaign created", {}, 400);
  await act("t-email-400", "email", "Reply from someone: webhook health check", { reply_id: "r1" }, 400);
  await act("t-content-400", "content", 'Webhook "x" received an event', { event_id: "e3" }, 400); // right words, wrong category

  const result = Object.fromEntries((await tx`select * from purge_old_records(${asOf})`).map((r) => [r.kind, Number(r.deleted)]));
  assert.deepEqual(Object.keys(result).sort(), ["activity_system", "activity_webhook_received", "webhook_events"]);

  const left = new Set([
    ...(await tx`select id from webhook_events where id like 't-%'`).map((r) => r.id),
    ...(await tx`select id from activity where id like 't-%'`).map((r) => r.id),
  ]);
  for (const gone of ["t-wh-31", "t-rcv-31", "t-sys-91", "t-sys-blank-91"]) assert.ok(!left.has(gone), `${gone} should be deleted`);
  for (const kept of ["t-wh-29", "t-rcv-29", "t-rcv-no-event-id-60", "t-sys-89", "t-sys-60", "t-out-400", "t-email-400", "t-content-400"]) assert.ok(left.has(kept), `${kept} should be kept`);
}));

test("V9: outreach and email History entries are never deleted, however old", () => rolledBack(async (tx) => {
  const before = await tx`select category, count(*)::int as n from activity where category in ('outreach', 'email') group by 1 order by 1`;
  await tx`select * from purge_old_records(now() + interval '100 years')`;
  const after = await tx`select category, count(*)::int as n from activity where category in ('outreach', 'email') group by 1 order by 1`;
  assert.deepEqual(after, before);
}));

test("0011: no campaign from before 19 Nov is left with any_trade false, and new campaigns default to true", () => rolledBack(async (tx) => {
  const [{ n }] = await tx`select count(*)::int as n from campaigns where any_trade = false and created_at < '2026-11-19'`;
  assert.equal(n, 0);
  const [c] = await tx`insert into campaigns (id) values ('t-camp-default') returning any_trade`;
  assert.equal(c.any_trade, true);
}));
