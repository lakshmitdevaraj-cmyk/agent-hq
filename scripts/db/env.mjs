// Loads db/local/.env (git-ignored) and opens a Postgres client. Connection strings are never printed or logged.
import { readFileSync } from "node:fs";
import dns from "node:dns";
import tls from "node:tls";
import postgres from "postgres";

// Workaround for one network: the home router's DNS refuses Neon database host names (as in the spike scripts).
// Inside these scripts only, ask 1.1.1.1 (then 8.8.8.8) for *.neon.tech. No Mac setting changes. TLS still gets the real
// host name, so the certificate is checked against it. Harmless where DNS already works.
const publicDns = new dns.Resolver({ timeout: 5000, tries: 2 });
publicDns.setServers(["1.1.1.1", "8.8.8.8"]);
const systemLookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  if (!String(host).endsWith(".neon.tech")) return systemLookup(host, options, callback);
  publicDns.resolve4(host, (err, ips) => {
    if (err) return cb(err);
    if (options?.all) return cb(null, ips.map((address) => ({ address, family: 4 })));
    cb(null, ips[0], 4);
  });
};

const ENV_FILE = new URL("../../db/local/.env", import.meta.url);

function readEnv() {
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** One value from db/local/.env, for scripts that need something other than a connection string. Never print it. */
export const localVar = (name) => readEnv()[name] ?? "";

/** The connection string for a branch ("dev" or "perf"). direct = no pooler (used for migrations and imports). */
function urlFor(branch, direct) {
  const name = `${branch.toUpperCase()}_${direct ? "DIRECT" : "DATABASE"}_URL`;
  const url = readEnv()[name];
  if (!url) throw new Error(`${name} is empty in db/local/.env`);
  // A bad value must not be echoed back, so it is checked here instead of by the driver.
  if (!/^postgres(ql)?:\/\//.test(url) || !URL.canParse(url)) throw new Error(`${name} does not look like a postgres:// connection string`);
  return url;
}

/** Host-derived facts that are safe to print. */
export function describe(branch, direct = true) {
  const host = new URL(urlFor(branch, direct)).hostname;
  return {
    region: /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host)?.[1] ?? "unknown",
    pooled: /-pooler\./.test(host),
  };
}

/**
 * A client with certificate checking ON. The driver turns it off for "sslmode=require" (what Neon's strings say),
 * so `ssl` is set here, which overrides the string. `ssl` can be passed to add checks (see check.mjs).
 */
export function connect(branch = "dev", { direct = true, max = 1, ssl = {} } = {}) {
  return postgres(urlFor(branch, direct), {
    max,
    prepare: direct,
    onnotice: () => {},
    connect_timeout: 20,
    ssl: { checkServerIdentity: tls.checkServerIdentity, ...ssl, rejectUnauthorized: true },
  });
}
