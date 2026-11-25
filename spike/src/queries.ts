// Test C: filtering and sorting happen in SQL. Each query returns ONE text column holding ready JSON,
// so the Worker passes it through without building or serialising objects (CPU stays tiny).
import type { Sql } from "postgres";

export type ProspectFilter = "no_email_social" | "emailed_no_reply" | "due_today";

export function prospects(sql: Sql, filter: ProspectFilter) {
  const where = filter === "no_email_social"
    ? sql`l.email is null and not l.excluded and coalesce(l.facebook, l.instagram, l.linkedin) is not null`
    : filter === "emailed_no_reply"
      ? sql`exists (select 1 from spike.emails e where e.lead_id = l.id and e.status in ('sent','delivered'))
            and not exists (select 1 from spike.replies r where r.lead_id = l.id)`
      : sql`not l.do_not_contact and (
              exists (select 1 from spike.social_messages s where s.lead_id = l.id and s.sent_at is null and s.due_date = current_date)
              or exists (select 1 from spike.emails e where e.lead_id = l.id and e.status = 'drafted' and e.due_date = current_date))`;
  return sql`
    select coalesce(json_agg(x), '[]')::text as json, count(*)::int as n from (
      select l.id, l.campaign_id, c.name as campaign_name, l.name, l.category, l.address, l.email, l.phone, l.rating, l.reviews_count,
             l.facebook, l.instagram, l.linkedin, l.data->>'gap_score' as gap_score
      from spike.leads l join spike.campaigns c on c.id = l.campaign_id
      where ${where}
      order by (l.data->>'gap_score')::int desc, l.id
      limit 200) x`;
}

/** Next unsent email whose previous step was sent at least 3 weekdays ago; replied, do-not-contact and bounced leads skipped. */
export function followups(sql: Sql) {
  return sql`
    with cutoff as (
      -- the latest date that has at least 3 weekdays after it, up to and including today
      select d::date as day from generate_series(current_date - 10, current_date, interval '1 day') d
      where (select count(*) from generate_series(d + interval '1 day', current_date, interval '1 day') w where extract(isodow from w) < 6) >= 3
      order by d desc limit 1),
    next as (
      select distinct on (lead_id) lead_id, id, sequence_position, subject from spike.emails where status = 'drafted' order by lead_id, sequence_position)
    select coalesce(json_agg(x), '[]')::text as json, count(*)::int as n from (
      select l.id as lead_id, l.name, l.campaign_id, n.id as email_id, n.sequence_position, n.subject, p.sent_at as last_sent_at
      from next n
      join spike.emails p on p.lead_id = n.lead_id and p.sequence_position = n.sequence_position - 1 and p.status in ('sent','delivered')
      join spike.leads l on l.id = n.lead_id
      where p.sent_at::date <= (select day from cutoff)
        and not l.do_not_contact
        and not exists (select 1 from spike.replies r where r.lead_id = l.id)
        and not exists (select 1 from spike.emails b where b.lead_id = l.id and b.status = 'bounced')
      order by p.sent_at, l.id
      limit 200) x`;
}

export function campaignPage(sql: Sql, id: string) {
  return sql`
    select json_build_object(
      'campaign', (select row_to_json(c) from spike.campaigns c where c.id = ${id}),
      'leads', (select coalesce(json_agg(l order by l.name), '[]') from (select * from spike.leads where campaign_id = ${id}) l),
      'emails', (select coalesce(json_agg(e order by e.lead_id, e.sequence_position), '[]') from (select * from spike.emails where campaign_id = ${id}) e)
    )::text as json, 1 as n`;
}
