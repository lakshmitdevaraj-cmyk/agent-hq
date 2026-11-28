// P2 chunk 11: the activity log on Postgres (activity.log, activity.list; used when DATA_BACKEND=sql, the Blobs code in
// command.ts stays the default until P5). Same answers as today; intended differences (listed in
// scripts/db/test/chunk11-equiv.test.mjs):
//   - F1: activity.log answers {logged: true, id} and activity.list reads it straight back.
//   - Limits: category up to 40 characters, summary up to 500, details a JSON object up to 10 KB (400 otherwise).
//   - The agent comes from the key (deps.agentId) first, then from the params.
//   - activity.list takes an optional `category` and an optional `before` (ISO time) for paging; newest first
//     (created_at, then id), limit default 100, at most 500.
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export type ActivityAction = "activity.log" | "activity.list";
export const ACTIVITY_ACTIONS: ActivityAction[] = ["activity.log", "activity.list"];
export type ActivityDeps = { newId: () => string; agentId?: string | null };

const fail = (status: number, message: string): never => { throw new CampaignError(status, message); };
const iso = (v: unknown): string | null => (typeof v === "string" ? new Date(v).toISOString() : v instanceof Date ? v.toISOString() : null);
const MAX_DETAILS = 10 * 1024;

export async function runActivityAction(q: Q, action: ActivityAction, p: Record<string, unknown>, deps: ActivityDeps): Promise<unknown> {
  switch (action) {
    case "activity.log": {
      const category = p.category, summary = p.summary;
      if (!category || !summary || typeof category !== "string" || typeof summary !== "string") return fail(400, "category and summary required");
      if (category.length > 40) return fail(400, "category is too long (40 characters at most)");
      if (summary.length > 500) return fail(400, "summary is too long (500 characters at most)");
      let details: Record<string, unknown> | null = null;
      if (p.details !== undefined && p.details !== null) {
        if (typeof p.details !== "object" || Array.isArray(p.details)) return fail(400, "details must be a JSON object");
        if (Buffer.byteLength(JSON.stringify(p.details)) > MAX_DETAILS) return fail(400, "details is too large (10 KB at most)");
        details = p.details as Record<string, unknown>;
      }
      const agentId = deps.agentId ?? (typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null);
      const id = deps.newId();
      await q`insert into activity (id, blob_key, agent_id, category, summary, details, created_at, data)
              values (${id}, ${id}, ${agentId}, ${category}, ${summary}, ${details === null ? null : q.json(details as never)}, now(), '{}')`;
      return { logged: true, id };
    }
    case "activity.list": {
      const lim = Number(p.limit ?? 100);
      const limit = Number.isFinite(lim) ? Math.max(1, Math.min(500, Math.floor(lim))) : 100;
      const category = typeof p.category === "string" && p.category ? p.category : null;
      let before: string | null = null;
      if (p.before !== undefined && p.before !== null && p.before !== "") {
        const t = typeof p.before === "string" ? Date.parse(p.before) : NaN;
        if (!Number.isFinite(t)) return fail(400, "before must be an ISO time");
        before = new Date(t).toISOString();
      }
      const rows = await q`select id, created_at, agent_id, category, summary, details from activity
        where (${category}::text is null or category = ${category}::text)
          and (${before}::timestamptz is null or created_at < ${before}::timestamptz)
        order by created_at desc, id desc
        limit ${limit}`;
      return (rows as unknown as Row[]).map((r) => ({ id: r.id, created_at: iso(r.created_at), agent_id: r.agent_id ?? null, category: r.category, summary: r.summary, details: r.details ?? null }));
    }
  }
}
