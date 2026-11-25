// Spike copy of the website check. Parsing functions are imported read-only from production code.
// fetchPage / siteBase / the analyzeSite call order are COPIED from netlify/functions/command.ts (~l.1456-1610),
// without the Gemini owner fallback and the browser-merge branches (a fresh plain-download check).
import {
  SITE_CHECK_PATHS, detectSignals, detectFormPlugin, extractSocial, findOwner, gapScore, siteHoursWording, fitFlags,
  needsBrowserCheck, realTrade, businessDetails, siteHours, websiteFacts, type Page,
} from "../../netlify/functions/lib/sitecheck";
import { extractEmailsFromHtml, isGovEduEmail } from "../../netlify/functions/lib/outreach";
import { cityOf } from "../../netlify/functions/lib/angle";

export { SITE_CHECK_PATHS, type Page };
export const UA = "Mozilla/5.0 (compatible; ShiftForgeHQ/1.0)";

export async function fetchPage(url: string, ms = 6000): Promise<Page | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (type && !/html|xml|text/i.test(type)) return null;
    return { url: r.url || url, html: (await r.text()).slice(0, 700_000) };
  } catch {
    return null;
  }
}

export function dedupePages(got: Array<Page | null>): Page[] {
  const seen = new Set<string>();
  return got.filter((p): p is Page => !!p).filter((p) => { const k = p.url.replace(/\/$/, ""); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** One request at a time (politeness). Production fetches these in parallel; the parsing CPU is the same. */
export async function fetchSite(host: string, paths: string[] = SITE_CHECK_PATHS, pause = 0): Promise<Page[]> {
  const base = new URL(`https://${host}`);
  const got: Array<Page | null> = [];
  for (const path of paths) {
    got.push(await fetchPage(new URL(path, base).toString()));
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  if (paths[0] === "" && !got[0]) got[0] = await fetchPage(base.toString(), 12000);
  return dedupePages(got);
}

export function parsePages(host: string, pages: Page[]) {
  const lead = { name: host.replace(/\.com$/, ""), website: `https://${host}`, category: null as string | null, address: null as string | null };
  const { signals } = detectSignals(pages);
  const { social } = extractSocial(pages);
  const emails: string[] = [];
  for (const p of pages) for (const e of extractEmailsFromHtml(p.html)) if (!emails.includes(e) && !isGovEduEmail(e)) emails.push(e);
  const owner = findOwner(pages, lead.name);
  const wording = siteHoursWording(pages);
  const homeTitle = (pages[0]?.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const fit = fitFlags(pages, lead.website, { name: lead.name, category: null, city: cityOf(""), reviews_count: null, phone: null, tls_problem: false });
  const trade = realTrade(null, lead.name, homeTitle);
  const nb = needsBrowserCheck(pages, signals);
  const facts = websiteFacts(pages, { via: "raw", jsBuilt: needsBrowserCheck(pages, { chat_widget: null, booking_tool: null }).needs });
  const gap = gapScore(lead as Parameters<typeof gapScore>[0], signals, { hoursUsable: wording.hours_usable });
  const formPlugin = detectFormPlugin(pages);
  const details = businessDetails(pages);
  const hours = siteHours(pages);
  return { signals, social, emails, owner, wording, fit, trade, nb, facts, gap, formPlugin, details, hours };
}

export type Parsed = ReturnType<typeof parsePages>;

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };

/** What the check found, with no scraped text, addresses or names (only presence, counts and hashes). Safe to commit. */
export function fingerprint(r: Parsed) {
  return {
    chat: !!r.signals.chat_widget,
    booking: !!r.signals.booking_tool,
    contact_form: r.signals.has_contact_form,
    request_form: r.signals.request_form,
    whatsapp: !!r.signals.whatsapp_url,
    social: Object.entries(r.social).filter(([, v]) => v).map(([k]) => k).sort().join("+"),
    emails: r.emails.length,
    emails_hash: hash([...r.emails].sort().join(",")),
    owner: r.owner ? hash(r.owner.name) : null,
    form_plugin: !!r.formPlugin,
    facts: r.facts.map((f) => `${f.key}=${f.value}`).join(" "),
    gap_score: r.gap.score,
  };
}

// ── Optimisations tried when the full parse is too slow ──
export const VARIANTS: Record<string, (p: Page) => Page> = {
  full: (p) => p,
  /** <head> + first 60 KB + last 20 KB. */
  trim: (p) => {
    if (p.html.length <= 90_000) return p;
    const head = p.html.slice(0, Math.min(p.html.indexOf("</head>") + 7 || 0, 20_000));
    return { url: p.url, html: head + p.html.slice(head.length, head.length + 60_000) + p.html.slice(-20_000) };
  },
  /** Drop the bodies of inline <script> and <style>, keep the tags (and their src=). JSON-LD is kept. */
  strip: (p) => ({ url: p.url, html: p.html.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2").replace(/(<script\b(?![^>]*ld\+json)[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2") }),
};

// Pages travel as plain text (url line + html) so the Worker pays about the same CPU to receive them as to read a fetch.
const SEP = "\n\u0001PAGE\u0001\n";
export const packPages = (pages: Page[]) => pages.map((p) => `${p.url}\n${p.html}`).join(SEP);
export const unpackPages = (s: string): Page[] => (s ? s.split(SEP).map((x) => { const i = x.indexOf("\n"); return { url: x.slice(0, i), html: x.slice(i + 1) }; }) : []);
