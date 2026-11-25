// Stand-in for @netlify/blobs over one table: spike.kv(store, key, value jsonb). Only the calls production makes.
import { ctx } from "./context";

export function connectLambda(_event: unknown): void {}

const LIKE_END = "￿";

export function getStore(name: string) {
  const full = () => `${ctx().ns}/${name}`;
  const bucket = (store: string) => {
    const c = ctx();
    let m = c.cache.get(store);
    if (!m) c.cache.set(store, (m = new Map()));
    return m;
  };

  return {
    async get(key: string, _opts?: unknown): Promise<string | null> {
      const c = ctx(), store = full();
      if (c.mode === "batched") {
        const hit = bucket(store).get(key);
        if (hit !== undefined) return hit;
      }
      c.queries++;
      const rows = await c.sql()`select case when jsonb_typeof(value) = 'string' then value #>> '{}' else value::text end as v from spike.kv where store = ${store} and key = ${key}`;
      const v = rows.length ? (rows[0].v as string) : null;
      c.rows += rows.length;
      if (c.mode === "batched") bucket(store).set(key, v);
      return v;
    },

    async set(key: string, value: string): Promise<void> {
      const c = ctx(), store = full();
      c.queries++;
      const sql = c.sql();
      await sql`insert into spike.kv (store, key, value) values (${store}, ${key}, ${/^\s*[\[{]/.test(value) ? sql`${value}::text::jsonb` : sql`to_jsonb(${value}::text)`})
        on conflict (store, key) do update set value = excluded.value`;
      if (c.mode === "batched") {
        bucket(store).set(key, value);
        for (const [id, keys] of c.listed) {
          const [s, prefix] = id.split("\u0000");
          if (s === store && key.startsWith(prefix) && !keys.includes(key)) keys.push(key);
        }
      }
    },

    async setJSON(key: string, value: unknown): Promise<void> {
      await this.set(key, JSON.stringify(value));
    },

    async delete(key: string): Promise<void> {
      const c = ctx(), store = full();
      c.queries++;
      await c.sql()`delete from spike.kv where store = ${store} and key = ${key}`;
      bucket(store).delete(key);
      for (const [id, keys] of c.listed) {
        const i = id.startsWith(`${store}\u0000`) ? keys.indexOf(key) : -1;
        if (i >= 0) keys.splice(i, 1);
      }
    },

    async list(opts?: { prefix?: string }): Promise<{ blobs: Array<{ key: string; etag: string }>; directories: string[] }> {
      const c = ctx(), store = full(), prefix = opts?.prefix ?? "";
      const id = `${store}\u0000${prefix}`;
      let keys = c.mode === "batched" ? c.listed.get(id) : undefined;
      if (!keys) {
        c.queries++;
        const sql = c.sql();
        if (c.mode === "batched") {
          const rows = await sql`select key, case when jsonb_typeof(value) = 'string' then value #>> '{}' else value::text end as v from spike.kv where store = ${store} and key >= ${prefix} and key < ${prefix + LIKE_END} order by key`;
          const m = bucket(store);
          keys = rows.map((r) => { m.set(r.key as string, r.v as string); return r.key as string; });
          c.listed.set(id, keys);
        } else {
          const rows = await sql`select key from spike.kv where store = ${store} and key >= ${prefix} and key < ${prefix + LIKE_END} order by key`;
          keys = rows.map((r) => r.key as string);
        }
        c.rows += keys.length;
      }
      return { blobs: keys.map((key) => ({ key, etag: "" })), directories: [] };
    },
  };
}
