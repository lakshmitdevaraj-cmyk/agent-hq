// Chunk 10 on Neon dev, every module transaction rolled back: signed click links (R7, lib/sql/clicks.ts).
// A click token is a random 22-character id kept in click_links; the destination is read from the database, never from
// the token, so a forged or old-style token gets a 404 and no redirect (no open redirect). Only http(s) links are wrapped.
// Through the real track-click.ts handler on dev (DATA_BACKEND=sql) with made-up rows that are removed afterwards.
// All data is made up. A real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const CID = "c10-camp";
let n, clicks, loadError, realFetch;
let seq = 0;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { clicks = await import("../../../netlify/functions/lib/sql/clicks.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });
const need = () => { if (loadError) throw new Error(`lib/sql/clicks.ts did not load: ${loadError.message}`); };

const BASE = "https://made-up.test";
const deps = () => ({ newId: () => `c10-id-${++seq}` });
async function seed(tx, { status = "sent" } = {}) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign C10', 'plumber', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), '{}')`;
  await tx`insert into leads (id, campaign_id, blob_key, name, created_at, data) values ('c10-lead', ${CID}, 'c10-lead', 'Made-up Plumbing C10', now(), '{}')`;
  await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, subject, body_text, step, sequence_total, framework, status, review_status, sent_at, created_at, updated_at, data)
           values ('c10-email', 'c10-email', ${CID}, 'c10-lead', 'owner@c10.test', 'owner@c10.test', 'plumbing', 'Made-up', 1, 1, 'one-off', ${status}, 'ready', now(), now(), now(), '{}')`;
}
const withFx = (fn, opts) => n.callWrite(async (tx) => { await seed(tx, opts); return fn(tx); });
const ids = { baseUrl: BASE, campaignId: CID, leadId: "c10-lead", emailId: "c10-email" };
const tokenOf = (html) => [...html.matchAll(/\/t\/([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const oldToken = (u) => Buffer.from(JSON.stringify({ c: CID, l: "c10-lead", e: "c10-email", u })).toString("base64url");

describe("R7: tracked links at send", () => {
  test("only http(s) links are wrapped; each gets a click_links row with the real link and the email; mailto/tel/javascript/#/already-tracked are left", () => withFx(async (tx) => {
    need();
    const html = '<a href="https://madeup-link.test/a?x=1">a</a> <a href="http://madeup-link.test/b">b</a> <a href="mailto:x@c10.test">m</a> <a href="tel:+15550100">t</a> <a href="javascript:alert(1)">j</a> <a href="#top">h</a> <a href="https://made-up.test/t/AAAAAAAAAAAAAAAAAAAAAA">done</a>';
    const out = await clicks.trackLinks(tx, html, ids, deps());
    const toks = tokenOf(out).filter((t) => t !== "AAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(toks.length, 2, out);
    for (const t of toks) assert.match(t, /^[A-Za-z0-9_-]{22}$/);
    for (const keep of ['href="mailto:x@c10.test"', 'href="tel:+15550100"', 'href="javascript:alert(1)"', 'href="#top"', 'href="https://made-up.test/t/AAAAAAAAAAAAAAAAAAAAAA"']) assert.ok(out.includes(keep), keep);
    const rows = await tx`select token, url, email_id, campaign_id, lead_id from click_links where token = any(${toks}) order by url`;
    assert.deepEqual(rows.map((r) => [r.url, r.email_id, r.campaign_id, r.lead_id]), [
      ["http://madeup-link.test/b", "c10-email", CID, "c10-lead"],
      ["https://madeup-link.test/a?x=1", "c10-email", CID, "c10-lead"],
    ]);
    assert.ok(!out.includes(Buffer.from("madeup-link").toString("base64url")), "the link is not inside the token");
  }));
});

describe("R7: a click", () => {
  test("a real token: 302 to the stored link, a clicks row, the email's count and status, one activity row (read straight back, F1)", () => withFx(async (tx) => {
    need();
    const [t] = tokenOf(await clicks.trackLinks(tx, '<a href="https://madeup-link.test/page">p</a>', ids, deps()));
    const r = await clicks.click(tx, t, { userAgent: "made-up-agent" }, deps());
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.Location, "https://madeup-link.test/page");
    const [e] = await tx`select status, click_count, last_clicked_at from emails where id = 'c10-email'`;
    assert.equal(e.status, "clicked");
    assert.equal(e.click_count, 1);
    assert.ok(e.last_clicked_at);
    const c = await tx`select * from clicks where email_id = 'c10-email'`;
    assert.equal(c.length, 1);
    assert.equal(c[0].url, "https://madeup-link.test/page");
    assert.equal(c[0].lead_id, "c10-lead");
    assert.ok(!JSON.stringify(c[0].data).match(/\d+\.\d+\.\d+\.\d+/), "no IP address kept");
    assert.equal((await tx`select count(*)::int as n from activity where details->>'email_id' = 'c10-email'`)[0].n, 1);
    await clicks.click(tx, t, {}, deps());
    assert.equal((await tx`select click_count from emails where id = 'c10-email'`)[0].click_count, 2);
  }));

  test("a reply is never moved back to clicked", () => withFx(async (tx) => {
    need();
    const [t] = tokenOf(await clicks.trackLinks(tx, '<a href="https://madeup-link.test/page">p</a>', ids, deps()));
    const r = await clicks.click(tx, t, {}, deps());
    assert.equal(r.statusCode, 302);
    const [e] = await tx`select status, click_count from emails where id = 'c10-email'`;
    assert.equal(e.status, "replied");
    assert.equal(e.click_count, 1);
  }, { status: "replied" }));

  test("forged tokens are refused with 404 and no redirect: wrong shape, unknown id, and an old-style token pointing at another site (open redirect refused)", () => withFx(async (tx) => {
    need();
    for (const bad of ["", "short", "A".repeat(23), "AAAAAAAAAAAAAAAAAAAA!!", "BBBBBBBBBBBBBBBBBBBBBB", oldToken("https://evil.example/phish"), oldToken("javascript:alert(1)")]) {
      const r = await clicks.click(tx, bad, {}, deps());
      assert.equal(r.statusCode, 404, bad.slice(0, 30));
      assert.equal(r.headers?.Location, undefined, `no Location for ${bad.slice(0, 30)}`);
      assert.ok(!String(r.body).includes("evil.example"), "the forged link is not echoed");
    }
    const [e] = await tx`select click_count from emails where id = 'c10-email'`;
    assert.equal(e.click_count, 0, "a forged token never counts a click");
    assert.equal((await tx`select count(*)::int as n from clicks where email_id = 'c10-email'`)[0].n, 0);
  }));

  test("the table refuses a non-http destination even if code tried to store one", () => withFx(async (tx) => {
    await assert.rejects(tx`insert into click_links (token, email_id, url) values ('CCCCCCCCCCCCCCCCCCCCCC', 'c10-email', 'javascript:alert(1)')`, /check/i);
  }));
});

describe("R7: through the real track-click.ts handler on dev (DATA_BACKEND=sql)", { skip: !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found" }, () => {
  test("a forged token is 404 with no Location; an old-style token to another site is 404; a real token is 302 to its stored link", async () => {
    const { openOld } = await import("../equiv/old-path.mjs");
    const { localVar } = await import("../env.mjs");
    const TOKEN = `c10h${Math.random().toString(36).slice(2, 12).padEnd(10, "x")}${"z".repeat(8)}`.slice(0, 22);
    await n.commit((tx) => tx`insert into click_links (token, email_id, campaign_id, lead_id, url) values (${TOKEN}, 'c10-handler-email', null, null, 'https://madeup-link.test/handler')`);
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    try {
      const h = await openOld(EXPORT, { allowDb: true, fn: "track-click" });
      const ev = (t) => ({ httpMethod: "GET", path: `/.netlify/functions/track-click/${t}`, headers: { "user-agent": "made-up" } });
      const forged = await h.rawFull(ev("BBBBBBBBBBBBBBBBBBBBBB"));
      assert.equal(forged.statusCode, 404);
      assert.equal(forged.headers?.Location, undefined);
      const old = await h.rawFull(ev(oldToken("https://evil.example/phish")));
      assert.equal(old.statusCode, 404);
      assert.equal(old.headers?.Location, undefined);
      const real = await h.rawFull(ev(TOKEN));
      assert.equal(real.statusCode, 302);
      assert.equal(real.headers.Location, "https://madeup-link.test/handler");
    } finally {
      delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL;
      await n.commit((tx) => tx`delete from clicks where email_id = 'c10-handler-email'`);
      await n.commit((tx) => tx`delete from activity where details->>'email_id' = 'c10-handler-email'`);
      await n.commit((tx) => tx`delete from click_links where token = ${TOKEN}`);
    }
  });
});
