// The five queries the proofs explain and time. Same text on dev and on the perf branch.
export const QUERIES = [
  { name: "lead by email", index: "leads_email", args: ["email"], text: "select id, name, campaign_id, stop_state from leads where email_key = $1" },
  { name: "email by AgentMail message id", index: "emails_message_id", args: ["messageId"], text: "select id, lead_id, status, step from emails where agentmail_message_id = $1" },
  { name: "campaign leads, page 1 of 50", index: "leads_campaign_page", args: ["campaignId"], text: "select id, name, email, phone, city, stop_state, created_at from leads where campaign_id = $1 and merged_into is null order by created_at desc, id limit 50" },
  { name: "Prospects search on a name", index: "leads_search", args: ["like"], text: "select id, name, city, gap_score from leads where search like $1 and merged_into is null order by gap_score desc nulls last, created_at desc, id limit 50" },
  { name: "follow-ups due today", index: "follow_ups_due", args: ["today"], text: "select f.lead_id, f.channel, f.step_key, f.due_date, l.name from follow_ups f join leads l on l.id = f.lead_id where f.stopped_reason is null and f.due_date <= $1 order by f.due_date, f.lead_id" },
];

/** Real values from the branch itself to ask for. */
export async function sampleArgs(sql, today) {
  const [lead] = await sql`select email_key, name from leads where email_key is not null and merged_into is null order by id offset 7 limit 1`;
  const [email] = await sql`select agentmail_message_id from emails where agentmail_message_id is not null order by id offset 7 limit 1`;
  const [campaign] = await sql`select campaign_id from leads where merged_into is null group by 1 order by count(*) desc, 1 limit 1`;
  // A whole business name, as someone looking for one business would type it.
  const word = lead.name.toLowerCase().replace(/[%_\\]/g, "");
  return { email: lead.email_key, messageId: email.agentmail_message_id, campaignId: campaign.campaign_id, like: `%${word}%`, today };
}

/** EXPLAIN ANALYZE as text lines. indexOnly switches whole-table reads off, to show the index can serve the query. */
export async function explain(sql, query, args, { indexOnly = false } = {}) {
  return sql.begin(async (tx) => {
    if (indexOnly) await tx`set local enable_seqscan = off`;
    const rows = await tx.unsafe(`explain (analyze, buffers off, costs off) ${query.text}`, query.args.map((a) => args[a]));
    return rows.map((r) => r["QUERY PLAN"]);
  });
}
