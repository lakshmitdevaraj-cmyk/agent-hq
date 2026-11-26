// Forward-only migrations: plain SQL files in db/migrations, applied in name order, each in its own transaction
// and recorded in schema_migrations. An applied file must never change; write a new one instead.
// Usage: node scripts/db/migrate.mjs [dev|perf]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "./env.mjs";

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

export async function migrate(sql, { dir = MIGRATIONS } = {}) {
  await sql`create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
  const done = new Map((await sql`select name, checksum from schema_migrations`).map((r) => [r.name, r.checksum]));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const sum = (text) => createHash("sha256").update(text).digest("hex");

  // Check every applied file before changing anything.
  for (const [name, checksum] of done) {
    if (!files.includes(name)) throw new Error(`${name} was applied but is no longer in ${dir}`);
    if (sum(readFileSync(join(dir, name), "utf8")) !== checksum) throw new Error(`${name} was changed after it was applied; write a new migration instead`);
  }

  const applied = [];
  for (const name of files.filter((f) => !done.has(f))) {
    const text = readFileSync(join(dir, name), "utf8");
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into schema_migrations (name, checksum) values (${name}, ${sum(text)})`;
      });
    } catch (e) {
      throw new Error(`${name} failed and was rolled back: ${e.message}`);
    }
    applied.push(name);
  }
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const branch = process.argv[2] ?? "dev";
  const sql = connect(branch);
  try {
    const applied = await migrate(sql);
    console.log(applied.length ? `${branch}: applied ${applied.join(", ")}` : `${branch}: nothing to apply`);
  } catch (e) {
    console.log(e.message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
