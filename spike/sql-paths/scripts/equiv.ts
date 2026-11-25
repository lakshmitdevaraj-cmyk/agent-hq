// Same answer? Runs the real production handlers (on an in-memory copy of the fake data) and the new SQL router
// (on the s75_ tables) side by side and compares responses and changed records. Timestamps and random ids are masked.
import { writeFileSync } from "node:fs";
import { als, type Ctx } from "../../whole-app/src/context";
import { handler as command } from "../../../netlify/functions/command";
import { handler as webhookReceive } from "../../../netlify/functions/webhook-receive";
import { handler as trackClick } from "../../../netlify/functions/track-click";
import router from "../src/router";
import { stores, getStore } from "./memory-blobs";
// @ts-ignore plain .mjs helpers
import { db, directUrl } from "../../scripts/env.mjs";
// @ts-ignore
import { reset, SENDABLE } from "../db/data.mjs";
// @ts-ignore
import { apiKey } from "../../whole-app/db/seed-kv.mjs";

const quiet = console.log;
console.log = console.warn = console.error = () => {};
const sql = db();
const HOST = "spike.example.test";

async function loadMemory(size: number) {
  stores.clear();
  const rows = await sql`select substring(store from ${`pristine-d${size}/`.length + 1}::int) as store, key, case when jsonb_typeof(value) = 'string' then value #>> '{}' else value::text end as v from spike.kv where store like ${`pristine-d${size}/%`}`;
  for (const r of rows) await getStore(r.store).set(r.key, r.v);
  // Negative control: CONTROL=1 changes one value on the production side only, so the comparison must report it.
  if (process.env.CONTROL) {
    const leads = stores.get("agent-hq-outreach-leads")!;
    leads.set("cbig/l3", JSON.stringify({ ...JSON.parse(leads.get("cbig/l3")!), name: "CONTROL", gap_score: 99 }));
    const w = stores.get("agent-hq-webhooks")!;
    w.set("hook1", JSON.stringify({ ...JSON.parse(w.get("hook1")!), event_count: 999 }));
  }
  const emails = stores.get("agent-hq-outreach-emails")!;
  for (const [k, v] of emails) {
    const e = JSON.parse(v);
    if (e.status === "drafted" && e.review_status === "ready") emails.set(k, JSON.stringify({ ...e, ...SENDABLE }));
  }
}
const mem = (store: string, key: string) => JSON.parse(stores.get(store)?.get(key) ?? "null");
const memAll = (store: string) => [...(stores.get(store)?.entries() ?? [])].map(([key, v]) => ({ key, v: JSON.parse(v) }));

const headers = { host: HOST, "x-api-key": apiKey(), "x-forwarded-proto": "https", "x-forwarded-host": HOST, "user-agent": "equiv", "content-type": "application/json" };
async function prod(handler: any, path: string, method: string, body?: unknown) {
  const c = { outbound: {} } as Ctx;
  const r: any = await als.run(c, () => handler({ httpMethod: method, path, headers, queryStringParameters: {}, body: body ? JSON.stringify(body) : null, isBase64Encoded: false }, {}));
  return { status: r.statusCode, headers: r.headers ?? {}, body: r.body, outbound: c.outbound };
}
async function mine(size: number, path: string, method: string, body?: unknown, variant = "a") {
  const waits: Promise<unknown>[] = [];
  const res = await router.fetch(new Request(`https://${HOST}${path}`, { method, headers: { ...headers, "x-spike-token": "t", "x-spike-ds": `d${size}`, "x-spike-variant": variant }, body: body ? JSON.stringify(body) : undefined }),
    { HYPERDRIVE: { connectionString: directUrl() }, SPIKE_TOKEN: "t" }, { waitUntil: (p) => void waits.push(p) });
  const text = await res.text();
  await Promise.all(waits);
  return { status: res.status, location: res.headers.get("location"), body: text, outbound: JSON.parse(res.headers.get("x-spike-stats") ?? "{}").outbound };
}

const near = (s: string) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s) && Math.abs(Date.now() - Date.parse(s)) < 3_600_000;
function norm(v: any): any {
  if (typeof v === "string") return near(v) ? "<now>" : v.replace(/fake-(out|thread)-[0-9a-f-]{36}/g, "fake-$1-<id>");
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, norm(v[k])]));
  return v;
}
function diff(a: any, b: any, path = "$", out: string[] = []): string[] {
  if (out.length >= 6) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) && a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
  } else out.push(`${path}: production ${JSON.stringify(a)?.slice(0, 80)} | sql ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}

const results: Array<{ check: string; size: number; same: boolean; differences: string[]; note?: string }> = [];
function check(name: string, size: number, a: unknown, b: unknown, note?: string) {
  const d = diff(norm(a), norm(b));
  results.push({ check: name, size, same: d.length === 0, differences: d, ...(note ? { note } : {}) });
  quiet(`${d.length ? "DIFF" : "same"}  d${size}  ${name}${note ? `  (${note})` : ""}${d.length ? "\n      " + d.join("\n      ") : ""}`);
}
const cmd = (action: string, params: unknown) => ({ action, params });
const dbRow = async (table: string, ds: string, col: string, val: string) => (await sql`select data from ${sql(`spike.${table}`)} where ds = ${ds} and ${sql(col)} = ${val}`)[0]?.data ?? null;

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const size of sizes.length ? sizes : [25, 500]) {
  const ds = `d${size}`;
  await loadMemory(size);
  await reset(sql, size);

  for (const id of ["cbig", "cnew"]) {
    const p = await prod(command, "/api/command", "POST", cmd("outreach.campaign.get", { id }));
    const s = await mine(size, "/api/command", "POST", cmd("outreach.campaign.get", { id }));
    check(`campaign.get ${id}`, size, JSON.parse(p.body), JSON.parse(s.body));
  }

  const p = JSON.parse((await prod(command, "/api/command", "POST", cmd("outreach.prospects.list", {}))).body).data;
  for (const v of ["a", "b"]) {
    const s = JSON.parse((await mine(size, "/api/command", "POST", cmd("outreach.prospects.list", {}), v)).body).data;
    check(`prospects.list ${v.toUpperCase()}`, size, p, s, `${p.length} rows`);
  }
  const fields = (r: any) => `${r.name ?? ""} ${r.owner_name ?? ""}`;
  for (const [label, params, expected] of [
    ["page 1", { page: 1 }, p.slice(0, 50)],
    ["page 2", { page: 2 }, p.slice(50, 100)],
    ["search 'air 12'", { q: "air 12" }, p.filter((r: any) => fields(r).toLowerCase().includes("air 12")).slice(0, 50)],
  ] as const) {
    const s = JSON.parse((await mine(size, "/api/command", "POST", cmd("outreach.prospects.list", params), "c")).body).data;
    check(`prospects.list C ${label}`, size, expected, s.rows, `${s.rows.length} of ${s.total}`);
  }

  // Delivered and bounced webhooks, on the first sent email.
  const target = memAll("agent-hq-outreach-emails").find((e) => e.v.agentmail_message_id)!;
  for (const [type, carrier] of [["message.delivered", "delivery"], ["message.bounced", "bounce"]]) {
    for (const variant of ["a", "b"]) {
      await loadMemory(size);
      await reset(sql, size);
      const body = { event_type: type, [carrier]: { message_id: target.v.agentmail_message_id, thread_id: target.v.agentmail_thread_id } };
      const pr = await prod(webhookReceive, "/api/webhook/hook1", "POST", body);
      const sr = await mine(size, "/api/webhook/hook1", "POST", body, variant);
      const act = async () => (await sql`select data from spike.s75_activity where ds = ${ds} and data->>'summary' like 'Webhook%' order by key desc limit 1`)[0]?.data;
      const strip = (x: any) => x && { ...x, id: 0, details: { ...x.details, event_id: 0 } };
      check(`webhook ${type} (${variant})`, size,
        { status: pr.status, email: mem("agent-hq-outreach-emails", target.key), count: mem("agent-hq-webhooks", "hook1").event_count, activity: strip(memAll("agent-hq-activity").find((a) => String(a.v.summary).startsWith("Webhook"))?.v), bounced: stores.get("agent-hq-outreach-contacts")!.has(`bounced/${target.v.to_email}`) },
        { status: sr.status, email: await dbRow("s75_emails", ds, "id", target.v.id), count: (await dbRow("s75_webhooks", ds, "id", "hook1")).event_count, activity: strip(await act()), bounced: (await sql`select 1 from spike.s75_contacts where ds = ${ds} and kind = 'bounced' and email = ${target.v.to_email}`).length > 0 });
    }
  }

  // Tracking link.
  const token = Buffer.from(JSON.stringify({ c: "cbig", l: target.v.lead_id, e: target.v.id, u: "https://cal.example.test/fake" })).toString("base64url");
  for (const variant of ["a", "b"]) {
    await loadMemory(size);
    await reset(sql, size);
    const pr = await prod(trackClick, `/t/${token}`, "GET");
    const sr = await mine(size, `/t/${token}`, "GET", undefined, variant);
    const click = (x: any) => x && { ...x, id: 0, ip: x.ip ?? null };
    const actP = memAll("agent-hq-activity").find((a) => String(a.v.summary).startsWith("Link clicked"))?.v;
    const [actS] = await sql`select data from spike.s75_activity where ds = ${ds} and data->>'summary' like 'Link clicked%'`;
    const [clickS] = await sql`select data from spike.s75_clicks where ds = ${ds} and data->>'url' = 'https://cal.example.test/fake' order by data->>'clicked_at' desc limit 1`;
    const newest = memAll("agent-hq-outreach-clicks").sort((a, b) => String(b.v.clicked_at).localeCompare(String(a.v.clicked_at)))[0].v;
    check(`tracking link (${variant})`, size,
      { status: pr.status, location: pr.headers.Location, email: mem("agent-hq-outreach-emails", target.key), campaign: mem("agent-hq-outreach-campaigns", "cbig"), activity: { ...actP, id: 0 }, click: click(newest) },
      { status: sr.status, location: sr.location, email: await dbRow("s75_emails", ds, "id", target.v.id), campaign: await dbRow("s75_campaigns", ds, "id", "cbig"), activity: { ...actS?.data, id: 0 }, click: click(clickS?.data) });
  }

  // Send. Production writes "sent"; the new code writes "sending" first and ends in the same place.
  for (const limit of [1, 3]) {
    await loadMemory(size);
    await reset(sql, size);
    const params = { campaign_id: "cbig", limit };
    const pr = await prod(command, "/api/command", "POST", cmd("outreach.emails.send", params));
    const sr = await mine(size, "/api/command", "POST", cmd("outreach.emails.send", params));
    const pb = JSON.parse(pr.body), sb = JSON.parse(sr.body);
    check(`send limit ${limit}: response`, size, pb, sb, `sent ${sb.data?.sent}`);
    const sentP = memAll("agent-hq-outreach-emails").filter((e) => e.v.status === "sent").map((e) => e.v).sort((a, b) => a.id.localeCompare(b.id));
    const sentS = (await sql`select data from spike.s75_emails where ds = ${ds} and status = 'sent' order by id collate "C"`).map((r: any) => r.data);
    sentP.sort((a, b) => (a.id < b.id ? -1 : 1));
    check(`send limit ${limit}: sent records`, size, sentP, sentS);
    check(`send limit ${limit}: outside calls`, size, pr.outbound, sr.outbound);
    const camp = (c: any) => ({ status: c.status, last_send_at: c.last_send_at, inbox: c.agentmail_inbox_id });
    const contacted = memAll("agent-hq-outreach-leads").filter((l) => l.v.contacted_at).map((l) => l.v.id).sort();
    const contactedS = (await sql`select id from spike.s75_leads where ds = ${ds} and data ? 'contacted_at'`).map((r: any) => r.id).sort();
    check(`send limit ${limit}: campaign and leads`, size,
      { campaign: camp(mem("agent-hq-outreach-campaigns", "cbig")), contacted, contacts: [...stores.get("agent-hq-outreach-contacts")!.keys()].filter((k) => k.startsWith("sent/")).length },
      { campaign: camp(await dbRow("s75_campaigns", ds, "id", "cbig")), contacted: contactedS, contacts: (await sql`select count(*)::int as n from spike.s75_contacts where ds = ${ds} and kind = 'sent'`)[0].n });
  }
  await reset(sql, size);
}
writeFileSync(process.env.CONTROL ? "results/equivalence-control.json" : "results/equivalence.json", JSON.stringify({ at: new Date().toISOString(), checks: results.length, same: results.filter((r) => r.same).length, results }, null, 1));
quiet(`${results.filter((r) => r.same).length} of ${results.length} the same`);
await sql.end();
process.exit(0);
