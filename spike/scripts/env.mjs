// Loads spike/.dev.vars for local scripts. Values are never printed.
import { readFileSync } from "node:fs";
import dns from "node:dns";
import postgres from "postgres";

// The home router's DNS refuses *.neon.tech database hosts. Inside these scripts only, ask 1.1.1.1 for those names.
// Nothing about the Mac's own settings changes.
const publicDns = new dns.Resolver();
publicDns.setServers(["1.1.1.1", "1.0.0.1"]);
const systemLookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "object" ? options : {};
  if (!String(host).endsWith(".neon.tech")) return systemLookup(host, options, callback);
  publicDns.resolve4(host, (err, ips) => {
    if (err) return cb(err);
    if (opts.all) return cb(null, ips.map((address) => ({ address, family: 4 })));
    cb(null, ips[0], 4);
  });
};

export const SPIKE_DIR = new URL("..", import.meta.url);

export function vars() {
  const text = readFileSync(new URL(".dev.vars", SPIKE_DIR), "utf8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  }));
}

/** The direct (non-pooler) Neon address: what Hyperdrive wants. */
export function directUrl() {
  const u = new URL(vars().NEON_URL);
  u.hostname = u.hostname.replace("-pooler.", ".");
  u.searchParams.delete("channel_binding");
  return u.toString();
}

export const db = () => postgres(directUrl(), { max: 1, onnotice: () => {} });
