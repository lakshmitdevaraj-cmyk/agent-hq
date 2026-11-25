import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

// One connection per request: parallel queries are pipelined on it, and opening a connection costs CPU.
export const connect = (url: string): Sql => postgres(url, { max: 1, fetch_types: false, onnotice: () => {} });

export const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
