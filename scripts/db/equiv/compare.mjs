// R13: compares an old (Blobs) result with a new (SQL) result.
// Object keys may come in any order; array order counts unless a path is listed in `unordered`.
// Timestamps are ignored: keys ending in _at / _on, and any string that looks like an ISO date-time.
// `nullIsMissing` (default true): a field that is null on one side and absent on the other is the same
// (the database has a column where the old record had no field). Any other difference is reported.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const TIME_KEY = /(_at|_on)$/;

export function normalise(value, { ignoreKeys = [], nullIsMissing = true, unordered = [] } = {}, path = "") {
  if (Array.isArray(value)) {
    const items = value.map((v, i) => normalise(v, { ignoreKeys, nullIsMissing, unordered }, `${path}[]`));
    return unordered.includes(path || "$") ? items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : items;
  }
  if (value instanceof Date) return "<time>";
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined || (nullIsMissing && v === null)) continue;
      if (TIME_KEY.test(key) || ignoreKeys.includes(key)) continue;
      out[key] = normalise(v, { ignoreKeys, nullIsMissing, unordered }, path ? `${path}.${key}` : key);
    }
    return out;
  }
  if (typeof value === "string" && ISO.test(value)) return "<time>";
  if (typeof value === "bigint") return Number(value);
  return value;
}

/** Every path where the two normalised values differ: [{ path, old, new }]. */
export function diff(a, b, path = "$", out = []) {
  if (a === b) return out;
  const isObj = (v) => v && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: `${path}.length`, old: a.length, new: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push({ path: `${path}.${k}`, old: "(absent)", new: b[k] });
      else if (!(k in b)) out.push({ path: `${path}.${k}`, old: a[k], new: "(absent)" });
      else diff(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  out.push({ path, old: a, new: b });
  return out;
}

/**
 * Compares old and new. `known` lists intended differences: [{ path: RegExp, when?: (d) => boolean, why }]. Those are returned in
 * `known`, never dropped silently; everything else is in `unexpected`. `same` is true when nothing is unexpected.
 */
export function compare(oldResult, newResult, { known = [], ...opts } = {}) {
  const all = diff(normalise(oldResult, opts), normalise(newResult, opts));
  const unexpected = [], knownHits = [];
  for (const d of all) {
    const k = known.find((x) => x.path.test(d.path) && (!x.when || x.when(d)));
    (k ? knownHits : unexpected).push(k ? { ...d, why: k.why } : d);
  }
  return { same: unexpected.length === 0, unexpected, known: knownHits };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const show = (v) => (typeof v === "string" ? JSON.stringify(v.replace(EMAIL, "<email>")).slice(0, 80) : JSON.stringify(v)?.replace(EMAIL, "<email>").slice(0, 80));

/** A short readable report (email addresses masked), at most `limit` lines per list. */
export function describe({ unexpected, known }, limit = 15) {
  const lines = [`${unexpected.length} unexpected difference(s), ${known.length} known`];
  for (const d of unexpected.slice(0, limit)) lines.push(`  ✗ ${d.path}: old ${show(d.old)} → new ${show(d.new)}`);
  if (unexpected.length > limit) lines.push(`  … ${unexpected.length - limit} more`);
  for (const d of known.slice(0, limit)) lines.push(`  ~ ${d.path}: old ${show(d.old)} → new ${show(d.new)} (${d.why})`);
  return lines.join("\n");
}
