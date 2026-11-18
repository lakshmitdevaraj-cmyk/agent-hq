// "Who have we already emailed / who bounced" index, across ALL campaigns.
//
// One blob per fact, keyed by the address, so reading the index is a single key
// listing (no per-record reads):
//   sent/<email>/<campaign_id>   an email to <email> was sent from that campaign
//   bounced/<email>              an email to <email> bounced, was rejected or got a complaint
//   meta/built                   marker: the index was built from existing emails once
// The first read builds the index from the emails already stored (covers history
// and data imported from another site).

import { store, readJson } from "./blobs";
import { emailKey } from "./outreach";

const CONTACTS = "agent-hq-outreach-contacts";
const EMAILS = "agent-hq-outreach-emails";

export type Contacts = {
  /** address -> campaign ids it was emailed from */
  sent: Map<string, Set<string>>;
  bounced: Set<string>;
};

export const emptyContacts = (): Contacts => ({ sent: new Map(), bounced: new Set() });

function addSent(c: Contacts, email: string, campaignId: string) {
  const set = c.sent.get(email) ?? new Set<string>();
  set.add(campaignId);
  c.sent.set(email, set);
}

export async function noteSent(email: string | null | undefined, campaignId: string): Promise<void> {
  const k = emailKey(email);
  if (!k || !campaignId) return;
  await store(CONTACTS).set(`sent/${k}/${campaignId}`, "1");
}

export async function noteBounced(email: string | null | undefined): Promise<void> {
  const k = emailKey(email);
  if (!k) return;
  await store(CONTACTS).set(`bounced/${k}`, "1");
}

const SENT_STATUSES = new Set(["sent", "delivered", "clicked", "replied", "bounced", "complained", "failed"]);
const BOUNCE_STATUSES = new Set(["bounced", "complained", "failed"]);

/** Read the index, building it from stored emails the first time. */
export async function loadContacts(): Promise<Contacts> {
  const cs = store(CONTACTS);
  const out = emptyContacts();
  const built = await cs.get("meta/built");
  if (built === null) {
    const es = store(EMAILS);
    const { blobs } = await es.list();
    for (const b of blobs) {
      const row = await readJson<{ to_email?: string; campaign_id?: string; status?: string }>(es, b.key);
      const k = emailKey(row?.to_email);
      if (!row || !k || !row.status || !SENT_STATUSES.has(row.status)) continue;
      const cid = row.campaign_id ?? b.key.split("/")[0];
      addSent(out, k, cid);
      await cs.set(`sent/${k}/${cid}`, "1");
      if (BOUNCE_STATUSES.has(row.status)) {
        out.bounced.add(k);
        await cs.set(`bounced/${k}`, "1");
      }
    }
    await cs.set("meta/built", new Date().toISOString());
    return out;
  }
  const { blobs } = await cs.list();
  for (const { key } of blobs) {
    if (key.startsWith("bounced/")) out.bounced.add(key.slice("bounced/".length));
    else if (key.startsWith("sent/")) {
      const rest = key.slice("sent/".length);
      const i = rest.lastIndexOf("/");
      if (i > 0) addSent(out, rest.slice(0, i), rest.slice(i + 1));
    }
  }
  return out;
}

export type ContactBlock = { code: "bounced" | "already_contacted"; message: string };

/**
 * Should this address be skipped for a campaign? Bounced anywhere: always.
 * Emailed from a DIFFERENT campaign: yes. Emailed earlier in THIS campaign: no,
 * that is a sequence follow-up (a second step-1 draft is already prevented by the
 * per-(lead, step) draft check).
 */
export function contactBlock(c: Contacts, email: string | null | undefined, campaignId: string): ContactBlock | null {
  const k = emailKey(email);
  if (!k) return null;
  if (c.bounced.has(k)) return { code: "bounced", message: "Skipped: bounced earlier" };
  const from = c.sent.get(k);
  if (from && [...from].some((id) => id !== campaignId)) return { code: "already_contacted", message: "Skipped: already contacted in another campaign" };
  return null;
}
