// The app's one Postgres client (R8). Netlify Functions keep a module alive between calls, so the client is made
// once per function instance and reused. Nothing here prints or returns the connection string.
//
// Certificate checking: postgres.js turns it OFF when the string says `sslmode=require` (as Neon's do). Passing
// `ssl` here overrides the string, so the server's certificate and host name are always checked.
//
// Timeouts: Neon's pooler ignores `statement_timeout` sent when connecting (checked 27 Nov 2026), so it is set
// per transaction (`withTx`) and single queries are cancelled from this side (`timed`).
import postgres from "postgres";
import tls from "node:tls";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** Seconds to wait for a connection. */
export const CONNECT_TIMEOUT_S = 5;
/** Milliseconds a query or transaction statement may run. */
export const QUERY_TIMEOUT_MS = 8000;

/** The TLS settings every connection uses. Exported so the test can prove they refuse a bad certificate. */
export const TLS_OPTIONS = Object.freeze({ rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity });

/** Options for every client. Kept separate from `db()` so a test can point it at a fake server. */
export function clientOptions(): postgres.Options<Record<string, postgres.PostgresType>> {
  return {
    max: 2,                      // one function instance serves one request at a time; 2 leaves room for a cancel
    prepare: false,              // Neon's pooler runs in transaction mode, where prepared statements don't carry over
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    connect_timeout: CONNECT_TIMEOUT_S,
    onnotice: () => {},
    ssl: { ...TLS_OPTIONS },
  };
}

function checkedUrl(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL is not set");
  // A bad value must not be echoed back in an error, so it is checked here instead of by the driver.
  if (!/^postgres(ql)?:\/\//.test(raw) || !URL.canParse(raw)) throw new Error("DATABASE_URL does not look like a postgres:// connection string");
  return raw;
}

let client: Sql | null = null;

/** The shared client, made on first use from `DATABASE_URL`. */
export function db(): Sql {
  if (!client) {
    const url = checkedUrl(process.env.DATABASE_URL);
    client = postgres(url, clientOptions());
  }
  return client;
}

/** Runs one query and cancels it if it takes longer than `ms`. The error then has code 57014. */
export async function timed<T>(query: postgres.PendingQuery<postgres.Row[]> & Promise<T>, ms = QUERY_TIMEOUT_MS): Promise<T> {
  const timer = setTimeout(() => { void query.cancel(); }, ms);
  try {
    return await query;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fn` in one transaction; any throw rolls it back. Each statement inside may run for `timeoutMs`. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, { timeoutMs = QUERY_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<T> {
  const ms = Math.max(1, Math.floor(timeoutMs));
  return (await db().begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${ms}`);
    return fn(tx);
  })) as T;
}

/** Closes the shared client (tests and scripts only). */
export async function closeDb(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.end({ timeout: 5 });
}
