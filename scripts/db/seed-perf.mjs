// Fills the throw-away `perf` branch with made-up data: 25 campaigns, 1,500 leads, 6,000 emails, example.com only.
// Usage: node scripts/db/seed-perf.mjs   (after: node scripts/db/migrate.mjs perf)
import { fileURLToPath } from "node:url";
import { connect } from "./env.mjs";

export async function seed(tx) {
  const [{ real }] = await tx`select count(*)::int as real from leads where email_key not like '%@example.com' or email_key is null`;
  if (real) throw new Error("This branch holds other leads. Seeding is only for an empty perf branch.");
  await tx`insert into campaigns (id, name, niche, area, country, time_zone, created_at)
    select 'perf-c' || n, 'Made-up campaign ' || n, 'hvac', 'Sampletown, TX', 'US', 'America/Chicago', now() - n * interval '1 day' from generate_series(1, 25) n`;
  await tx`with names as (
      select n, (array['Blue','Cedar','Lone','Prairie','Summit','Harbor','Copper','Maple','Iron','Willow'])[1 + n % 10] as a,
             (array['Heron','Valley','Ridge','Brook','Anchor','Falcon','Orchard','Meadow','Canyon','Lantern','Pioneer','Beacon','Juniper'])[1 + n % 13] as b
      from generate_series(1, 1500) n)
    insert into leads (id, campaign_id, name, owner_name, email, email_key, phone, website, website_key, city, gap_score, created_at)
    select 'perf-l' || n, 'perf-c' || (1 + n % 25), a || ' ' || b || ' Services ' || n, 'Sample Owner ' || n, 'lead' || n || '@example.com', 'lead' || n || '@example.com',
           '555-01' || lpad((n % 100)::text, 2, '0'), 'https://site' || n || '.example.com', 'site' || n || '.example.com', 'Sampletown', n % 7, now() - n * interval '1 minute' from names`;
  await tx`insert into emails (id, campaign_id, lead_id, to_email, to_key, subject, body_text, step, framework, status, agentmail_message_id, agentmail_thread_id, sent_at, created_at)
    select 'perf-e' || n || '-' || s, 'perf-c' || (1 + n % 25), 'perf-l' || n, 'lead' || n || '@example.com', 'lead' || n || '@example.com', 'Made-up subject ' || s, repeat('Made-up text. ', 40), s, 'four-step',
           case when s <= n % 3 then 'delivered' else 'drafted' end, case when s <= n % 3 then '<perf-' || n || '-' || s || '@example.com>' end, case when s <= n % 3 then 'perf-t' || n end,
           case when s <= n % 3 then now() - (10 - s) * interval '1 day' end, now() - n * interval '1 minute'
    from generate_series(1, 1500) n, generate_series(1, 4) s`;
  // About a fifth of leads have a follow-up waiting, spread over two weeks either side of today.
  await tx`insert into follow_ups (lead_id, channel, campaign_id, step_key, position, due_date)
    select 'perf-l' || n, 'email', 'perf-c' || (1 + n % 25), '2', 2, current_date + (n % 29 - 14) from generate_series(1, 1500, 5) n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sql = connect("perf");
  try {
    await sql.begin(seed);
    await sql`analyze`;
    const [r] = await sql`select (select count(*) from leads)::int as leads, (select count(*) from emails)::int as emails, (select count(*) from follow_ups)::int as follow_ups`;
    console.log("perf seeded:", r);
  } finally {
    await sql.end();
  }
}
