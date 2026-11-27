// R13 cases for chunk 4 (lead finding). Both sides run the real Apify and site-check code from command.ts against
// the same made-up answers: the old path through fetchRoutes, the SQL side through openPrivates (the same private
// functions, bundled in memory) passed in as deps. Every made-up name and address is on alcance-test.invalid; real
// rows used for duplicates are picked on dev at test time and never written into this file.
import * as leadgen from "../../../../netlify/functions/lib/sql/leadgen.ts";
import * as leads from "../../../../netlify/functions/lib/sql/leads.ts";
import { asResponse } from "./shared.mjs";

export const APIFY_KEY = "equiv-fake-apify-key-not-real";
export const SEED = { "agent-hq-service-config": { apify: { key: APIFY_KEY, updated_at: "2026-11-27T00:00:00Z" } } };
export const PRIVATES = ["startApifyGoogleMapsRun", "getApifyRunStatus", "getApifyDatasetItems", "extractLeadFromApify", "checkLeadSite", "noWebsiteFields", "pickBestEmail", "browserEligible"];

/** The made-up outside world. `state` is changed by the test between calls (run status, items, a failing start). */
export function world() {
  const state = { startFails: false, runStatus: "RUNNING", statusMessage: null, items: [], sites: new Map(), calls: [] };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  async function routes(url) {
    state.calls.push(url.replace(/token=[^&]+/, "token=…"));
    const u = new URL(url);
    if (u.hostname === "api.apify.com") {
      if (u.pathname.endsWith("/acts/compass~crawler-google-places/runs")) return state.startFails ? new Response("made-up failure", { status: 500 }) : json({ data: { id: "equiv-run-1", defaultDatasetId: "equiv-ds-1", status: "READY" } });
      if (u.pathname === "/v2/actor-runs/equiv-run-1") return json({ data: { status: state.runStatus, defaultDatasetId: "equiv-ds-1", statusMessage: state.statusMessage } });
      if (u.pathname === "/v2/datasets/equiv-ds-1/items") return json(state.items);
      return new Response("not found", { status: 404 });
    }
    const host = u.hostname.replace(/^www\./, "");
    if (state.sites.has(host)) return new Response(state.sites.get(host)(u.pathname), { status: 200, headers: { "content-type": "text/html" } });
    return undefined; // anything else stays refused
  }
  return { state, routes };
}

/** A made-up small-business home page: an address to find and a Facebook page. */
export const SITE_HTML = () => `<!doctype html><html><head><title>Made-up Test Plumbing</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<h1>Made-up Test Plumbing</h1><p>Family plumbers. Call <a href="tel:+15550100000">(555) 010-0000</a>.</p>
<p><a href="mailto:office@alcance-test.invalid">office@alcance-test.invalid</a></p>
<a href="https://www.facebook.com/alcance-made-up-plumbing">Facebook</a></body></html>`;

/** Made-up Google Maps places, plus three that copy one key each of a real lead in ANOTHER campaign. */
export function places(dup) {
  const p = (k, extra = {}) => ({ title: `Equiv Made-up Plumbing ${k}`, website: `https://${k.toLowerCase()}.alcance-test.invalid`, phone: `(555) 010-00${k.charCodeAt(0) % 90}`,
    address: `${k.charCodeAt(0)} Test St, Katy, TX 77494`, categoryName: "Plumber", totalScore: 4.5, reviewsCount: 12, url: `https://www.google.com/maps/place/?q=place_id:equiv-${k}`,
    placeId: `equiv-place-${k}`, emails: [`${k.toLowerCase()}@alcance-test.invalid`], ...extra });
  return [
    p("A"), p("B"), p("C", { emails: [] }),
    p("D", { emails: [dup.email] }),
    p("E", { website: dup.website, emails: [] }),
    p("F", { placeId: dup.placeId, emails: [] }),
    p("A", { title: "Equiv Made-up Plumbing A again" }),
  ];
}

/** A campaign with a search set up and leads, and one real key of each kind from leads in other campaigns. */
export async function pick(tx) {
  const [c] = await tx`select id from campaigns where data->'structured_query'->>'location' is not null and exists (select 1 from leads where campaign_id = campaigns.id) order by id limit 1`;
  const other = (col) => tx.unsafe(`select ${col} as v from leads where campaign_id <> $1 and not is_test and ${col} is not null
    and not exists (select 1 from leads o where o.campaign_id = $1 and (o.email_key = leads.email_key or o.website_key = leads.website_key or o.data->'raw'->>'placeId' = leads.data->'raw'->>'placeId'))
    order by id limit 1`, [c.id]);
  const [[e], [w], [pl]] = await Promise.all([other("email"), other("website"), other("data->'raw'->>'placeId'")]);
  return { id: c.id, dup: { email: e.v, website: w.v, placeId: pl.v } };
}

const ctx = { newId: (() => { let i = 0; return () => `equiv-new-${++i}`; })(), createdBy: null };

/** run → sync (running) → sync (succeeded) → the campaign and its leads; the same steps the old path takes. */
export async function runAndSync(tx, { id, deps, w, items }) {
  const out = {};
  out.run = await asResponse(() => leadgen.run(tx, { id }, deps, ctx));
  out.afterRun = await asResponse(() => leadgen.campaignRecord(tx, id));
  w.state.runStatus = "RUNNING";
  out.syncRunning = await asResponse(() => leadgen.sync(tx, { id }, deps, ctx));
  w.state.runStatus = "SUCCEEDED";
  w.state.items = items;
  out.syncDone = await asResponse(() => leadgen.sync(tx, { id }, deps, ctx));
  out.syncAgain = await asResponse(() => leadgen.sync(tx, { id }, deps, ctx));
  out.leads = await asResponse(() => leads.list(tx, { campaign_id: id }));
  out.activity = (await tx`select summary from activity where details->>'campaign_id' = ${id} order by created_at desc nulls last limit 2`).map((r) => r.summary);
  return out;
}

export async function runFails(tx, { id, deps, w }) {
  w.state.startFails = true;
  const failed = await asResponse(() => leadgen.run(tx, { id }, deps, ctx));
  const after = await asResponse(() => leadgen.campaignRecord(tx, id));
  w.state.startFails = false;
  const noId = await asResponse(() => leadgen.run(tx, {}, deps, ctx));
  const unknown = await asResponse(() => leadgen.run(tx, { id: "no-such-campaign-equiv" }, deps, ctx));
  const noKey = await asResponse(() => leadgen.run(tx, { id }, { ...deps, apifyKey: async () => null }, ctx));
  return { failed, after, noId, unknown, noKey };
}

export async function syncFailed(tx, { id, deps, w }) {
  await leadgen.run(tx, { id }, deps, ctx);
  w.state.runStatus = "FAILED";
  w.state.statusMessage = "made-up failure";
  const failed = await asResponse(() => leadgen.sync(tx, { id }, deps, ctx));
  const notSearching = await asResponse(() => leadgen.sync(tx, { id }, deps, ctx));
  return { failed, notSearching };
}

export const addTest = (tx, p) => asResponse(() => leadgen.addTest(tx, p, ctx));
export const checkSite = (tx, { params, deps, infoOnly }) => asResponse(() => leadgen.checkSite(tx, params, deps, infoOnly));
export const browserPlan = (tx, { params, deps }) => asResponse(() => leadgen.browserPlan(tx, params, deps));
export const browserStart = (tx, { params, deps }) => asResponse(() => leadgen.browserStart(tx, params, deps));
