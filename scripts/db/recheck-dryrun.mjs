// Dry run (P2 run C, fix 3): how many unsent drafts on Neon dev would change review status when re-checked under the
// current rules (RULES_VERSION, with the 5b lead-aware checks F35–F37, F40 and F38/F39). Read only: it only runs selects. Prints counts only (no names, addresses or ids).
// Two counts: (1) what the list-time re-check (recheckStaleDrafts) would change: only a hard hit blocks, and a stale
// code-checks block is lifted; (2) the status a fresh check gives (as on save), split by which F35–F37/F40 check fires.
// codeCheckDraft only reads, so the drafts are checked 8 at a time.
// Run: node scripts/db/recheck-dryrun.mjs
import "./equiv/ts-ext.mjs";
import postgres from "postgres";
import { localVar } from "./env.mjs";
const { clientOptions } = await import("../../netlify/functions/lib/db/client.ts");
const { codeCheckDraft, readSettings } = await import("../../netlify/functions/lib/sql/emailchecks.ts");
const { messageChecks } = await import("../../netlify/functions/lib/sql/messagechecks.ts");
const { RULES_VERSION } = await import("../../netlify/functions/lib/messagerules.ts");

const sql = postgres(localVar("DEV_DATABASE_URL"), { ...clientOptions(), max: 8 });
const tally = new Map();
const add = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
const byCheck = new Map();
const fresh = new Map();
const freshBy = new Map();
let total = 0, stale = 0;
{
  const tx = sql;
  const settings = await readSettings(tx);
  const rows = await tx`select * from emails where status = 'drafted' and not is_duplicate`;
  total = rows.length;
  const kinds = ["email1", "email2", "email3", "email4"];
  const one = async (r) => {
    if (r.rules_version !== RULES_VERSION) stale++;
    const was = String(r.review_status ?? "check");
    const ck = await codeCheckDraft(tx, r, settings);
    // (1) the same decision recheckStaleDrafts makes
    const now = ck.hard.length ? "blocked" : was === "blocked" && r.reviewed_by === "code checks" ? "check" : was;
    add(`${was} -> ${now}`);
    // (2) a fresh check: the worse of the saved status and the code-check status (code checks never raise a draft)
    const rank = { ready: 0, check: 1, blocked: 2 };
    const f = rank[ck.status] > rank[was] ? ck.status : was;
    fresh.set(`${was} -> ${f}`, (fresh.get(`${was} -> ${f}`) ?? 0) + 1);
    if ((f !== was || now !== was) && r.lead_id) {
      const [lead] = await tx`select name, email, website, owner_name, contact_name, site_check, data->'raw' as raw from leads where id = ${r.lead_id}`;
      const pos = Math.min(4, Math.max(1, Number(r.step ?? 1)));
      const mc = lead ? messageChecks(kinds[r.framework === "four-step" ? pos - 1 : 0], String(r.body_text ?? ""), lead, r.to_email ?? null) : [];
      const keys = mc.length ? [...new Set(mc.map((h) => `${h.id} (${h.level})`))] : ["(not F35–F40: other rules)"];
      const target = now !== was ? byCheck : freshBy;
      for (const k of keys) target.set(k, (target.get(k) ?? 0) + 1);
    }
  };
  for (let i = 0; i < rows.length; i += 8) await Promise.all(rows.slice(i, i + 8).map(one));
}
await sql.end();
console.log(`unsent drafts (not duplicates): ${total}; not yet stamped with RULES_VERSION ${RULES_VERSION}: ${stale}`);
for (const [k, n] of [...tally].sort()) console.log(`  ${k}: ${n}${k.split(" -> ")[0] === k.split(" -> ")[1] ? " (unchanged)" : ""}`);
console.log("(1) changed by the list-time re-check, by the check that fires:");
for (const [k, n] of byCheck) console.log(`  ${k}: ${n}`);
console.log("(2) a fresh check (as on save), saved status -> new status:");
for (const [k, n] of [...fresh].sort()) console.log(`  ${k}: ${n}${k.split(" -> ")[0] === k.split(" -> ")[1] ? " (unchanged)" : ""}`);
console.log("(2) changed drafts by the F35–F40 check that fires (one draft can count under more than one):");
for (const [k, n] of freshBy) console.log(`  ${k}: ${n}`);
console.log("read only: nothing was written.");
