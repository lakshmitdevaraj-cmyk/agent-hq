import { writeFileSync } from "node:fs";
import { call, sleep } from "../scripts/remote.mjs";
const before = (await import("../results/c-queries.json", { with: { type: "json" } })).default.warm;
const paths = { prospects_no_email_social: "/q/prospects?filter=no_email_social", prospects_emailed_no_reply: "/q/prospects?filter=emailed_no_reply", prospects_due_today: "/q/prospects?filter=due_today", followups: "/q/followups", campaign_page: "/q/campaign?id=c1" };
await sleep(15000);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = { at: new Date().toISOString(), placement: "aws:us-east-1", warm: {} };
for (const [name, p] of Object.entries(paths)) {
  await call(p);
  const runs = [];
  for (let i = 0; i < 15; i++) { runs.push(await call(p)); await sleep(250); }
  out.warm[name] = { n: runs.length, statuses: [...new Set(runs.map((r) => r.status))], client_ms_median: med(runs.map((r) => r.ms)), db_ms_median: med(runs.map((r) => Number(r.headers["x-db-ms"]))), cf_placement: runs[0].headers["cf-placement"] ?? null, before_client_ms: before[name].client_ms.median, before_db_ms: before[name].db_ms.median };
  console.log(name, JSON.stringify(out.warm[name]));
}
writeFileSync("results/c-queries-placed.json", JSON.stringify(out, null, 1));
