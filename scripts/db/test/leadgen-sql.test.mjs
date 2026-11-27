// Chunk 4 on Neon dev, every transaction rolled back: F3 (a site check never undoes a flag or a hand-typed value),
// F2 (run, sync and add_test never write the campaigns row), and the import claim (two syncs at once import once).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

describe("chunk 4: lead finding in SQL", () => {
  let n, leadgen, leads, lead, ctx;
  const FLAGS = "do_not_contact, do_not_contact_at, do_not_contact_reason, excluded, excluded_at, excluded_reason, not_fit_kept, contacted_at, stop_state, is_test";
  before(async () => {
    n = (await import("../equiv/new-path.mjs")).openNew("dev");
    leadgen = await import("../../../netlify/functions/lib/sql/leadgen.ts");
    leads = await import("../../../netlify/functions/lib/sql/leads.ts");
    lead = await n.call(async (tx) => (await tx`select id, campaign_id from leads where merged_into is null and not is_test and website is not null and email is null order by id limit 1`)[0]);
    ctx = { newId: (() => { let i = 0; return () => `f-new-${++i}`; })(), createdBy: null };
  });
  after(() => n?.close());

  /** A site check whose result tries to clear every flag; `during` runs while it "fetches". */
  const hostileDeps = (during) => ({
    checkSite: async () => {
      if (during) await during();
      return { fields: { site_check: { checked_at: new Date().toISOString(), via: "raw" }, gap_score: 42, do_not_contact: false, excluded: false, contacted_at: null, not_fit_kept: false, stop_state: "none", owner_name: null, social: { facebook: "https://facebook.com/a-made-up-page" } }, emails: ["found@alcance-test.invalid"], fetched: 1, tried: [] };
    },
    noWebsiteFields: () => ({}), pickBestEmail: (e) => e[0] ?? null,
  });

  test("F3: a check result carrying flag fields leaves every flag as it was", async () => {
    await n.callWrite(async (tx) => {
      await tx`update leads set do_not_contact = true, do_not_contact_reason = 'f3 test', excluded = true, contacted_at = now(), stop_state = 'do_not_contact' where id = ${lead.id}`;
      const before = await tx.unsafe(`select ${FLAGS} from leads where id = $1`, [lead.id]);
      await leadgen.checkSite(tx, { campaign_id: lead.campaign_id, lead_id: lead.id }, hostileDeps(), true);
      const after = await tx.unsafe(`select ${FLAGS}, gap_score from leads where id = $1`, [lead.id]);
      const { gap_score, ...flags } = after[0];
      assert.deepEqual(flags, { ...before[0] });
      assert.equal(Number(gap_score), 42, "the site fields were written");
    });
  });

  test("F3: a flag set while the check is fetching survives the check's write", async () => {
    // Two connections: the check runs in one transaction; the "user" marks do-not-contact in another and commits
    // nothing (rolled back) — so here both happen in one transaction, the flag written mid-check.
    await n.callWrite(async (tx) => {
      const deps = hostileDeps(() => tx`update leads set do_not_contact = true, do_not_contact_reason = 'set mid-check' where id = ${lead.id}`);
      await leadgen.checkSite(tx, { campaign_id: lead.campaign_id, lead_id: lead.id }, deps, false);
      const [r] = await tx`select do_not_contact, do_not_contact_reason, email, email_source from leads where id = ${lead.id}`;
      assert.equal(r.do_not_contact, true);
      assert.equal(r.do_not_contact_reason, "set mid-check");
      assert.equal(r.email, "found@alcance-test.invalid", "enrich still saves a found email");
      assert.equal(r.email_source, "site_check");
    });
  });

  test("F3: a hand-typed email and a hand-typed link survive a check", async () => {
    await n.callWrite(async (tx) => {
      await leads.setEmail(tx, { campaign_id: lead.campaign_id, lead_id: lead.id, email: "typed@alcance-test.invalid" });
      const [pg] = await tx`insert into social_pages (platform, url_norm, url) values ('facebook', 'https://facebook.com/typed-by-hand', 'https://facebook.com/typed-by-hand') returning id`;
      await tx`insert into lead_social_links (lead_id, kind, page_id, url, source) values (${lead.id}, 'facebook', ${pg.id}, 'https://facebook.com/typed-by-hand', 'manual')
               on conflict (lead_id, kind) do update set page_id = excluded.page_id, url = excluded.url, source = 'manual'`;
      await leadgen.checkSite(tx, { campaign_id: lead.campaign_id, lead_id: lead.id }, hostileDeps(), false);
      const [l] = await tx`select email, email_source from leads where id = ${lead.id}`;
      assert.deepEqual({ ...l }, { email: "typed@alcance-test.invalid", email_source: "manual" });
      const [k] = await tx`select url, source from lead_social_links where lead_id = ${lead.id} and kind = 'facebook'`;
      assert.deepEqual({ ...k }, { url: "https://facebook.com/typed-by-hand", source: "manual" });
    });
  });

  test("F2: run, sync and add_test never touch the campaigns row", async () => {
    await n.callWrite(async (tx) => {
      const [c] = await tx`select id from campaigns where data->'structured_query'->>'location' is not null order by id limit 1`;
      const row = async () => JSON.stringify((await tx`select * from campaigns where id = ${c.id}`)[0]);
      const before = await row();
      const deps = {
        apifyKey: async () => "made-up", startRun: async () => ({ runId: "r1", defaultDatasetId: "d1", status: "READY" }),
        runStatus: async () => ({ status: "SUCCEEDED", defaultDatasetId: "d1", statusMessage: null }),
        datasetItems: async () => [{ title: "F2 Made-up Place", website: "https://f2.alcance-test.invalid", placeId: "f2-made-up" }],
        extractLead: (raw) => ({ name: raw.title, email: null, phone: null, website: raw.website, address: null, category: null, rating: null, reviews_count: null, maps_url: null }),
      };
      await leadgen.run(tx, { id: c.id }, deps, ctx);
      await leadgen.sync(tx, { id: c.id }, deps, ctx);
      await leadgen.addTest(tx, { campaign_id: c.id, email: "f2@alcance-test.invalid" }, ctx);
      assert.equal(await row(), before, "the campaigns row is byte-for-byte the same");
      const [j] = await tx`select status, data->>'apify_run_id' as run from campaign_jobs where campaign_id = ${c.id} and kind = 'leads'`;
      assert.deepEqual({ ...j }, { status: "ready", run: "r1" });
    });
  });

  test("import claim: a second sync while one is importing does not import again", async () => {
    await n.callWrite(async (tx) => {
      const [c] = await tx`select id from campaigns where data->'structured_query'->>'location' is not null order by id limit 1`;
      let release;
      const gate = new Promise((r) => { release = r; });
      let itemsCalls = 0;
      const deps = {
        apifyKey: async () => "made-up", startRun: async () => ({ runId: "r2", defaultDatasetId: "d2", status: "READY" }),
        runStatus: async () => ({ status: "SUCCEEDED", defaultDatasetId: "d2", statusMessage: null }),
        datasetItems: async () => { itemsCalls++; return []; },
        extractLead: (raw) => raw,
      };
      await leadgen.run(tx, { id: c.id }, deps, ctx);
      // The first sync takes the claim; a second one in the same 90 s answers "searching" and imports nothing.
      const claimed = await leadgen.claimImport(tx, c.id);
      assert.equal(claimed, true);
      const second = await leadgen.sync(tx, { id: c.id }, deps, ctx);
      assert.deepEqual(second, { status: "searching", apify_status: "SUCCEEDED", changed: false });
      assert.equal(itemsCalls, 0);
      assert.equal(await leadgen.claimImport(tx, c.id), false, "the claim is taken");
      release(); void gate;
    });
  });
});
