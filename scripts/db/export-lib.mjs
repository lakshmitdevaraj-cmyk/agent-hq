// Pure parts of the live export: paging, call estimate and removal of secrets before anything reaches disk.

export const REDACTED = "[redacted]";

// Field names that hold credentials. "key" and "token" alone are ordinary data here (message part keys, tracking tokens).
const SECRET_FIELD = /(api_?key|gemini_key|apify_key|agentmail_key|secret|password|access_token|auth_token|refresh_token)$/i;
// Header names that carry credentials, only inside an object called "headers" (webhook events).
const SECRET_HEADER = /authorization|cookie|secret|signature|token|api[-_]?key/i;
// Values shaped like a key, wherever they were typed.
const SECRET_VALUE = /AIza[0-9A-Za-z_-]{30,}|\b(?:ahq_|akey_|apify_api_|sk-|am_|whsec_)[A-Za-z0-9_-]{20,}/g;

/** Returns the value to store (the original string when nothing was secret) and the names of what was removed. */
export function redact(store, value) {
  const redacted = [];
  const scrub = (text, where) => text.replace(SECRET_VALUE, () => { redacted.push(where); return REDACTED; });

  let parsed;
  try { parsed = JSON.parse(value); } catch { return { value: scrub(value, "(text)"), redacted }; }
  if (!parsed || typeof parsed !== "object") return { value: scrub(value, "(text)"), redacted };

  const walk = (node, field, inHeaders) => {
    if (typeof node === "string") return scrub(node, field);
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((v) => walk(v, field, inHeaders));
    return Object.fromEntries(Object.entries(node).map(([k, v]) => {
      if (v && v !== REDACTED && (SECRET_FIELD.test(k) || (inHeaders && SECRET_HEADER.test(k)))) {
        redacted.push(k);
        return [k, REDACTED];
      }
      return [k, walk(v, k, inHeaders || k.toLowerCase() === "headers")];
    }));
  };
  const clean = walk(parsed, "(value)", false);
  return { value: redacted.length ? JSON.stringify(clean) : value, redacted };
}

/** Reads one store page by page with data.export. `call(action, params)` returns the response's data. */
export async function exportStore(call, store) {
  const records = [];
  let cursor = null;
  let calls = 0;
  let total = 0;
  for (;;) {
    const page = await call("data.export", { store, cursor });
    calls++;
    records.push(...page.records);
    total = page.total;
    if (!page.next_cursor) return { records, calls, total };
    if (page.next_cursor === cursor) throw new Error(`${store}: the cursor did not move`);
    cursor = page.next_cursor;
  }
}

/** At least this many data.export calls (a page is at most 100 records, fewer if they are large). */
export const estimateCalls = (counts) => Object.values(counts).reduce((n, c) => n + Math.max(1, Math.ceil(c / 100)), 0);
