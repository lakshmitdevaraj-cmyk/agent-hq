// Prospects side panel with the dimmed backdrop, both themes; also checks Esc and click-outside close it.
import fs from "node:fs"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/lakshmidevaraj/Documents/SocialEngine/node_modules/playwright-core");
const chrome = fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`).find((p) => fs.existsSync(p));
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const b = await chromium.launch({ executablePath: chrome, headless: true });
for (const sch of ["dark", "light"]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: sch });
  await ctx.addInitScript((k) => { localStorage.setItem("agent_hq_api_key", k); localStorage.setItem("agent_hq_live_feed_hidden", "1"); }, KEY);
  const p = await ctx.newPage(); await p.goto("http://localhost:8890/prospects"); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(1200);
  await p.locator("tbody tr").first().click(); await p.waitForTimeout(600);
  await p.screenshot({ path: `tasks/tests-8b/screenshots/round2/prospects-panel-dimmed-${sch}.png` });
  const a = await p.evaluate(() => { const el = document.querySelector("[role=dialog] > div"); return getComputedStyle(el).backgroundColor; });
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  const escClosed = (await p.locator("[role=dialog]").count()) === 0;
  await p.locator("tbody tr").first().click(); await p.waitForTimeout(500);
  await p.mouse.click(300, 450); await p.waitForTimeout(300);
  const outClosed = (await p.locator("[role=dialog]").count()) === 0;
  console.log(sch, "backdrop", a, "| Esc closes:", escClosed, "| click outside closes:", outClosed);
  await ctx.close();
}
await b.close();
