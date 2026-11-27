// A1 add lead (chunk 4): single, paste and CSV; the duplicate check across all campaigns on email, website, phone
// and link; never reads LinkedIn (nothing is fetched). Dev, every transaction rolled back. Made-up rows only; real
// leads used as duplicates are picked at test time and checked by id, never printed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

describe("A1: add a lead", () => {
  let n, al, norm, ctx;
  before(async () => {
    n = (await import("../equiv/new-path.mjs")).openNew("dev");
    al = await import("../../../netlify/functions/lib/sql/addlead.ts");
    norm = await import("../normalise.mjs");
    ctx = { newId: (() => { let i = 0; return () => `a1-new-${++i}`; })() };
  });
  after(() => n?.close());
  const refused = (fn, status, re) => assert.rejects(fn, (e) => e.status === status && (!re || re.test(e.message)));

  test("parsePaste: tabs, commas with quotes, fields in any order, blank lines", () => {
    const rows = al.parsePaste([
      "Made-up Plumbing A\tmadeup-a-test.com\t(555) 010-0001\ta@alcance-test.invalid",
      "",
      '"Made-up Plumbing, B", b@alcance-test.invalid, https://www.facebook.com/made-up-b, 555-010-0002',
      "   ",
      "https://www.google.com/maps/place/?q=x&query_place_id=equiv-made-up-c, Made-up C",
    ].join("\n"));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { name: "Made-up Plumbing A", website: "madeup-a-test.com", phone: "(555) 010-0001", email: "a@alcance-test.invalid" });
    assert.deepEqual(rows[1], { name: "Made-up Plumbing, B", email: "b@alcance-test.invalid", link: "https://www.facebook.com/made-up-b", phone: "555-010-0002" });
    assert.equal(rows[2].name, "Made-up C");
    assert.match(rows[2].link, /query_place_id=equiv-made-up-c/);
  });

  test("parseCsv: header in any order and case, quoted commas and newlines, \"\", CRLF, unknown columns ignored", () => {
    const rows = al.parseCsv('EMAIL,Business Name,Notes,Website\r\na@alcance-test.invalid,"Made-up ""Best"" Plumbing, LLC","line one\nline two",madeup-test.com\r\n\r\n,Made-up Two,,two-test.com\r\n');
    assert.deepEqual(rows, [
      { email: "a@alcance-test.invalid", name: 'Made-up "Best" Plumbing, LLC', website: "madeup-test.com" },
      { name: "Made-up Two", website: "two-test.com" },
    ]);
  });

  test("each kind of duplicate is refused across campaigns, with what it matched; nothing is added", async () => {
    await n.callWrite(async (tx) => {
      const [camp] = await tx`select id from campaigns order by id limit 1`;
      const pick = (where) => tx.unsafe(`select l.id, l.campaign_id, l.email, l.website, l.phone, l.data->'raw'->>'placeId' as place from leads l where merged_into is null and not is_test and campaign_id <> $1 and ${where} order by id limit 1`, [camp.id]);
      const [[e], [w], [p], [pl]] = await Promise.all([pick("email is not null"), pick("website is not null"), pick("phone ~ '\\d{3}.*\\d{4}'"), pick("data->'raw'->>'placeId' is not null")]);
      const [fb] = await tx`select k.lead_id as id, l.campaign_id, k.url from lead_social_links k join leads l on l.id = k.lead_id where k.kind = 'facebook' and l.merged_into is null and l.campaign_id <> ${camp.id} order by k.lead_id limit 1`;
      const cases = [
        [{ name: "Made-up Dup Email", email: e.email.toUpperCase() }, e, "email"],
        [{ name: "Made-up Dup Website", website: w.website.replace(/^https?:\/\//, "").replace(/\/$/, "") }, w, "website"],
        [{ name: "Made-up Dup Phone", phone: `+1 ${p.phone.replace(/\D/g, "").slice(-10)}` }, p, "phone"],
        [{ name: "Made-up Dup Maps", link: `https://www.google.com/maps/search/?api=1&query=x&query_place_id=${pl.place}` }, pl, "link"],
        [{ name: "Made-up Dup Facebook", link: `${fb.url}?ref=made-up` }, fb, "link"],
      ];
      for (const [row, real, on] of cases) {
        const r = await al.addLeads(tx, { campaign_id: camp.id, format: "single", lead: row }, ctx);
        assert.equal(r.added.length, 0, `${on}: not added`);
        assert.equal(r.duplicates.length, 1, `${on}: one duplicate`);
        assert.equal(r.duplicates[0].match.on, on);
        assert.equal(r.duplicates[0].match.lead_id, real.id);
        assert.equal(r.duplicates[0].match.campaign_id, real.campaign_id);
      }
      const [{ c }] = await tx`select count(*)::int as c from leads where name like 'Made-up Dup%'`;
      assert.equal(c, 0);
    });
  });

  test("single, paste and CSV add made-up leads; a repeat in the same paste is a duplicate; read straight back (F1)", async () => {
    await n.callWrite(async (tx) => {
      const [camp] = await tx`select id from campaigns order by id limit 1`;
      const one = await al.addLeads(tx, { campaign_id: camp.id, format: "single", lead: { name: "Made-up Single", email: "Single@Alcance-Test.invalid", website: "https://single.alcance-test.invalid/" } }, ctx);
      assert.equal(one.added.length, 1);
      assert.equal(one.added[0].email, "single@alcance-test.invalid");
      const paste = await al.addLeads(tx, { campaign_id: camp.id, format: "paste", text: "Made-up Paste One\tpaste1.alcance-test.invalid\nMade-up Paste Two\thttps://www.linkedin.com/company/made-up-paste-two\nMade-up Paste One again\thttps://paste1.alcance-test.invalid/" }, ctx);
      assert.equal(paste.added.length, 2);
      assert.equal(paste.duplicates.length, 1);
      assert.equal(paste.duplicates[0].row, 2);
      assert.equal(paste.duplicates[0].match.on, "website");
      const csv = await al.addLeads(tx, { campaign_id: camp.id, format: "csv", text: "name,phone,category\nMade-up Csv,(555) 010-0099,Plumber\n" }, ctx);
      assert.equal(csv.added.length, 1);
      const rows = await tx`select id, name, email, email_key, email_source, website_key, data->>'source' as source from leads where name like 'Made-up %' and campaign_id = ${camp.id} order by name`;
      assert.deepEqual(rows.map((r) => r.name), ["Made-up Csv", "Made-up Paste One", "Made-up Paste Two", "Made-up Single"]);
      const single = rows.find((r) => r.name === "Made-up Single");
      assert.deepEqual({ email_key: single.email_key, email_source: single.email_source, website_key: single.website_key, source: single.source }, { email_key: "single@alcance-test.invalid", email_source: "manual", website_key: "single.alcance-test.invalid", source: "added_by_hand" });
      const two = rows.find((r) => r.name === "Made-up Paste Two");
      const [link] = await tx`select kind, source from lead_social_links where lead_id = ${two.id}`;
      assert.deepEqual({ ...link }, { kind: "linkedin_company", source: "manual" });
      // The same address again, now in the database: a duplicate of the lead just added.
      const again = await al.addLeads(tx, { campaign_id: camp.id, format: "single", lead: { name: "Made-up Single 2", email: "single@alcance-test.invalid" } }, ctx);
      assert.equal(again.duplicates[0].match.lead_id, single.id);
    });
  });

  test("never reads LinkedIn: nothing is fetched while a LinkedIn link is added", async () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("fetch is not allowed here"); };
    try {
      await n.callWrite(async (tx) => {
        const [camp] = await tx`select id from campaigns order by id limit 1`;
        const r = await al.addLeads(tx, { campaign_id: camp.id, format: "single", lead: { name: "Made-up LinkedIn Only", link: "https://www.linkedin.com/in/made-up-person" } }, ctx);
        assert.equal(r.added.length, 1);
      });
    } finally { globalThis.fetch = real; }
    assert.deepEqual(calls, []);
  });

  test("refusals: whole request and per row", async () => {
    await n.callWrite(async (tx) => {
      const [camp] = await tx`select id from campaigns order by id limit 1`;
      await refused(() => al.addLeads(tx, { format: "single", lead: { name: "x", phone: "5550100000" } }, ctx), 400, /campaign_id required/);
      await refused(() => al.addLeads(tx, { campaign_id: "no-such-campaign", format: "single", lead: { name: "x", phone: "5550100000" } }, ctx), 404);
      await refused(() => al.addLeads(tx, { campaign_id: camp.id, format: "fax" }, ctx), 400);
      await refused(() => al.addLeads(tx, { campaign_id: camp.id, format: "paste", text: "\n \n" }, ctx), 400, /nothing to add/);
      await refused(() => al.addLeads(tx, { campaign_id: camp.id, format: "paste", text: Array.from({ length: 501 }, (_, i) => `Made-up ${i}\t555010${String(i).padStart(4, "0")}`).join("\n") }, ctx), 400);
      const r = await al.addLeads(tx, { campaign_id: camp.id, format: "csv", text: "name,email,website\n,a@alcance-test.invalid,\nMade-up Name Only,,\nMade-up Junk,johndoe@alcance-test.invalid,\nMade-up Gov,someone@city.gov,\n" }, ctx);
      assert.equal(r.added.length, 0);
      assert.deepEqual(r.refused.map((x) => x.row), [0, 1, 2, 3]);
    });
  });

  test("the phone and place-id lookups use the 0012 indexes (seqscan off at this size)", async () => {
    await n.call(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const plan = async (q, v) => (await tx.unsafe(`explain ${q}`, v)).map((r) => r["QUERY PLAN"]).join("\n");
      assert.match(await plan(`select id from leads where right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = any($1)`, [["5550100000"]]), /leads_phone_key/);
      assert.match(await plan(`select id from leads where (data->'raw'->>'placeId') = any($1)`, [["equiv-made-up"]]), /leads_place_id/);
    });
  });

  test("the normaliseSocialUrl and phoneKey copies match the import's on every link and phone on dev", async () => {
    const [links, phones] = await n.call(async (tx) => [await tx`select url from lead_social_links`, await tx`select phone from leads where phone is not null`]);
    for (const { url } of links) assert.deepEqual(al.normaliseSocialUrl(url), norm.normaliseSocialUrl(url));
    for (const { phone } of phones) assert.equal(al.phoneKey(phone), norm.phoneKey(phone));
    console.log(`normalise copies: ${links.length} links and ${phones.length} phones give the same answers`);
  });
});
