// The migration runner, tried against a throwaway schema on the dev branch.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../env.mjs";
import { migrate } from "../migrate.mjs";

const SCHEMA = "t_migrate";
let sql, dir;

before(async () => {
  sql = connect("dev");
  await sql`drop schema if exists ${sql(SCHEMA)} cascade`;
  await sql`create schema ${sql(SCHEMA)}`;
  await sql`set search_path to ${sql(SCHEMA)}`;
  dir = mkdtempSync(join(tmpdir(), "mig-"));
  writeFileSync(join(dir, "0001_a.sql"), "create table a (id int);\ncreate table a2 (id int);");
  writeFileSync(join(dir, "0002_b.sql"), "alter table a add column b text;");
});
after(async () => {
  await sql`drop schema if exists ${sql(SCHEMA)} cascade`;
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
});

test("applies new files in order and records them; a second run does nothing", async () => {
  assert.deepEqual(await migrate(sql, { dir }), ["0001_a.sql", "0002_b.sql"]);
  assert.deepEqual(await migrate(sql, { dir }), []);
  const rows = await sql`select name from schema_migrations order by name`;
  assert.deepEqual(rows.map((r) => r.name), ["0001_a.sql", "0002_b.sql"]);
});

test("refuses an applied file that was edited", async () => {
  writeFileSync(join(dir, "0002_b.sql"), "alter table a add column c text;");
  await assert.rejects(migrate(sql, { dir }), /0002_b\.sql was changed/);
  writeFileSync(join(dir, "0002_b.sql"), "alter table a add column b text;");
});

test("a failing file leaves nothing behind", async () => {
  writeFileSync(join(dir, "0003_c.sql"), "create table c (id int);\nselect no_such_function();");
  await assert.rejects(migrate(sql, { dir }), /0003_c\.sql/);
  const [{ t }] = await sql`select to_regclass('c') as t`;
  assert.equal(t, null);
  assert.equal((await sql`select 1 from schema_migrations where name = '0003_c.sql'`).length, 0);
  rmSync(join(dir, "0003_c.sql"));
});
