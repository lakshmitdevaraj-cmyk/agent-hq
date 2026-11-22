// Screenshots of chosen routes: node tasks/tests-8b/shoot.mjs <outDir> <label> <routes comma list> [widths comma list]
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const [outDir, label, routes, widths = "1440,800"] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/Users/lakshmidevaraj/Documents/SocialEngine/node_modules/playwright-core");
const chrome = fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`).find((p) => fs.existsSync(p));
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ executablePath: chrome, headless: true });
for (const w of widths.split(",").map(Number)) for (const sch of ["dark", "light"]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, colorScheme: sch });
  await ctx.addInitScript((k) => { try { localStorage.setItem("agent_hq_api_key", k); localStorage.setItem("agent_hq_live_feed_hidden", "1"); } catch {} }, KEY);
  const p = await ctx.newPage();
  for (const r of routes.split(",")) {
    await p.goto("http://localhost:8890" + r); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(900);
    for (const re of [/finish later/i, /skip for now/i]) { const x = p.getByRole("button", { name: re }).first(); if (await x.count()) await x.click().catch(() => {}); }
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(outDir, `${label}-${r === "/" ? "office" : r.slice(1)}-${sch}-${w}.png`) });
  }
  await ctx.close();
}
await b.close(); console.log("done");
