// Alcance spike Worker. Every route needs the x-spike-token header. No route takes a recipient or a free URL.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import postgres from "postgres";
import { fetchSite, parsePages, fingerprint, unpackPages, VARIANTS, SITE_CHECK_PATHS } from "../lib/analyze";
import { SITES } from "../lib/sites";
import { prospects, followups, campaignPage, type ProspectFilter } from "./queries";

type Env = {
  HYPERDRIVE: Hyperdrive; QUEUE: Queue<{ run: string; n: number }>; WF: Workflow;
  SPIKE_TOKEN: string; AGENTMAIL_KEY: string; AGENTMAIL_INBOX: string; TEST_TO: string; DRY_RUN?: string;
};

// Synthetic site (no real website involved): used to see which handlers are allowed more than 10 ms of CPU.
function synthPages(kchars: number) {
  const block = '<div class="svc"><a href="/contact">Request service</a><p>Family owned heating and air since 1998. Call (555) 010-2000 or email office@synthetic.test. Open Mon - Fri 8am - 5pm.</p><script>var a={"k":"v"};</script></div>\n';
  const body = block.repeat(Math.ceil((kchars * 1024) / 3 / block.length));
  return ["", "contact", "about"].map((p) => ({ url: `https://synthetic.test/${p}`, html: `<html><head><title>Synthetic Air</title></head><body>${body}</body></html>` }));
}
const burn = (kchars: number) => fingerprint(parsePages("synthetic.test", synthPages(kchars))).gap_score;

const connect = (env: Env) => postgres(env.HYPERDRIVE.connectionString, { max: 3, fetch_types: false, onnotice: () => {} });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.SPIKE_TOKEN || req.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return json({ error: "no" }, 401);
    const url = new URL(req.url);
    const q = url.searchParams;
    const started = Date.now();
    try {
      switch (url.pathname) {
        // Test A: fetch one of the 20 listed sites and parse it.
        case "/site": {
          const host = q.get("host") ?? "";
          if (!SITES.includes(host)) return json({ error: "unknown site" }, 400);
          const pages = await fetchSite(host, SITE_CHECK_PATHS);
          if (!pages.length) return json({ host, loaded: false });
          const bytes = pages.reduce((s, p) => s + p.html.length, 0);
          return json({ host, loaded: true, pages: pages.length, kchars: Math.round(bytes / 1024), fp: fingerprint(parsePages(host, pages)) });
        }
        // Test A variants: parse HTML sent by the test machine, so the prospects' websites are not visited again.
        case "/parse": {
          const host = q.get("host") ?? "";
          const variant = VARIANTS[q.get("variant") ?? "full"];
          const pages = unpackPages(await req.text()).map(variant);
          return json({ host, pages: pages.length, fp: pages.length ? fingerprint(parsePages(host, pages)) : null });
        }
        // Test B
        case "/queue/start": {
          const run = env.DRY_RUN ? "dry" : "real"; // one real run ever: at most 10 emails can leave
          const sql = connect(env);
          const [{ n }] = await sql`select count(*)::int as n from spike.send_status where run_id = ${run}`;
          if (n > 0) return json({ error: `run '${run}' already queued`, n }, 409);
          for (let i = 1; i <= 10; i++) await sql`insert into spike.send_status (run_id, n, status) values (${run}, ${i}, 'queued')`;
          await env.QUEUE.sendBatch(Array.from({ length: 10 }, (_, i) => ({ body: { run, n: i + 1 } })));
          ctx.waitUntil(sql.end());
          return json({ run, queued: 10 });
        }
        case "/queue/status": {
          const sql = connect(env);
          const rows = await sql`select n, status, http_status, detail, queued_at, done_at from spike.send_status where run_id = ${q.get("run") ?? "real"} order by n`;
          return json({ rows });
        }
        case "/limit": {
          let ok = 0;
          try {
            for (let i = 0; i < 60; i++) { const r = await fetch(`https://example.com/?i=${i}`); await r.body?.cancel(); ok++; }
            return json({ ok, failed: false });
          } catch (e) {
            return json({ ok, failed: true, error: String((e as Error).message) });
          }
        }
        // CPU allowance by handler type (synthetic pages only)
        case "/load/http":
          return json({ ok: true, gap: burn(Number(q.get("kb") ?? 600)) });
        case "/load/queue": {
          const kb = Number(q.get("kb") ?? 600), n = Math.min(60, Number(q.get("n") ?? 40));
          for (let i = 0; i < n; i += 20) await env.QUEUE.sendBatch(Array.from({ length: Math.min(20, n - i) }, (_, j) => ({ body: { run: "cpu", n: i + j, kb } })));
          return json({ queued: n, kb });
        }
        case "/load/workflow": {
          const id = `cpu-${Date.now()}`;
          await env.WF.create({ id, params: { kb: Number(q.get("kb") ?? 600), steps: Math.min(40, Number(q.get("n") ?? 40)) } });
          return json({ id });
        }
        case "/load/workflow-status":
          return json(await (await env.WF.get(q.get("id") ?? "")).status());
        // Test C
        case "/q/prospects":
        case "/q/followups":
        case "/q/campaign": {
          const sql = connect(env);
          const t0 = Date.now();
          const [row] = url.pathname === "/q/prospects" ? await prospects(sql, (q.get("filter") ?? "emailed_no_reply") as ProspectFilter)
            : url.pathname === "/q/followups" ? await followups(sql)
            : await campaignPage(sql, q.get("id") ?? "c1");
          const dbMs = Date.now() - t0;
          ctx.waitUntil(sql.end());
          return new Response(row.json as string, { headers: { "Content-Type": "application/json", "x-rows": String(row.n), "x-db-ms": String(dbMs), "x-worker-ms": String(Date.now() - started), "x-queries": "1" } });
        }
        // Test D
        case "/workflow/start": {
          const id = `run-${Date.now()}`;
          await env.WF.create({ id, params: {} });
          return json({ id });
        }
        case "/workflow/status": {
          const id = q.get("id") ?? "";
          const sql = connect(env);
          const steps = await sql`select step, source, started_at, finished_at from spike.workflow_steps where run_id = ${id} order by step`;
          const inst = await env.WF.get(id).then((i) => i.status()).catch((e) => ({ status: "unknown", error: String(e) }));
          return json({ steps, instance: inst });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: String((e as Error).message).slice(0, 300) }, 500);
    }
  },

  // Test B: one message = one invocation = one email. No retries, and a row must be claimed first, so nothing is sent twice.
  async queue(batch: MessageBatch<{ run: string; n: number; kb?: number }>, env: Env): Promise<void> {
    if (batch.messages.every((m) => m.body.run === "cpu")) {
      for (const m of batch.messages) { burn(m.body.kb ?? 600); m.ack(); }
      return;
    }
    const sql = connect(env);
    for (const m of batch.messages) {
      const { run, n } = m.body;
      const claimed = await sql`update spike.send_status set status = 'sending' where run_id = ${run} and n = ${n} and status = 'queued' returning n`;
      if (claimed.length) {
        try {
          let http = 0;
          let detail = "dry run: nothing sent";
          if (!env.DRY_RUN && run === "real") {
            const r = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(env.AGENTMAIL_INBOX)}/messages/send`, {
              method: "POST",
              headers: { Authorization: `Bearer ${env.AGENTMAIL_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ to: [env.TEST_TO], subject: `[SPIKE TEST] ${n}/10`, text: `Spike test message ${n} of 10 from the Cloudflare Queue test. Nothing to do.` }),
            });
            http = r.status;
            detail = r.ok ? "accepted" : `rejected: ${(await r.text()).slice(0, 120)}`.split(env.TEST_TO).join("[recipient]");
          }
          await sql`update spike.send_status set status = ${http === 0 || (http >= 200 && http < 300) ? "sent" : "failed"}, http_status = ${http}, detail = ${detail}, done_at = now() where run_id = ${run} and n = ${n}`;
        } catch (e) {
          await sql`update spike.send_status set status = 'failed', detail = ${String((e as Error).message).slice(0, 120)}, done_at = now() where run_id = ${run} and n = ${n}`;
        }
      }
      m.ack();
    }
    await sql.end();
  },
};

// Test D: 10 steps, each waits ~20 s (stand-in for a Gemini call) and writes one row.
export class SpikeWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const run = event.instanceId;
    const load = event.payload as { kb?: number; steps?: number };
    if (load?.kb) {
      let ok = 0;
      for (let i = 1; i <= (load.steps ?? 40); i++) ok += await step.do(`parse ${i}`, { retries: { limit: 0, delay: 1000 } }, async () => { burn(load.kb!); return 1; });
      return `parsed ${ok}`;
    }
    for (let i = 1; i <= 10; i++) {
      await step.do(`step ${i}`, { retries: { limit: 1, delay: "5 seconds" }, timeout: "2 minutes" }, async () => {
        const startedAt = new Date();
        let source = "httpbin";
        const r = await fetch("https://httpbin.org/delay/20").catch(() => null);
        if (!r?.ok) { source = `timer (httpbin ${r?.status ?? "unreachable"})`; await scheduler.wait(20_000); }
        await r?.body?.cancel();
        const sql = connect(this.env);
        await sql`insert into spike.workflow_steps values (${run}, ${i}, ${source}, ${startedAt}, now()) on conflict do nothing`;
        await sql.end();
        return source;
      });
    }
    return "done";
  }
}
