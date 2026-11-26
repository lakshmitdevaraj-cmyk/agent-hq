// Proof of the import: counts, every lead and email compared field by field, five of each shown, and query plans.
// Writes ../p1-reports/proofs.md. Usage: node scripts/db/proofs.mjs <export folder>
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { connect } from "./env.mjs";
import { fingerprint, GROUPS } from "./load.mjs";
import { maskEmails } from "./mask.mjs";
import { normaliseSocialUrl } from "./normalise.mjs";
import { explain, QUERIES, sampleArgs } from "./queries.mjs";
import { readExport } from "./read-export.mjs";

const { manifest, stores, today } = readExport(process.argv[2]);
const records = (name) => (stores[`agent-hq-${name}`] ?? []).map((r) => JSON.parse(r.value));
const sql = connect("dev");

// Export field → column. A field not listed must be in `data` under its own name.
const LEAD = Object.fromEntries(["id", "campaign_id", "name", "owner_name", "contact_name", "email", "phone", "website", "address", "category", "rating", "reviews_count", "status", "is_test", "excluded", "excluded_at", "excluded_reason", "excluded_note", "not_fit_kept", "do_not_contact", "do_not_contact_at", "do_not_contact_reason", "gap_score", "site_check", "enriched_at", "browser_checked_at", "contacted_at", "created_at", "updated_at", "email_source"].map((f) => [f, f]));
const EMAIL = { ...Object.fromEntries(["id", "campaign_id", "lead_id", "to_email", "to_name", "subject", "body_text", "body_html", "sender_name", "sequence_total", "framework", "status", "error", "review_status", "review_reasons", "reviewed_by", "reviewed_at", "rules_version", "source", "edited", "agentmail_message_id", "agentmail_thread_id", "agentmail_inbox_id", "sent_at", "delivered_at", "bounced_at", "replied_at", "click_count", "last_clicked_at", "created_at", "updated_at"].map((f) => [f, f])), sequence_position: "step", written_by: "written_model" };

const noNulls = (v) => JSON.parse(JSON.stringify(v ?? null).replaceAll("\\u0000", ""));
function same(exported, stored) {
  if (stored instanceof Date) return Date.parse(exported) === stored.getTime();
  if (typeof exported === "number") return Number(stored) === exported;
  if (exported === "" && stored === null) return true; // an empty time
  return isDeepStrictEqual(noNulls(exported), stored ?? null);
}

async function compare(storeName, table, map) {
  const rows = new Map((await sql`select * from ${sql(table)}`).map((r) => [r.id, r]));
  const links = table === "leads" ? await sql`select l.lead_id, l.kind, p.url_norm from lead_social_links l join social_pages p on p.id = l.page_id` : [];
  const results = [], expected = {}, differences = [];
  for (const record of records(storeName)) {
    const row = rows.get(record.id);
    if (!row) { differences.push([record.id, "(whole record)", "missing"]); continue; }
    const fields = [];
    for (const [field, value] of Object.entries(record)) {
      let stored, where, note = "";
      if (field === "social" && table === "leads") {
        const wanted = Object.entries(value ?? {}).filter(([, u]) => u).map(([k, u]) => `${k} ${normaliseSocialUrl(u)?.url_norm}`).sort();
        const got = links.filter((l) => l.lead_id === record.id).map((l) => `${l.kind} ${l.url_norm}`).sort();
        const ok = wanted.every((w) => got.includes(w));
        fields.push({ field, exported: `${wanted.length} links`, stored: `${got.length} links`, where: "lead_social_links", ok });
        if (!ok) differences.push([record.id, field, "a link is missing"]);
        continue;
      }
      if (map[field] && !(map[field] in (row.data ?? {}))) { where = map[field]; stored = row[where]; }
      else { where = `data.${field}`; stored = row.data?.[field]; }
      let ok = same(value, stored);
      // Changes the import makes on purpose, each of which keeps the old value on the row.
      if (!ok && field === "lead_id" && same(value, row.data?.original_lead_id)) { ok = true; note = "moved by an approved merge"; }
      if (!ok && field === "sequence_position" && same(value, row.data?.original_step)) { ok = true; note = "approved step fix"; }
      if (!ok && field === "sequence_total" && same(value, row.data?.original_sequence_total)) { ok = true; note = "approved step fix"; }
      if (note) expected[note] = (expected[note] ?? 0) + 1;
      if (!ok) differences.push([record.id, field, where]);
      fields.push({ field, exported: value, stored, where, ok, note });
    }
    results.push({ id: record.id, name: record.name ?? record.subject ?? "", fields });
  }
  return { total: results.length, results, differences, expected };
}

const PERSONAL = /^(owner_name|contact_name|to_name|phone|address|owner_evidence|owner_source_url|body_text|body_html|raw|notes|previous_email)$/;
const cell = (v) => String(v ?? "-").replace(/\s+/g, " ").replace(/\|/g, "\\|");
const show = (field, v) => {
  const text = typeof v === "object" && v !== null ? JSON.stringify(v instanceof Date ? v.toISOString() : v) : String(v ?? "-");
  if (PERSONAL.test(field) && v) return `(hidden, ${text.length} characters)`;
  return maskEmails(text).slice(0, 50) + (text.length > 50 ? "…" : "");
};
const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") : "None.");
const pick = (list, n) => [...list].map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, x]) => x);

const parts = [`# Proofs`, `Export of ${manifest.exported_at}, dev branch. Email addresses are masked; names of people, phones, street addresses and message text are hidden.`];

const counts = await fingerprint(sql);
parts.push("## Counts: export store against tables", table(["Store", "Exported", "Rows"], GROUPS.map(([store, ...tables]) => [store, manifest.stores.find((s) => s.store === `agent-hq-${store}`)?.count ?? "not stored today", tables.map((t) => `${t} ${counts[t].rows}`).join(", ")])),
  "Differences: social_messages has one row per step; campaign_jobs one row per job type; social pages are stored once however many links point to them; follow_ups is worked out by the live rule. Merged leads stay as rows (marked), so the lead count does not drop.");

const spot = [];
for (const [title, store, tableName, map] of [["Leads", "outreach-leads", "leads", LEAD], ["Emails", "outreach-emails", "emails", EMAIL]]) {
  const r = await compare(store, tableName, map);
  const fieldCount = r.results.reduce((n, x) => n + x.fields.length, 0);
  console.log(`${title}: ${r.total} records, ${fieldCount} fields compared, ${r.differences.length} differences; on purpose: ${JSON.stringify(r.expected)}`);
  spot.push(`## ${title}: all ${r.total} compared`, `${fieldCount} fields compared. Unexplained differences: **${r.differences.length}**. Changed on purpose (old value kept): ${Object.entries(r.expected).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.`);
  if (r.differences.length) spot.push(table(["Id", "Field", "Where"], r.differences.slice(0, 50)));
  for (const x of pick(r.results, 5)) spot.push(`### ${title.slice(0, -1)} ${x.id}: ${maskEmails(x.name)}`, table(["Field", "Export", "Database", "Column", "Same"], x.fields.map((f) => [f.field, show(f.field, f.exported), show(f.field, f.stored), f.where, f.ok ? (f.note || "yes") : "NO"])));
}
parts.push(...spot);

parts.push("## Query plans on dev", "Dev tables are small, so Postgres may rightly read a whole table. Each query is shown as planned, and again with whole-table reads switched off to prove its index can serve it.");
const args = await sampleArgs(sql, today);
for (const q of QUERIES) {
  const asPlanned = await explain(sql, q, args), forced = await explain(sql, q, args, { indexOnly: true });
  const uses = (plan) => plan.some((line) => line.includes(q.index));
  console.log(`${q.name}: index ${q.index} ${uses(asPlanned) ? "used as planned" : uses(forced) ? "used only when whole-table reads are off" : "NOT USED"}`);
  parts.push(`### ${q.name} (expects ${q.index})`, "As planned:", "```\n" + asPlanned.join("\n") + "\n```", "Whole-table reads off:", "```\n" + forced.join("\n") + "\n```");
}
const out = fileURLToPath(new URL("../../../p1-reports/proofs.md", import.meta.url));
writeFileSync(out, maskEmails(parts.join("\n\n") + "\n"), { mode: 0o600 });
console.log(out);
await sql.end();
