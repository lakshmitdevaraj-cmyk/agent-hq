// R13 cases for chunk 6 (emails.send, send.today). The old side is the real command.ts on the P1 export with a FAKE
// AgentMail key and a stubbed fetch (no real network); the new side is lib/sql/send.ts on Neon dev, run inside a
// rolled-back transaction with run = (fn) => fn(tx) and a deps.agentmail stub that returns the same made-up answers.
import * as send from "../../../../netlify/functions/lib/sql/send.ts";
import { OWN_ADDRESSES } from "../../../../netlify/functions/lib/replies.ts";
import { asResponse } from "./shared.mjs";

export const BASE_URL = "https://equiv.madeup.test";
export const FAKE_KEY = "fake-key-for-tests";
export const SEED = { "agent-hq-service-config": { agentmail: { key: FAKE_KEY, updated_at: "2026-11-27T00:00:00Z" } } };
const INBOX = { inbox_id: "madeup-inbox@madeup.test", email: "madeup-inbox@madeup.test", display_name: "Made-up Other Name" };

/**
 * One made-up AgentMail. `failOn(callNumber, path)` returns a status (e.g. 422) to refuse that send, or null.
 * `posts` records every send in order: { path, body }. Ids come from a counter, so old and new answer alike.
 */
export function makeAgentMail({ failOn = () => null } = {}) {
  const posts = [], other = [];
  let n = 0;
  const answerPost = (path, body) => {
    posts.push({ path, body });
    const status = failOn(posts.length, path);
    if (status) return { status, text: JSON.stringify({ message: "made-up refusal" }) };
    n++;
    return { status: 200, json: { message_id: `made-up-msg-${n}`, thread_id: `made-up-thr-${n}` } };
  };
  const res = ({ status, json, text }) => new Response(text ?? JSON.stringify(json ?? {}), { status, headers: { "content-type": "application/json" } });
  return {
    posts, other,
    /** For the old path: global fetch routes. Anything that is not AgentMail returns undefined (refused). */
    routes: async (url, init = {}) => {
      if (!url.startsWith("https://api.agentmail.to/v0")) return undefined;
      const path = url.slice("https://api.agentmail.to/v0".length), method = init.method ?? "GET";
      if (method === "POST" && /\/messages\/send$|\/reply$/.test(path)) return res(answerPost(path, JSON.parse(init.body)));
      other.push({ method, path });
      if (method === "GET" && /^\/inboxes\?/.test(path)) return res({ status: 200, json: { inboxes: [INBOX] } });
      if (method === "GET" && /^\/inboxes\/[^/]+$/.test(path)) return res({ status: 200, json: INBOX });
      if (method === "PATCH") return res({ status: 200, json: {} });
      return res({ status: 404, json: { message: "made-up: not found" } });
    },
    /** For the new path: deps.agentmail. */
    stub: {
      inbox: async () => { other.push({ method: "GET", path: "/inboxes" }); return { ...INBOX }; },
      setDisplayName: async () => { other.push({ method: "PATCH", path: "/inboxes/x" }); },
      post: async (path, body) => {
        const a = answerPost(path, body);
        return a.status === 200 ? { ok: true, ...a.json } : { ok: false, status: a.status, text: a.text };
      },
    },
  };
}

const deps = (agentmail) => ({ agentmail, baseUrl: BASE_URL, ownAddresses: [...OWN_ADDRESSES], newId: () => `eq-${Math.random().toString(36).slice(2, 10)}` });
/** The SQL action inside the caller's transaction (every step shares it, so everything rolls back). */
export const sqlAction = (tx, action, params, agentmail = null) => asResponse(() => send.runSendAction((fn) => fn(tx), action, params, deps(agentmail)));

/** The campaign with the most ready, sendable step-1 drafts on dev (id only, no names). */
export async function pickSendCampaign(tx) {
  const [r] = await tx`
    select e.campaign_id, count(*)::int as n from emails e join leads l on l.id = e.lead_id
    where e.status = 'drafted' and e.review_status = 'ready' and not e.is_duplicate and e.step = 1 and e.to_email is not null
      and l.merged_into is null and not l.excluded and not l.do_not_contact and l.stop_state = 'none'
    group by e.campaign_id having count(*) >= 4 order by n desc, e.campaign_id limit 1`;
  return r;
}
export const rowStatus = async (tx, id) => (await tx`select status, error from emails where id = ${id}`)[0];
