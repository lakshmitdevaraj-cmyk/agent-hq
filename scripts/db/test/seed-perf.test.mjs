// The speed-test seed and queries, tried on dev inside a transaction that is rolled back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../env.mjs";
import { QUERIES } from "../queries.mjs";
import { seed } from "../seed-perf.mjs";

let sql;
before(() => { sql = connect("dev"); });
after(() => sql.end());

test("seeding is refused where there are other leads", async () => {
  await assert.rejects(sql.begin(async (tx) => { await tx`insert into leads (id) values ('t-real')`; await seed(tx); }), /only for an empty perf branch/);
});

test("the seed makes 1,500 leads and 6,000 emails and all five queries run", async () => {
  const ROLLBACK = new Error("rollback");
  await assert.rejects(sql.begin(async (tx) => {
    await tx`truncate leads, emails, campaigns, follow_ups`; // undone by the rollback
    await seed(tx);
    const [r] = await tx`select (select count(*) from leads)::int as leads, (select count(*) from emails)::int as emails, (select count(*) from emails where to_key not like '%@example.com')::int as other`;
    assert.deepEqual({ ...r }, { leads: 1500, emails: 6000, other: 0 });
    for (const q of QUERIES) {
      const args = { email: "lead9@example.com", messageId: "<perf-1-1@example.com>", campaignId: "perf-c1", like: "%heron%", today: new Date().toISOString().slice(0, 10) };
      assert.ok((await tx.unsafe(q.text, q.args.map((a) => args[a]))).length > 0, q.name);
    }
    throw ROLLBACK;
  }), (e) => { if (e !== ROLLBACK) throw e; return true; });
});
