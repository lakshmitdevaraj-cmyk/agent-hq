// The only door to the Netlify CLI. Read-only: blobs:list and blobs:get, nothing else.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localVar } from "./env.mjs";

const TOOLS = join(homedir(), "agent-hq-backups", "tools");
const CLI = join(TOOLS, "node_modules", ".bin", "netlify");
const ALLOWED = new Set(["blobs:list", "blobs:get"]);
const run = promisify(execFile);

// --debug and --auth are left out on purpose: they can print or carry the login token.
const FLAGS = new Set(["--json", "--output", "--region"]);

export function checkArgs(args) {
  if (!ALLOWED.has(args[0])) throw new Error(`refusing "netlify ${args[0]}": only blobs:list and blobs:get are allowed`);
  const flag = args.find((a) => a.startsWith("-") && !FLAGS.has(a));
  if (flag) throw new Error(`refusing the option ${flag}`);
  return args;
}

// The live site's Project ID comes from db/local/.env and is passed by environment, so nothing is linked or changed.
// export-cli.mjs proves it is the right site by matching campaign ids against data.export.
function projectId() {
  const id = localVar("NETLIFY_PROJECT_ID");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("NETLIFY_PROJECT_ID in db/local/.env is missing or not a project ID");
  return id;
}

export async function netlify(args) {
  checkArgs(args);
  const site = projectId();
  try {
    const { stdout } = await run(CLI, args, { cwd: TOOLS, env: { ...process.env, NETLIFY_SITE_ID: site }, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    return stdout;
  } catch (e) {
    // Only the CLI's own error line, with addresses and long strings hidden: output can hold record or account details.
    const why = (String(e.stderr ?? "").split("\n").find((l) => /error/i.test(l)) ?? "").replace(/\S+@\S+/g, "[email]").replace(/(sent|bounced)\/\S+/g, "$1/[hidden]").replace(/[A-Za-z0-9_.-]{32,}/g, "[long]").trim().slice(0, 160);
    throw new Error(`netlify ${args[0]} on ${args[1]} failed (exit ${e.code ?? "?"}) ${why}`);
  }
}

/** `region` is where the site's blobs are held; "" lets the CLI use its default. */
export const withRegion = (args, region) => (region ? [...args, "--region", region] : args);

export async function listKeys(store, region = "") {
  const out = await netlify(withRegion(["blobs:list", store, "--json"], region));
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  return parsed.blobs.map((b) => b.key).sort();
}
