/**
 * Browser check helpers (pure): the Apify "playwright-scraper" input that opens
 * each site in a real browser (so chat and booking widgets that load with
 * JavaScript appear), the cost estimate shown before a run, and the conversion
 * of its results back into pages the normal detectors can read.
 */
import type { Page } from "./sitecheck";

export const BROWSER_ACTOR = "apify~playwright-scraper";
/** Pages opened per lead: homepage, contact page, About page. */
export const BROWSER_PATHS = ["", "/contact", "/about"];
export const BROWSER_DEFAULT_CAP = 25; // leads per campaign (a setting)
// Rough Apify price: a small start fee plus about half a cent per page (shown as an estimate, never as a promise).
const START_FEE_USD = 0.02;
const PER_PAGE_USD = 0.005;

export const estimateBrowserCost = (leads: number): { pages: number; usd: number } => {
  const pages = leads * BROWSER_PATHS.length;
  return { pages, usd: Math.round((START_FEE_USD + pages * PER_PAGE_USD) * 100) / 100 };
};

/** Runs inside the actor's browser: wait for late widgets, then return the page as the browser sees it. */
export const BROWSER_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page, request } = context;
  await page.waitForTimeout(6000);
  const html = await page.content();
  return { lead_id: request.userData && request.userData.lead_id, url: page.url(), html: html.slice(0, 600000) };
}`;

export function browserInput(sites: Array<{ lead_id: string; base: string }>): Record<string, unknown> {
  const startUrls: Array<{ url: string; userData: { lead_id: string } }> = [];
  for (const s of sites) {
    for (const p of BROWSER_PATHS) {
      try { startUrls.push({ url: new URL(p, s.base).toString(), userData: { lead_id: s.lead_id } }); } catch { /* bad URL: skip */ }
    }
  }
  return {
    startUrls,
    pageFunction: BROWSER_PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true },
    maxRequestsPerCrawl: startUrls.length,
    maxConcurrency: 5,
    headless: true,
    ignoreSslErrors: true,
    maxRequestRetries: 1,
    pageLoadTimeoutSecs: 40,
  };
}

/** Dataset items -> pages per lead (homepage first, one page per URL). */
export function pagesByLead(items: Array<Record<string, unknown>>): Map<string, Page[]> {
  const out = new Map<string, Page[]>();
  for (const it of items) {
    const id = typeof it.lead_id === "string" ? it.lead_id : null;
    const url = typeof it.url === "string" ? it.url : null;
    const html = typeof it.html === "string" ? it.html : null;
    if (!id || !url || !html) continue;
    const list = out.get(id) ?? [];
    if (!list.some((p) => p.url.replace(/\/$/, "") === url.replace(/\/$/, ""))) list.push({ url, html });
    out.set(id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.url.length - b.url.length);
  return out;
}
