// Writes the import findings as readable files in ../p1-reports (beside the repo, never in it).
// Usage: node scripts/db/reports.mjs <export folder>   (after import.mjs has run into dev)
// Email addresses are masked in everything written. Nothing is changed in the database.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./env.mjs";
import { maskEmails } from "./mask.mjs";
import { nameKey, phoneKey } from "./normalise.mjs";
import { readExport } from "./read-export.mjs";
import { loadRules } from "./rules.mjs";
import { transform } from "./transform.mjs";

const { dir, manifest, stores, decisions, today } = readExport(process.argv[2]);
const rules = await loadRules();
const run = (d) => transform(stores, { rules, today, exportedAt: manifest.exported_at, decisions: d });
// Findings are described as found in the export, before any approved change.
const { tables, report } = run({});
const applied = (n, of) => (n === 0 ? "not applied" : n === of ? "applied in dev" : `${n} of ${of} applied in dev`);
const records = (name) => (stores[`agent-hq-${name}`] ?? []).map((r) => JSON.parse(r.value));

const lead = new Map(tables.leads.map((l) => [l.id, l]));
const rawLead = new Map(records("outreach-leads").map((l) => [l.id, l]));
const campaign = new Map(tables.campaigns.map((c) => [c.id, c]));
const email = new Map(tables.emails.map((e) => [e.id, e]));
const cName = (id) => campaign.get(id)?.name ?? `(campaign ${id ?? "none"} is gone)`;
const lName = (id) => lead.get(id)?.name ?? `(lead ${id ?? "none"})`;
const cell = (v) => String(v ?? "-").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "-";
const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") : "None.");
const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "-");
const sent = (e) => e.status !== "drafted" && e.status !== "failed";
const tally = (list) => Object.entries(list.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(", ");

const out = fileURLToPath(new URL("../../../p1-reports/", import.meta.url));
mkdirSync(out, { recursive: true });
const written = [];
function save(name, title, ...parts) {
  const head = `# ${title}\n\nFrom the live export of ${when(manifest.exported_at)} UTC. Nothing here changes the live app. Email addresses are masked.\n`;
  writeFileSync(join(out, name), maskEmails([head, ...parts].join("\n\n") + "\n"), { mode: 0o600 });
  written.push(join(out, name));
}

// ── 1. Proposed merges ──
function activity(id) {
  const es = tables.emails.filter((e) => e.lead_id === id);
  const done = es.filter(sent);
  const replies = tables.replies.filter((r) => r.lead_id === id || email.get(r.original_email_id)?.lead_id === id);
  const social = tables.social_messages.filter((m) => m.lead_id === id);
  return [
    done.length ? `${done.length} (${tally(done.map((e) => e.status))})` : "0",
    es.length - done.length,
    replies.length ? `${replies.length} (${tally(replies.map((r) => r.kind))})` : "0",
    social.length ? `${social.length} (${tally(social.map((m) => m.status))})` : "0",
  ];
}
const keysOf = (id) => {
  const l = lead.get(id);
  return { name: nameKey(l.name), phone: phoneKey(l.phone), website: l.website_key, place: rules.placeIdKey(rawLead.get(id)?.raw) };
};
const compare = (a, b, k) => (!a[k] || !b[k] ? "missing" : a[k] === b[k] ? "same" : "differs");
const pairRows = report.duplicate_leads.map((d, i) => {
  const a = keysOf(d.keep), b = keysOf(d.merge);
  return { d, i: i + 1, match: ["phone", "website", "place", "name"].map((k) => compare(a, b, k)) };
});
// Pairs this rule does not cover: both have an address, or neither has one.
const others = [];
const list = tables.leads.filter((l) => !l.is_test);
for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  const x = list[i], y = list[j];
  if (x.campaign_id !== y.campaign_id || !!x.email_key !== !!y.email_key) continue;
  const a = keysOf(x.id), b = keysOf(y.id);
  const same = ["name", "phone", "website", "place"].filter((k) => compare(a, b, k) === "same");
  if (same.includes("place") || (same.includes("name") && same.length > 1)) others.push([cName(x.campaign_id), x.name, y.name, x.email_key ? "both" : "neither", same.join(", ")]);
}
const approved = report.duplicate_leads.filter((d) => decisions.merges?.some((m) => m.merge === d.merge)).length;
save("merges.md", `Proposed merges: ${pairRows.length} pairs (${applied(approved, pairRows.length)})`,
  "In each pair, **keep** is the row that has an email address. **Merge** has none and would be marked as merged into it. No row is deleted.",
  `Pairs per campaign: ${tally(report.duplicate_leads.map((d) => `in "${cName(d.campaign_id)}"`))}.`,
  "## Why each pair matches",
  table(["#", "Campaign", "Keep (has email)", "Its address", "Merge (no email)", "Phone", "Website", "Google place id", "Name"],
    pairRows.map(({ d, i, match }) => [i, cName(d.campaign_id), d.keep_name, lead.get(d.keep).email_key, d.merge_name, ...match])),
  "## What is on each row",
  "\"Sent\" means the email left the app (sent, delivered, bounced or replied).",
  table(["#", "Row", "Business", "Sent emails", "Drafts", "Replies", "Social messages"],
    pairRows.flatMap(({ d, i }) => [[i, "keep", d.keep_name, ...activity(d.keep)], [i, "merge", d.merge_name, ...activity(d.merge)]])),
  `## Possible duplicates NOT proposed: ${others.length}`,
  "Both rows have an email address, or neither has one, so the rule above does not cover them. Listed so you can see them; nothing would happen to them.",
  table(["Campaign", "Lead", "Lead", "Have an address", "Same"], others));

// ── 2. A first send stored at a later step ──
const fixes = report.first_send_at_later_step;
const proposed = fixes.map((f) => ({ email_id: f.email_id, step: 1, sequence_total: 1 }));
const fixed = run({ email_steps: proposed }).tables;
const emailRows = (rows, leadId) => rows.emails.filter((e) => e.lead_id === leadId).sort((a, b) => a.step - b.step || String(a.created_at).localeCompare(String(b.created_at)));
const stepRows = (rows, leadId) => table(["Step", "Status", "Marked superseded", "To", "Framework", "Created (UTC)", "Sent (UTC)", "Subject"],
  emailRows(rows, leadId).map((e) => [`${e.step} of ${e.sequence_total ?? "-"}`, e.status, e.is_duplicate ? "yes" : "no", e.to_key, e.framework, when(e.created_at), when(e.sent_at), e.subject]));
save("first-send-steps.md", `First send stored at a later step: before and after the fix (${applied(proposed.filter((p) => decisions.email_steps?.some((m) => m.email_id === p.email_id)).length, proposed.length)})`,
  "In both, the first email bounced at one address and the email that really arrived is stored as step 2.",
  ...fixes.flatMap((f) => {
    const l = lead.get(f.lead_id);
    const due = tables.follow_ups.filter((x) => x.lead_id === f.lead_id);
    const replies = tables.replies.filter((r) => r.lead_id === f.lead_id).length;
    return [`## ${f.name} (${cName(f.campaign_id)})`,
      `Lead address now: ${l.email_key} (source: ${l.email_source}). Stop state: ${l.stop_state}. Replies: ${replies}. Follow-up due: ${due.length ? due.map((x) => `${x.channel} ${x.step_key} on ${x.due_date}`).join(", ") : "none"}.`,
      "**Now**", stepRows(tables, f.lead_id), "**After the proposed fix**", stepRows(fixed, f.lead_id)];
  }),
  "## The fix",
  "- The email that arrived becomes step 1 of 1. Its old position is kept on the row.\n- The bounced email stays as it is, marked as superseded, so step 1 has one live email.\n- No status, date or text changes, and nothing is sent or deleted.\n- These are one-off emails, so the app works out no follow-up for them, before or after.");

// ── 3. Stop states ──
const label = { none: "none", replied: "replied", bounced: "bounced", do_not_contact: "do not contact" };
const why = (c) => {
  if (c.why) {
    if (c.why.startsWith("same address")) {
      const other = tables.leads.filter((l) => l.id !== c.lead_id && l.email_key === lead.get(c.lead_id).email_key && l.do_not_contact);
      return `${c.why}: shares ${lead.get(c.lead_id).email_key} with ${other.map((l) => `"${l.name}", campaign ${campaign.get(l.campaign_id)?.name ?? `${l.campaign_id} (gone)`}`).join(", ") || "another record"}`;
    }
    return c.why === "bounce event" ? "a real bounce; what today counts as the reply is the bounce report" : c.why;
  }
  const old = report.bounced_old_address.find((b) => b.lead_id === c.lead_id);
  if (!old) return "no stop reason found";
  const was = email.get(old.email_id).to_key, now = lead.get(c.lead_id).email_key;
  return `the bounce was to an old address (${was}); the lead now has ${now}${maskEmails(was) === maskEmails(now) ? " (the two differ in the hidden part)" : ""}`;
};
const dueRows = report.bounced_old_address.flatMap((b) => tables.follow_ups.filter((f) => f.lead_id === b.lead_id && !f.stopped_reason).map((f) => [lName(b.lead_id), f.channel, f.step_key, f.due_date]));
save("stop-states.md", `Stop states: ${report.state_changes.length} leads change`,
  "\"Today\" shows the two screens, which do not always agree.",
  table(["Business", "Campaign", "Today: Prospects", "Today: Follow-ups", "New", "Reason"],
    report.state_changes.map((c) => [c.name, cName(c.campaign_id), label[c.today_prospects], label[c.today_followups], label[c.after], why(c)])),
  `## All ${tables.leads.length} leads, new state`, table(["State", "Leads"], Object.keys(label).map((k) => [label[k], tables.leads.filter((l) => l.stop_state === k).length])),
  "## Check before sending",
  "Leads whose first try bounced at an old address and who still have a follow-up due. The new address never got the first email.",
  table(["Business", "Channel", "Step due", "Due date"], dueRows));

// ── 4. Failed sends ──
const failedEmails = report.failed_emails.map((f) => [lName(f.lead_id), email.get(f.email_id)?.to_key, f.step, f.error]);
const logged = records("activity").filter((a) => /^Sent \d+ of \d+ emails/.test(a.summary ?? "") && Number(a.details?.errors) > 0);
const savedErrors = records("outreach-emails").filter((e) => e.error || e.error_message).length;
const failedSearches = tables.campaign_jobs.filter((j) => j.status === "failed" || j.data?.error_message);
save("failed-sends.md", "Failed sends",
  `## Emails stored as "failed": ${failedEmails.length}`, table(["Business", "To", "Step", "Error"], failedEmails),
  `Emails with a saved error message, whatever their status: ${savedErrors}.`,
  `## Send runs that logged an error: ${logged.length}`,
  "**The app does not save why a single send failed.** The email stays \"drafted\" and the error is only shown on screen at that moment. The activity log keeps the number of errors, so the failed email cannot be named from the saved data.",
  table(["When (UTC)", "Campaign", "Log line", "Errors", "Drafts in that campaign now"], logged.map((a) => [
    when(a.created_at), cName(a.details.campaign_id), a.summary, a.details.errors, tables.emails.filter((e) => e.campaign_id === a.details.campaign_id && e.status === "drafted").length])),
  `## Lead searches with an error (not email sends): ${failedSearches.length}`,
  table(["Campaign", "Job", "Status", "Error"], failedSearches.map((j) => [cName(j.campaign_id), j.kind, j.status, j.data?.error_message])),
  `Bounced emails are not failed sends: ${tables.emails.filter((e) => e.status === "bounced").length} emails have status "bounced".`);

// ── 5. Orphans and unique-key clashes ──
const o = report.orphans;
const byId = (name) => new Map(tables[name].map((r) => [r.id, r]));
const reply = byId("replies");
const contactOrphans = tables.contacts.filter((c) => c.campaign_id && !campaign.has(c.campaign_id));
const shared = tables.social_pages.map((p) => ({ p, links: tables.lead_social_links.filter((l) => l.url_norm === p.url_norm) })).filter((s) => s.links.length > 1);
const skipped = Object.entries(report.stores).flatMap(([store, s]) => Object.entries(s.skipped).map(([reason, n]) => [store, reason, n]));
const unreadable = Object.entries(report.stores).filter(([, s]) => s.parse_failed).map(([store, s]) => [store, s.parse_failed]);
save("orphans-and-clashes.md", "Orphans and unique-key clashes",
  "Orphans are rows that point to something that no longer exists. **All are imported and kept.**",
  "## Counts", table(["Kind", "Count"], [
    ["Leads whose campaign is gone", o.leads_without_campaign.length], ["Emails whose campaign is gone", o.emails_without_campaign.length], ["Emails whose lead is gone", o.emails_without_lead.length],
    ["Replies with no matching campaign", o.replies_without_campaign.length], ["Replies with no matching lead", o.replies_without_lead.length], ["Social messages with no lead", o.social_without_lead.length],
    ["Touches with no lead", o.touches_without_lead.length], ["Follow-up settings with no lead", o.follow_state_without_lead.length], ["Clicks with no email", o.clicks_without_email.length],
    ["Contact entries for a campaign that is gone", contactOrphans.length]]),
  "## Leads whose campaign is gone", table(["Business", "Campaign id", "Test lead"], o.leads_without_campaign.map((id) => [lName(id), lead.get(id).campaign_id, lead.get(id).is_test ? "yes" : "no"])),
  "## Emails whose campaign or lead is gone",
  table(["Business", "To", "Status", "Step", "Campaign", "Missing"], [...new Set([...o.emails_without_campaign, ...o.emails_without_lead])].map((id) => {
    const e = email.get(id);
    return [lead.get(e.lead_id)?.name ?? e.to_name, e.to_key, e.status, e.step, cName(e.campaign_id), [!campaign.has(e.campaign_id) && "campaign", !lead.has(e.lead_id) && "lead"].filter(Boolean).join(" and ")];
  })),
  "## Replies with no matching campaign or lead",
  table(["Kind", "From", "Subject", "Received (UTC)", "Missing"], [...new Set([...o.replies_without_campaign, ...o.replies_without_lead])].map((id) => {
    const r = reply.get(id);
    return [r.kind, r.from_key, r.subject, when(r.received_at), [!campaign.has(r.campaign_id) && "campaign", !lead.has(r.lead_id) && "lead"].filter(Boolean).join(" and ")];
  })),
  `Contact entries whose "+" came out of the export as a space, now restored: ${report.contact_plus_restored}.`,
  "## Contact entries for a campaign that is gone", table(["Kind", "Address", "Campaign id"], contactOrphans.map((c) => [c.kind, c.email, c.campaign_id])),
  `## Unique-key clashes`,
  `Two drafts for one lead and step (email) or lead, channel and step (social): ${report.duplicate_drafts.length}.`,
  table(["Type", "Business", "Kept", "Marked"], report.duplicate_drafts.map((d) => [d.what, lName(d.lead_id), d.kept, d.marked.map((m) => `${m.id} (${m.status})`).join(", ")])),
  "Records skipped (repeated or missing id):", table(["Store", "Reason", "Records"], skipped),
  "Records that could not be read:", table(["Store", "Records"], unreadable),
  `## Social pages shared by several leads: ${shared.length}`,
  "Not a clash: one page is stored once and each lead links to it.",
  table(["Page", "Leads"], shared.map(({ p, links }) => [p.url_norm, links.map((l) => `${lName(l.lead_id)} (${cName(lead.get(l.lead_id)?.campaign_id)})`).join("; ")])));

// ── 6. Postal address ──
save("postal-address.md", "Footer postal address", `Filled in: **${report.postal_address_filled ? "yes" : "no"}**.`);

// Safety check on what was written: no full address, key or connection string.
for (const file of written) {
  const text = readFileSync(file, "utf8");
  const found = [/[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9-]+\./, /postgres(ql)?:\/\//i, /AIza[0-9A-Za-z_-]{20}/, /\b(sk|am|apify_api)[-_][A-Za-z0-9]{16}/].filter((p) => p.test(text));
  console.log(`${found.length ? "CHECK FAILED" : "ok"}  ${file}  (${text.split("\n").length} lines)`);
  if (found.length) process.exitCode = 1;
}

// Counts of emails on the merge rows, from the database itself, as a cross-check of merges.md.
const sql = connect("dev");
try {
  const ids = report.duplicate_leads.map((d) => d.merge);
  const [r] = ids.length ? await sql`select (select count(*)::int from emails where lead_id in ${sql(ids)}) as emails, (select count(*)::int from replies where lead_id in ${sql(ids)}) as replies, (select count(*)::int from social_messages where lead_id in ${sql(ids)}) as social` : [{}];
  console.log(`dev database, rows to be merged: ${JSON.stringify(r)}`);
} finally {
  await sql.end();
}
