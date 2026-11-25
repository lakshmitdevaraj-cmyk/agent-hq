// Per-request state shared by the Blobs shim and the outside-service stubs.
import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";

export type Ctx = {
  sql: () => ReturnType<typeof postgres>;
  /** Dataset prefix, e.g. "d500". Keeps the data sizes apart inside spike.kv. */
  ns: string;
  /** batched: list() fetches values too and later get()s come from memory. literal: one query per read, like Blobs. */
  mode: "batched" | "literal";
  cache: Map<string, Map<string, string | null>>;
  listed: Map<string, string[]>; // `${store} ${prefix}` already loaded in this request
  queries: number;
  rows: number;
  outbound: Record<string, number>; // calls to faked outside services, by host
};

export const als = new AsyncLocalStorage<Ctx>();

export function ctx(): Ctx {
  const c = als.getStore();
  if (!c) throw new Error("spike: no request context");
  return c;
}
