// Screenshots of the Prospects "Contacted" column: the first rows get synthetic touch summaries (0, 1, 2, 3 and 4 channels, with and
// without Replied) injected into the prospects.list response in the browser only. Nothing is written to any store.
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const outDir = process.argv[2] || "tasks/tests-8b/screenshots/round2";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/Users/lakshmidevaraj/Documents/SocialEngine/node_modules/playwright-core");
const chrome = fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`).find((p) => fs.existsSync(p));
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const mk = (e, f, i, l, last, rep) => ({ counts: { email: e, facebook: f, instagram: i, linkedin: l }, total: e + f + i + l, last_at: last, replied: !!rep, replied_at: rep, replied_via: rep ? "email" : null });
const CASES = [mk(0, 0, 0, 0, null, null), mk(1, 0, 0, 0, "2026-11-22T10:00:00Z", null), mk(1, 0, 0, 0, "2026-11-18T10:00:00Z", "2026-11-21T09:00:00Z"), mk(2, 2, 1, 0, "2026-11-22T10:00:00Z", null), mk(2, 2, 1, 1, "2026-11-22T10:00:00Z", "2026-11-21T09:00:00Z"), mk(0, 0, 0, 0, null, "2026-11-20T09:00:00Z")];
const b = await chromium.launch({ executablePath: chrome, headless: true });
fs.mkdirSync(outDir, { recursive: true });
for (const [sch, theme] of [["dark", "auto"], ["light", "auto"]]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: sch });
  await ctx.addInitScript((k) => { try { localStorage.setItem("agent_hq_api_key", k); localStorage.setItem("agent_hq_live_feed_hidden", "1"); } catch {} }, KEY);
  const p = await ctx.newPage();
  await p.route("**/api/command", async (route) => {
    const req = route.request();
    if (!(req.postData() || "").includes("outreach.prospects.list")) return route.continue();
    const res = await route.fetch(); const j = await res.json();
    const arr = j.data; const base = arr[0] || {};
    const names = ["0 channels", "1 channel (email)", "1 channel, replied", "3 channels", "4 channels, replied", "Replied only"];
    const fake = CASES.map((c, i) => ({ ...base, id: "demo-" + i, name: "Demo " + names[i], gap_score: 99 - i, touches: c, social_drafts: [], fb_checked: null, excluded: false, auto_not_fit: null, not_fit_kept: false, is_test: false, do_not_contact: false, email_status: c.replied ? "replied" : c.total ? "emailed" : "not_emailed" }));
    j.data = [...fake, ...arr];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  await p.goto("http://localhost:8890/prospects"); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(1200);
  const th = p.locator("th", { hasText: "Contacted" }).first();
  await th.scrollIntoViewIfNeeded().catch(() => {});
  await p.evaluate(() => { const sc = [...document.querySelectorAll("div")].find((d) => d.scrollWidth > d.clientWidth + 5 && /auto|scroll/.test(getComputedStyle(d).overflowX)); if (sc) { const t = [...sc.querySelectorAll("th")].find((x) => /Contacted/.test(x.textContent)); if (t) sc.scrollLeft = t.offsetLeft - 330; } });
  await p.waitForTimeout(300);
  await p.evaluate(() => { const t = document.querySelector("table"); window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 60); });
  await p.waitForTimeout(300);
  const box = await p.locator("table").first().boundingBox();
  await p.screenshot({ path: path.join(outDir, `contacted-${sch}.png`), clip: { x: 280, y: Math.max(0, box.y - 10), width: 1160, height: 560 } });
  // line count check: each cell must be at most two lines tall
  const heights = await p.evaluate(() => [...document.querySelectorAll("tbody tr td:nth-child(9) > div")].slice(0, 6).map((d) => Math.round(d.getBoundingClientRect().height)));
  console.log(sch, "contacted cell heights (px):", heights.join(", "));
  await ctx.close();
}
await b.close();
