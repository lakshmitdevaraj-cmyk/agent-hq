// The whole Alcance API as one Worker: Request -> Netlify Handler event -> the real, unchanged handlers.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import postgres from "postgres";
import { als, type Ctx } from "./context";
import { installStubs } from "./stubs";
import { handler as command } from "../../../netlify/functions/command";
import { handler as webhookReceive } from "../../../netlify/functions/webhook-receive";
import { handler as pageServe } from "../../../netlify/functions/page-serve";
import { handler as trackClick } from "../../../netlify/functions/track-click";
import { handler as formSubmit } from "../../../netlify/functions/form-submit";
import { handler as aiBackground } from "../../../netlify/functions/ai-background";

installStubs();

type Env = { HYPERDRIVE: Hyperdrive; WF: Workflow; SPIKE_TOKEN: string };
type Handler = (event: any, context: any) => Promise<any>;

// Same routing as netlify.toml, plus the background function the app calls directly.
const ROUTES: Array<[RegExp, Handler, string]> = [
  [/^\/(api\/command|\.netlify\/functions\/command)$/, command as Handler, "command"],
  [/^\/(api\/webhook|\.netlify\/functions\/webhook-receive)\//, webhookReceive as Handler, "webhook-receive"],
  [/^\/(p|\.netlify\/functions\/page-serve)\//, pageServe as Handler, "page-serve"],
  [/^\/(t|\.netlify\/functions\/track-click)\//, trackClick as Handler, "track-click"],
  [/^\/(api\/form|\.netlify\/functions\/form-submit)\//, formSubmit as Handler, "form-submit"],
  [/^\/\.netlify\/functions\/ai-background$/, aiBackground as Handler, "ai-background"],
];

let isCold = true;

async function toEvent(req: Request, url: URL) {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (!k.startsWith("x-spike-")) headers[k] = v; });
  headers["x-forwarded-proto"] = url.protocol.replace(":", "");
  headers["x-forwarded-host"] = url.host;
  headers["host"] = url.host;
  const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "rid"));
  return {
    httpMethod: req.method, path: url.pathname, rawUrl: url.toString(), rawQuery: new URLSearchParams(query).toString(),
    headers, multiValueHeaders: {}, queryStringParameters: query, multiValueQueryStringParameters: {},
    body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(), isBase64Encoded: false,
  };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    if (!env.SPIKE_TOKEN || req.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return json({ error: "no" }, 401);
    const cold = isCold;
    isCold = false;
    const url = new URL(req.url);

    // Test I: a real network wait made by a timer, not CPU.
    if (url.pathname === "/slow") {
      const s = Math.min(90, Math.max(0, Number(url.searchParams.get("s") ?? 30)));
      const t = Date.now();
      await new Promise((r) => setTimeout(r, s * 1000));
      return json({ asked_s: s, waited_ms: Date.now() - t });
    }
    if (url.pathname === "/wf/start") {
      const s = Number(url.searchParams.get("s") ?? 30);
      const instance = await env.WF.create({ id: `wait-${s}-${Date.now()}`, params: { url: `${url.origin}/slow?s=${s}`, token: env.SPIKE_TOKEN } });
      return json({ id: instance.id });
    }
    if (url.pathname === "/wf/status") return json(await (await env.WF.get(url.searchParams.get("id") ?? "")).status());

    const route = ROUTES.find(([re]) => re.test(url.pathname));
    if (!route) return json({ error: "no route" }, 404);

    let sql: ReturnType<typeof postgres> | null = null;
    const c: Ctx = {
      sql: () => (sql ??= postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, onnotice: () => {} })),
      ns: req.headers.get("x-spike-ns") ?? "d25",
      mode: req.headers.get("x-spike-mode") === "literal" ? "literal" : "batched",
      cache: new Map(), listed: new Map(), queries: 0, rows: 0, outbound: {},
    };
    const started = Date.now();
    let result: { statusCode: number; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean };
    try {
      result = await als.run(c, async () => route[1](await toEvent(req, url), {}));
    } catch (e) {
      result = { statusCode: 599, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spike_uncaught: String((e as Error)?.message ?? e) }) };
    }
    if (sql) exec.waitUntil((sql as ReturnType<typeof postgres>).end({ timeout: 5 }));

    const headers = new Headers(result.headers ?? {});
    headers.set("x-spike-stats", JSON.stringify({ handler: route[2], cold, queries: c.queries, rows: c.rows, outbound: c.outbound, ms: Date.now() - started }));
    const status = result.statusCode;
    const body = status === 204 || status === 304 ? null : result.isBase64Encoded ? Uint8Array.from(atob(result.body ?? ""), (ch) => ch.charCodeAt(0)) : (result.body ?? "");
    return new Response(body, { status: status === 599 ? 500 : status, headers });
  },
};

export class WaitWorkflow extends WorkflowEntrypoint<Env, { url: string; token: string }> {
  async run(event: WorkflowEvent<{ url: string; token: string }>, step: WorkflowStep) {
    return await step.do("long-wait", { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" }, async () => {
      const t = Date.now();
      const r = await fetch(event.payload.url, { headers: { "x-spike-token": event.payload.token } });
      const text = await r.text();
      return { status: r.status, wall_ms: Date.now() - t, body: text.slice(0, 200) };
    });
  }
}
