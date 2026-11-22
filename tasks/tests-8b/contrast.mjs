// Contrast check for batch 8b: visits every page and the main open panels in BOTH colour modes and lists text under 4.5:1
// (3:1 for large text). Text only; disabled controls are exempt (WCAG). Local server only; prints no keys.
// Usage: node tasks/tests-8b/contrast.mjs [baseUrl] [--shots dir]
//   PLAYWRIGHT_CORE=/path/to/playwright-core  CHROME=/path/to/chrome
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const base = process.argv.find((a) => a.startsWith("http")) || "http://localhost:8890";
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/Users/lakshmidevaraj/Documents/SocialEngine/node_modules/playwright-core");
const chrome = process.env.CHROME || fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `${process.env.HOME}/Library/Caches/ms-playwright/${d}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`).find((p) => fs.existsSync(p));
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();

// Runs inside the page. Returns [{text, ratio, need, fg, bg, tag}] for every visible piece of text under its threshold.
const CHECK = () => {
  const parse = (c) => {
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; }
    m = c.match(/^color\(srgb ([^)]+)\)$/);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] }; }
    return { r: 0, g: 0, b: 0, a: 0 };
  };
  const over = (top, bot) => { const a = top.a + bot.a * (1 - top.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a, g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a, b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const page = parse(getComputedStyle(document.body).backgroundColor);
  const bgOf = (el) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let bg = { r: page.r, g: page.g, b: page.b, a: 1 };
    for (const e of chain.reverse()) {
      const cs = getComputedStyle(e);
      const c = parse(cs.backgroundColor);
      if (c.a > 0) bg = over({ ...c, a: c.a * (Number(cs.opacity) || 1) }, bg);
    }
    return bg;
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  const out = [];
  const small = [];
  const seen = new Set();
  const test = (el, text, fgCss, label) => {
    if (!text || !visible(el) || el.closest(":disabled, [aria-disabled='true']")) return;
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    if (px < 12 - 0.01) small.push({ text: text.trim().slice(0, 40), px, el: el.tagName.toLowerCase() + "." + String(el.className).slice(0, 50) });
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    const bg = bgOf(el);
    let fg = parse(fgCss);
    fg = over({ ...fg, a: fg.a * opacityOf(el) }, bg);
    const r = ratio(fg, bg);
    if (r + 0.005 < need) {
      const key = `${text.slice(0, 40)}|${el.className}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ text: text.trim().slice(0, 50), ratio: Math.round(r * 100) / 100, need, fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, el: (label || el.tagName.toLowerCase()) + "." + String(el.className).slice(0, 60) });
    }
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "OPTION"].includes(el.tagName)) continue;
    test(el, t, getComputedStyle(el).color);
  }
  for (const el of document.querySelectorAll("input, textarea")) {
    if (["checkbox", "radio", "range", "color", "file", "hidden"].includes(el.type)) continue;
    if (el.value) test(el, el.value, getComputedStyle(el).color, "input-value");
    else if (el.placeholder) test(el, el.placeholder, getComputedStyle(el, "::placeholder").color, "placeholder");
  }
  // Sideways overflow: the page itself must never scroll sideways; a side panel must not either.
  const overflow = [];
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth + 1) { const wide = [...document.body.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(e).position !== "fixed" && !e.closest("table, pre, [class*='overflow-x-auto'], [class*='overflow-auto']"); }).slice(0, 3).map((e) => e.tagName.toLowerCase() + "." + String(e.className).slice(0, 50) + " right=" + Math.round(e.getBoundingClientRect().right)); overflow.push(`page scrolls sideways (${de.scrollWidth} > ${innerWidth}) widest: ${wide.join(" | ")}`); }
  for (const aside of document.querySelectorAll("aside")) { if (aside.getBoundingClientRect().right > innerWidth + 1 || !visible(aside)) continue; const sc = [...aside.querySelectorAll("*")].find((e) => e.scrollWidth > e.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowX) && !e.closest("table, pre, code") && e.tagName !== "PRE"); if (aside.scrollWidth > aside.clientWidth + 1) overflow.push(`panel scrolls sideways (${aside.scrollWidth} > ${aside.clientWidth})`); else if (sc) overflow.push(`a block inside the panel scrolls sideways: ${sc.tagName}.${String(sc.className).slice(0, 40)}`); }
  // Overlap: visible text whose box overlaps other visible text or an icon (rects clipped by scroll/overflow containers).
  const overlaps = [];
  const clip = (el, r) => {
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") { const b = e.getBoundingClientRect(); x0 = Math.max(x0, b.left); y0 = Math.max(y0, b.top); x1 = Math.min(x1, b.right); y1 = Math.min(y1, b.bottom); }
    }
    return x1 - x0 > 1 && y1 - y0 > 1 ? { x0, y0, x1, y1 } : null;
  };
  const boxes = [];
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w2.nextNode(); n; n = w2.nextNode()) {
    const t = n.nodeValue.replace(/\s+/g, " ").trim();
    const el = n.parentElement;
    if (!t || !el || ["SCRIPT", "STYLE", "NOSCRIPT", "OPTION", "TITLE"].includes(el.tagName) || el.closest("svg, .sr-only") || !visible(el) || opacityOf(el) < 0.05) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) { const c = clip(el, r); if (c && c.x1 > 0 && c.y1 > 0 && c.x0 < innerWidth) boxes.push({ ...c, kind: "text", label: t.slice(0, 28), el }); }
  }
  for (const sv of document.querySelectorAll("svg")) {
    if (!visible(sv) || opacityOf(sv) < 0.05) continue;
    const c = clip(sv, sv.getBoundingClientRect()); if (c && c.x1 > 0 && c.y1 > 0 && c.x0 < innerWidth) boxes.push({ ...c, kind: "icon", label: "icon", el: sv });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.kind === "icon" && b.kind === "icon") continue;
    if (a.el === b.el) continue;
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w > 2 && h > 2 && w * h > 12) {
      // A fixed floating panel (the Live agent feed and its pill) sits on top of the page by design; it is checked on its own.
      const fx = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) if (getComputedStyle(x).position === "fixed") return x; return null; };
      if (fx(a.el) !== fx(b.el)) continue;
      overlaps.push(`"${a.label}" (${a.kind}) overlaps "${b.label}" (${b.kind}) by ${Math.round(w)}x${Math.round(h)}px`);
    }
  }
  return { out, small, overflow, overlaps: overlaps.slice(0, 5) };
};

let scheme = "";
const report = (name, r) => {
  total++;
  results.push({ scheme, name, ...r });
  const bad = r.out.length + r.small.length + r.overflow.length + r.overlaps.length;
  console.log(`${scheme.padEnd(18)} ${name.padEnd(30)} ${bad === 0 ? "ok: 0 under 4.5:1, 0 under 12px, no overflow, no overlap" : `contrast ${r.out.length}, under 12px ${r.small.length}, overflow ${r.overflow.length}, overlap ${r.overlaps.length}`}`);
  for (const f of r.out) console.log(`        ${f.ratio}:1 (need ${f.need}) "${f.text}" ${f.fg} on ${f.bg}  [${f.el}]`);
  for (const f of r.small) console.log(`        ${f.px}px "${f.text}" [${f.el}]`);
  for (const f of r.overflow) console.log(`        ${f}`);
  for (const f of r.overlaps) console.log(`        overlap: ${f}`);
};
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = [];
const WIDTHS = [1440, 800, 640];
// Theme settings: Auto on a dark Mac, Auto on a light Mac, forced Light on a dark Mac, forced Dark on a light Mac.
const THEMES = [{ os: "dark", pick: "auto" }, { os: "light", pick: "auto" }, { os: "dark", pick: "light" }, { os: "light", pick: "dark" }];
let total = 0;
for (const [th, width] of WIDTHS.flatMap((w) => THEMES.map((t) => [t, w]))) {
  const sch = th.pick === "auto" ? th.os : `${th.pick}(on-${th.os})`;
  scheme = sch + "@" + width;
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: th.os });
  await ctx.addInitScript(([k, pick]) => { try { localStorage.setItem("agent_hq_api_key", k); if (!window.__feedOpen) localStorage.setItem("agent_hq_live_feed_hidden", "1"); if (pick !== "auto") localStorage.setItem("alcance_theme", pick); } catch { /* */ } }, [KEY, th.pick]);
  const page = await ctx.newPage();
  const dismiss = async () => { for (const re of [/finish later/i, /skip for now/i]) { const b = page.getByRole("button", { name: re }).first(); if (await b.count()) await b.click().catch(() => {}); } };
  const settle = async () => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(700); await dismiss(); await page.waitForTimeout(200); };
  const run = async (name) => {
    report(name, await page.evaluate(CHECK));
  };
  const shot = async (name) => { if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `${name}-${sch.replace(/[()]/g, "-")}-${width}.png`) }); } };
  const go = async (route) => { await page.goto(base + route); await settle(); };
  const clickText = async (sel, re) => { const loc = page.locator(sel).filter({ hasText: re }).first(); if (await loc.count()) { await loc.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); return true; } return false; };
  const closePanel = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(250); };

  for (const [route, name] of [["/", "Office"], ["/tasks", "Tasks"], ["/activity", "Activity"], ["/agents", "Agents"], ["/voice", "Voice"], ["/forms", "Forms"], ["/pages", "Pages"], ["/outreach", "Outreach"], ["/prospects", "Prospects"], ["/inbox", "Inbox"], ["/analytics", "Analytics"], ["/webhooks", "Webhooks"], ["/integrations", "Integrations"], ["/settings", "Settings"]]) {
    await go(route);
    await run(name);
    if (["Outreach", "Inbox", "Prospects", "Office", "Webhooks", "Agents", "Integrations"].includes(name)) await shot(name.toLowerCase());
  }

  // campaign page + its pop-ups
  await go("/outreach");
  const href = await page.locator("a[href^='/outreach/']").first().getAttribute("href").catch(() => null);
  if (href) {
    await go(href);
    await run("Campaign page");
    await shot("campaign");
    const row = page.locator("tbody tr").first();
    if (await row.count()) { await row.click().catch(() => {}); await page.waitForTimeout(500); await run("Campaign lead pop-up"); await closePanel(); }
  }

  // panels
  await go("/prospects");
  const prow = page.locator("tbody tr").first();
  if (await prow.count()) { await prow.click().catch(() => {}); await page.waitForTimeout(700); await run("Prospects side panel"); await shot("prospects-panel"); await closePanel(); }
  await go("/inbox");
  const reply = page.locator("button.w-full.text-left").first();
  if (await reply.count()) { await reply.click().catch(() => {}); await page.waitForTimeout(500); await run("Inbox reply open"); await shot("inbox-open"); }
  for (const [route, re, name] of [["/outreach", /new campaign/i, "New campaign pop-up"], ["/agents", /register|new agent|add agent/i, "Register agent pop-up"], ["/tasks", /new task|add task/i, "New task pop-up"], ["/forms", /new form/i, "New form pop-up"], ["/pages", /new page/i, "New page pop-up"], ["/webhooks", /new webhook/i, "New webhook pop-up"]]) {
    await go(route);
    if (await clickText("button, a", re)) { await run(name); await closePanel(); }
  }

  // sign-in screen (no key)
  const ctx2 = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: th.os });
  if (th.pick !== "auto") await ctx2.addInitScript((pick) => { try { localStorage.setItem("alcance_theme", pick); } catch { /* */ } }, th.pick);
  const p2 = await ctx2.newPage();
  await p2.goto(base + "/outreach");
  await p2.waitForTimeout(1500);
  if (await p2.getByText(/paste your .* api key/i).count()) {
    report("Sign-in screen", await p2.evaluate(CHECK));
    if (shotsDir) await p2.screenshot({ path: path.join(shotsDir, `signin-${sch.replace(/[()]/g, "-")}-${width}.png`) });
  } else console.log(`${scheme} Sign-in screen: gate not shown (skipped)`);
  await ctx2.close();
  await ctx.close();
}
await browser.close();
const bad = results.reduce((n, r) => n + r.out.length + r.small.length + r.overflow.length + r.overlaps.length, 0);
console.log(`\n${total} page/panel views checked (${THEMES.length} theme settings, ${WIDTHS.join(", ")} px wide); ${bad} problems (text under 4.5:1, under 12px, sideways overflow, overlapping text/icons).`);
if (bad) process.exitCode = 1;
