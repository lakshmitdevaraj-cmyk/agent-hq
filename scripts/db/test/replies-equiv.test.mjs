// R13 for chunk 7: replies and webhooks, old path (real command.ts / webhook-receive.ts on the P1 export, network blocked)
// vs the SQL versions (lib/sql/replies.ts, lib/sql/webhooks.ts) on Neon dev in rolled-back transactions. Known, intended
// differences are listed in each compare, never hidden. Skipped without the export.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";

// What every reply record may differ in, and why.
const REPLY_KNOWN = (base) => [
  { path: new RegExp(`^${base}\\.(to|labels|authentication_results|source|flag|lead_id|campaign_id|original_email_id|agentmail_thread_id|html|handled)$`), when: (d) => d.old === "(absent)" || d.new === null, why: "a field the old record never had comes back as null (columns are null when unset)" },
  { path: new RegExp(`^${base}\\.received_at$`), when: (d) => typeof d.old === "string" && new Date(d.old).getTime() === new Date(d.new).getTime(), why: "the same instant, written as Postgres gives it back (milliseconds always shown)" },
  { path: new RegExp(`^${base}\\.lead_id$`), when: (d) => typeof d.new === "string", why: "P1 merges: the reply points at the lead that was kept" },
];

describe("chunk 7 replies and webhooks: old vs new", { skip }, () => {
  let old, fresh, rp, wh;
  before(async () => {
    const { openOld } = await import("../equiv/old-path.mjs");
    old = await openOld(EXPORT);
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    rp = await import("../../../netlify/functions/lib/sql/replies.ts");
    wh = await import("../../../netlify/functions/lib/sql/webhooks.ts");
  });
  after(() => fresh?.close());
  const deps = { newId: () => `eq7-${randomBytes(4).toString("hex")}`, ownAddresses: [], agentmail: null, baseUrl: "" };
  const sqlReply = (action, params) => fresh.call(async (tx) => {
    try { return { status: 200, body: { ok: true, data: await rp.runReplyAction((fn) => fn(tx), action, params, deps) } }; }
    catch (e) { if (e.status) return { status: e.status, body: { ok: false, error: e.message } }; throw e; }
  });
  const sqlHook = (action, params) => fresh.call(async (tx) => {
    try { return { status: 200, body: { ok: true, data: await wh.runWebhookAction(tx, action, params, deps) } }; }
    catch (e) { if (e.status) return { status: e.status, body: { ok: false, error: e.message } }; throw e; }
  });

  test("replies.list: all, one campaign, limit 3: same replies in the same order", async () => {
    const o = await old.call("outreach.replies.list");
    const campaign_id = o.body.data.find((r) => r.campaign_id)?.campaign_id;
    for (const params of [{}, { campaign_id }, { limit: 3 }]) {
      const a = await old.call("outreach.replies.list", params), b = await sqlReply("outreach.replies.list", params);
      assert.deepEqual(b.body.data.map((r) => r.id), a.body.data.map((r) => r.id), `same ids in the same order for ${JSON.stringify(params)}`);
      const r = compare(a, b, { known: REPLY_KNOWN("\\$\\.body\\.data\\[\\d+\\]") });
      console.log(`replies.list ${JSON.stringify(params)}: ${a.body.data.length} replies; ${describeDiff(r)}`);
      assert.ok(r.same, describeDiff(r));
    }
  });

  test("replies.get for every reply, a missing id and no id", async () => {
    const ids = (await old.call("outreach.replies.list")).body.data.map((r) => r.id);
    const { pmap } = await import("../equiv/new-path.mjs");
    for (const [id, a, b] of await pmap(ids, 6, async (id) => [id, await old.call("outreach.replies.get", { id }), await sqlReply("outreach.replies.get", { id })])) {
      const r = compare(a, b, { known: REPLY_KNOWN("\\$\\.body\\.data") });
      assert.ok(r.same, `${id}: ${describeDiff(r)}`);
    }
    for (const p of [{ id: "no-such-reply" }, {}]) {
      const a = await old.call("outreach.replies.get", p), b = await sqlReply("outreach.replies.get", p);
      assert.equal(b.status, a.status);
    }
  });

  test("webhook.list and webhook.events: same hooks and events; the V8 status is new", async () => {
    const a = await old.call("webhook.list"), b = await sqlHook("webhook.list", {});
    const r = compare(a, b, { known: [{ path: /^\$\.body\.data\[\d+\]\.status$/, when: (d) => d.old === "(absent)", why: "V8: the SQL list adds each webhook's status" }] });
    console.log(`webhook.list: ${describeDiff(r)}`);
    assert.ok(r.same, describeDiff(r));
    const id = a.body.data[0]?.id;
    assert.ok(id, "the export has a webhook");
    const ea = await old.call("webhook.events", { id }), eb = await sqlHook("webhook.events", { id });
    assert.equal(eb.body.data.length, ea.body.data.length);
    const re = compare(ea, eb, { known: [
      { path: /^\$\.body\.data\[\d+\]\.received_at$/, when: (d) => new Date(d.old).getTime() === new Date(d.new).getTime(), why: "the same instant" },
      { path: /^\$\.body\.data\[\d+\]\.(body\.message\.)?headers\.[^.]*[Ss]ignature$/, when: (d) => d.old === "[redacted]" && d.new === "(absent)", why: "P1: the export redacted signature headers (webhook and DKIM/ARC) and the import left them out" },
    ] });
    console.log(`webhook.events: ${ea.body.data.length} events; ${describeDiff(re)}`);
    assert.ok(re.same, describeDiff(re));
  });

  test("reply.send preview: the same recipient, subject, text and inbox (nothing is sent on either path)", async () => {
    const list = (await old.call("outreach.replies.list")).body.data;
    let checked = 0;
    for (const rep of list) {
      const p = { id: rep.id, text: "Thanks for getting back to me. Would a short call work?", preview: true };
      const a = await old.call("outreach.reply.send", p), b = await sqlReply("outreach.reply.send", p);
      assert.equal(b.status, a.status, `${rep.id}: ${JSON.stringify(a.body).slice(0, 160)} | ${JSON.stringify(b.body).slice(0, 160)}`);
      if (a.status === 200) { const r = compare(a, b); assert.ok(r.same, describeDiff(r)); checked++; }
    }
    console.log(`reply.send preview: ${list.length} replies, ${checked} previews compared`);
  });

  test("webhook-receive replay: a delivered event for a sent email gives the same email status; F47 and R4 differences listed", async () => {
    const { openOld } = await import("../equiv/old-path.mjs");
    const recv = await openOld(EXPORT, { fn: "webhook-receive" });
    const hook = (await old.call("webhook.list")).body.data.find((w) => w.service === "agentmail");
    const target = await fresh.call(async (tx) => (await tx`select id, agentmail_message_id from emails where status = 'sent' and agentmail_message_id is not null order by sent_at desc limit 1`)[0]);
    const body = JSON.stringify({ event_type: "message.delivered", event_id: "eq7-evt", delivery: { message_id: target.agentmail_message_id, timestamp: new Date().toISOString() } });
    const a = await recv.raw({ httpMethod: "POST", path: `/.netlify/functions/webhook-receive/${hook.id}`, headers: {}, body });
    assert.equal(a.status, 200);
    recv.blobs.getStore("agent-hq-outreach-emails");
    const oldStatus = [...recv.blobs.stores.get("agent-hq-outreach-emails").values()].map((v) => JSON.parse(v)).find((e) => e.id === target.id)?.status;
    const secret = `whsec_${randomBytes(24).toString("base64")}`;
    const result = await fresh.callWrite(async (tx) => {
      await tx`update webhooks set data = data || ${tx.json({ signing_secret: secret })} where id = ${hook.id}`;
      const unsigned = await wh.receive((fn) => fn(tx), { webhookId: hook.id, headers: {}, rawBody: body }, deps);
      const ts = Math.floor(Date.now() / 1000), sid = "msg_eq7";
      const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${sid}.${ts}.${body}`).digest("base64");
      const signed = await wh.receive((fn) => fn(tx), { webhookId: hook.id, headers: { "svix-id": sid, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` }, rawBody: body }, deps);
      const [e] = await tx`select status, sent_at from emails where id = ${target.id}`;
      return { unsigned: unsigned.statusCode, signed: signed.statusCode, status: e.status };
    });
    console.log(`replay: old 200 (no signature check), new unsigned ${result.unsigned} (R4: refused), signed ${result.signed}; email status new ${result.status}`);
    assert.equal(result.unsigned, 401, "R4: the unsigned event the old path accepted is refused");
    assert.equal(result.signed, 200);
    assert.equal(result.status, oldStatus, "the same status on both paths");
    assert.equal(result.status, "delivered");
  });
});
