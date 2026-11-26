// Bundles rules.ts in memory with the esbuild that Vite already installs, and imports it.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function loadRules() {
  const out = await build({ entryPoints: [fileURLToPath(new URL("rules.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
