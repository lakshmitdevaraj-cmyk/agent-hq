// outreach.emails.send, measured again. In the first runs every fake draft was stopped by the app's own send checks,
// so nothing was sent. Here the "ready" drafts are given wording that passes, and each call must really send.
import { call, startTail, sleep, save } from "./lib.mjs";
import { ACTIONS } from "./actions.mjs";
import { db } from "../../scripts/env.mjs";
import { reset } from "../db/seed-kv.mjs";

const SUBJECT = "missed calls";
const BODY = "Hi there,\n\nPeople who call a heating company after hours often have to ring back the next day.\n\nI put together a short note on how other HVAC teams catch those calls.\n\nWould it help if I sent it over?\n\nLakshmi";

const sql = db();
const tail = await startTail();
const out = {};
const prepare = async (size) => {
  await reset(sql, size);
  await sql`update spike.kv set value = value || ${sql.json({ subject: SUBJECT, body_text: BODY })}
    where store = ${`d${size}/agent-hq-outreach-emails`} and value->>'status' = 'drafted' and value->>'review_status' = 'ready'`;
};
for (const size of [25, 100, 500]) {
  for (const limit of [1, 10]) {
    const calls = [];
    for (let i = 0; i < 4; i++) {
      await prepare(size);
      await sleep(6000);
      const r = await call({ ns: `d${size}`, body: { action: "outreach.emails.send", params: { ...ACTIONS["outreach.emails.send"].params, limit } } });
      let sent = null;
      try { sent = JSON.parse(r.text).data.sent; } catch { /* cut-off calls have no body */ }
      calls.push({ rid: r.rid, status: r.status, sent, stats: r.stats });
    }
    const t = await tail.wait(calls.map((c) => c.rid));
    const rows = calls.map((c, i) => ({ status: c.status, sent: c.sent, queries: c.stats?.queries ?? null, outbound: c.stats?.outbound ?? null, cpu_ms: t[i]?.cpu ?? null, outcome: t[i]?.outcome ?? "not in tail" }));
    const done = rows.filter((c) => c.status === 200 && c.sent > 0);
    const cpus = done.map((c) => c.cpu_ms).filter((v) => v != null).sort((a, b) => a - b);
    out[`limit ${limit}|d${size}`] = { size, limit, sent_ok: done.length, cut: rows.filter((c) => /exceeded/.test(c.outcome)).length, cpu_median: cpus[Math.floor((cpus.length - 1) / 2)] ?? null, cpu_worst: cpus.at(-1) ?? null, calls: rows };
    save("h-send.json", out);
    const o = out[`limit ${limit}|d${size}`];
    console.log(size, limit, `ok ${o.sent_ok} cut ${o.cut} cpu ${o.cpu_median}/${o.cpu_worst}`, JSON.stringify(rows.find((c) => c.status === 200) ?? rows[0]));
  }
  await reset(sql, size);
}
tail.stop();
await sql.end();
process.exit(0);
