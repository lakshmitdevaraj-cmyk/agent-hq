// 30 measured calls per path, variant and size; CPU from `wrangler tail`; every call must have done its work.
//   node scripts/measure.mjs first    floor, campaign page, webhook, tracking link, send, Prospects C
//   node scripts/measure.mjs heavy    Prospects A and B
//   node scripts/measure.mjs second   every case that passed (or was marginal), measured again after the heavy runs
//   add a case name to run only that one, e.g. node scripts/measure.mjs first "send"
import { readFileSync, existsSync } from "node:fs";
import { call, startTail, sleep, save } from "./lib.mjs";
import { db } from "../../scripts/env.mjs";
import { reset } from "../db/data.mjs";

const N = 30;
const sql = db();
const URL_OK = "https://cal.example.test/fake";
const cmd = (action, params = {}) => ({ body: { action, params } });
const data = (r) => { try { return JSON.parse(r.text).data; } catch { return null; } };
const count = async (q) => (await q)[0].n;

// A case: prepare(size) returns { req(i), ok(response), after() }. after() checks what changed in the database.
const read = (req, ok) => async () => ({ req: () => req, ok });
const sentEmails = (ds) => sql`select id, lead_id, message_id, thread_id from spike.s75_emails where ds = ${ds} and message_id is not null and status = 'delivered' order by key limit ${N + 1}`;

const hook = (variant) => async (size) => {
  const ds = `d${size}`;
  const emails = await sentEmails(ds);
  return {
    req: (i) => ({ path: "/api/webhook/hook1", variant, body: { event_type: "message.delivered", delivery: { message_id: emails[i].message_id, thread_id: emails[i].thread_id } } }),
    ok: (r) => r.status === 200 && /"ok":true/.test(r.text),
    after: async () => ({
      expected: N + 1,
      events_written: await count(sql`select count(*)::int as n from spike.s75_webhook_events where ds = ${ds} and data->'body'->>'event_type' = 'message.delivered'`),
      emails_updated: await count(sql`select count(*)::int as n from spike.s75_emails where ds = ${ds} and data ? 'delivered_at'`),
    }),
  };
};
const link = (variant) => async (size) => {
  const ds = `d${size}`;
  const emails = await sentEmails(ds);
  return {
    req: (i) => ({ path: `/t/${Buffer.from(JSON.stringify({ c: "cbig", l: emails[i].lead_id, e: emails[i].id, u: URL_OK })).toString("base64url")}`, method: "GET", variant }),
    ok: (r) => r.status === 302 && r.location === URL_OK,
    after: async () => ({
      expected: N + 1,
      clicks_written: await count(sql`select count(*)::int as n from spike.s75_clicks where ds = ${ds} and data->>'user_agent' = 'spike'`),
      emails_clicked: await count(sql`select count(*)::int as n from spike.s75_emails where ds = ${ds} and data ? 'last_clicked_at'`),
    }),
  };
};
const prospects = (variant, params, ok) => read({ variant, ...cmd("outreach.prospects.list", params) }, ok);

const CASES = {
  floor: { sizes: [500, 1500], make: read(cmd("spike.floor"), (r) => data(r)?.campaigns >= 3) },
  "campaign page": { sizes: [500, 1500], make: (size) => read(cmd("outreach.campaign.get", { id: "cbig" }), (r) => data(r)?.emails_generated === size * 4)() },
  "webhook (plain)": { sizes: [500, 1500], write: true, make: hook("a") },
  "webhook (combined)": { sizes: [500, 1500], write: true, make: hook("b") },
  "tracking link (plain)": { sizes: [500, 1500], write: true, make: link("a") },
  "tracking link (combined)": { sizes: [500, 1500], write: true, make: link("b") },
  send: {
    sizes: [500, 1500], write: true,
    make: async (size) => ({
      req: () => cmd("outreach.emails.send", { campaign_id: "cbig", limit: 1 }),
      ok: (r) => data(r)?.sent === 1 && r.stats?.outbound?.["api.agentmail.to"] >= 2,
      after: async () => ({ expected: N + 1, emails_sent: await count(sql`select count(*)::int as n from spike.s75_emails where ds = ${`d${size}`} and status = 'sent'`) }),
    }),
  },
  "Prospects C page 1": { sizes: [500, 1500], make: prospects("c", { page: 1 }, (r) => data(r)?.rows.length === 50) },
  "Prospects C page 3": { sizes: [500, 1500], make: prospects("c", { page: 3 }, (r) => data(r)?.rows.length === 50) },
  "Prospects C search name": { sizes: [500, 1500], make: prospects("c", { q: "air 12" }, (r) => data(r)?.rows.length >= 11 && data(r).rows.every((x) => x.name.toLowerCase().includes("air 12"))) },
  "Prospects C search 2 letters": { sizes: [500, 1500], make: prospects("c", { q: "12" }, (r) => data(r)?.rows.length > 0) },
  "Prospects A": { sizes: [500, 1500], heavy: true, make: (size) => prospects("a", {}, (r) => data(r)?.length === size + 13)() },
  "Prospects B": { sizes: [500, 1500], heavy: true, make: (size) => prospects("b", {}, (r) => data(r)?.length === size + 13)() },
};

export const verdict = (c) => (c.cut === 0 && c.n >= 28 && c.work_ok && c.median <= 5 && c.p95 <= 8 ? "pass" : c.median != null && c.median <= 7 && c.work_ok ? "marginal" : "fail");
const cutOff = (c) => c.status === 503 || /exceeded/i.test(c.outcome ?? "");

const load = (f) => (existsSync(new URL(`../results/${f}`, import.meta.url)) ? JSON.parse(readFileSync(new URL(`../results/${f}`, import.meta.url), "utf8")) : {});
const [round, only] = process.argv.slice(2);
const file = `${round}.json`;
const out = load(file);
let todo = [];
if (round === "second") {
  todo = Object.values({ ...load("first.json"), ...load("heavy.json") }).filter((c) => c.verdict !== "fail").map((c) => [c.name, c.size]);
} else {
  for (const [name, c] of Object.entries(CASES)) if (!!c.heavy === (round === "heavy")) for (const size of c.sizes) todo.push([name, size]);
}
if (only) todo = todo.filter(([name]) => name === only);
console.log(`${round}: ${todo.length} cases`);

const tail = await startTail();
for (const [name, size] of todo) {
  const spec = CASES[name];
  if (spec.write) await reset(sql, size);
  const job = await spec.make(size);
  const calls = [];
  for (let i = 0; i <= N; i++) {
    const r = await call({ ...job.req(i), ds: `d${size}` });
    calls.push({ rid: r.rid, status: r.status, ok: !!job.ok(r), wall_ms: r.ms, bytes: r.bytes });
    await sleep(400);
  }
  const t = await tail.wait(calls.map((c) => c.rid), 25_000);
  calls.forEach((c, i) => Object.assign(c, { cpu_ms: t[i]?.cpu ?? null, outcome: t[i]?.outcome ?? "not in tail" }));
  const database = job.after ? await job.after() : null;
  const measured = calls.slice(1); // the first call is a warm-up
  const done = measured.filter((c) => !cutOff(c) && c.cpu_ms != null);
  const cpus = done.map((c) => c.cpu_ms).sort((a, b) => a - b);
  const cut = measured.filter(cutOff).length;
  const workOk = done.length > 0 && measured.filter((c) => !cutOff(c)).every((c) => c.ok) &&
    (!database || cut > 0 || Object.entries(database).every(([k, v]) => k === "expected" || v >= database.expected));
  const row = {
    name, size, round, n: done.length, cut, median: cpus.length ? cpus[Math.floor((cpus.length - 1) / 2)] : null,
    p95: cpus.length ? cpus[Math.ceil(0.95 * cpus.length) - 1] : null, worst: cpus.at(-1) ?? null,
    work_ok: workOk, database, bytes: done[0]?.bytes ?? null, calls: calls.map(({ rid, ...c }) => c),
  };
  row.verdict = verdict(row);
  out[`${name}|d${size}`] = row;
  save(file, out);
  console.log(`${name.padEnd(30)} d${size}  median ${row.median}  p95 ${row.p95}  worst ${row.worst}  cut ${cut}  n ${row.n}  work ${workOk}  → ${row.verdict}${database ? "  " + JSON.stringify(database) : ""}`);
  if (spec.write) await reset(sql, size);
}
tail.stop();
await sql.end();
process.exit(0);
