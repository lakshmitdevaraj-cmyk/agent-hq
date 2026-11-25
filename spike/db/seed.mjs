// Creates the spike schema and fills it with FAKE data (25 campaigns, 1,500 leads, 6,000 emails, 500 social, 200 replies).
import { readFileSync } from "node:fs";
import { db } from "../scripts/env.mjs";

const sql = db();
const existing = await sql`select table_schema || '.' || table_name as t from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1`;
console.log("tables before:", existing.length ? existing.map((r) => r.t).join(", ") : "(none)");
await sql.unsafe(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

const [{ n }] = await sql`select count(*)::int as n from spike.campaigns`;
if (n === 0) {
  await sql.unsafe(`
  set search_path to spike;
  insert into campaigns select 'c'||g, 'Fake campaign '||g, 'hvac in Faketown '||g, 'active', now() - (g||' days')::interval,
    jsonb_build_object('sender_offer', repeat('offer text ', 30), 'any_trade', true) from generate_series(1,25) g;

  insert into leads select 'l'||g, 'c'||(1 + (g-1) % 25), 'Fake Heating & Air '||g,
    case when g % 4 = 0 then null else 'owner'||g||'@fake'||g||'.example.test' end,
    '(555) 010-'||lpad((g % 10000)::text,4,'0'), 'https://fake'||g||'.example.test', g||' Fake St, Faketown, TX 75000', 'HVAC contractor',
    3.5 + (g % 15)/10.0, g % 400,
    case when g % 2 = 0 then 'https://facebook.com/fake'||g end,
    case when g % 5 = 0 then 'https://instagram.com/fake'||g end,
    case when g % 7 = 0 then 'https://linkedin.com/company/fake'||g end,
    g % 41 = 0, g % 29 = 0, now() - ((g % 60)||' days')::interval,
    jsonb_build_object('site_check', jsonb_build_object('details', repeat('detail ', 120), 'has_contact_form', g % 3 = 0), 'gap_score', g % 100)
  from generate_series(1,1500) g;

  -- 4 emails per lead. How many were sent depends on the lead; first send 0-40 days ago, then 3-day steps.
  insert into emails
  select 'e'||l||'-'||p, 'c'||(1 + (l-1) % 25), 'l'||l, p, 'Fake subject '||l||'/'||p, repeat('This is fake body text. ', 25),
    case when p > l % 4 then 'drafted' when l % 53 = 0 and p = 1 then 'bounced' else (array['sent','delivered'])[1 + l % 2] end,
    case when p > l % 4 then current_date - (l % 40) + p * 3 end,
    case when p <= l % 4 then now() - (((l % 40) + 12 - (p-1)*3)||' days')::interval end,
    now() - '50 days'::interval, jsonb_build_object('framework','four-step','review_status',(array['ready','check','blocked'])[1 + l % 3],'click_count', l % 3)
  from generate_series(1,1500) l, generate_series(1,4) p;

  insert into social_messages select 's'||g, 'c'||(1 + (g*3-1) % 25), 'l'||(g*3), (array['facebook','instagram','linkedin'])[1 + g % 3],
    case when g % 3 = 0 then 'sent' else 'draft' end, current_date - 3 + (g % 7), case when g % 3 = 0 then now() - '2 days'::interval end,
    repeat('fake social message ', 8), jsonb_build_object('type','first') from generate_series(1,500) g;

  insert into replies select 'r'||g, 'c'||(1 + (g*7-1) % 25), 'l'||(g*7), 'e'||(g*7)||'-1', 'someone'||g||'@example.test',
    repeat('fake reply ', 30), now() - ((g % 20)||' days')::interval, jsonb_build_object('flag', null) from generate_series(1,200) g;
  analyze;`);
}
const counts = await sql`select (select count(*) from spike.campaigns)::int campaigns, (select count(*) from spike.leads)::int leads, (select count(*) from spike.emails)::int emails, (select count(*) from spike.social_messages)::int social, (select count(*) from spike.replies)::int replies,
  (select sum(pg_total_relation_size(c.oid))::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'spike' and c.relkind = 'r') spike_bytes, pg_database_size(current_database()) db_bytes, version() v`;
console.log(counts[0]);
await sql.end();
