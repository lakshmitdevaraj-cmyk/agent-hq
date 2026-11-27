// R13 for chunk 4: lead finding, old path (real command.ts on the P1 export; a made-up Apify key; fetch answers only
// made-up Apify and website responses) vs the SQL versions in lib/sql/leadgen.ts on Neon dev (rolled back), which get
// the very same private Apify / site-check functions as deps. Skipped without the export.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, describe as describeDiff } from "../equiv/compare.mjs";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const skip = !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found";

function same(label, oldValue, newValue, opts) {
  const r = compare(oldValue, newValue, opts);
  console.log(`${label}: ${describeDiff(r, 6)}`);
  assert.ok(r.same, `${label}\n${describeDiff(r)}`);
  return r;
}
const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.created_at).localeCompare(String(b.created_at));

describe("chunk 4 lead finding: old vs new", { skip }, () => {
  let openOld, openPrivates, fresh, cs, lc, shared, merged, priv, target;
  const depsFor = (w) => ({
    apifyKey: async () => cs.APIFY_KEY, startRun: priv.startApifyGoogleMapsRun, runStatus: priv.getApifyRunStatus, datasetItems: priv.getApifyDatasetItems,
    extractLead: priv.extractLeadFromApify, checkSite: priv.checkLeadSite, noWebsiteFields: priv.noWebsiteFields, pickBestEmail: priv.pickBestEmail,
    browserEligible: priv.browserEligible, useRoutes: () => priv.setRoutes(w.routes),
  });
  before(async () => {
    ({ openOld, openPrivates } = await import("../equiv/old-path.mjs"));
    fresh = (await import("../equiv/new-path.mjs")).openNew("dev");
    cs = await import("../equiv/cases/leadgen.mjs");
    lc = await import("../equiv/cases/leads.mjs");
    shared = await import("../equiv/cases/shared.mjs");
    merged = await fresh.call(shared.mergedCounts);
    priv = await openPrivates(cs.PRIVATES, { exportDir: EXPORT });
    target = await fresh.call(cs.pick);
  });
  after(() => fresh?.close());

  const oldWorld = async () => { const w = cs.world(); return { w, old: await openOld(EXPORT, { fetchRoutes: w.routes, seed: cs.SEED }) }; };
  const campKnown = (id) => [
    ...shared.oneKnown(id, merged, "\\$\\.body\\.data"),
    { path: /^\$\.body\.data\.(job|browser_checked_ids|default_sender_\w+|default_framework|default_sequence_total)$/, when: (d) => d.old === "(absent)", why: "the stored record now carries its saved state (chunk 2: settings and jobs in their own columns)" },
  ];
  const leadsKnown = lc.leadKnown("\\$\\.body\\.data\\[\\d+\\]");

  test("campaign.run → sync (running) → sync (succeeded: 3 new, 3 duplicates of other campaigns, 1 repeat) → read back (F1)", async () => {
    const { id, dup } = target;
    const items = cs.places(dup);
    const { w, old } = await oldWorld();
    const o = {};
    o.run = await old.call("outreach.campaign.run", { id });
    o.afterRun = await old.call("outreach.campaign.get", { id });
    w.state.runStatus = "RUNNING";
    o.syncRunning = await old.call("outreach.campaign.sync", { id });
    w.state.runStatus = "SUCCEEDED"; w.state.items = items;
    o.syncDone = await old.call("outreach.campaign.sync", { id });
    o.syncAgain = await old.call("outreach.campaign.sync", { id });
    o.leads = await old.call("outreach.leads.list", { campaign_id: id });
    const nw = cs.world();
    const deps = depsFor(nw);
    deps.useRoutes();
    const n = await fresh.callWrite(cs.runAndSync, { id, deps, w: nw, items });
    same("run", o.run, n.run, { known: campKnown(id) });
    same("run → get", o.afterRun, n.afterRun, { known: campKnown(id) });
    same("sync running", o.syncRunning, n.syncRunning);
    same("sync succeeded", o.syncDone, n.syncDone);
    assert.equal(n.syncDone.body.data.imported, 3);
    assert.equal(n.syncDone.body.data.skipped, 3);
    same("sync again", o.syncAgain, n.syncAgain);
    const keep = (r) => ({ ...r, body: { ...r.body, data: r.body.data.filter((l) => !lc.mergedIds || true).sort(byName) } });
    const mergedIds = await fresh.call(lc.mergedIds);
    const oldLeads = { ...o.leads, body: { ...o.leads.body, data: o.leads.body.data.filter((l) => !mergedIds.has(l.id)).sort(byName) } };
    same("sync → leads.list", oldLeads, keep(n.leads), { known: leadsKnown, ignoreKeys: ["id"] });
    assert.deepEqual(n.activity.length, 2);
    assert.match(n.activity[0], /3 imported/);
  });

  test("campaign.run refusals: Apify refuses the start (500, job failed), no id, unknown id, no key", async () => {
    const { id } = target;
    const { w, old } = await oldWorld();
    w.state.startFails = true;
    const failed = await old.call("outreach.campaign.run", { id });
    const after = await old.call("outreach.campaign.get", { id });
    w.state.startFails = false;
    const noId = await old.call("outreach.campaign.run", {});
    const unknown = await old.call("outreach.campaign.run", { id: "no-such-campaign-equiv" });
    const noKey = await (await openOld(EXPORT)).call("outreach.campaign.run", { id });
    const nw = cs.world(); const deps = depsFor(nw); deps.useRoutes();
    const n = await fresh.callWrite(cs.runFails, { id, deps, w: nw });
    same("run fails", failed, n.failed);
    same("run fails → get", after, n.after, { known: campKnown(id) });
    same("run no id", noId, n.noId);
    same("run unknown", unknown, n.unknown);
    same("run no key", noKey, n.noKey);
  });

  test("campaign.sync: Apify says FAILED, then a sync on a campaign that is not searching", async () => {
    const { id } = target;
    const { w, old } = await oldWorld();
    await old.call("outreach.campaign.run", { id });
    w.state.runStatus = "FAILED"; w.state.statusMessage = "made-up failure";
    const failed = await old.call("outreach.campaign.sync", { id });
    const notSearching = await old.call("outreach.campaign.sync", { id });
    const nw = cs.world(); const deps = depsFor(nw); deps.useRoutes();
    const n = await fresh.callWrite(cs.syncFailed, { id, deps, w: nw });
    same("sync failed", failed, n.failed);
    same("sync not searching", notSearching, n.notSearching);
  });

  test("leads.add_test, then read back (F1)", async () => {
    const { id } = target;
    const p = { campaign_id: id, name: "Equiv Test Lead", email: "tester@alcance-test.invalid", notes: "made up" };
    const old = await openOld(EXPORT);
    const o = await old.call("outreach.leads.add_test", p);
    const oList = await old.call("outreach.leads.list", { campaign_id: id });
    const n = await fresh.callWrite(async (tx) => ({ made: await cs.addTest(tx, p), list: await lc.list(tx, { campaign_id: id }), refusals: [await cs.addTest(tx, { email: "x@alcance-test.invalid" }), await cs.addTest(tx, { campaign_id: id }), await cs.addTest(tx, { campaign_id: "no-such-campaign-equiv", email: "x@alcance-test.invalid" })] }));
    same("add_test", o, n.made, { known: lc.leadKnown("\\$\\.body\\.data"), ignoreKeys: ["id"] });
    const mergedIds = await fresh.call(lc.mergedIds);
    same("add_test → list", { ...oList, body: { ...oList.body, data: oList.body.data.filter((l) => !mergedIds.has(l.id)).sort(byName) } }, { ...n.list, body: { ...n.list.body, data: n.list.body.data.sort(byName) } }, { known: lc.leadKnown("\\$\\.body\\.data\\[\\d+\\]"), ignoreKeys: ["id"] });
    for (const [i, p2] of [{ email: "x@alcance-test.invalid" }, { campaign_id: id }, { campaign_id: "no-such-campaign-equiv", email: "x@alcance-test.invalid" }].entries()) same(`add_test refusal ${i + 1}`, await old.call("outreach.leads.add_test", p2), n.refusals[i]);
  });

  test("enrich_one and check_site: a made-up site, no website, a chain, already has an email; refusals; read back (F1)", async () => {
    const leads = await fresh.call(async (tx) => {
      const one = async (where) => (await tx.unsafe(`select id, campaign_id, website from leads where merged_into is null and not is_test and not excluded and ${where} order by id limit 1`))[0];
      return {
        site: await one(`website is not null and (email is null or email = '') and coalesce(email_source, '') <> 'manual' and name !~* '(chain|franchise)'`),
        noSite: await one(`website is null and email is null`),
        hasEmail: await one(`email is not null and site_check->>'checked_at' is not null`),
      };
    });
    const host = new URL(/^https?:/.test(leads.site.website) ? leads.site.website : `https://${leads.site.website}`).hostname.replace(/^www\./, "");
    for (const [action, infoOnly] of [["outreach.leads.enrich_one", false], ["outreach.leads.check_site", true]]) {
      for (const [label, l] of Object.entries(leads)) {
        const params = { campaign_id: l.campaign_id, lead_id: l.id };
        const { w, old } = await oldWorld();
        w.state.sites.set(host, cs.SITE_HTML);
        const o = await old.call(action, params);
        const oList = await old.call("outreach.leads.list", { campaign_id: l.campaign_id });
        const nw = cs.world(); nw.state.sites.set(host, cs.SITE_HTML);
        const deps = depsFor(nw); deps.useRoutes();
        const n = await fresh.callWrite(async (tx) => ({ r: await cs.checkSite(tx, { params, deps, infoOnly }), list: await lc.list(tx, { campaign_id: l.campaign_id }) }));
        same(`${action} ${label}`, o, n.r, { known: lc.leadKnown("\\$\\.body\\.data") });
        const mergedIds = await fresh.call(lc.mergedIds);
        const pickOne = (r) => r.body.data.find((x) => x.id === l.id);
        same(`${action} ${label} → list`, pickOne({ body: { data: oList.body.data.filter((x) => !mergedIds.has(x.id)) } }), pickOne(n.list), { known: lc.leadKnown("\\$") });
      }
    }
    const old = await openOld(EXPORT);
    const nw = cs.world(); const deps = depsFor(nw); deps.useRoutes();
    for (const p of [{}, { campaign_id: leads.site.campaign_id }, { campaign_id: leads.site.campaign_id, lead_id: "no-such-lead-equiv" }]) {
      same(`check_site refusal ${Object.keys(p)}`, await old.call("outreach.leads.check_site", p), await fresh.call(cs.checkSite, { params: p, deps, infoOnly: true }));
    }
  });

  test("browsercheck.plan for every campaign; browsercheck.start, then the job (F1); refusals", async () => {
    const old = await openOld(EXPORT, { seed: cs.SEED });
    const campaigns = (await old.call("outreach.campaign.list")).body.data.map((c) => c.id);
    const nw = cs.world(); const deps = depsFor(nw);
    let withLeads = null;
    for (const campaign_id of campaigns) {
      const o = await old.call("outreach.browsercheck.plan", { campaign_id });
      same(`browsercheck.plan ${campaign_id}`, o, await fresh.call(cs.browserPlan, { params: { campaign_id }, deps }));
      if (!withLeads && o.body.data?.leads > 0) withLeads = campaign_id;
    }
    same("browsercheck.plan no id", await old.call("outreach.browsercheck.plan", {}), await fresh.call(cs.browserPlan, { params: {}, deps }));
    same("browsercheck.plan unknown", await old.call("outreach.browsercheck.plan", { campaign_id: "no-such-campaign-equiv" }), await fresh.call(cs.browserPlan, { params: { campaign_id: "no-such-campaign-equiv" }, deps }));
    assert.ok(withLeads, "some campaign has leads to browser-check, so start is really tested");
    const o = await old.call("outreach.browsercheck.start", { campaign_id: withLeads });
    const oGet = await old.call("outreach.campaign.get", { id: withLeads });
    const again = await old.call("outreach.browsercheck.start", { campaign_id: withLeads });
    const n = await fresh.callWrite(async (tx) => ({ start: await cs.browserStart(tx, { params: { campaign_id: withLeads }, deps }), get: await shared.asResponse(async () => (await import("../../../netlify/functions/lib/sql/campaigns.ts")).get(tx, withLeads)), again: await cs.browserStart(tx, { params: { campaign_id: withLeads }, deps }) }));
    same("browsercheck.start", o, n.start);
    same("browsercheck.start → get", oGet, n.get, { known: campKnown(withLeads) });
    same("browsercheck.start while running", again, n.again);
    const noKeyOld = await (await openOld(EXPORT)).call("outreach.browsercheck.start", { campaign_id: withLeads });
    same("browsercheck.start no key", noKeyOld, await fresh.call(cs.browserStart, { params: { campaign_id: withLeads }, deps: { ...deps, apifyKey: async () => null } }));
  });
});
