// Lists the elements that stick out past the viewport on a route: node tasks/tests-8b/widest.mjs /prospects 800
import fs from "node:fs"; import { createRequire } from "node:module";
const [route, width = "800"] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/lakshmidevaraj/Documents/SocialEngine/node_modules/playwright-core");
const chrome = fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`).find((p) => fs.existsSync(p));
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const b = await chromium.launch({ executablePath: chrome, headless: true });
const ctx = await b.newContext({ viewport: { width: Number(width), height: 900 } });
await ctx.addInitScript((k) => { localStorage.setItem("agent_hq_api_key", k); localStorage.setItem("agent_hq_live_feed_hidden", "1"); }, KEY);
const p = await ctx.newPage(); await p.goto("http://localhost:8890" + route); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(1200);
console.log(await p.evaluate(() => { const w = innerWidth; const bad = [...document.body.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.right > w + 1)) return false; return getComputedStyle(e).position !== "fixed"; }); return `doc ${document.documentElement.scrollWidth} > ${w}\n` + bad.slice(0, 8).map((e) => e.tagName + "." + String(e.className).slice(0, 70) + " right=" + Math.round(e.getBoundingClientRect().right)).join("\n"); }));
await b.close();
