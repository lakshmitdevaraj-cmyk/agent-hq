// Local smoke test: no token → 401 on every kind of route; an unknown outside host is refused.
import { writeFileSync } from "node:fs";
import router from "../src/router";
import { als, type Ctx } from "../../whole-app/src/context";

const env = { HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/none" }, SPIKE_TOKEN: "t" };
const lines: string[] = [];
for (const [method, path] of [["POST", "/api/command"], ["POST", "/api/webhook/hook1"], ["GET", "/t/abc"]]) {
  for (const token of [null, "wrong"]) {
    const r = await router.fetch(new Request(`https://x.example.test${path}`, { method, headers: token ? { "x-spike-token": token } : {} }), env, { waitUntil() {} });
    lines.push(`${method} ${path} ${token ? "wrong token" : "no token"} ${r.status}`);
  }
}
for (const url of ["https://example.com/", "https://api.brevo.com/x"]) {
  try { await als.run({ outbound: {} } as Ctx, () => fetch(url)); lines.push(`${url} ALLOWED`); }
  catch (e) { lines.push(`${url} ${(e as Error).message}`); }
}
writeFileSync("results/smoke.txt", lines.join("\n") + "\n");
console.log(lines.join("\n"));
