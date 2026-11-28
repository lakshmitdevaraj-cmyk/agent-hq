// Timings for send_today() and plan_send() (migration 0013) on Neon dev: on the real dev data, then on made-up data
// seeded inside one transaction that is rolled back. Prints no ids, names or addresses. Nothing is kept.
//   (a) database time: EXPLAIN (ANALYZE, BUFFERS), planning + execution, median of 5
//   (b) wall time from this Mac, median of 5
// Run: node scripts/db/bench-send.mjs
import "./equiv/ts-ext.mjs";
import postgres from "postgres";
import { localVar } from "./env.mjs";
const { clientOptions, closeDb } = await import("../../netlify/functions/lib/db/client.ts");

const url = localVar("DEV_DATABASE_URL");
process.env.DATABASE_URL = url;
const ROLLBACK = Symbol("rollback");
const captured = [];
const sql = postgres(url, { ...clientOptions(), max: 1, debug: (_c, query, parameters) => { captured.push({ query, parameters }); } });

const own = "array['me@madeup-own.test']";
const nextTuesday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((2 - d.getUTCDay() + 7) % 7 || 7)); return d.toISOString().slice(0, 10); })();
const calls = {
  send_today: `select send_today(${own}) as r`,
  plan_send: `select plan_send('${nextTuesday}'::date, ${own}) as r`,
};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const counts = async (q) => (await q.unsafe("select (select count(*)::int from leads) as leads, (select count(*)::int from emails) as emails"))[0];

async function time(q) {
  const out = {};
  for (const [name, text] of Object.entries(calls)) {
    await q.unsafe(text); // warm-up
    const wall = [], db = [];
    let items = null;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const [row] = await q.unsafe(text);
      wall.push(performance.now() - t0);
      if (name === "plan_send") items = row.r.items.length;
    }
    for (let i = 0; i < 5; i++) {
      const plan = (await q.unsafe(`explain (analyze, buffers) ${text}`)).map((r) => r["QUERY PLAN"]);
      const num = (l) => Number((plan.find((x) => x.startsWith(l))?.match(/([\d.]+) ms/) ?? [])[1] ?? 0);
      db.push(num("Planning Time") + num("Execution Time"));
    }
    out[name] = { db: med(db), wall: med(wall), items };
  }
  return out;
}

const rows = [];
let before, after, seeded, seededCounts;
try {
  before = await counts(sql);
  rows.push(["dev data", before, await time(sql)]);

  try {
    await sql.begin(async (tx) => {
      const addLeads = 1500; // each gets 4 emails (steps 1-4): 6,000 new emails
      await tx.unsafe(`insert into campaigns (id, name, country, created_at, updated_at)
        select 'bench-c' || g, 'Bench campaign ' || g, 'US', now(), now() from generate_series(1, 10) g`);
      await tx.unsafe(`insert into leads (id, campaign_id, name, email, email_key, stop_state, created_at, updated_at)
        select 'bench-l' || n, 'bench-c' || (n % 10 + 1), 'Bench lead ' || n,
               'lead-' || n || '@madeup-bench.test', 'lead-' || n || '@madeup-bench.test',
               case when n % 20 = 0 then 'bounced' when n % 20 = 1 then 'replied' when n % 20 = 2 then 'do_not_contact' else 'none' end,
               now() - interval '40 days', now()
        from generate_series(1, ${addLeads}) n`);
      await tx.unsafe(`insert into emails (id, campaign_id, lead_id, to_email, to_key, step, sequence_total, framework, status, review_status,
                                            sent_at, delivered_at, bounced_at, created_at, updated_at)
        select id, campaign_id, lead_id, to_email, to_key, step, 4, 'four-step', status,
               case when status = 'drafted' then case when rv then 'ready' else 'check' end end,
               case when status in ('sent', 'delivered', 'bounced') then sat end,
               case when status = 'delivered' then sat + interval '1 minute' end,
               case when status = 'bounced' then sat + interval '2 minutes' end,
               now() - interval '40 days', now()
        from (
          select 'bench-e' || n || '-' || s as id, 'bench-c' || (n % 10 + 1) as campaign_id, 'bench-l' || n as lead_id,
                 'lead-' || n || '@madeup-bench.test' as to_email, 'lead-' || n || '@madeup-bench.test' as to_key, s as step,
                 now() - make_interval(days => greatest(0, n % 30 - 3 * (s - 1)), mins => n % 600) as sat,
                 case n % 5
                   when 0 then 'drafted'
                   when 1 then case s when 1 then 'sent' else 'drafted' end
                   when 2 then case s when 1 then 'delivered' when 2 then 'sent' else 'drafted' end
                   when 3 then case s when 1 then 'bounced' else 'drafted' end
                   else case s when 1 then 'sent' when 2 then 'delivered' when 3 then 'sent' else 'drafted' end end as status,
                 not (n % 5 = 3 or (n % 5 = 2 and s = 4) or n % 11 = 0) as rv
          from generate_series(1, ${addLeads}) n, generate_series(1, 4) s
        ) x`);
      await tx.unsafe("analyze campaigns"); await tx.unsafe("analyze leads"); await tx.unsafe("analyze emails");
      seededCounts = await counts(tx);
      seeded = await time(tx);
      throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  rows.push(["seeded", seededCounts, seeded]);
  after = await counts(sql);

  const f = (n) => n.toFixed(1).padStart(8);
  console.log(`plan_send day: ${nextTuesday} (next Tuesday)`);
  console.log("data      leads  emails | fn          db ms (plan+exec)  wall ms  items");
  for (const [label, c, r] of rows)
    for (const fn of Object.keys(calls))
      console.log(`${label.padEnd(9)} ${String(c.leads).padStart(5)} ${String(c.emails).padStart(7)} | ${fn.padEnd(11)} ${f(r[fn].db)}          ${f(r[fn].wall)}  ${r[fn].items ?? "-"}`);
  console.log(`counts before: ${before.leads} leads, ${before.emails} emails; after rollback: ${after.leads} leads, ${after.emails} emails; rolled back: ${before.leads === after.leads && before.emails === after.emails}`);
} finally {
  await sql.end({ timeout: 5 });
  await closeDb();
}
