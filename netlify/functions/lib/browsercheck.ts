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
  const ud = request.userData || {};
  let shot = null;
  let shotError = null;
  if (ud.home) { try { await page.setViewportSize({ width: 1280, height: 800 }); } catch (e) {} }
  await page.waitForTimeout(6000);
  const html = await page.content();
  if (ud.home) {
    // Homepage only: one 1280x800 JPEG, quality stepped down until it is about 150 KB.
    try {
      for (const q of [72, 55, 40, 30]) {
        const buf = await page.screenshot({ type: "jpeg", quality: q });
        shot = buf.toString("base64");
        if (buf.length <= 150000) break;
      }
    } catch (e) { shot = null; shotError = String((e && e.message) || e).slice(0, 160); }
  }
  return { lead_id: ud.lead_id, url: page.url(), html: html.slice(0, 600000), screenshot: shot, screenshot_error: shotError, home: !!ud.home };
}`;

export function browserInput(sites: Array<{ lead_id: string; base: string }>): Record<string, unknown> {
  const startUrls: Array<{ url: string; userData: { lead_id: string; home: boolean } }> = [];
  for (const s of sites) {
    for (const p of BROWSER_PATHS) {
      try { startUrls.push({ url: new URL(p, s.base).toString(), userData: { lead_id: s.lead_id, home: p === "" } }); } catch { /* bad URL: skip */ }
    }
  }
  return {
    startUrls,
    pageFunction: BROWSER_PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true },
    // Do NOT wait for the network to go idle: sites with chat widgets and trackers (GoDaddy and others)
    // never go idle, so every page timed out. The page function waits a few seconds for late widgets itself.
    waitUntil: "domcontentloaded",
    maxPagesPerCrawl: startUrls.length,
    maxConcurrency: 5,
    headless: true,
    ignoreSslErrors: true,
    maxRequestRetries: 1,
    pageLoadTimeoutSecs: 30,
    pageFunctionTimeoutSecs: 40,
    downloadMedia: false, // images, fonts and video are not needed to see which scripts load
    downloadCss: false,
    maxScrollHeightPixels: 0,
  };
}

/** The few log lines worth showing on the banner: errors and failures, newest last, cleaned up and short. */
export function logTail(log: string, maxLines = 6, maxChars = 700): string {
  const lines = log
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "").replace(/token=[^&\s]+/gi, "token=…").trim())
    .filter(Boolean);
  const bad = lines.filter((l) => /error|fail|timeout|exceeded|blocked|denied|refused/i.test(l));
  const picked = (bad.length > 0 ? bad : lines).slice(-maxLines);
  return picked.join("\n").slice(-maxChars);
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

/**
 * Why a lead's homepage got no picture, per lead (only leads whose homepage was opened and gave none).
 * "taking the picture failed: <browser message>" when the page function caught an error, else "the browser returned no picture".
 */
export function screenshotErrorsByLead(items: Array<Record<string, unknown>>): Map<string, string> {
  const have = new Set<string>();
  for (const it of items) if (typeof it.lead_id === "string" && typeof it.screenshot === "string" && it.screenshot.length > 500) have.add(it.lead_id);
  const out = new Map<string, string>();
  for (const it of items) {
    const id = typeof it.lead_id === "string" ? it.lead_id : null;
    if (!id || have.has(id) || it.home !== true || out.has(id)) continue;
    out.set(id, typeof it.screenshot_error === "string" && it.screenshot_error ? `Taking the picture failed: ${it.screenshot_error}` : "The browser opened the homepage but returned no picture.");
  }
  return out;
}

/** The homepage screenshot (base64 JPEG) per lead, from the same dataset items. */
export function screenshotsByLead(items: Array<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of items) {
    const id = typeof it.lead_id === "string" ? it.lead_id : null;
    const shot = typeof it.screenshot === "string" && it.screenshot.length > 500 ? it.screenshot : null;
    if (id && shot && !out.has(id)) out.set(id, shot);
  }
  return out;
}
