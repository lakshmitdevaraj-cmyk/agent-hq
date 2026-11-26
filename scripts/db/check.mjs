// Connection check for Gate 1: prints only version, database, time, the region read from the host name,
// and whether the server certificate was really checked.
// Usage: node scripts/db/check.mjs [dev|perf]
import tls from "node:tls";
import { connect, describe } from "./env.mjs";

const branch = process.argv[2] ?? "dev";
let failed = false;
// Driver messages can carry host or user names, so only the error code or our own message is printed.
const safe = (e) => e.code ?? (e.message.includes("db/local/.env") || e.message.includes("connection string") ? e.message : "connection error");

for (const direct of [false, true]) {
  const label = `${branch} ${direct ? "direct" : "pooled"}`;
  let sql;
  let nameChecked = false;
  try {
    const info = describe(branch, direct);
    sql = connect(branch, {
      direct,
      ssl: { checkServerIdentity: (host, cert) => { const err = tls.checkServerIdentity(host, cert); nameChecked = !err && host.endsWith(".neon.tech"); return err; } },
    });
    const [row] = await sql`select version(), current_database(), now()`;
    console.log(`${label}: ok\n  region ${info.region}; host is ${info.pooled ? "a pooler" : "direct"}\n  ${row.version}\n  database ${row.current_database}; now ${row.now.toISOString()}`);
    console.log(`  certificate checked against the Neon host name: ${nameChecked ? "yes" : "NO"}`);
    if (!nameChecked) failed = true;
    if (info.pooled === direct) { console.log(`  WRONG STRING: ${label} should ${direct ? "not " : ""}be the pooled one`); failed = true; }
  } catch (e) {
    console.log(`${label}: failed (${safe(e)})`);
    failed = true;
    continue;
  } finally {
    await sql?.end({ timeout: 5 });
  }
  // The same connection while trusting only an unrelated authority must be refused, or checking is not really on.
  const wrong = connect(branch, { direct, ssl: { ca: tls.rootCertificates.find((c) => !c.includes("ISRG")) } });
  try {
    await wrong`select 1`;
    console.log("  with an unrelated certificate authority: CONNECTED (certificate checking is off)");
    failed = true;
  } catch (e) {
    console.log(`  with an unrelated certificate authority: refused (${safe(e)})`);
  } finally {
    await wrong.end({ timeout: 5 });
  }
}
process.exit(failed ? 1 : 0);
