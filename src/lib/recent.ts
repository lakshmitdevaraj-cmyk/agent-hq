/**
 * Blobs lists can lag by up to about a minute after a write. So that a lead,
 * draft or campaign you just created shows up (and one you just deleted stays
 * gone) without waiting for the list to catch up, the pages remember what the
 * server told them and merge it into every list they fetch. Entries expire
 * after a few minutes, or as soon as the fresh list contains them.
 */
type Kind = "campaign" | "lead" | "email";
const TTL_MS = 5 * 60_000;
const created = new Map<Kind, Map<string, { item: { id: string }; at: number }>>();
const deleted = new Map<Kind, Map<string, number>>();

const bucket = <V,>(m: Map<Kind, Map<string, V>>, k: Kind) => {
  let b = m.get(k);
  if (!b) m.set(k, (b = new Map()));
  return b;
};

export function noteCreated<T extends { id: string }>(kind: Kind, item: T): void {
  bucket(created, kind).set(item.id, { item, at: Date.now() });
  bucket(deleted, kind).delete(item.id);
}

export function noteDeleted(kind: Kind, id: string): void {
  bucket(deleted, kind).set(id, Date.now());
  bucket(created, kind).delete(id);
}

/** Merge remembered creates/deletes into a freshly fetched list (newest first). `inScope` limits creates to this list (e.g. same campaign). */
export function mergeRecent<T extends { id: string }>(kind: Kind, fresh: T[], inScope: (item: T) => boolean = () => true): T[] {
  const now = Date.now();
  const del = bucket(deleted, kind);
  for (const [id, at] of del) if (now - at > TTL_MS) del.delete(id);
  const out = fresh.filter((x) => !del.has(x.id));
  const have = new Set(out.map((x) => x.id));
  const cre = bucket(created, kind);
  const extra: T[] = [];
  for (const [id, rec] of cre) {
    if (now - rec.at > TTL_MS || have.has(id)) {
      cre.delete(id);
      continue;
    }
    if (inScope(rec.item as T)) extra.push(rec.item as T);
  }
  return extra.length ? [...extra, ...out] : out;
}

export function recentlyCreated<T extends { id: string }>(kind: Kind, id: string): T | null {
  const rec = bucket(created, kind).get(id);
  return rec && Date.now() - rec.at <= TTL_MS ? (rec.item as T) : null;
}

/**
 * A lead's "draft / don't draft" tick is a write to an existing record, and reads can lag by about
 * a minute, so a refresh would flip the checkbox back. Remember what the user chose for a few minutes.
 */
const excludedAt = new Map<string, { excluded: boolean; at: number }>();
export function noteExcluded(leadId: string, excluded: boolean): void {
  excludedAt.set(leadId, { excluded, at: Date.now() });
}
export function applyExcluded<T extends { id: string; excluded?: boolean; skip_code?: string; skip_reason?: string }>(leads: T[]): T[] {
  const now = Date.now();
  return leads.map((raw) => {
    // "excluded" is the user's own choice, shown by the checkbox, not a skip reason that locks the lead.
    const l = raw.skip_code === "excluded" ? { ...raw, excluded: true, skip_code: undefined, skip_reason: undefined } : raw;
    const rec = excludedAt.get(l.id);
    if (!rec) return l;
    if (now - rec.at > TTL_MS) {
      excludedAt.delete(l.id);
      return l;
    }
    return { ...l, excluded: rec.excluded };
  });
}
