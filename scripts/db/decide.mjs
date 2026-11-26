// Records the clean-up Lakshmi approved on 26 Nov 2026 in <export folder>/decisions.json (outside the repo), which
// import.mjs then applies, and writes merges-69.md and merges-left.md. Run only for changes she has approved:
// on a new export, look at its findings first. Usage: node scripts/db/decide.mjs <export folder>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskEmails } from "./mask.mjs";
import { placeMerges } from "./place-merges.mjs";
import { readExport } from "./read-export.mjs";
import { loadRules } from "./rules.mjs";
import { transform } from "./transform.mjs";

const { dir, manifest, stores, today } = readExport(process.argv[2]);
const rules = await loadRules();
const raw = new Map(stores["agent-hq-outreach-leads"].map((r) => JSON.parse(r.value)).map((l) => [l.id, l.raw]));
const run = (decisions) => transform(stores, { rules, today, exportedAt: manifest.exported_at, decisions });
const { tables, report } = run({});

const withEmail = report.duplicate_leads.map((d) => ({ keep: d.keep, merge: d.merge }));
const email_steps = report.first_send_at_later_step.map((f) => ({ email_id: f.email_id, step: 1, sequence_total: 1 }));
const taken = new Set(withEmail.flatMap((m) => [m.keep, m.merge]));
const place = placeMerges(tables, (l) => (taken.has(l.id) ? null : rules.placeIdKey(raw.get(l.id))));
const decisions = { merges: [...withEmail, ...place.merges.map(({ keep, merge }) => ({ keep, merge }))], email_steps };
writeFileSync(join(dir, "decisions.json"), JSON.stringify(decisions, null, 2), { mode: 0o600 });

const lead = new Map(tables.leads.map((l) => [l.id, l]));
const campaign = new Map(tables.campaigns.map((c) => [c.id, c.name]));
const cell = (v) => String(v ?? "-").replace(/\s+/g, " ").replace(/\|/g, "\\|");
const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") : "None.");
const out = fileURLToPath(new URL("../../../p1-reports/", import.meta.url));
const save = (name, ...parts) => { writeFileSync(join(out, name), maskEmails(parts.join("\n\n") + "\n"), { mode: 0o600 }); console.log(join(out, name)); };
const onKept = (k) => Object.entries(k).filter(([, n]) => n).map(([name, n]) => (name === "facebook" ? "Facebook-checked note" : `${n} ${name}`)).join(", ") || "none";

save("merges-69.md", `# Merges with no email on either row: ${place.merges.length}`,
  `Applied in dev. Same campaign and same Google place id. The merged row is kept and marked; nothing is deleted. The live app is unchanged.`,
  `Kept because: ${Object.entries(place.merges.reduce((m, x) => ({ ...m, [x.reason]: (m[x.reason] ?? 0) + 1 }), {})).map(([k, n]) => `${k}: ${n}`).join("; ")}.`,
  "Where neither row had records (your rule did not say which to keep), I kept the row holding more, else the older one.",
  table(["#", "Campaign", "Kept", "Kept id", "Merged", "Merged id", "Why kept", "Records on the kept row"],
    place.merges.map((m, i) => [i + 1, campaign.get(lead.get(m.keep).campaign_id), lead.get(m.keep).name, m.keep, lead.get(m.merge).name, m.merge, m.reason, onKept(m.kept)])));
save("merges-left.md", `# Pairs not merged: ${place.left.length}`, "Same campaign and Google place id, neither has an email, but left for you.",
  table(["Campaign", "Rows", "Why"], place.left.map((x) => [campaign.get(lead.get(x.ids[0]).campaign_id), x.ids.map((id) => `${lead.get(id).name} (${id})`).join("; "), x.why])));
console.log(`decisions.json: ${withEmail.length} merges with an email + ${place.merges.length} by place id, ${email_steps.length} step fixes; ${place.left.length} left`);
