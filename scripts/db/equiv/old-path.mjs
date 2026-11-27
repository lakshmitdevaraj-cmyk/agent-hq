// R13 old path: runs the real netlify/functions/command.ts handler, bundled in memory by esbuild, with
//   - @netlify/blobs swapped for fake-blobs.mjs (the P1 export, read only; writes stay in memory), and
//   - ALL network access blocked: global fetch, and http/https/http2/net/tls/dgram/child_process imports, throw.
// So the old code can never reach Gemini, AgentMail or Apify.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBlobs } from "./fake-blobs.mjs";

const ENTRY = fileURLToPath(new URL("../../../netlify/functions/command.ts", import.meta.url));
/** The key the harness signs in with. It exists only in memory, in the fake config store. */
export const TEST_KEY = "equiv-test-key-not-real";

export class NetworkBlocked extends Error {
  constructor(what) { super(`equivalence harness: network access is blocked (${what})`); this.name = "NetworkBlocked"; this.code = "EQUIV_NETWORK_BLOCKED"; }
}

/** Every refused attempt, for tests: [{ what, target }]. */
export const blockedCalls = [];
const refuse = (what, target) => { blockedCalls.push({ what, target: String(target ?? "").slice(0, 120) }); throw new NetworkBlocked(what); };

const NET_MODULES = ["http", "https", "http2", "net", "tls", "dgram", "child_process", "undici"];
const STUB = `
const refuse = (what) => (...args) => globalThis.__equivNet.refuse(what, typeof args[0] === "string" ? args[0] : args[0]?.host ?? args[0]?.hostname ?? "");
const handler = { get: (_, p) => (p === "__esModule" ? false : refuse(String(p))) };
const mod = new Proxy({}, handler);
export default mod;
export const request = refuse("request"), get = refuse("get"), connect = refuse("connect"), createConnection = refuse("createConnection"),
  Agent = function () { refuse("Agent")(); }, fetch = refuse("fetch"), spawn = refuse("spawn"), exec = refuse("exec"), execFile = refuse("execFile"),
  createSocket = refuse("createSocket");
`;

/**
 * `allowDb`: let net and tls through (the postgres driver's socket) and keep everything else blocked: fetch,
 * http/https/http2, dgram, child_process, undici. Gemini, AgentMail and Apify are reached through fetch or https,
 * so they stay refused. Used only to run the SQL route of the handler end to end on dev.
 */
const makePlugin = (allowDb = false) => {
  const blocked = allowDb ? NET_MODULES.filter((m) => m !== "net" && m !== "tls") : NET_MODULES;
  return {
    name: "equiv-old-path",
    setup(b) {
      b.onResolve({ filter: /^@netlify\/blobs$/ }, () => ({ path: "blobs", namespace: "equiv" }));
      b.onResolve({ filter: new RegExp(`^(node:)?(${blocked.join("|")})$`) }, (a) => ({ path: `net:${a.path}`, namespace: "equiv" }));
      b.onLoad({ filter: /.*/, namespace: "equiv" }, (a) => ({
        contents: a.path === "blobs"
          ? "export const getStore = (...a) => globalThis.__equivBlobs.getStore(...a); export const connectLambda = () => {};"
          : STUB,
        loader: "js",
      }));
    },
  };
};
const plugin = makePlugin(false);

const bundled = new Map();
/** What the bundle was built from (esbuild metafile inputs), so a test can see every network import went to the stub. */
export const bundleInputs = [];
/**
 * Bundles command.ts: the working tree by default, or the file as it was at git commit `commit` (read with
 * `git show`, never written to disk; its imports resolve against today's netlify/functions folder).
 */
async function loadHandler(commit = null, allowDb = false) {
  const key = `${commit ?? "working-tree"}${allowDb ? "+db" : ""}`;
  if (!bundled.has(key)) {
    const source = commit
      ? { stdin: { contents: execFileSync("git", ["show", `${commit}:netlify/functions/command.ts`], { cwd: dirname(ENTRY), encoding: "utf8" }), resolveDir: dirname(ENTRY), sourcefile: "command.ts", loader: "ts" } }
      : { entryPoints: [ENTRY] };
    const out = await build({ ...source, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", metafile: true, plugins: [makePlugin(allowDb)] });
    if (!commit && !allowDb) bundleInputs.push(...Object.keys(out.metafile.inputs));
    bundled.set(key, import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`).then((m) => m.handler));
  }
  return bundled.get(key);
}

/** Builds a one-line module that imports `spec` through the same plugin and calls `call` on it (tests only). */
export async function probeImport(spec, call) {
  const out = await build({ stdin: { contents: `import m from ${JSON.stringify(spec)}; export const run = () => m.${call}({ host: "example.com" });`, resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [plugin] });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

/**
 * The fetch every old-path bundle sees. `routes(url, init)` may answer a request with a Response (made-up Apify or
 * website answers, for tests); anything it does not answer is refused, as before.
 */
function installFetch(routes) {
  globalThis.__equivNet = { refuse };
  globalThis.fetch = async (input, init) => { // async, like the real fetch
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const hit = routes ? await routes(url, init) : undefined;
    if (hit) return hit;
    return refuse("fetch", url);
  };
}

/**
 * Opens the old path on an export folder, with fresh in-memory stores each time. From here on, global fetch
 * refuses every call in this process (the new path uses postgres sockets, not fetch) unless `fetchRoutes` answers
 * it. `commit` bundles command.ts as it was at that commit (for the "switch unset = old behaviour" proof);
 * `allowDb` see makePlugin; `seed` adds records to the in-memory stores (e.g. a made-up Apify key).
 */
export async function openOld(exportDir, { commit = null, allowDb = false, fetchRoutes = null, seed = {} } = {}) {
  installFetch(fetchRoutes);
  const config = { "agent-hq-config": { "api-key": { key: TEST_KEY, created_at: "2026-11-27T00:00:00Z" } } };
  const blobs = fakeBlobs(exportDir, { ...seed, ...config });
  globalThis.__equivBlobs = blobs;
  const handler = await loadHandler(commit, allowDb);
  return {
    blobs,
    /** Calls one action the way the app does; returns { status, body }. */
    async call(action, params = {}) {
      globalThis.__equivBlobs = blobs; // several old paths can be open at once; each call uses its own stores
      installFetch(fetchRoutes);
      const res = await handler({ httpMethod: "POST", headers: { "x-api-key": TEST_KEY }, body: JSON.stringify({ action, params }) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    },
  };
}

/**
 * The given functions that are private to command.ts (working tree), from an in-memory bundle of the file plus one
 * `export { … }` line; the file on disk is not touched. Same network block; `fetchRoutes` as in openOld. Used to
 * give the SQL versions the very same Apify, site-check and lead-shaping code as deps.
 */
export async function openPrivates(names, { fetchRoutes = null, exportDir = null } = {}) {
  installFetch(fetchRoutes);
  if (exportDir) globalThis.__equivBlobs = fakeBlobs(exportDir, {});
  const contents = `${readFileSync(ENTRY, "utf8")}\nexport { ${names.join(", ")} };\n`;
  const out = await build({ stdin: { contents, resolveDir: dirname(ENTRY), sourcefile: "command.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [plugin] });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  return { ...Object.fromEntries(names.map((n) => [n, mod[n]])), setRoutes: (r) => installFetch(r) };
}
