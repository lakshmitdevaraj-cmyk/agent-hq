// Chunk 3 on Neon dev, every transaction rolled back: F16 (one email edit, every unsent draft follows), F18 (facts
// typed by hand), paging and search on the Prospects list (S0/S6b), global search, index use, merged leads hidden (F17).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

describe("chunk 3: leads and prospects in SQL", () => {
  let n, leads, search, pick;
  before(async () => {
    n = (await import("../equiv/new-path.mjs")).openNew("dev");
    leads = await import("../../../netlify/functions/lib/sql/leads.ts");
    search = await import("../../../netlify/functions/lib/sql/search.ts");
    pick = (await import("../equiv/cases/leads.mjs")).pickLeadWithMail;
  });
  after(() => n?.close());

  const refused = async (fn, status, re) => {
    await assert.rejects(fn, (e) => e.status === status && (!re || re.test(e.message)), `expected ${status} ${re ?? ""}`);
  };

  test("F16: update with an email sends every unsent draft to it; sent emails are untouched; read back (F1)", async () => {
    await n.callWrite(async (tx) => {
      const { id, campaign_id } = await pick(tx);
      // A second unsent draft of the same lead in another campaign (a P1 merge can do this): it must follow too.
      await tx`insert into emails (id, campaign_id, lead_id, to_email, to_key, step, status, data) values ('f16-other', 'f16-elsewhere', ${id}, 'old@alcance-test.invalid', 'old@alcance-test.invalid', 9, 'drafted', '{}')`;
      const sentBefore = await tx`select id, to_email from emails where lead_id = ${id} and status <> 'drafted' order by id`;
      const r = await leads.update(tx, { campaign_id, lead_id: id, email: "F16.New@Alcance-Test.invalid" });
      assert.equal(r.email, "f16.new@alcance-test.invalid");
      assert.equal(r.email_source, "manual");
      assert.ok(r.drafts_updated >= 2);
      const drafts = await tx`select to_email, to_key from emails where lead_id = ${id} and status = 'drafted'`;
      assert.ok(drafts.length >= 2 && drafts.every((d) => d.to_email === "f16.new@alcance-test.invalid" && d.to_key === "f16.new@alcance-test.invalid"));
      assert.deepEqual(await tx`select id, to_email from emails where lead_id = ${id} and status <> 'drafted' order by id`, sentBefore);
      const [row] = await tx`select email, email_key, email_source from leads where id = ${id}`;
      assert.deepEqual({ ...row }, { email: "f16.new@alcance-test.invalid", email_key: "f16.new@alcance-test.invalid", email_source: "manual" });
      const listed = (await leads.list(tx, { campaign_id })).find((l) => l.id === id);
      assert.equal(listed.email, "f16.new@alcance-test.invalid");
    });
  });

  test("F16: set_email and update take the same path (the same rows after either)", async () => {
    const after = async (useUpdate) => n.callWrite(async (tx) => {
      const { id, campaign_id } = await pick(tx);
      if (useUpdate) await leads.update(tx, { campaign_id, lead_id: id, email: "same.path@alcance-test.invalid" });
      else await leads.setEmail(tx, { campaign_id, lead_id: id, email: "same.path@alcance-test.invalid" });
      const [l] = await tx`select email, email_key, email_source, data - 'email_manual_at' - 'updated_at' as data from leads where id = ${id}`;
      const d = await tx`select id, to_email, to_key, data->>'original_to_email' as o from emails where lead_id = ${id} order by id`;
      return JSON.stringify({ l, d });
    });
    assert.equal(await after(true), await after(false));
  });

  test("F16: clearing the address removes only unsent drafts", async () => {
    await n.callWrite(async (tx) => {
      const { id, campaign_id } = await pick(tx);
      const [{ sent }] = await tx`select count(*)::int as sent from emails where lead_id = ${id} and status <> 'drafted'`;
      const r = await leads.update(tx, { campaign_id, lead_id: id, email: "" });
      assert.equal(r.email, null);
      assert.ok(r.drafts_removed > 0);
      const [{ d, s }] = await tx`select count(*) filter (where status = 'drafted')::int as d, count(*) filter (where status <> 'drafted')::int as s from emails where lead_id = ${id}`;
      assert.equal(d, 0);
      assert.equal(s, sent);
    });
  });

  test("F16 bad case: a check can never undo a hand-typed address (0007 trigger)", async () => {
    await n.callWrite(async (tx) => {
      const { id, campaign_id } = await pick(tx);
      await leads.setEmail(tx, { campaign_id, lead_id: id, email: "typed.by.hand@alcance-test.invalid" });
      await tx`update leads set email = 'found.by.check@alcance-test.invalid', email_key = 'found.by.check@alcance-test.invalid', email_source = 'site_check' where id = ${id}`;
      const [r] = await tx`select email, email_source from leads where id = ${id}`;
      assert.deepEqual({ ...r }, { email: "typed.by.hand@alcance-test.invalid", email_source: "manual" });
    });
  });

  test("F18: a fact typed by hand is saved with its source, listed, shown on the Prospects row, and removed", async () => {
    await n.callWrite(async (tx) => {
      const { id } = await pick(tx);
      const f = await leads.addFact(tx, { lead_id: id, fact: "  Family run since 1987  " });
      assert.equal(f.fact, "Family run since 1987");
      assert.equal(f.source, "manual");
      const g = await leads.addFact(tx, { lead_id: id, fact: "Seen on Google: 24/7 emergency", source: "google" });
      const listed = await leads.listFacts(tx, { lead_id: id });
      assert.deepEqual(listed.map((x) => x.id), [g.id, f.id]);
      const [row] = (await search.prospects(tx, { q: "", limit: 500 })).rows.filter((r) => r.id === id);
      assert.equal(row.facts.length, 2);
      await refused(() => leads.removeFact(tx, { lead_id: id, id: g.id }), 400, /typed by hand/);
      assert.deepEqual(await leads.removeFact(tx, { lead_id: id, id: f.id }), { id: f.id, deleted: true });
      assert.deepEqual((await leads.listFacts(tx, { lead_id: id })).map((x) => x.id), [g.id]);
      await refused(() => leads.addFact(tx, { lead_id: id, fact: "   " }), 400);
      await refused(() => leads.addFact(tx, { lead_id: id, fact: "x".repeat(501) }), 400);
      await refused(() => leads.addFact(tx, { lead_id: id, fact: "ok", source: "gossip" }), 400);
      await refused(() => leads.addFact(tx, { lead_id: "no-such-lead", fact: "ok" }), 404);
      await refused(() => leads.removeFact(tx, { lead_id: id, id: 999999999 }), 404);
    });
  });

  test("Prospects paging: pages of 50 joined give the full list, no lead twice, merged leads never shown (F17)", async () => {
    await n.call(async (tx) => {
      const full = await search.prospects(tx, {});
      const seen = [];
      let cursor;
      for (let i = 0; i < 100; i++) {
        const page = await search.prospects(tx, { limit: 50, ...(cursor ? { cursor } : {}) });
        assert.ok(page.rows.length <= 50);
        seen.push(...page.rows.map((r) => r.id));
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      assert.deepEqual(seen, full.map((r) => r.id));
      assert.equal(new Set(seen).size, seen.length);
      const merged = new Set((await tx`select id from leads where merged_into is not null`).map((r) => r.id));
      assert.ok(merged.size > 0 && seen.every((id) => !merged.has(id)));
      await refused(() => search.prospects(tx, { limit: 50, cursor: "not-ours" }), 400, /cursor/);
      await refused(() => search.prospects(tx, { limit: 0 }), 400);
      await refused(() => search.prospects(tx, { limit: 501 }), 400);
    });
  });

  test("Prospects search: name, phone, website, case-insensitive; % is a plain character; campaign filter", async () => {
    await n.call(async (tx) => {
      const [l] = await tx`select id, name, phone, website, campaign_id from leads where merged_into is null and phone is not null and website is not null and length(name) > 6 order by id limit 1`;
      for (const q of [l.name.slice(1, 6).toUpperCase(), l.phone.replace(/\D/g, "").slice(-4), l.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 8)]) {
        const ids = (await search.prospects(tx, { q, limit: 500 })).rows.map((r) => r.id);
        assert.ok(ids.includes(l.id), `q ${q.length} chars finds the lead`);
      }
      assert.equal((await search.prospects(tx, { q: "%%%", limit: 50 })).rows.length, 0);
      const inCamp = (await search.prospects(tx, { campaign_id: l.campaign_id, limit: 500 })).rows;
      assert.ok(inCamp.length > 0 && inCamp.every((r) => r.campaign_id === l.campaign_id));
    });
  });

  test("S6b global search finds campaigns and leads, never merged leads; refusals", async () => {
    await n.call(async (tx) => {
      const [c] = await tx`select name from campaigns where length(name) >= 4 order by id limit 1`;
      const r1 = await search.searchAll(tx, { q: c.name.slice(0, 4), limit: 50 });
      assert.ok(r1.campaigns.some((x) => x.name === c.name));
      const [l] = await tx`select id, name from leads where merged_into is null and length(name) > 6 order by id desc limit 1`;
      const r2 = await search.searchAll(tx, { q: l.name.slice(0, 6), limit: 50 });
      assert.ok(r2.leads.some((x) => x.id === l.id));
      assert.ok(r2.leads.every((x) => "stop_state" in x && "campaign_name" in x));
      const [m] = await tx`select name from leads where merged_into is not null and length(name) > 6 order by id limit 1`;
      const merged = new Set((await tx`select id from leads where merged_into is not null`).map((r) => r.id));
      assert.ok((await search.searchAll(tx, { q: m.name, limit: 50 })).leads.every((x) => !merged.has(x.id)));
      await refused(() => search.searchAll(tx, { q: "a" }), 400);
      await refused(() => search.searchAll(tx, { q: "x".repeat(201) }), 400);
    });
  });

  test("index use: leads_search for a search, leads_order for a page (seqscan off at this size); timings", async () => {
    await n.call(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const plan = async (opts) => (await tx.unsafe(`explain ${search.pageSql(opts).text}`, search.pageSql(opts).values)).map((r) => r["QUERY PLAN"]).join("\n");
      assert.match(await plan({ q: "plumb", limit: 50 }), /leads_search/);
      assert.match(await plan({ limit: 50 }), /leads_order/);
    });
    const t0 = Date.now();
    await n.call((tx) => search.prospects(tx, { limit: 50 }));
    const t1 = Date.now();
    await n.call((tx) => search.prospects(tx, { q: "plumb", limit: 50 }));
    console.log(`prospects page of 50: ${t1 - t0} ms; search page: ${Date.now() - t1} ms (from this machine, inside a transaction)`);
  });
});
