// Read only (P2 chunk 7, Lakshmi's ask 3): lists the Ready drafts on Neon dev that a fresh check (as on save) would
// move to "Check this", with the F35–F40 check that fires. Nothing is written to the database.
// The list holds business names, so it is written to the file given (outside the repo), never printed; addresses are masked.
// Run: node scripts/db/recheck-list.mjs ~/Documents/ShiftForge\ HQ/p2-reports/<file>.md
import "./equiv/ts-ext.mjs";
import postgres from "postgres";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localVar } from "./env.mjs";
import { maskEmails } from "./mask.mjs";
const { clientOptions } = await import("../../netlify/functions/lib/db/client.ts");
const { codeCheckDraft, readSettings } = await import("../../netlify/functions/lib/sql/emailchecks.ts");
const { messageChecks } = await import("../../netlify/functions/lib/sql/messagechecks.ts");

const out = process.argv[2];
if (!out || resolve(out).startsWith(resolve(new URL("../..", import.meta.url).pathname))) {
  console.error("give an output file outside the repo (the list holds business names)");
  process.exit(2);
}
const sql = postgres(localVar("DEV_DATABASE_URL"), { ...clientOptions(), max: 8 });
const kinds = ["email1", "email2", "email3", "email4"];
const rank = { ready: 0, check: 1, blocked: 2 };
const found = [];
try {
  await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    const settings = await readSettings(tx);
    const rows = await tx`select e.*, c.name as campaign_name from emails e left join campaigns c on c.id = e.campaign_id
                          where e.status = 'drafted' and not e.is_duplicate and e.review_status = 'ready'`;
    const one = async (r) => {
      const ck = await codeCheckDraft(tx, r, settings);
      if (rank[ck.status] <= rank.ready) return;
      const [lead] = r.lead_id ? await tx`select name, email, website, owner_name, contact_name, site_check, data->'raw' as raw from leads where id = ${r.lead_id}` : [];
      const pos = Math.min(4, Math.max(1, Number(r.step ?? 1)));
      const mc = lead ? messageChecks(kinds[r.framework === "four-step" ? pos - 1 : 0], String(r.body_text ?? ""), lead, r.to_email ?? null) : [];
      const reasons = mc.length ? mc.map((h) => `${h.id}: ${h.label}${h.excerpt ? ` ("${h.excerpt}")` : ""}`) : ["(not F35–F40: other rules)"];
      found.push({ business: lead?.name ?? r.to_name ?? "(no lead)", campaign: r.campaign_name ?? r.campaign_id, step: r.step, to: r.to_email, website: lead?.website ?? "", new_status: ck.status, reasons });
    };
    for (let i = 0; i < rows.length; i += 8) await Promise.all(rows.slice(i, i + 8).map(one));
  });
} finally { await sql.end(); }
found.sort((a, b) => `${a.campaign}/${a.business}/${a.step}`.localeCompare(`${b.campaign}/${b.business}/${b.step}`));
const cell = (s) => maskEmails(String(s ?? "")).replace(/\|/g, "/").replace(/\s+/g, " ");
const lines = [
  `Ready drafts a fresh check would move (read only, ${new Date().toISOString().slice(0, 10)}): ${found.length}`, "",
  "| # | Business | Campaign | Step | To (masked) | Website | New status | Reason |", "|---|---|---|---|---|---|---|---|",
  ...found.map((f, i) => `| ${i + 1} | ${cell(f.business)} | ${cell(f.campaign)} | ${f.step} | ${cell(f.to)} | ${cell(String(f.website).replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, ""))} | ${f.new_status} | ${cell(f.reasons.join("; "))} |`),
];
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`${found.length} drafts written to the file given (no names printed here). Read only: nothing was written to the database.`);
