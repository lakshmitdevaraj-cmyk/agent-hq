// Writes the transformed rows into the database: one transaction per exported store, upsert by primary key,
// so running it twice gives the same rows.

const KEYS = {
  campaigns: ["id"], campaign_jobs: ["campaign_id", "kind"], leads: ["id"], social_pages: ["url_norm"], lead_social_links: ["lead_id", "kind"], lead_screenshots: ["campaign_id", "lead_id"],
  emails: ["id"], social_messages: ["id"], touches: ["id"], follow_up_state: ["lead_id", "channel"], follow_ups: ["lead_id", "channel"], replies: ["id"], clicks: ["id"], contacts: ["blob_key"],
  outreach_settings: ["key"], activity: ["id"], tasks: ["id"], agents: ["id"], forms: ["slug"], submissions: ["id"], pages: ["slug"], webhooks: ["id"], webhook_events: ["id"],
  voice_config: ["key"], voice_sessions: ["id"], voice_invitations: ["id"],
};

/** Which tables each exported store fills. follow_ups is worked out from several stores, so it goes last. */
export const GROUPS = [
  ["outreach-campaigns", "campaigns", "campaign_jobs"], ["outreach-leads", "leads", "social_pages", "lead_social_links"], ["lead-screenshots", "lead_screenshots"],
  ["outreach-emails", "emails"], ["outreach-social", "social_messages"], ["outreach-touches", "touches"], ["outreach-followups", "follow_up_state"],
  ["outreach-replies", "replies"], ["outreach-clicks", "clicks"], ["outreach-contacts", "contacts"], ["outreach-settings", "outreach_settings"],
  ["activity", "activity"], ["tasks", "tasks"], ["agents", "agents"], ["forms", "forms"], ["submissions", "submissions"], ["pages", "pages"],
  ["webhooks", "webhooks"], ["webhook-events", "webhook_events"], ["voice-config", "voice_config"], ["voice-sessions", "voice_sessions"], ["voice-invitations", "voice_invitations"],
  ["(worked out)", "follow_ups"],
];

export const TABLES = GROUPS.flatMap(([, ...tables]) => tables);

async function columnsOf(sql, table) {
  const rows = await sql`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER'`;
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

async function upsert(tx, table, rows) {
  if (!rows.length) return;
  const types = await columnsOf(tx, table);
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const unknown = columns.filter((c) => !types.has(c));
  if (unknown.length) throw new Error(`${table} has no column: ${unknown.join(", ")}`);
  const ready = rows.map((r) => Object.fromEntries(columns.map((c) => {
    const v = r[c] ?? null;
    return [c, v !== null && types.get(c) === "jsonb" ? tx.json(v) : v];
  })));
  const keys = KEYS[table];
  const rest = columns.filter((c) => !keys.includes(c));
  // A page already known keeps its first spelling and its id.
  const action = table === "social_pages" || !rest.length ? tx`do nothing` : tx`do update set ${tx.unsafe(rest.map((c) => `"${c}" = excluded."${c}"`).join(", "))}`;
  for (let i = 0; i < ready.length; i += 200) {
    await tx`insert into ${tx(table)} ${tx(ready.slice(i, i + 200), ...columns)} on conflict (${tx(keys)}) ${action}`;
  }
}

/** result: what transform() returned. Returns { table: rows sent }. */
export async function load(sql, result) {
  const inTransaction = (fn) => (sql.savepoint ? sql.savepoint(fn) : sql.begin(fn)); // tests pass an open transaction
  const sent = {};
  for (const [, ...tables] of GROUPS) {
    await inTransaction(async (tx) => {
      for (const table of tables) {
        let rows = result.tables[table] ?? [];
        sent[table] = rows.length;
        if (table === "lead_social_links" && rows.length) {
          const ids = new Map((await tx`select id, url_norm from social_pages`).map((p) => [p.url_norm, p.id]));
          rows = rows.map(({ url_norm, ...link }) => ({ ...link, page_id: ids.get(url_norm) }));
        }
        // While rows are rewritten none of them may hold a step, or a renumbered one could clash half way.
        if ((table === "emails" || table === "social_messages") && rows.length) await tx`update ${tx(table)} set is_duplicate = true where id in ${tx(rows.map((r) => r.id))}`;
        // Its key includes the lead, so a merged lead's old row must go before the moved one is written.
        if (table === "follow_up_state" && rows.length) await tx`delete from follow_up_state where blob_key in ${tx(rows.map((r) => r.blob_key))}`;
        // Worked out from the other tables, so it is replaced whole.
        if (table === "follow_ups") await tx`delete from follow_ups`;
        await upsert(tx, table, rows);
      }
    });
  }
  return sent;
}

/** Row count and a checksum of the contents of every table: equal before and after means nothing changed. */
export async function fingerprint(sql) {
  const out = {};
  for (const table of TABLES) {
    const [r] = await sql`select count(*)::int as rows, md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) as checksum from ${sql(table)} t`;
    out[table] = r;
  }
  return out;
}
