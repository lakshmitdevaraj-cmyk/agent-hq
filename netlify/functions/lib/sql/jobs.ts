// P2 chunk 11: resumable jobs on Postgres (outreach.job.resume, outreach.job.resume_due; used when DATA_BACKEND=sql, the
// Blobs code in command.ts stays the default until P5). A resumable job is a `campaign_jobs` row of kind generate, social
// or review (never `leads` or `browser_check`). Its paused extras (paused_reason, resume_at, resume_params, message,
// resumes, resumed_at) live in `data`. Intended differences (listed in scripts/db/test/chunk11-equiv.test.mjs):
//   - A campaign can have several jobs: resume takes the given kind, or the paused one progressed most recently.
//   - resume is ONE update guarded by status = 'paused', so two clicks cannot both resume it; the second is 409 not_paused.
//   - resume_due is one query over all campaigns, oldest reset time first.
import { CampaignError } from "./campaigns.ts";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export type JobAction = "outreach.job.resume" | "outreach.job.resume_due";
export const JOB_ACTIONS: JobAction[] = ["outreach.job.resume", "outreach.job.resume_due"];
export type JobDeps = { now?: () => Date };

const fail = (status: number, message: string, code?: string): never => { throw new CampaignError(status, message, code ? { code } : undefined); };
// A reset time that is not a date never counts as due (the old Date.parse gave NaN).
const DATE_RE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}";

export async function runJobAction(q: Q, action: JobAction, p: Record<string, unknown>, deps: JobDeps = {}): Promise<unknown> {
  const now = (deps.now ?? (() => new Date()))();
  switch (action) {
    case "outreach.job.resume": {
      const campaignId = p.campaign_id;
      if (typeof campaignId !== "string" || !campaignId) return fail(400, "campaign_id required");
      const kind = typeof p.kind === "string" && p.kind ? p.kind : null;
      const force = p.force === true || p.force === "true" || p.force === 1;
      const [job] = (await q`select kind, data from campaign_jobs
        where campaign_id = ${campaignId} and status = 'paused' and kind not in ('leads', 'browser_check')
          and (${kind}::text is null or kind = ${kind}::text)
        order by coalesce(progress_at, started_at) desc nulls last, kind
        limit 1`) as unknown as Row[];
      if (!job) return fail(409, "There is no paused job to resume.", "not_paused");
      const data = (job.data as Row) ?? {};
      const at = Date.parse(String(data.resume_at ?? ""));
      if (!force && Number.isFinite(at) && at > now.getTime()) return fail(409, "Gemini's limit has not reset yet. Use Resume now to try anyway.", "not_due");
      const stamp = now.toISOString();
      const done = (await q`update campaign_jobs set status = 'running', progress_at = ${stamp}::timestamptz,
          data = (data - 'paused_reason' - 'resume_at' - 'resume_params' - 'message')
                 || jsonb_build_object('resumed_at', ${stamp}::text, 'resumes', coalesce((nullif(data->>'resumes', ''))::int, 0) + 1)
        where campaign_id = ${campaignId} and kind = ${job.kind as string} and status = 'paused'
        returning kind`) as unknown as Row[];
      if (done.length === 0) return fail(409, "There is no paused job to resume.", "not_paused");
      const k = job.kind as string;
      return { kind: k, task: k === "generate" ? "draft" : k === "social" ? "social" : "review", params: (data.resume_params as Row) ?? {} };
    }
    case "outreach.job.resume_due": {
      const rows = (await q`select campaign_id, kind, data->>'resume_at' as resume_at from campaign_jobs
        where status = 'paused' and kind not in ('leads', 'browser_check')
          and case when data->>'resume_at' ~ ${DATE_RE} then (data->>'resume_at')::timestamptz end <= ${now.toISOString()}::timestamptz
        order by case when data->>'resume_at' ~ ${DATE_RE} then (data->>'resume_at')::timestamptz end, campaign_id, kind`) as unknown as Row[];
      return { due: rows.map((r) => ({ campaign_id: r.campaign_id, kind: r.kind, resume_at: r.resume_at })) };
    }
  }
}
