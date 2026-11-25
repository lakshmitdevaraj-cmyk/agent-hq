// Planned fallback: CPU used by each over-limit request when nothing cuts it off, on the Mac (Node), same handlers,
// same data, same stubs. These numbers are LOCAL: they show how big the work is and how it grows, not Cloudflare time.
import { writeFileSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { als, type Ctx } from "../src/context";
import { installStubs } from "../src/stubs";
import { handler as command } from "../../../netlify/functions/command";
import { handler as webhookReceive } from "../../../netlify/functions/webhook-receive";
import { handler as trackClick } from "../../../netlify/functions/track-click";
import { handler as aiBackground } from "../../../netlify/functions/ai-background";
// @ts-ignore plain .mjs helpers
import { db } from "../../scripts/env.mjs";
// @ts-ignore
import { reset, apiKey } from "../db/seed-kv.mjs";
// @ts-ignore
import { ACTIONS, HANDLERS, BACKGROUND } from "./actions.mjs";

installStubs();
console.log = console.error = console.warn = () => {};
const out = (s: string) => process.stdout.write(s + "\n");
const sql: ReturnType<typeof postgres> = db();

const NAMES = [
  "outreach.campaign.get", "outreach.campaign.list", "outreach.leads.list", "outreach.emails.list", "outreach.prospects.list", "followups.list", "outreach.analytics.summary", "outreach.send.today",
  "data.counts", "data.export", "data.import", "outreach.social.plan", "outreach.browsercheck.plan", "outreach.emails.update", "outreach.emails.create", "outreach.lead.set_email", "outreach.leads.delete",
  "outreach.campaign.delete", "outreach.campaign.sync", "outreach.emails.send", "outreach.replies.sync", "outreach.reply.draft", "outreach.leads.check_site", "outreach.emails.generate_one",
  "track-click GET /t/:token", "webhook-receive message.delivered", "webhook-receive message.received", "ai-background draft (10 leads)", "ai-background review (3 drafts)", "ai-background social (3 leads)",
];
const all: Record<string, any> = { ...ACTIONS, ...HANDLERS, ...BACKGROUND };

async function run(ns: string, req: any) {
  const path: string = req.path ?? "/api/command";
  const handler: any = path.includes("webhook") ? webhookReceive : path.startsWith("/t/") ? trackClick : path.includes("ai-background") ? aiBackground : command;
  const c: Ctx = { sql: () => sql as any, ns, mode: "batched", cache: new Map(), listed: new Map(), queries: 0, rows: 0, outbound: {} };
  const event = { httpMethod: req.method ?? "POST", path, headers: { "x-api-key": apiKey(), host: "local.example.test", "x-forwarded-proto": "https", "x-forwarded-host": "local.example.test" }, queryStringParameters: {}, body: req.body ? JSON.stringify(req.body) : "{}", isBase64Encoded: false };
  // The app paces itself with timers; they are not CPU, so they are shortened here.
  const t = process.cpuUsage();
  const r: any = await als.run(c, () => handler(event, {}));
  const u = process.cpuUsage(t);
  return { cpu_ms: Math.round((u.user + u.system) / 100) / 10, status: r.statusCode, queries: c.queries };
}

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, ms === 4500 || ms === 1500 ? 1 : ms, ...a)) as any;

// Names given on the command line are measured on their own and added to the earlier results.
const only = process.argv.slice(2);
const results: any[] = only.length ? JSON.parse(readFileSync("results/h-local-cpu.json", "utf8")).results.filter((r: any) => !only.some((o) => r.name.startsWith(o))) : [];
let variants: Array<[string, any, string]> = NAMES.map((n) => [n, all[n], n]);
for (const [label, p] of all["outreach.leads.check_site"].variants) variants.push([`outreach.leads.check_site (${label})`, { ...all["outreach.leads.check_site"], params: p }, "outreach.leads.check_site"]);
variants = variants.filter(([label]) => !only.length || only.some((o) => label.startsWith(o)));
for (const [label, rec, action] of variants) {
  // campaign.delete deletes one record per query: thousands of round trips from India, so only the small sizes.
  const sizes = action.includes("check_site") ? [25] : action === "outreach.campaign.delete" ? [25, 100] : [25, 100, 500, 1500];
  for (const size of sizes) {
    const ns = `d${size}`;
    const cpus: number[] = [];
    let last: any;
    try {
      for (let i = 0; i < 3; i++) {
        if (rec.reset && (i === 0 || rec.resetEach)) await reset(sql, size);
        for (const s of rec.setup ?? []) await run(ns, s);
        const req = rec.req ? rec.req(i) : { body: { action, params: typeof rec.params === "function" ? rec.params(i) : rec.params } };
        last = await run(ns, req);
        cpus.push(last.cpu_ms);
        if (last.cpu_ms > 5000) break;
      }
      if (rec.reset || rec.kind === "write") await reset(sql, size);
      cpus.sort((a, b) => a - b);
      results.push({ name: label, size, mac_cpu_ms_median: cpus[Math.floor((cpus.length - 1) / 2)], mac_cpu_ms_worst: cpus.at(-1), status: last.status, queries: last.queries });
    } catch (e) {
      results.push({ name: label, size, error: String((e as Error).message).slice(0, 120) });
    }
    out(JSON.stringify(results.at(-1)));
    writeFileSync("results/h-local-cpu.json", JSON.stringify({ machine: "Mac, Node " + process.version, note: "process CPU time, 3 calls, handlers only", results }, null, 1));
  }
}
await sql.end();
process.exit(0);
