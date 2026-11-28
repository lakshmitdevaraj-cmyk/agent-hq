// Chunk 11 on Neon dev, every transaction rolled back: analytics (lib/sql/analytics.ts), outreach.analytics.summary.
// Counts follow the old deriveCampaign rules: sent = status not drafted; delivered = delivered/clicked/replied;
// clicked = status clicked or click_count > 0; replied = status replied unless every reply is a test (own address);
// bounced = bounced/complained/failed. A merged lead is not counted in leads. Newest campaign first, at most 50.
// The test compares each made-up campaign's numbers (the dev database may hold other rows), so totals are checked as
// "totals changed by exactly what the made-up rows add". All data is made up. A real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

let n, an, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { an = await import("../../../netlify/functions/lib/sql/analytics.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });
const need = () => { if (loadError) throw new Error(`lib/sql/analytics.ts did not load: ${loadError.message}`); };

async function seed(tx) {
  for (const [id, at] of [["zz-an1", "2032-01-02T00:00:00Z"], ["zz-an2", "2032-01-03T00:00:00Z"]]) {
    await tx`insert into campaigns (id, blob_key, name, created_at, updated_at, data) values (${id}, ${id}, ${`Made-up ${id}`}, ${at}, ${at}, '{}')`;
  }
  for (const [id, merged] of [["zz-l1", null], ["zz-l2", null], ["zz-l3", null], ["zz-l4", "zz-l1"]]) {
    await tx`insert into leads (id, campaign_id, blob_key, name, created_at, merged_into, data) values (${id}, 'zz-an1', ${id}, 'Made-up Lead', now(), ${merged}, '{}')`;
  }
  // zz-an2 has no live leads: the stored count in its leads job is used (old withLeadCount rule).
  await tx`insert into campaign_jobs (campaign_id, kind, status, data) values ('zz-an2', 'leads', 'done', ${tx.json({ leads_imported: 7 })})`;
  // status, click_count
  const E = [["drafted", 0], ["sent", 0], ["delivered", 0], ["clicked", 1], ["delivered", 2], ["replied", 0], ["replied", 0], ["replied", 0], ["bounced", 0], ["complained", 0], ["failed", 0]];
  let i = 0;
  for (const [status, clicks] of E) {
    i++;
    await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, step, status, click_count, created_at, updated_at, data)
             values (${`zz-e${i}`}, ${`zz-e${i}`}, 'zz-an1', 'zz-l1', 'a@made-up.test', 'a@made-up.test', ${i}, ${status}, ${clicks}, now(), now(), '{}')`; // one step each (emails_one_per_step)
  }
  // e6: only a test reply (does not count); e7: a real reply (counts); e8: a test and a real reply (counts)
  const R = [["zz-r1", "zz-e6", "test", true], ["zz-r2", "zz-e7", "person", false], ["zz-r3", "zz-e8", "test", true], ["zz-r4", "zz-e8", "person", false]];
  for (const [id, email, kind, test_] of R) {
    await tx`insert into replies (id, blob_key, campaign_id, lead_id, original_email_id, from_address, from_key, received_at, is_test, kind, data)
             values (${id}, ${id}, 'zz-an1', 'zz-l1', ${email}, 'x@made-up.test', 'x@made-up.test', now(), ${test_}, ${kind}, '{}')`;
  }
  await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, step, status, created_at, updated_at, data)
           values ('zz-e20', 'zz-e20', 'zz-an2', 'zz-l9', 'b@made-up.test', 'b@made-up.test', 1, 'sent', now(), now(), '{}')`;
}

describe("chunk 11 analytics on SQL", () => {
  test("module loads", () => need());

  test("outreach.analytics.summary: the old shape, the old counting rules, merged leads left out", async () => {
    need();
    await n.callWrite(async (tx) => {
      const before = await an.analyticsSummary(tx);
      await seed(tx);
      const a = await an.runAnalyticsAction(tx, "outreach.analytics.summary", {});
      assert.deepEqual(Object.keys(a).sort(), ["campaigns", "totals"]);
      assert.deepEqual(Object.keys(a.totals).sort(), ["bounced", "campaigns", "clicked", "delivered", "leads", "replied", "sent"]);
      assert.ok(a.campaigns.length <= 50);
      const c1 = a.campaigns.find((c) => c.id === "zz-an1");
      assert.deepEqual(Object.keys(c1).sort(), ["created_at", "emails_bounced", "emails_clicked", "emails_delivered", "emails_replied", "emails_sent", "id", "leads_imported", "name"]);
      assert.equal(c1.name, "Made-up zz-an1");
      assert.equal(c1.created_at, "2032-01-02T00:00:00.000Z");
      assert.equal(c1.leads_imported, 3); // the merged lead is left out
      assert.equal(c1.emails_sent, 10);
      assert.equal(c1.emails_delivered, 6); // delivered, clicked, delivered, replied x3
      assert.equal(c1.emails_clicked, 2); // e4 (status clicked, 1 click) and e5 (delivered, 2 clicks)
      assert.equal(c1.emails_replied, 2); // the test-only reply does not count
      assert.equal(c1.emails_bounced, 3);
      const c2 = a.campaigns.find((c) => c.id === "zz-an2");
      assert.equal(c2.leads_imported, 7);
      assert.equal(c2.emails_sent, 1);
      // newest first: an2 before an1
      assert.ok(a.campaigns.findIndex((c) => c.id === "zz-an2") < a.campaigns.findIndex((c) => c.id === "zz-an1"));
      // totals moved by exactly what the made-up rows add
      const d = (k) => a.totals[k] - before.totals[k];
      assert.equal(d("campaigns"), 2);
      assert.equal(d("leads"), 10);
      assert.equal(d("sent"), 11);
      assert.equal(d("delivered"), 6);
      assert.equal(d("clicked"), 2);
      assert.equal(d("replied"), 2);
      assert.equal(d("bounced"), 3);
    });
  });

  test("a campaign with nothing gives zeros; runAnalyticsAction refuses an unknown action", async () => {
    need();
    await n.callWrite(async (tx) => {
      await tx`insert into campaigns (id, blob_key, name, created_at, updated_at, data) values ('zz-an3', 'zz-an3', 'Made-up empty', '2033-01-01', now(), '{}')`;
      const a = await an.analyticsSummary(tx);
      const c = a.campaigns.find((x) => x.id === "zz-an3");
      assert.equal(JSON.stringify([c.leads_imported, c.emails_sent, c.emails_delivered, c.emails_bounced, c.emails_clicked, c.emails_replied]), "[0,0,0,0,0,0]");
      assert.equal(a.campaigns[0].id, "zz-an3");
      await assert.rejects(an.runAnalyticsAction(tx, "outreach.analytics.nope", {}));
    });
  });
});
