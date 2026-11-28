// Chunk 8 on Neon dev, every transaction rolled back: follow-ups (lib/sql/followups.ts).
// dueFollowUps on SQL, F10 (due dates skip weekends, holidays and blackout dates through next_working_day; a date she
// moved by hand is kept), F7 (bounced stops email only), F8 stop states, F11 (Facebook page gone: no Facebook due date),
// F3 (a follow-up change only touches its own step; a stale change is refused; a move never clears a stop), follow_ups
// kept current (chunk 2 carry-over), F1 (read straight back). All data is made up. A real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const CID = "f8-camp";
let n, fu, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { fu = await import("../../../netlify/functions/lib/sql/followups.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/followups.ts did not load: ${loadError.message}`); };
const NOW = new Date("2026-11-30T15:00:00.000Z"); // Monday 30 Nov 2026, 09:00 in Chicago
const deps = { now: () => NOW };
const act = (tx, action, params) => fu.runFollowupAction(tx, action, params, deps);
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); return true; });
}

// Lead → [stop_state, email 1 sent, extra]
const LEADS = {
  "f8-sat": ["none", "2026-11-04T15:00:00Z"], // +3 = Sat 7 Nov → Mon 9 Nov
  "f8-thx": ["none", "2026-11-23T15:00:00Z"], // +3 = Thu 26 Nov (Thanksgiving, blackout 26–29) → Mon 30 Nov
  "f8-moved": ["none", "2026-11-04T15:00:00Z"], // moved by hand to Sat 28 Nov: kept
  "f8-dnc": ["do_not_contact", "2026-11-04T15:00:00Z"],
  "f8-replied": ["replied", "2026-11-04T15:00:00Z"],
  "f8-bounced": ["bounced", "2026-11-04T15:00:00Z"],
  "f8-gone": ["none", null],
  "f8-merged": ["none", "2026-11-04T15:00:00Z"],
  "f8-excluded": ["none", "2026-11-04T15:00:00Z"],
};

async function seed(tx) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign F8', 'plumber', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), '{}')`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", follow_up_gaps_email: [3, 8, 15], follow_up_gaps_social: [3, 8, 15], postal_address: "1 Made Up Street" })})
           on conflict (key) do update set data = excluded.data`;
  for (const [id, [stop]] of Object.entries(LEADS)) {
    await tx`insert into leads (id, campaign_id, blob_key, name, created_at, stop_state, do_not_contact, merged_into, excluded, data)
             values (${id}, ${CID}, ${id}, ${`Made-up Plumbing ${id}`}, now(), ${stop}, ${stop === "do_not_contact"}, ${id === "f8-merged" ? "f8-sat" : null}, ${id === "f8-excluded"},
                     ${tx.json(id === "f8-gone" ? { fb_checked: { at: "2026-11-22T10:00:00Z", result: "gone", note: "" } } : {})})`;
  }
  for (const [id, [, sent]] of Object.entries(LEADS)) {
    if (!sent) continue;
    for (const step of [1, 2, 3, 4]) {
      await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, subject, body_text, step, sequence_total, framework, status, review_status, sent_at, created_at, updated_at, data)
               values (${`${id}-e${step}`}, ${`${id}-e${step}`}, ${CID}, ${id}, ${`owner@${id}.test`}, ${`owner@${id}.test`}, 'plumbing', ${`Made-up email ${step}`}, ${step}, 4, 'four-step',
                       ${step === 1 ? "sent" : "drafted"}, 'ready', ${step === 1 ? sent : null}, now(), now(), '{}')`;
    }
  }
  // Facebook runs: the bounced lead (still due on Facebook, F7) and the page-gone lead (F11).
  for (const lead of ["f8-bounced", "f8-gone"]) {
    for (const [key, step] of [["message", 1], ["follow_up", 2], ["last", 3]]) {
      await tx`insert into social_messages (id, record_id, campaign_id, lead_id, channel, step_key, step, label, body, status, type, review_status, sent_at, created_at, updated_at, data)
               values (${`${lead}-facebook:${key}`}, ${`${lead}-facebook`}, ${CID}, ${lead}, 'facebook', ${key}, ${step}, ${key}, 'Made-up text', ${step === 1 ? "sent" : "drafted"}, 'sequence', 'ready',
                       ${step === 1 ? "2026-11-20T15:00:00Z" : null}, now(), now(), '{}')`;
    }
  }
  await tx`insert into follow_up_state (lead_id, channel, steps, updated_at) values ('f8-moved', 'email', ${tx.json({ 2: { moved_to: "2026-11-28" } })}, '2026-11-25T10:00:00Z')`;
}
const row = (ans, lead, channel = "email") => ans.rows.find((r) => r.lead_id === lead && r.channel === channel);

describe("chunk 8 follow-ups on SQL", () => {
  test("module loads", () => need());

  test("followups.list: the old answer shape; F10 rolls Saturdays, holidays and blackout dates; a moved date is kept as she typed it", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = await act(tx, "followups.list", {});
      assert.deepEqual(Object.keys(a).sort(), ["counts", "ms", "postal_address_set", "rows", "today"]);
      assert.equal(a.today, "2026-11-30");
      assert.equal(a.postal_address_set, true);
      assert.equal(row(a, "f8-sat").due_date, "2026-11-09");
      assert.equal(row(a, "f8-sat").bucket, "overdue");
      assert.equal(row(a, "f8-thx").due_date, "2026-11-30");
      assert.equal(row(a, "f8-thx").bucket, "today");
      assert.equal(row(a, "f8-moved").due_date, "2026-11-28");
      assert.equal(row(a, "f8-moved").moved, true);
    });
  });

  test("stopped leads are never due (F8); bounced stops email only (F7); Facebook page gone gives no Facebook row (F11); merged and excluded leads are left out", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = await act(tx, "followups.list", {});
      assert.equal(row(a, "f8-dnc").bucket, "stopped");
      assert.equal(row(a, "f8-dnc").stopped_reason, "do_not_contact");
      assert.equal(row(a, "f8-replied").bucket, "stopped");
      assert.equal(row(a, "f8-replied").stopped_reason, "replied");
      assert.equal(row(a, "f8-bounced").bucket, "stopped");
      assert.equal(row(a, "f8-bounced", "facebook").due_date, "2026-11-23");
      assert.equal(row(a, "f8-gone", "facebook"), undefined);
      assert.equal(row(a, "f8-merged"), undefined);
      assert.equal(row(a, "f8-excluded"), undefined);
      const due = a.rows.filter((r) => r.bucket === "overdue" || r.bucket === "today");
      assert.equal(a.counts.total, due.length);
      assert.ok(due.every((r) => !["f8-dnc", "f8-replied"].includes(r.lead_id)));
    });
  });

  test("follow_ups is kept current: after the list its rows match the answer (F1)", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = await act(tx, "followups.list", {});
      const stored = await tx`select lead_id, channel, due_date::text as due, stopped_reason from follow_ups where campaign_id = ${CID}`;
      const key = (r) => `${r.lead_id}/${r.channel}`;
      const mine = a.rows.filter((r) => r.campaign_id === CID);
      assert.deepEqual(stored.map(key).sort(), mine.map(key).sort());
      for (const s of stored) {
        const r = mine.find((x) => key(x) === key(s));
        assert.equal(s.due, r.due_date);
        assert.equal(s.stopped_reason, r.stopped_reason ?? null);
      }
    });
  });

  test("followups.update (F3): changes on two steps are both kept; a stale change is refused; a move never clears a stop; a non-working day is kept with a warning", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = await act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "2", op: "move", value: "2026-12-02" });
      await act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "3", op: "note", value: "call first" });
      const [s] = await tx`select steps, updated_at from follow_up_state where lead_id = 'f8-sat' and channel = 'email'`;
      assert.equal(s.steps["2"].moved_to, "2026-12-02");
      assert.equal(s.steps["3"].note, "call first");
      assert.equal(row(await act(tx, "followups.list", {}), "f8-sat").due_date, "2026-12-02");
      await refused(act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "2", op: "move", value: "2026-12-03", if_updated_at: "2020-01-01T00:00:00.000Z" }), 409, "stale");
      const ok2 = await act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "2", op: "move", value: "2026-12-03", if_updated_at: (await act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "4", op: "skip" })).updated_at });
      assert.equal(ok2.steps["2"].moved_to, "2026-12-03");
      assert.equal(a.steps["2"].moved_to, "2026-12-02");

      const sat = await act(tx, "followups.update", { lead_id: "f8-thx", channel: "email", step_key: "2", op: "move", value: "2026-12-05" });
      assert.equal(sat.warning, "not_working_day");
      assert.equal(sat.next_working_day, "2026-12-07");
      assert.equal(sat.steps["2"].moved_to, "2026-12-05");

      await act(tx, "followups.update", { lead_id: "f8-dnc", channel: "email", step_key: "2", op: "move", value: "2026-12-02" });
      const [l] = await tx`select stop_state from leads where id = 'f8-dnc'`;
      assert.equal(l.stop_state, "do_not_contact");
      assert.equal(row(await act(tx, "followups.list", {}), "f8-dnc").bucket, "stopped");

      await refused(act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "2", op: "move", value: "2026-13-45" }), 400);
      await refused(act(tx, "followups.update", { lead_id: "f8-sat", channel: "email", step_key: "2", op: "explode" }), 400);
      await refused(act(tx, "followups.update", { lead_id: "f8-sat", channel: "fax", step_key: "2", op: "skip" }), 400);
    });
  });

  test("followups.replied: stops every channel (stop_state replied, reason 'replied by hand'); Undo puts the old state back; do-not-contact stays", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = await act(tx, "followups.replied", { lead_id: "f8-bounced" });
      assert.ok(r.replied_by_hand);
      let [l] = await tx`select stop_state, stop_reason from leads where id = 'f8-bounced'`;
      assert.deepEqual({ ...l }, { stop_state: "replied", stop_reason: "replied by hand" });
      const a = await act(tx, "followups.list", {});
      assert.equal(row(a, "f8-bounced", "facebook").bucket, "stopped");
      await act(tx, "followups.replied", { lead_id: "f8-bounced", undo: true });
      [l] = await tx`select stop_state from leads where id = 'f8-bounced'`;
      assert.equal(l.stop_state, "bounced");

      await act(tx, "followups.replied", { lead_id: "f8-dnc" });
      await act(tx, "followups.replied", { lead_id: "f8-dnc", undo: true });
      [l] = await tx`select stop_state from leads where id = 'f8-dnc'`;
      assert.equal(l.stop_state, "do_not_contact");
      await refused(act(tx, "followups.replied", {}), 400);
    });
  });

  test("followups.linkedin: accepted, withdrawn, undo; an unknown op is refused", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = await act(tx, "followups.linkedin", { lead_id: "f8-sat", op: "accepted" });
      assert.ok(a.accepted_at);
      const w = await act(tx, "followups.linkedin", { lead_id: "f8-sat", op: "withdrawn" });
      assert.ok(w.withdrawn_at);
      const u = await act(tx, "followups.linkedin", { lead_id: "f8-sat", op: "undo" });
      assert.equal(u.accepted_at, null);
      assert.equal(u.withdrawn_at, null);
      const [s] = await tx`select accepted_at, withdrawn_at from follow_up_state where lead_id = 'f8-sat' and channel = 'linkedin'`;
      assert.equal(s.accepted_at, null);
      await refused(act(tx, "followups.linkedin", { lead_id: "f8-sat", op: "maybe" }), 400);
    });
  });
});
