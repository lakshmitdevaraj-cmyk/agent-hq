// The small router: five paths plus a floor, real SQL, nothing from command.ts.
import { connect, type Sql } from "./db";
import { campaignGet } from "./campaign";
import { webhook, click } from "./events";
import { send } from "./send";
import { listA, listB, listC } from "./prospects";
import { installStubs } from "../../whole-app/src/stubs";
import { als, type Ctx } from "../../whole-app/src/context";

installStubs(); // every outside service is faked; unknown hosts throw

export type Env = { HYPERDRIVE: { connectionString: string }; SPIKE_TOKEN: string };

const json = (v: unknown, status = 200) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
let isCold = true;

async function identify(sql: Sql, ds: string, key: string | null): Promise<{ agent_id: string | null } | null> {
  if (!key) return null;
  const [r] = await sql`select name, data from spike.s75_settings where ds = ${ds} and ((name = 'api-key' and data->>'key' = ${key}) or name = ${`agent-key-${key}`}) limit 1`;
  return r ? { agent_id: r.name === "api-key" ? null : (r.data.agent_id as string) } : null;
}

async function route(req: Request, url: URL, sql: Sql, ds: string): Promise<Response> {
  const variant = (req.headers.get("x-spike-variant") ?? "a") as "a" | "b" | "c";
  const headers = Object.fromEntries([...req.headers].filter(([k]) => !k.startsWith("x-spike-") && k !== "x-api-key"));

  if (url.pathname.startsWith("/t/")) {
    const r = await click(sql, ds, url.pathname.slice(3), headers, variant === "b" ? "b" : "a");
    return new Response(r.body ?? "", { status: r.status, headers: r.location ? { Location: r.location, "Cache-Control": "no-cache" } : {} });
  }
  if (url.pathname.startsWith("/api/webhook/")) {
    const r = await webhook(sql, ds, url.pathname.slice("/api/webhook/".length), await req.json(), headers, variant === "b" ? "b" : "a");
    return typeof r.body === "string" ? new Response(r.body, { status: r.status }) : json(r.body, r.status);
  }
  if (url.pathname !== "/api/command") return json({ error: "no route" }, 404);

  const { action, params = {} } = (await req.json()) as { action?: string; params?: Record<string, any> };
  const identity = await identify(sql, ds, req.headers.get("x-api-key"));
  if (!identity) return json({ ok: false, error: "Invalid or missing X-API-Key" }, 401);

  switch (action) {
    case "spike.floor": {
      const [r] = await sql`select count(*)::int as n from spike.s75_campaigns where ds = ${ds}`;
      return json({ ok: true, data: { campaigns: r.n } });
    }
    case "outreach.campaign.get": {
      const c = await campaignGet(sql, ds, String(params.id ?? ""));
      return c ? json({ ok: true, data: c }) : json({ ok: false, error: "campaign not found" }, 404);
    }
    case "outreach.prospects.list": {
      if (variant === "b") return json(await listB(sql, ds));
      if (variant === "c") return json({ ok: true, data: await listC(sql, ds, Number(params.page ?? 1), String(params.q ?? "")) });
      return json({ ok: true, data: await listA(sql, ds) });
    }
    case "outreach.emails.send": {
      const r = await send(sql, ds, params, `${url.protocol}//${url.host}`, identity.agent_id);
      return json(r.body, r.status);
    }
    default:
      return json({ ok: false, error: "unknown action" }, 400);
  }
}

export default {
  async fetch(req: Request, env: Env, exec: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    // Every route, the public-looking ones too, needs the spike token.
    if (!env.SPIKE_TOKEN || req.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return json({ error: "no" }, 401);
    const cold = isCold;
    isCold = false;
    const url = new URL(req.url);
    const ds = req.headers.get("x-spike-ds") ?? "d500";
    const sql = connect(env.HYPERDRIVE.connectionString);
    const c = { outbound: {} } as Ctx;
    let res: Response;
    try {
      res = await als.run(c, () => route(req, url, sql, ds));
    } catch (e) {
      res = json({ spike_uncaught: String((e as Error)?.message ?? e) }, 500);
    }
    exec.waitUntil(sql.end({ timeout: 5 }));
    res = new Response(res.body, res);
    res.headers.set("x-spike-stats", JSON.stringify({ cold, outbound: c.outbound }));
    return res;
  },
};
