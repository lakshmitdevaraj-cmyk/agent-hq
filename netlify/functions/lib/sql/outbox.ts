// P2 chunk 7: the outbox (R12, table from migration 0009). A message for another system or person is written in the SAME
// transaction as the change that causes it, so it is never lost; it is sent only after that transaction commits.
//   - alert.reply  the short "new reply" note to the alert address (the rules of lib/inbound.ts sendReplyAlert)
//   - alert.fyi    F31: "FYI, no action needed" for an opt-out, a bounce or a complaint
//   - crm.*        CRM handoffs (P6 sends them; nothing here does)
// `drain` sends unsent alert.* rows through deps.agentmail (command.ts wraps its own helper; tests pass a stub) and records
// every try. A row is tried at most MAX_TRIES times; it is never sent twice (claimed with FOR UPDATE SKIP LOCKED and marked
// sent in the same short transaction as the send).
import type { Sql, Tx } from "../db/client.ts";

type Q = Sql | Tx;
type Row = Record<string, unknown>;
export type Runner = <T>(fn: (q: Q) => Promise<T>) => Promise<T>;
export type AlertPost = { post(path: string, body: Row): Promise<{ ok: true } | { ok: false; status: number; text: string }> };

export const MAX_TRIES = 3;
export const ALERT_KINDS = ["alert.reply", "alert.fyi"];

export async function enqueue(q: Q, kind: string, payload: Row): Promise<number> {
  const [r] = await q`insert into outbox (kind, payload) values (${kind}, ${q.json(payload as never)}) returning id`;
  return Number(r.id);
}

/**
 * Sends unsent alert rows, oldest first, at most `max` per call. `onlyNewerThan` (an interval, tests only) limits it to
 * rows made just now, so a test never picks up rows other runs left on dev.
 */
export async function drain(run: Runner, deps: { agentmail: AlertPost | null }, opts: { max?: number; onlyNewerThan?: string } = {}): Promise<{ sent: number; failed: number }> {
  const am = deps.agentmail;
  if (!am) return { sent: 0, failed: 0 };
  // A local dev server only logs alerts (as lib/inbound.ts does), unless ALERTS_LIVE=1.
  if (process.env.NETLIFY_DEV === "true" && process.env.ALERTS_LIVE !== "1") return { sent: 0, failed: 0 };
  const max = Math.max(1, Math.min(50, Number(opts.max) || 20));
  let sent = 0, failed = 0;
  const tried: number[] = []; // a row that failed is tried again on a later call, not straight away
  for (let i = 0; i < max; i++) {
    const done = await run(async (q) => {
      const [row] = await q`select id, payload from outbox
                            where sent_at is null and attempts < ${MAX_TRIES} and kind = any(${ALERT_KINDS}::text[])
                              and not (id = any(${tried}::bigint[]))
                              and (${opts.onlyNewerThan ?? null}::interval is null or created_at > now() - ${opts.onlyNewerThan ?? null}::interval)
                            order by created_at, id limit 1 for update skip locked`;
      if (!row) return null;
      tried.push(Number(row.id));
      const p = row.payload as { inbox_id?: string; to?: string[]; subject?: string; text?: string };
      let err: string | null = null;
      try {
        const r = await am.post(`/inboxes/${encodeURIComponent(String(p.inbox_id ?? ""))}/messages/send`, { to: p.to ?? [], subject: p.subject ?? "", text: p.text ?? "" });
        if (!r.ok) err = `AgentMail ${r.status}: ${r.text.slice(0, 200)}`;
      } catch (e) { err = `No answer from AgentMail: ${String((e as Error)?.message ?? e).slice(0, 200)}`; }
      if (err) await q`update outbox set attempts = attempts + 1, last_error = ${err} where id = ${row.id}`;
      else await q`update outbox set attempts = attempts + 1, last_error = null, sent_at = now() where id = ${row.id}`;
      return err ? "failed" : "sent";
    });
    if (!done) break;
    if (done === "sent") sent++; else failed++;
  }
  return { sent, failed };
}
