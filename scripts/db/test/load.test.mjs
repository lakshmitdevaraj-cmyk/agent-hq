// Loading into the real dev schema with made-up records. Everything is rolled back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../env.mjs";
import { fingerprint, load } from "../load.mjs";
import { loadRules } from "../rules.mjs";
import { transform } from "../transform.mjs";

const rules = await loadRules();
let sql;
before(() => { sql = connect("dev"); });
after(() => sql.end());

const rec = (key, value) => ({ key, value: JSON.stringify(value) });
const stores = {
  "agent-hq-outreach-campaigns": [rec("t-c1", { id: "t-c1", name: "T", structured_query: { location: "Katy, TX" } })],
  "agent-hq-outreach-leads": [rec("t-c1/a", { id: "t-a", campaign_id: "t-c1", name: "Made Up", email: "a@example.com", social: { facebook: "https://facebook.com/t-madeup" }, raw: {}, tags: ["x"] })],
  "agent-hq-outreach-emails": [
    rec("t-c1/e1", { id: "t-e1", campaign_id: "t-c1", lead_id: "t-a", sequence_position: 2, status: "sent", framework: "four-step", sent_at: "2026-11-02T15:00:00Z", review_reasons: ["a"] }),
    rec("t-c1/e0", { id: "t-e0", campaign_id: "t-c1", lead_id: "t-a", sequence_position: 1, status: "drafted", framework: "four-step" }),
  ],
};
const run = (decisions) => transform(stores, { rules, today: "2026-11-10", decisions });

const ROLLBACK = new Error("rollback");
const rolledBack = (fn) => assert.rejects(sql.begin(async (tx) => { await fn(tx); throw ROLLBACK; }), (e) => { if (e !== ROLLBACK) throw e; return true; });

test("loading twice gives the same rows; a step moved by a decision does not clash; a manual value stays", () => rolledBack(async (tx) => {
  await load(tx, run());
  const first = await fingerprint(tx);
  await load(tx, run());
  assert.deepEqual(await fingerprint(tx), first);

  const [link] = await tx`select l.page_id, p.url_norm from lead_social_links l join social_pages p on p.id = l.page_id where lead_id = 't-a'`;
  assert.equal(link.url_norm, "https://facebook.com/t-madeup");
  const [lead] = await tx`select data from leads where id = 't-a'`;
  assert.deepEqual(lead.data.tags, ["x"]);

  await load(tx, run({ email_steps: [{ email_id: "t-e1", step: 1 }, { email_id: "t-e0", step: 2 }] }));
  const steps = await tx`select id, step, is_duplicate from emails where lead_id = 't-a' order by id`;
  assert.deepEqual(steps.map((e) => [e.id, e.step, e.is_duplicate]), [["t-e0", 2, false], ["t-e1", 1, false]]);

  await tx`update leads set email = 'typed@example.com', email_key = 'typed@example.com', email_source = 'manual' where id = 't-a'`;
  await load(tx, run());
  assert.equal((await tx`select email from leads where id = 't-a'`)[0].email, "typed@example.com");
}));

test("a merge moves follow-up settings to the kept lead without leaving the old row", () => rolledBack(async (tx) => {
  const merged = {
    "agent-hq-outreach-leads": [rec("t-c1/a", { id: "t-a", campaign_id: "t-c1", raw: {} }), rec("t-c1/b", { id: "t-b", campaign_id: "t-c1", raw: {} })],
    "agent-hq-outreach-followups": [rec("t-b/email", { lead_id: "t-b", channel: "email" })],
  };
  const go = (decisions) => load(tx, transform(merged, { rules, today: "2026-11-10", decisions }));
  await go();
  await go({ merges: [{ keep: "t-a", merge: "t-b" }] });
  assert.deepEqual((await tx`select lead_id from follow_up_state where blob_key = 't-b/email'`).map((r) => r.lead_id), ["t-a"]);
}));
