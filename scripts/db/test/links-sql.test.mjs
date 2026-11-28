// Chunk 10 on Neon dev, every transaction rolled back: the links library (lib/sql/links.ts).
// isHttpUrl, withUtm (pure), then links.create / list / update / delete / build on SQL: F1 (read straight back),
// a javascript: / data: / mailto: / ftp: link is refused, unknown type and bad utm key refused, update changes only the
// given fields, unknown id is 404, build adds utm_* tags without overwriting one already in the link.
// All data is made up. A real fetch is refused.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

let n, lk, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { lk = await import("../../../netlify/functions/lib/sql/links.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/links.ts did not load: ${loadError.message}`); };
let seq = 0;
const deps = { newId: () => `lk-test-${++seq}` };
const act = (tx, action, params) => lk.runLinkAction(tx, action, params, deps);
async function refused(p, status, text) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (text) assert.match(e.message, text); return true; });
}

describe("chunk 10 links: pure", () => {
  test("module loads", () => need());

  test("isHttpUrl: http and https pass; javascript:, data:, mailto:, ftp:, protocol-relative, junk and too long do not", () => {
    need();
    assert.equal(lk.isHttpUrl("https://booking.example.test/made-up?x=1"), true);
    assert.equal(lk.isHttpUrl("http://booking.example.test/"), true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "mailto:a@example.test", "ftp://files.example.test/x", "//evil.test", "not a url", "", null, 5, `https://booking.example.test/${"a".repeat(2000)}`]) {
      assert.equal(lk.isHttpUrl(bad), false, String(bad));
    }
  });

  test("withUtm: adds tags, keeps an existing utm_source, keeps other params and the #fragment", () => {
    need();
    const out = new URL(lk.withUtm("https://booking.example.test/book?ref=abc&utm_source=newsletter#slot", { source: "alcance", medium: "email", campaign: "made-up-camp", content: "" }));
    assert.equal(out.searchParams.get("utm_source"), "newsletter");
    assert.equal(out.searchParams.get("utm_medium"), "email");
    assert.equal(out.searchParams.get("utm_campaign"), "made-up-camp");
    assert.equal(out.searchParams.has("utm_content"), false);
    assert.equal(out.searchParams.get("ref"), "abc");
    assert.equal(out.hash, "#slot");
  });

  test("withUtm refuses javascript: with 400", () => {
    need();
    assert.throws(() => lk.withUtm("javascript:alert(1)", { source: "x" }), (e) => e.status === 400);
  });
});

describe("chunk 10 links on SQL", () => {
  test("F1: create, then list reads it straight back", async () => {
    need();
    await n.callWrite(async (tx) => {
      const c = await act(tx, "links.create", { name: "  Made-up Booking Page ", url: "https://booking.example.test/book", type: "booking", niche: "plumber", note: "Made-up note", utm: { campaign: "spring" } });
      assert.equal(c.name, "Made-up Booking Page");
      assert.equal(c.type, "booking");
      assert.deepEqual(c.utm, { campaign: "spring" });
      assert.equal(typeof c.created_at, "string");
      const l = await act(tx, "links.list", {});
      const found = l.links.find((x) => x.id === c.id);
      assert.deepEqual(found, c);
      const d = await act(tx, "links.create", { name: "Made-up Site", url: "https://site.example.test/" });
      assert.equal(d.type, "other");
      assert.deepEqual(d.utm, {});
    });
  });

  test("create refuses javascript:, data:, mailto:, ftp: links, unknown type, bad utm key, empty name", async () => {
    need();
    await n.callWrite(async (tx) => {
      for (const url of ["javascript:alert(1)", "data:text/html,hi", "mailto:a@example.test", "ftp://x.example.test/"]) {
        await refused(act(tx, "links.create", { name: "Made-up", url }), 400, /must start with http:\/\/ or https:\/\//);
      }
      await refused(act(tx, "links.create", { name: "Made-up", url: "https://a.example.test/", type: "nonsense" }), 400);
      await refused(act(tx, "links.create", { name: "Made-up", url: "https://a.example.test/", utm: { evil: "x" } }), 400);
      await refused(act(tx, "links.create", { name: "Made-up", url: "https://a.example.test/", utm: { source: "x".repeat(101) } }), 400);
      await refused(act(tx, "links.create", { name: "   ", url: "https://a.example.test/" }), 400);
    });
  });

  test("update changes only the given field and bumps updated_at; unknown id is 404", async () => {
    need();
    await n.callWrite(async (tx) => {
      const c = await act(tx, "links.create", { name: "Made-up Demo", url: "https://demo.example.test/", type: "demo", niche: "plumber" });
      const u = await act(tx, "links.update", { id: c.id, note: "changed note" });
      assert.equal(u.note, "changed note");
      assert.equal(u.name, c.name);
      assert.equal(u.url, c.url);
      assert.equal(u.type, "demo");
      assert.equal(u.niche, "plumber");
      assert.ok(new Date(u.updated_at) > new Date(c.updated_at), "updated_at moved forward");
      await refused(act(tx, "links.update", { id: c.id, url: "javascript:alert(1)" }), 400);
      await refused(act(tx, "links.update", { id: "no-such-link", note: "x" }), 404, /Link not found/);
      await refused(act(tx, "links.delete", { id: "no-such-link" }), 404, /Link not found/);
      assert.deepEqual(await act(tx, "links.delete", { id: c.id }), { deleted: true, id: c.id });
      assert.equal((await act(tx, "links.list", {})).links.some((x) => x.id === c.id), false);
    });
  });

  test("list filters by type, niche and q (a % in q is literal)", async () => {
    need();
    await n.callWrite(async (tx) => {
      const a = await act(tx, "links.create", { name: "Zeta Made-up Video", url: "https://video.example.test/zq1", type: "video", niche: "zq-niche" });
      const b = await act(tx, "links.create", { name: "Alpha Made-up Doc", url: "https://doc.example.test/zq2", type: "doc", niche: "zq-niche", note: "Contains Needle" });
      await act(tx, "links.create", { name: "Other Made-up", url: "https://other.example.test/", type: "doc", niche: "zq-other" });
      const ids = (r) => r.links.map((x) => x.id);
      assert.deepEqual(ids(await act(tx, "links.list", { niche: "zq-niche" })), [b.id, a.id]); // ordered by lower(name)
      assert.deepEqual(ids(await act(tx, "links.list", { niche: "zq-niche", type: "video" })), [a.id]);
      assert.deepEqual(ids(await act(tx, "links.list", { q: "needle" })), [b.id]);
      assert.deepEqual(ids(await act(tx, "links.list", { q: "VIDEO.example.test/ZQ1" })), [a.id]);
      assert.deepEqual(ids(await act(tx, "links.list", { q: "%" })), []);
    });
  });

  test("build: a library link with a campaign gets utm_campaign (slug), utm_source=alcance, utm_medium=email; a utm already in the link is kept", async () => {
    need();
    await n.callWrite(async (tx) => {
      await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
               values ('lk-camp', 'lk-camp', 'Made-up Campaign: Spring 2026!', 'plumber', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), '{}')`;
      const c = await act(tx, "links.create", { name: "Made-up Booking Page", url: "https://booking.example.test/book?ref=abc#slot", type: "booking" });
      const b = new URL((await act(tx, "links.build", { id: c.id, campaign_id: "lk-camp" })).url);
      assert.equal(b.searchParams.get("utm_campaign"), "made-up-campaign-spring-2026");
      assert.equal(b.searchParams.get("utm_source"), "alcance");
      assert.equal(b.searchParams.get("utm_medium"), "email");
      assert.equal(b.searchParams.get("ref"), "abc");
      assert.equal(b.hash, "#slot");
      // the caller's utm wins over the defaults; an unknown campaign adds no campaign tag
      const b2 = new URL((await act(tx, "links.build", { id: c.id, campaign_id: "no-such-camp", utm: { source: "made-up-src" } })).url);
      assert.equal(b2.searchParams.get("utm_source"), "made-up-src");
      assert.equal(b2.searchParams.has("utm_campaign"), false);
      // a utm already in the link is kept
      const k = await act(tx, "links.create", { name: "Made-up Tagged", url: "https://site.example.test/?utm_source=partner" });
      const b3 = new URL((await act(tx, "links.build", { id: k.id })).url);
      assert.equal(b3.searchParams.get("utm_source"), "partner");
      assert.equal(b3.searchParams.get("utm_medium"), "email");
      // a bare url works; neither id nor url is 400; unknown id is 404; javascript: refused
      assert.equal(new URL((await act(tx, "links.build", { url: "https://x.example.test/p" })).url).searchParams.get("utm_source"), "alcance");
      await refused(act(tx, "links.build", {}), 400);
      await refused(act(tx, "links.build", { id: "no-such-link" }), 404);
      await refused(act(tx, "links.build", { url: "javascript:alert(1)" }), 400);
    });
  });
});
