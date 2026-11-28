// P2 chunk 10: click links on Postgres (R7; used when DATA_BACKEND=sql, the Blobs code in track-click.ts stays the
// default until P5).
//   - At send, every http(s) link in a draft gets a row in click_links with a random 22-character token (128 bits) and
//     becomes <base>/t/<token>. The token carries nothing: the destination is read from click_links, so a made-up token
//     can never send anyone to another site (no open redirect) and can never count a click.
//   - A token that is not 22 URL-safe characters, or is not in click_links, gets a 404 and no Location. The old
//     base64 tokens are refused the same way (0 of the 166 sent emails in the export had a link).
//   - mailto:, tel:, sms:, #anchors, javascript: and anything else that is not http(s) is left as it is, never wrapped.
//   - A click: one clicks row (no IP kept), the email's count and last click, sent/delivered → clicked (never back
//     from replied, bounced or complained), one activity row; all in one statement each, no scans.
import { randomBytes } from "node:crypto";
import type { Q } from "./leads.ts";

type Row = Record<string, unknown>;
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const newClickToken = (): string => randomBytes(16).toString("base64url");

export type TrackIds = { baseUrl: string; campaignId: string | null; leadId: string | null; emailId: string };
export type ClickDeps = { newId: () => string; newToken?: () => string };

const isHttp = (u: string): boolean => {
  try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; }
};

/** Rewrites the http(s) links of `html` to tracked links, one click_links row each. */
export async function trackLinks(q: Q, html: string, ids: TrackIds, deps: ClickDeps): Promise<string> {
  const rows: Row[] = [];
  const own = `${ids.baseUrl}/t/`;
  const out = html.replace(/href="([^"]+)"/gi, (full, raw: string) => {
    const url = raw.replace(/&amp;/g, "&");
    if (raw.startsWith(own) || !isHttp(url) || url.length > 2000) return full;
    const token = (deps.newToken ?? newClickToken)();
    rows.push({ token, email_id: ids.emailId, campaign_id: ids.campaignId, lead_id: ids.leadId, url });
    return `href="${own}${token}"`;
  });
  if (rows.length) await q`insert into click_links ${q(rows as never)}`;
  return out;
}

export type ClickResult = { statusCode: number; headers: Record<string, string>; body: string };
const notFound = (): ClickResult => ({
  statusCode: 404,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  body: "This link is not valid.",
});

/** The SQL path of track-click.ts. */
export async function click(q: Q, token: string, req: { userAgent?: string | null }, deps: ClickDeps): Promise<ClickResult> {
  if (!TOKEN_RE.test(token)) return notFound();
  const [link] = await q`select token, email_id, campaign_id, lead_id, url from click_links where token = ${token}`;
  if (!link || !isHttp(String(link.url))) return notFound();
  const at = new Date().toISOString();
  await q`insert into clicks (id, blob_key, campaign_id, lead_id, email_id, url, clicked_at, data)
          values (${deps.newId()}, null, ${link.campaign_id as string | null}, ${link.lead_id as string | null}, ${link.email_id as string}, ${link.url as string}, ${at}::timestamptz,
                  ${q.json({ token, user_agent: String(req.userAgent ?? "").slice(0, 300) || null } as never)})`;
  await q`update emails set click_count = click_count + 1, last_clicked_at = ${at}::timestamptz, updated_at = now(),
                            status = case when status in ('sent', 'delivered') then 'clicked' else status end
          where id = ${link.email_id as string}`;
  const [camp] = link.campaign_id ? await q`select name from campaigns where id = ${link.campaign_id as string}` : [];
  await q`insert into activity (id, agent_id, category, summary, details, created_at, data) values (${deps.newId()}, null, 'email',
            ${`Link clicked in campaign ${String(camp?.name ?? link.campaign_id ?? "")}`.trim()},
            ${q.json({ campaign_id: link.campaign_id, email_id: link.email_id, url: link.url } as never)}, ${at}::timestamptz, '{}')`;
  return { statusCode: 302, headers: { Location: String(link.url), "Cache-Control": "no-store" }, body: "" };
}
