// R13 new path: runs an action's SQL version on Neon dev through the app's own client (lib/db/client.ts),
// with certificate checking on. Every call runs inside a transaction that is always rolled back.
import { localVar } from "../env.mjs"; // DNS workaround for *.neon.tech, scripts only
import { db, closeDb } from "../../../netlify/functions/lib/db/client.ts";

const ROLLBACK = Symbol("rollback");

export function openNew(branch = "dev") {
  if (branch !== "dev") throw new Error("the equivalence harness runs on dev only");
  process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
  async function run(version, params, readOnly) {
    let result;
    try {
      await db().begin(async (tx) => { if (readOnly) await tx`set transaction read only`; result = await version(tx, params); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return result;
  }
  return {
    /** Runs `version(tx, params)` in a read-only transaction that is rolled back, and returns what it returned. */
    call: (version, params = {}) => run(version, params, true),
    /** The same for a write: `version` may change rows, and every change is rolled back. */
    callWrite: (version, params = {}) => run(version, params, false),
    close: closeDb,
  };
}
