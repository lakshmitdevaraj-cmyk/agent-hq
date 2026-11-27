// Test harness only: lets Node load the app's lib/ files directly. They use extensionless relative imports
// ("./blobs"), which esbuild (the Netlify build) resolves but Node's own loader does not; this adds ".ts" when the
// plain name is not found. Must be imported before anything that pulls in lib/ files (new-path.mjs imports it).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (e) {
      if (e?.code === "ERR_MODULE_NOT_FOUND" && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});
