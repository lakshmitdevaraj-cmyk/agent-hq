// R13 new path: runs an action's SQL version on Neon dev through the app's own client (lib/db/client.ts),
// with certificate checking on. Every call runs inside a transaction that is always rolled back.
import "./ts-ext.mjs"; // lets the lib/sql modules load the app's lib/ files (extensionless imports)
import { localVar } from "../env.mjs"; // DNS workaround for *.neon.tech, scripts only
import postgres from "postgres";
import { clientOptions, closeDb } from "../../../netlify/functions/lib/db/client.ts";

const ROLLBACK = Symbol("rollback");

/**
 * The harness has its own pool (the app's options, certificate checking on), 8 connections by default instead of the app's
 * 2, so a test can run independent calls side by side (`pmap`); each call is still its own rolled-back transaction.
 */
export function openNew(branch = "dev", { max = Number(process.env.EQUIV_POOL) || 8 } = {}) {
  if (branch !== "dev") throw new Error("the equivalence harness runs on dev only");
  process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
  let pool = null;
  // connect_timeout 30 s: several connections opened at once from India can take longer than the app's 5 s (the app opens one or two).
  const db = () => (pool ??= postgres(process.env.DATABASE_URL, { ...clientOptions(), max, connect_timeout: 30 }));
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
    close: async () => { const p = pool; pool = null; if (p) await p.end({ timeout: 5 }); await closeDb(); }, // the app's own pool too, if a test used it
  };
}

/** Runs `fn` over `items` with at most `limit` at a time; results in the order of `items`. */
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
