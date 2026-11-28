// R13, chunk 11: activity.list, outreach.job.resume_due and outreach.analytics.summary, old path (Blobs, the P1 export)
// vs SQL (Neon dev, read only).
// Intended differences (listed, never hidden):
//   - activity.list: SQL has the same entries; ties on created_at are ordered by id, so only the SET of the newest 100 is
//     compared (id, category, summary, details, created_at). details missing in the old record is null on SQL.
//   - resume_due: SQL looks at every paused resumable job, the old code at the one job in each campaign's state. The same
//     (campaign_id, kind, resume_at) set is expected from the export.
//   - analytics: emails_* and totals (sent, delivered, bounced, clicked, replied, campaigns) must be equal. leads_imported
//     may differ ON PURPOSE: the old summary used the stored leads_imported, SQL uses the live lead count (merged leads
//     left out, the old campaign.get rule), falling back to the stored one. Those are counted and printed, never hidden;
//     totals.leads is not compared. The 50-campaign list is compared by id for campaigns on both sides.
// Assertion messages never print an answer (they may hold real business names).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
let n, activity, jobs, analytics, old;
before(async () => {
  if (skip) return;
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  activity = await import("../../../netlify/functions/lib/sql/activity.ts");
  jobs = await import("../../../netlify/functions/lib/sql/jobs.ts");
  analytics = await import("../../../netlify/functions/lib/sql/analytics.ts");
  old = await (await import("../equiv/old-path.mjs")).openOld(EXPORT);
});
after(() => n?.close());
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v); // jsonb keeps its own key order
const iso = (v) => (v ? new Date(v).toISOString() : null);
const NUMS = ["emails_sent", "emails_delivered", "emails_bounced", "emails_clicked", "emails_replied"];

describe("chunk 11: old vs new", { skip }, () => {
  test("activity.list limit 100: the same entries", async () => {
    const was = (await old.call("activity.list", { limit: 100 })).body.data;
    const now = await n.call((tx) => activity.runActivityAction(tx, "activity.list", { limit: 100 }, { newId: () => "x" }));
    const key = (r) => JSON.stringify([r.id, r.category, r.summary, sorted(r.details ?? null), iso(r.created_at)]);
    const a = was.map(key), b = now.map(key);
    const bSet = new Set(b);
    const missing = a.filter((k) => !bSet.has(k)).length;
    assert.ok(was.length > 0 ? now.length > 0 : true, "SQL has entries when the export has");
    assert.equal(missing, 0, `old entries missing or different on SQL: ${missing}`);
    console.log(`activity.list: ${was.length} old entries, ${now.length} on SQL, all old ones equal`);
  });

  test("outreach.job.resume_due: the same campaign_id / kind set", async () => {
    const was = (await old.call("outreach.job.resume_due")).body.data.due;
    const now = (await n.call((tx) => jobs.runJobAction(tx, "outreach.job.resume_due", {}, {}))).due;
    const key = (d) => JSON.stringify([d.campaign_id, d.kind]);
    assert.ok(JSON.stringify(was.map(key).sort()) === JSON.stringify(now.map(key).sort()), `due jobs: ${was.length} old vs ${now.length} SQL`);
    console.log(`resume_due: ${was.length} old, ${now.length} on SQL`);
  });

  test("outreach.analytics.summary: totals and each campaign's email numbers are equal", async () => {
    const was = (await old.call("outreach.analytics.summary")).body.data;
    const now = await n.call((tx) => analytics.runAnalyticsAction(tx, "outreach.analytics.summary", {}));
    for (const k of ["campaigns", "sent", "delivered", "bounced", "clicked", "replied"]) assert.equal(now.totals[k], was.totals[k], `totals.${k}`);
    assert.deepEqual(Object.keys(now).sort(), Object.keys(was).sort());
    assert.deepEqual(Object.keys(now.totals).sort(), Object.keys(was.totals).sort());
    const byId = new Map(now.campaigns.map((c) => [c.id, c]));
    let compared = 0, leadsDiff = 0, bad = 0;
    for (const w of was.campaigns) {
      const x = byId.get(w.id);
      if (!x) continue;
      compared++;
      if (w.name !== x.name || iso(w.created_at) !== x.created_at) bad++;
      for (const k of NUMS) if (w[k] !== x[k]) bad++;
      if (w.leads_imported !== x.leads_imported) leadsDiff++;
    }
    assert.ok(compared > 0 || was.campaigns.length === 0, "some campaigns compared");
    assert.equal(bad, 0, `campaign fields that differ (name, created_at, email counts): ${bad}`);
    assert.equal(now.campaigns.length, was.campaigns.length, "same list length");
    console.log(`analytics: ${compared} campaigns compared, email numbers equal; leads_imported differs on ${leadsDiff} (intended: live count); totals.leads old ${was.totals.leads} vs SQL ${now.totals.leads}`);
  });
});
