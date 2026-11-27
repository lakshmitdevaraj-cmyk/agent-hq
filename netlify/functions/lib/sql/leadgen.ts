// P2 chunk 4: lead finding on Postgres (used when DATA_BACKEND=sql). Nothing here reaches the network: the Apify calls,
// the website check and the lead-shaping helpers are private to command.ts and are passed in as `deps` (the guarded
// helper in command.ts passes the existing functions; tests pass the same functions from an in-memory bundle).
//   - F2: run, sync and add_test write job progress to the 'leads' job (writeLeadsJob) and never the campaigns row.
//   - F3: a site check writes only site fields. Flags (do-not-contact, excluded, contacted, stop state, kept by me, test)
//     are never in its write, even if a check result carried them; a hand-typed email, owner name or link stays.
//   - F4: the sync dedupe looks up only the scraped leads' keys instead of reading every lead.
import { CampaignError, get as getCampaign, storedRecord, writeJob, writeLeadsJob } from "./campaigns.ts";
import { leadRecord, campaignCtxRecord, type Q } from "./leads.ts";
import { campaignSkipCtx, type SkipCtx } from "./leadrules.ts";
import { normaliseSocialUrl } from "./addlead.ts";
import { leadSkipReason, isJunkEmail, isGovEduEmail, emailKey, websiteKey, placeIdKey, emptyIndex, addToIndex, matchesIndex } from "../outreach.ts";
import { STATE_TZ, stateFromAddress } from "../replydraft.ts";
import { BROWSER_DEFAULT_CAP, estimateBrowserCost } from "../browsercheck.ts";

type Row = Record<string, unknown>;
const fail = (status: number, message: string, opts?: { code?: string; keep?: boolean }): never => { throw new CampaignError(status, message, opts); };

export type LeadgenDeps = {
  apifyKey?: () => Promise<string | null>;
  startRun?: (key: string, terms: string[], location: string, max: number) => Promise<{ runId: string; defaultDatasetId: string | null; status: string }>;
  runStatus?: (key: string, runId: string) => Promise<{ status: string; defaultDatasetId: string | null; statusMessage: string | null }>;
  datasetItems?: (key: string, datasetId: string, limit: number) => Promise<Row[]>;
  extractLead?: (raw: Row) => Row;
  checkSite?: (lead: Row) => Promise<{ fields: Row; emails: string[]; fetched: number; tried: string[] }>;
  noWebsiteFields?: (lead: Row, checkedAt: string) => Row;
  pickBestEmail?: (emails: string[]) => string | null;
  browserEligible?: (lead: Row, ctx: SkipCtx, forced: boolean) => boolean;
};
export type LeadgenCtx = { newId: () => string; createdBy?: string | null };
const need = <K extends keyof LeadgenDeps>(deps: LeadgenDeps, k: K): NonNullable<LeadgenDeps[K]> => deps[k] ?? fail(500, `lead finding is missing ${String(k)}`);

/** outreach.campaign.get, for read-backs. */
export const campaignRecord = (sql: Q, id: string) => getCampaign(sql, id);

async function logActivity(sql: Q, ctx: LeadgenCtx, category: string, summary: string, details: Row): Promise<void> {
  const id = ctx.newId(), now = new Date();
  await sql`insert into activity (id, blob_key, agent_id, category, summary, details, created_at)
            values (${id}, ${`${now.toISOString()}-${id}`}, ${ctx.createdBy ?? null}, ${category}, ${summary}, ${sql.json(details as never)}, ${now})`;
}

/** The campaign's lead-search state: the 'leads' job (status and the old record's apify_* fields). */
async function leadsJob(sql: Q, id: string): Promise<{ name: string; structured: Row | null; status: string | null; data: Row; time_zone: string | null } | null> {
  const [c] = await sql`select c.name, c.data->'structured_query' as structured, c.time_zone, j.status, coalesce(j.data, '{}') as data
                        from campaigns c left join campaign_jobs j on j.campaign_id = c.id and j.kind = 'leads' where c.id = ${id}`;
  return c ? { name: c.name, structured: (c.structured as Row | null) ?? null, status: (c.status as string | null) ?? null, data: c.data as Row, time_zone: c.time_zone ?? null } : null;
}

// ── Inserting a lead (the P1 import's column rules) ────────────────────────

const INSERT_COLUMNS = ["name", "email", "phone", "website", "address", "category", "rating", "reviews_count", "status", "is_test"];

/** Inserts an old-style lead record: its columns as the import sets them, the rest in `data`. */
export async function insertLead(sql: Q, rec: Row, campaignZone: string | null): Promise<void> {
  const cols: Row = { id: rec.id, campaign_id: rec.campaign_id, blob_key: `${rec.campaign_id}/${rec.created_at}-${rec.id}`, created_at: new Date(rec.created_at as string) };
  const data: Row = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "id" || k === "campaign_id" || k === "created_at") continue;
    if (INSERT_COLUMNS.includes(k)) cols[k] = v ?? (k === "is_test" ? false : null);
    else data[k] = v;
  }
  const raw = (rec.raw ?? {}) as Row;
  const email = (rec.email as string | null) ?? null;
  const usState = stateFromAddress(rec.address);
  Object.assign(cols, {
    email_key: emailKey(email), website_key: websiteKey(rec.website as string | null),
    email_source: email ? (rec.is_test === true ? "manual" : "google_maps") : null,
    city: (typeof raw.city === "string" && raw.city) || (/([^,]+),\s*[A-Z]{2}\b/.exec(String(rec.address ?? ""))?.[1].trim() ?? null),
    time_zone: (usState && STATE_TZ[usState]) || campaignZone || null,
    data: sql.json(data as never),
  });
  await sql`insert into leads ${sql(cols)}`;
}

// ── campaign.run ───────────────────────────────────────────────────────────

/** outreach.campaign.run: starts the Google Maps search; progress goes to the 'leads' job only (F2). */
export async function run(sql: Q, params: Row, deps: LeadgenDeps, ctx: LeadgenCtx): Promise<Row> {
  const id = params.id as string;
  if (!id) fail(400, "id required");
  const c = await leadsJob(sql, id);
  if (!c) return fail(404, "campaign not found");
  const sq = c.structured as { searchTerms: string[]; location: string; maxResults: number } | null;
  if (!sq) fail(400, "campaign has no structured_query — run preview first");
  const key = await need(deps, "apifyKey")();
  if (!key) fail(400, "Apify key not configured");
  try {
    const r = await need(deps, "startRun")(key as string, sq!.searchTerms, sq!.location, sq!.maxResults);
    await writeLeadsJob(sql, id, { status: "searching", apify_run_id: r.runId, apify_dataset_id: r.defaultDatasetId, apify_status: r.status, error_message: null, last_run_at: new Date().toISOString() });
    await logActivity(sql, ctx, "research", `Apify run started for "${c.name}"`, { campaign_id: id, apify_run_id: r.runId });
    return (await storedRecord(sql, id))!;
  } catch (err) {
    if (err instanceof CampaignError) throw err;
    const message = err instanceof Error ? err.message : "Run start failed";
    await writeLeadsJob(sql, id, { status: "failed", error_message: message });
    return fail(500, message, { keep: true });
  }
}

// ── campaign.sync ──────────────────────────────────────────────────────────

const CLAIM_MS = 90_000;

/** Takes the import claim in one statement (true), or false when another sync claimed it less than 90 s ago. */
export async function claimImport(sql: Q, id: string): Promise<boolean> {
  const now = new Date();
  const rows = await sql`update campaign_jobs set data = data || ${sql.json({ import_started_at: now.toISOString() })}
    where campaign_id = ${id} and kind = 'leads'
      and (data->>'import_started_at' is null or (data->>'import_started_at')::timestamptz < ${new Date(now.getTime() - CLAIM_MS)})
    returning 1`;
  return rows.length > 0;
}

/**
 * outreach.campaign.sync. The old code also refreshed sent-email statuses from AgentMail here; that is email status
 * (chunks 6–7), so this answers status_refresh: null, as the old code does whenever there is no AgentMail key.
 * A failed import is rolled back whole (no half import); only the explicit "failed" states are kept.
 */
export async function sync(sql: Q, params: Row, deps: LeadgenDeps, ctx: LeadgenCtx): Promise<Row> {
  const id = params.id as string;
  if (!id) fail(400, "id required");
  const c = await leadsJob(sql, id);
  if (!c) return fail(404, "campaign not found");
  const runId = c.data.apify_run_id as string | undefined;
  if (c.status !== "searching" || !runId) return { status: c.status, apify_status: c.data.apify_status ?? null, changed: false, status_refresh: null };
  const key = await need(deps, "apifyKey")();
  if (!key) fail(400, "Apify key not configured");
  try {
    const st = await need(deps, "runStatus")(key as string, runId);
    if (st.status === "SUCCEEDED") {
      const datasetId = st.defaultDatasetId ?? (c.data.apify_dataset_id as string | null) ?? null;
      if (!datasetId) {
        const msg = "Apify succeeded but no dataset id was returned";
        await writeLeadsJob(sql, id, { status: "failed", error_message: msg, apify_status: st.status });
        return fail(500, msg, { keep: true });
      }
      if (!(await claimImport(sql, id))) return { status: "searching", apify_status: st.status, changed: false };
      const items = await need(deps, "datasetItems")(key as string, datasetId, Number((c.structured as Row | null)?.maxResults ?? 0));
      const extract = need(deps, "extractLead");
      const scraped = items.map((raw) => {
        const e = extract(raw);
        if (isGovEduEmail(e.email as string | null)) e.email = null; // never a sales contact: keep the lead, drop the address
        return { e, raw };
      });
      // Dedupe as today (place id, email, website against every OTHER campaign; this campaign's own leads are a retried
      // import and are skipped silently), but only the rows that share a key with a scraped lead are read.
      const keys = (f: (x: { e: Row; raw: Row }) => string | null) => [...new Set(scraped.map(f).filter((k): k is string => !!k))];
      const existing = await sql`select campaign_id, email, website, data->'raw' as raw from leads where not is_test and (
          email_key = any(${keys((x) => emailKey(x.e.email as string | null))}) or website_key = any(${keys((x) => websiteKey(x.e.website as string | null))})
          or (data->'raw'->>'placeId') = any(${keys((x) => placeIdKey(x.raw))}))`;
      const prior = emptyIndex(), own = emptyIndex();
      for (const r of existing) addToIndex(r.campaign_id === id ? own : prior, r as never);
      let imported = 0, skipped = 0;
      const skippedBy = { place_id: 0, email: 0, website: 0 };
      for (const { e, raw } of scraped) {
        const candidate = { email: e.email as string | null, website: e.website as string | null, raw };
        if (matchesIndex(own, candidate)) continue;
        const hit = matchesIndex(prior, candidate);
        if (hit) { skipped++; skippedBy[hit]++; continue; }
        addToIndex(prior, candidate);
        await insertLead(sql, { id: ctx.newId(), campaign_id: id, ...e, raw, status: "new", is_test: false, tags: [], created_at: new Date().toISOString() }, c.time_zone);
        imported++;
      }
      const [{ n }] = await sql`select count(*)::int as n from leads where campaign_id = ${id} and merged_into is null`;
      await writeLeadsJob(sql, id, { status: "ready", apify_status: st.status, total_leads_found: items.length, leads_skipped_duplicate: skipped, leads_skipped_by: skippedBy, leads_imported: n, import_started_at: null });
      await logActivity(sql, ctx, "research", `Apify scrape complete for "${c.name}": ${items.length} found, ${skipped} skipped as already contacted, ${imported} imported`, { campaign_id: id, found: items.length, skipped, imported });
      return { status: "ready", apify_status: st.status, found: items.length, skipped, imported, changed: true };
    }
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(st.status)) {
      await writeLeadsJob(sql, id, { status: "failed", apify_status: st.status, error_message: `Apify run ${st.status.toLowerCase()}: ${st.statusMessage ?? "no details"}` });
      return { status: "failed", apify_status: st.status, changed: true };
    }
    if (st.status !== c.data.apify_status) await writeLeadsJob(sql, id, { apify_status: st.status });
    return { status: "searching", apify_status: st.status, changed: false };
  } catch (err) {
    if (err instanceof CampaignError) throw err;
    return fail(500, err instanceof Error ? err.message : "Sync failed");
  }
}

// ── leads.add_test ─────────────────────────────────────────────────────────

/** outreach.leads.add_test: a test lead with your own address. The campaign row is not written (counts are worked out). */
export async function addTest(sql: Q, params: Row, ctx: LeadgenCtx): Promise<Row> {
  const { campaign_id, name, email, notes } = params as Record<string, string>;
  if (!campaign_id) fail(400, "campaign_id required");
  if (!email) fail(400, "email required");
  const c = await leadsJob(sql, campaign_id);
  if (!c) return fail(404, "campaign not found");
  const id = ctx.newId();
  await insertLead(sql, { id, campaign_id, name: name || email.split("@")[0], email, phone: null, website: null, address: null, category: null, rating: null, reviews_count: null, maps_url: null, raw: { source: "test_lead" }, notes: notes ?? null, status: "new", is_test: true, tags: ["test"], created_at: new Date().toISOString() }, c.time_zone);
  await logActivity(sql, ctx, "system", `Test lead added to campaign "${c.name}": ${email}`, { campaign_id, lead_id: id });
  return leadRecord((await sql`select * from leads where id = ${id}`)[0]);
}

// ── enrich_one / check_site (F3) ───────────────────────────────────────────

/** Never written by a site check: the flags a person or a reply sets, and the lead's identity. */
const NEVER = new Set(["id", "campaign_id", "created_at", "blob_key", "merged_into", "is_test", "excluded", "excluded_at", "excluded_reason", "excluded_note", "not_fit_kept",
  "do_not_contact", "do_not_contact_at", "do_not_contact_reason", "stop_state", "stop_reason", "stopped_at", "contacted_at", "email", "email_key", "email_source", "status", "trade_override"]);
const OWNER = ["owner_name", "contact_name", "owner_confidence", "owner_source", "owner_source_url", "owner_evidence"];
const SITE_COLUMNS = new Set(["name", "owner_name", "contact_name", "phone", "website", "address", "category", "rating", "reviews_count", "gap_score", "site_check", "enriched_at", "browser_checked_at", "updated_at"]);

/**
 * Writes what a site check found, and nothing else (F3): never a flag, never a hand-typed owner name, never over a
 * hand-typed email (the 0007 trigger also refuses that) or link (the links trigger keeps a 'manual' row).
 */
async function writeSiteFields(sql: Q, leadId: string, fields: Row, opts: { email?: string | null; junk?: string | null } = {}): Promise<void> {
  const [cur] = await sql`select data->>'owner_source' as owner_source from leads where id = ${leadId} for update`;
  const cols: Row = {};
  const data: Row = {};
  for (const [k, v] of Object.entries(fields)) {
    if (NEVER.has(k) || (cur?.owner_source === "manual" && OWNER.includes(k))) continue;
    if (SITE_COLUMNS.has(k)) cols[k] = k.endsWith("_at") && typeof v === "string" ? new Date(v) : v;
    else data[k] = v;
  }
  if (opts.junk) data.junk_email = opts.junk;
  if (typeof data.social === "object" && data.social) {
    // Keep data.social in step with lead_social_links, where a hand-typed link wins.
    const manual = await sql`select kind, url from lead_social_links where lead_id = ${leadId} and source = 'manual'`;
    data.social = { ...(data.social as Row), ...Object.fromEntries(manual.map((m) => [m.kind, m.url])) };
  }
  if (Object.keys(cols).length || Object.keys(data).length) {
    await sql`update leads set ${sql({ ...cols, updated_at: new Date() })}, data = data || ${sql.json(data as never)} where id = ${leadId}`;
  }
  if (opts.junk) await sql`update leads set email = null, email_key = null where id = ${leadId} and email = ${opts.junk} and email_source is distinct from 'manual'`;
  if (opts.email) {
    await sql`update leads set email = ${opts.email}, email_key = ${emailKey(opts.email)}, email_source = 'site_check'
              where id = ${leadId} and (email is null or email = '' or email = ${opts.junk ?? ""})`;
  }
  for (const [kind, url] of Object.entries((fields.social ?? {}) as Row)) {
    const n = typeof url === "string" ? normaliseSocialUrl(url) : null;
    if (!n) continue;
    await sql`insert into social_pages (platform, url_norm, url) values (${n.platform}, ${n.url_norm}, ${url as string}) on conflict (url_norm) do nothing`;
    await sql`insert into lead_social_links (lead_id, kind, page_id, url, source, updated_at)
              select ${leadId}, ${kind}, id, ${url as string}, 'site_check', now() from social_pages where url_norm = ${n.url_norm}
              on conflict (lead_id, kind) do update set page_id = excluded.page_id, url = excluded.url, source = excluded.source, updated_at = excluded.updated_at`;
  }
}

/** outreach.leads.enrich_one (infoOnly false) and outreach.leads.check_site (infoOnly true). */
export async function checkSite(sql: Q, params: Row, deps: LeadgenDeps, infoOnly: boolean): Promise<Row> {
  const { campaign_id, lead_id } = params as Record<string, string>;
  if (!campaign_id || !lead_id) fail(400, "campaign_id and lead_id required");
  const [row] = await sql`select * from leads where id = ${lead_id} and campaign_id = ${campaign_id} and merged_into is null`;
  if (!row) return fail(404, "lead not found");
  let lead = leadRecord(row);
  const hadEmail = !!lead.email && !isJunkEmail(lead.email as string);
  const manualEmail = lead.email_source === "manual";
  if (!infoOnly && hadEmail && (lead.site_check as { checked_at?: string } | null)?.checked_at) return { ...lead, already_had_email: true, enriched: false };
  const junk = lead.email && !hadEmail ? (lead.email as string) : null;
  if (junk) lead = { ...lead, email: null, junk_email: junk };
  const checkedAt = new Date().toISOString();
  const skip = leadSkipReason(lead as Parameters<typeof leadSkipReason>[0], campaignSkipCtx(await campaignCtxRecord(sql, campaign_id)));
  const reread = async () => leadRecord((await sql`select * from leads where id = ${lead_id}`)[0]);
  if (skip && (skip.code === "chain" || skip.code === "out_of_state")) {
    await writeSiteFields(sql, lead_id, { enrich_checked_at: checkedAt, site_check: { checked_at: checkedAt, error: skip.message } }, { junk });
    return { ...lead, enriched: false, reason: skip.message };
  }
  if (!lead.website) {
    await writeSiteFields(sql, lead_id, { enrich_checked_at: checkedAt, ...need(deps, "noWebsiteFields")(lead, checkedAt) }, { junk });
    return { ...(await reread()), ...(junk ? { email: null, junk_email: junk } : {}), enriched: false, reason: "no website to scrape" };
  }
  let res;
  try { res = await need(deps, "checkSite")(lead); } catch (err) { return fail(500, err instanceof Error ? err.message : "Website check failed"); }
  const fresh = await reread();
  const skipEmail = (!!skip && skip.code === "gov_edu_email") || manualEmail || fresh.email_source === "manual";
  let found: string | null = null;
  const at = new Date().toISOString();
  if (!hadEmail && !skipEmail) found = need(deps, "pickBestEmail")(res.emails);
  await writeSiteFields(sql, lead_id, { ...res.fields, enrich_checked_at: checkedAt, ...(found ? { enriched_at: at, enrichment_source: "website_scrape" } : {}) }, { junk, email: found });
  const after = await reread();
  return { ...after, ...(junk && !found ? { email: null, junk_email: junk } : {}), enriched: !!found, tried: res.tried, reason: found || hadEmail ? undefined : res.fetched === 0 ? "website did not load" : "no email found on website" };
}

// ── browsercheck.plan / browsercheck.start ─────────────────────────────────

const JOB_STALE_MS = 4 * 60_000;

/** The same plan as planBrowserCheck: eligible leads (emailable first), within the campaign's cap; re-checks are free. */
export async function browserPlan(sql: Q, params: Row, deps: LeadgenDeps): Promise<Row> {
  const { campaign_id, lead_id } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  const cid = campaign_id as string;
  const leadId = typeof lead_id === "string" ? lead_id : undefined;
  const [[camp], [checked], [settings], rows] = await Promise.all([
    sql`select niche as query, data->'structured_query' as structured_query, any_trade from campaigns where id = ${cid}`,
    sql`select data->'browser_checked_ids' as ids from campaign_jobs where campaign_id = ${cid} and kind = 'browser_check'`,
    sql`select data from outreach_settings where key = 'settings'`,
    sql`select * from leads where campaign_id = ${cid} and merged_into is null order by created_at, id`,
  ]);
  if (!camp) return fail(404, "campaign not found");
  const ctx = campaignSkipCtx(camp);
  const capSetting = (settings?.data as Row | undefined)?.browser_check_cap as number | undefined;
  const cap = Math.max(1, Math.min(200, capSetting ?? BROWSER_DEFAULT_CAP));
  const done = new Set<string>(Array.isArray(checked?.ids) ? (checked!.ids as string[]) : []);
  const eligible = need(deps, "browserEligible");
  let picked = rows.map(leadRecord).filter((l) => (leadId ? l.id === leadId : true) && eligible(l, ctx, !!leadId));
  const hasEmail = (l: Row) => (l.email && !isJunkEmail(l.email as string) ? 0 : 1);
  picked = picked.map((l, i) => ({ l, i })).sort((a, b) => hasEmail(a.l) - hasEmail(b.l) || a.i - b.i).map((x) => x.l);
  const remaining = Math.max(0, cap - done.size);
  let room = remaining;
  picked = picked.filter((l) => { if (done.has(l.id as string)) return true; if (room <= 0) return false; room--; return true; });
  const est = estimateBrowserCost(picked.length);
  return { lead_ids: picked.map((l) => l.id), names: picked.map((l) => String(l.name ?? l.id)), leads: picked.length, pages: est.pages, est_usd: est.usd, cap, used: done.size, remaining };
}

/** outreach.browsercheck.start: records the job; the page then starts the background run, as today. */
export async function browserStart(sql: Q, params: Row, deps: LeadgenDeps): Promise<Row> {
  const { campaign_id, lead_id } = params;
  if (typeof campaign_id !== "string" || !campaign_id) fail(400, "campaign_id required");
  const cid = campaign_id as string;
  const campaign = await storedRecord(sql, cid); // read first, so the answers below come in the old order
  if (!(await need(deps, "apifyKey")())) fail(400, "Apify key not configured. Add it in Settings to use the browser check.");
  if (!campaign) return fail(404, "campaign not found");
  const job = campaign.job as { status?: string; progress_at?: string; started_at?: string } | undefined;
  const last = Date.parse(job?.progress_at ?? job?.started_at ?? "");
  if (job?.status === "running" && Number.isFinite(last) && Date.now() - last < JOB_STALE_MS) fail(409, "A job is already running for this campaign. Wait for it to finish.", { code: "job_running" });
  const plan = await browserPlan(sql, { campaign_id: cid, ...(typeof lead_id === "string" ? { lead_id } : {}) }, deps);
  if (plan.leads === 0) fail(400, (plan.remaining as number) <= 0 && (plan.used as number) > 0 ? `The browser check limit for this campaign (${plan.cap} leads) is reached. You can raise it in Settings.` : "No lead needs a browser check right now.");
  const now = new Date().toISOString();
  await writeJob(sql, cid, "browsercheck", { status: "running", total: plan.leads, done: 0, started_at: now, progress_at: now, message: "Starting the browser…" });
  return { ...plan, started_at: now };
}

// ── The actions, for command.ts ────────────────────────────────────────────

export const LEADGEN_ACTIONS = ["outreach.browsercheck.plan", "outreach.browsercheck.start", "outreach.campaign.run", "outreach.campaign.sync", "outreach.leads.add_test", "outreach.leads.enrich_one", "outreach.leads.check_site", "outreach.leads.add"] as const;
export type LeadgenAction = (typeof LEADGEN_ACTIONS)[number];

export async function runLeadgenAction(sql: Q, action: LeadgenAction, params: Row, deps: LeadgenDeps, ctx: LeadgenCtx): Promise<unknown> {
  switch (action) {
    case "outreach.browsercheck.plan": return browserPlan(sql, params, deps);
    case "outreach.browsercheck.start": return browserStart(sql, params, deps);
    case "outreach.campaign.run": return run(sql, params, deps, ctx);
    case "outreach.campaign.sync": return sync(sql, params, deps, ctx);
    case "outreach.leads.add_test": return addTest(sql, params, ctx);
    case "outreach.leads.enrich_one": return checkSite(sql, params, deps, false);
    case "outreach.leads.check_site": return checkSite(sql, params, deps, true);
    case "outreach.leads.add": return (await import("./addlead.ts")).addLeads(sql, params, ctx);
  }
}
