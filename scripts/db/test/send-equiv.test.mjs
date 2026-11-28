// R13 for chunk 6: outreach.send.today and outreach.emails.send, old path (real command.ts on the P1 export, fake AgentMail
// key, fetch stubbed) vs the SQL versions in lib/sql/send.ts on Neon dev (rolled-back transactions, AgentMail stub).
// Nothing reaches the network: a real fetch to AgentMail is refused. Skipped without the export.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";
process.env.URL = "https://equiv.madeup.test"; // old path's baseUrl when no forwarded headers (same as cases/send.mjs BASE_URL)

describe("chunk 6 send: old vs new", { skip }, () => {
  let openOld, fresh, cs, campaign_id;
  before(async () => {
    ({ openOld } = await import("../equiv/old-path.mjs"));
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    cs = await import("../equiv/cases/send.mjs");
    campaign_id = (await fresh.call(cs.pickSendCampaign))?.campaign_id;
  });
  after(() => fresh?.close());

  test("a real fetch to AgentMail is refused (the harness blocks the network; only stubs answer)", async () => {
    await openOld(EXPORT, { seed: cs.SEED }); // no routes: nothing is answered
    await assert.rejects(() => fetch("https://api.agentmail.to/v0/inboxes"), /blocked/);
    await assert.rejects(() => fetch("https://api.agentmail.to/v0/inboxes/x/messages/send", { method: "POST", body: "{}" }), /blocked/);
    await assert.rejects(() => fetch("https://example.com/"), /blocked/);
    const { blockedCalls } = await import("../equiv/old-path.mjs");
    assert.ok(blockedCalls.some((c) => /api\.agentmail\.to/.test(c.target)), "the refused AgentMail call was recorded");
  });

  test("send.today: the same sent_today and limit (old on the export, new on dev)", async () => {
    const old = await openOld(EXPORT);
    const o = await old.call("outreach.send.today");
    const nw = await fresh.callWrite((tx) => cs.sqlAction(tx, "outreach.send.today", {}));
    console.log(`send.today old ${JSON.stringify(o.body.data)} new ${JSON.stringify(nw.body.data)}`);
    const r = compare(o, nw, { known: [
      { path: /^\$\.body\.data\.(sending_unknown|day|time_zone)$/, when: (d) => d.old === "(absent)", why: "the SQL answer adds sending_unknown (R2 rows still 'sending'), the day and the time zone" },
    ] });
    console.log(describeDiff(r));
    assert.ok(r.same, describeDiff(r));
  });

  test("emails.send, limit 2 on one campaign: same ids oldest first, codes, counts and the bodies posted to AgentMail", async () => {
    assert.ok(campaign_id, "dev has a campaign with 4+ ready step-1 drafts");
    const amOld = cs.makeAgentMail(), amNew = cs.makeAgentMail();
    const old = await openOld(EXPORT, { fetchRoutes: amOld.routes, seed: cs.SEED });
    const o = await old.call("outreach.emails.send", { campaign_id, limit: 2 });
    const { nw } = await fresh.callWrite(async (tx) => {
      const nw = await cs.sqlAction(tx, "outreach.emails.send", { campaign_id, limit: 2 }, amNew.stub);
      return { nw };
    });
    console.log(`old ${o.status} sent ${o.body.data?.sent}/${o.body.data?.total} queued ${o.body.data?.queued} | new ${nw.status} sent ${nw.body.data?.sent}/${nw.body.data?.total} queued ${nw.body.data?.queued}`);
    assert.equal(o.status, 200, JSON.stringify(o.body).slice(0, 300));
    assert.equal(nw.status, 200, JSON.stringify(nw.body).slice(0, 300));
    assert.equal(o.body.data.sent, 2);
    // What was posted: path (inbox + message route), to, subject, text, html.
    const strip = (p) => p.map((x) => ({ path: x.path, to: x.body.to, subject: x.body.subject, text: x.body.text, html: x.body.html }));
    assert.equal(amOld.posts.length, amNew.posts.length, "same number of AgentMail sends");
    const rp = compare(strip(amOld.posts), strip(amNew.posts));
    console.log(`posted bodies: ${describeDiff(rp)}`);
    assert.ok(rp.same, `posted bodies differ\n${describeDiff(rp)}`);
    const tracked = amNew.posts.filter((p) => p.body.html.includes(`${cs.BASE_URL}/t/`)).length;
    console.log(`posted: ${amNew.posts.length} sends, ${tracked} with tracker links on the shared baseUrl (identical on both paths)`);
    // Answers (ids, not_sent codes, skipped_* counts, sent/total/queued).
    const known = [
      { path: /^\$\.body\.data\.queued$/, when: (d) => typeof d.old === "number" && typeof d.new === "number", why: "queued: new counts live ready drafts (stop states F7/F8, merged leads); old is queuedBefore minus sent" },
      { path: /\.not_sent\[\d+\]\.(code|reason)$/, when: (d) => /^(replied|bounced)$/.test(String(d.new)) || /replied|bounced/.test(String(d.new)), why: "F7/F8: stop_state replied/bounced stops every step on the new path" },
    ];
    const r = compare(o, nw, { known });
    console.log(describeDiff(r));
    assert.ok(r.same, describeDiff(r));
    // Same set of emails, oldest first: the made-up message ids are handed out in call order, and the sent set is what was posted.
    assert.deepEqual(amNew.posts.map((p) => p.body.to), amOld.posts.map((p) => p.body.to));
  });

  test("emails.send, rows: new rows are 'sent' after passing through 'sending'; old rows go straight to 'sent' (known)", async () => {
    const am = cs.makeAgentMail();
    const seen = [];
    const spy = { ...am.stub, post: async (path, body) => { seen.push(path); return am.stub.post(path, body); } };
    const out = await fresh.callWrite(async (tx) => {
      const inFlight = [];
      const watching = { ...spy, post: async (path, body) => { inFlight.push((await tx`select count(*)::int n from emails where campaign_id = ${campaign_id} and status = 'sending'`)[0].n); return spy.post(path, body); } };
      const r = await cs.sqlAction(tx, "outreach.emails.send", { campaign_id, limit: 2 }, watching);
      const sent = await tx`select count(*)::int n from emails where campaign_id = ${campaign_id} and status = 'sent' and sent_at > now() - interval '1 minute'`;
      const stuck = await tx`select count(*)::int n from emails where campaign_id = ${campaign_id} and status = 'sending'`;
      return { r, inFlight, sent: sent[0].n, stuck: stuck[0].n };
    });
    console.log(`known difference: while AgentMail was called the claimed rows were 'sending' (${out.inFlight.join(",")}), afterwards ${out.sent} sent, ${out.stuck} still sending (F45 claim)`);
    assert.ok(out.inFlight.every((n) => n >= 1), "claimed rows are 'sending' during the AgentMail call");
    assert.equal(out.sent, 2);
    assert.equal(out.stuck, 0);
  });

  test("a 422 from AgentMail on one send: old leaves the row 'drafted' (error only in the response); new marks it 'failed' with emails.error (R2, intended)", async () => {
    const failOn = (n) => (n === 1 ? 422 : null);
    const amOld = cs.makeAgentMail({ failOn }), amNew = cs.makeAgentMail({ failOn });
    const old = await openOld(EXPORT, { fetchRoutes: amOld.routes, seed: cs.SEED });
    const o = await old.call("outreach.emails.send", { campaign_id, limit: 2 });
    assert.equal(o.status, 200);
    assert.equal(o.body.data.errors.length, 1);
    assert.match(o.body.data.errors[0].error, /AgentMail send 422/);
    const failedId = o.body.data.errors[0].email_id;
    const oldList = (await old.call("outreach.emails.list", { campaign_id, limit: 100000 })).body.data;
    const oldRow = oldList.find((e) => e.id === failedId);
    assert.equal(oldRow.status, "drafted", "old: still drafted");
    assert.ok(!oldRow.error, "old: nothing stored on the row");
    const { nw, row, count } = await fresh.callWrite(async (tx) => {
      const nw = await cs.sqlAction(tx, "outreach.emails.send", { campaign_id, limit: 2 }, amNew.stub);
      const failed = nw.body.data.errors[0]?.email_id;
      return { nw, row: failed ? await cs.rowStatus(tx, failed) : null, count: nw.body.data.errors.length };
    });
    assert.equal(count, 1);
    assert.match(nw.body.data.errors[0].error, /AgentMail send 422/);
    assert.equal(row.status, "failed", "new: failed");
    assert.match(row.error, /AgentMail send 422/, "new: reason kept in emails.error");
    assert.equal(nw.body.data.errors[0].email_id, failedId, "the same email was the one that failed");
    assert.equal(nw.body.data.sent, o.body.data.sent);
    console.log("known difference (R2): old row stays drafted, new row failed with its reason; same email, same error text");
  });
});
