// Rules the database itself must enforce. Every test runs in a transaction that is rolled back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "../env.mjs";

let sql;
before(() => { sql = connect("dev"); });
after(() => sql.end());

const ROLLBACK = new Error("rollback");
async function rolledBack(fn) {
  await assert.rejects(sql.begin(async (tx) => { await fn(tx); throw ROLLBACK; }), (e) => { if (e !== ROLLBACK) throw e; return true; });
}
/** The statement must be refused with this Postgres error code; the surrounding transaction carries on. */
const refused = (tx, code, fn) => assert.rejects(tx.savepoint(fn), (e) => { assert.equal(e.code, code, e.message); return true; });
const UNIQUE = "23505", CHECK = "23514";

test("F9: one draft per lead and step for email; failed and marked-duplicate rows do not count", () => rolledBack(async (tx) => {
  await tx`insert into emails (id, lead_id, step) values ('t-e1', 't-lead', 1)`;
  await refused(tx, UNIQUE, (s) => s`insert into emails (id, lead_id, step) values ('t-e2', 't-lead', 1)`);
  await tx`insert into emails (id, lead_id, step, status) values ('t-e3', 't-lead', 1, 'failed')`;
  await tx`insert into emails (id, lead_id, step, is_duplicate) values ('t-e4', 't-lead', 1, true)`;
  await tx`insert into emails (id, lead_id, step) values ('t-e5', 't-lead', 2)`;
}));

test("F9: one social draft per lead, channel and step", () => rolledBack(async (tx) => {
  await tx`insert into social_messages (id, lead_id, channel, step_key, step) values ('t-s1', 't-lead', 'facebook', 'message', 1)`;
  await refused(tx, UNIQUE, (s) => s`insert into social_messages (id, lead_id, channel, step_key, step) values ('t-s2', 't-lead', 'facebook', 'message', 1)`);
  await tx`insert into social_messages (id, lead_id, channel, step_key, step) values ('t-s3', 't-lead', 'instagram', 'message', 1)`;
}));

test("F46/F22: a draft can be written by hand on any lead and step, with who wrote it", () => rolledBack(async (tx) => {
  await tx`insert into emails (id, lead_id, step, written_by) values ('t-e6', 't-lead', 4, 'claude')`;
  await tx`insert into social_messages (id, lead_id, channel, step_key, step, written_by) values ('t-s4', 't-lead', 'linkedin', 'last', 4, 'lakshmi')`;
  await refused(tx, CHECK, (s) => s`insert into emails (id, lead_id, step, written_by) values ('t-e7', 't-lead', 3, 'someone')`);
}));

test("F12/F13: a social page is stored once and several leads can point to it", () => rolledBack(async (tx) => {
  const [page] = await tx`insert into social_pages (platform, url_norm, url) values ('facebook', 'https://facebook.com/t-page', 'https://facebook.com/t-page') returning id`;
  await refused(tx, UNIQUE, (s) => s`insert into social_pages (platform, url_norm, url) values ('facebook', 'https://facebook.com/t-page', 'x')`);
  for (const lead of ["t-a", "t-b"]) await tx`insert into lead_social_links (lead_id, kind, page_id, url, source) values (${lead}, 'facebook', ${page.id}, 'u', 'site_check')`;
}));

test("F14: a manual email or link is never overwritten by a check", () => rolledBack(async (tx) => {
  await tx`insert into leads (id, email, email_source) values ('t-lead', 'typed@example.com', 'manual')`;
  await tx`update leads set email = 'found@example.com', email_source = 'site_check' where id = 't-lead'`;
  let [l] = await tx`select email, email_source from leads where id = 't-lead'`;
  assert.deepEqual([l.email, l.email_source], ["typed@example.com", "manual"]);
  await tx`update leads set email = 'retyped@example.com' where id = 't-lead'`; // a person changing it again
  [l] = await tx`select email from leads where id = 't-lead'`;
  assert.equal(l.email, "retyped@example.com");

  await tx`insert into lead_social_links (lead_id, kind, url, source) values ('t-lead', 'facebook', 'typed', 'manual')`;
  await tx`insert into lead_social_links (lead_id, kind, url, source) values ('t-lead', 'facebook', 'found', 'browser')
    on conflict (lead_id, kind) do update set url = excluded.url, source = excluded.source`;
  const [link] = await tx`select url, source from lead_social_links where lead_id = 't-lead'`;
  assert.deepEqual([link.url, link.source], ["typed", "manual"]);
}));

test("F7/F8: only the four stop states exist", () => rolledBack(async (tx) => {
  for (const [i, s] of ["none", "do_not_contact", "replied", "bounced"].entries()) await tx`insert into leads (id, stop_state) values (${`t-${i}`}, ${s})`;
  await refused(tx, CHECK, (sp) => sp`insert into leads (id, stop_state) values ('t-x', 'stopped')`);
}));

const next = async (day) => (await sql`select to_char(next_working_day(${day}::date, 'US'), 'YYYY-MM-DD') as d`)[0].d;

test("next_working_day: weekends, holidays and blackouts", async () => {
  assert.equal(await next("2026-12-05"), "2026-12-07", "Saturday to Monday");
  assert.equal(await next("2026-11-26"), "2026-11-30", "Thanksgiving week (26-29 Nov blackout)");
  assert.equal(await next("2026-11-25"), "2026-11-25", "the Wednesday before is a working day");
  assert.equal(await next("2026-12-21"), "2027-01-04", "21 Dec to 1 Jan blackout, then a weekend");
  assert.equal(await next("2026-12-01"), "2026-12-01", "a normal Tuesday");
  assert.equal(await next("2027-05-31"), "2027-06-01", "Memorial Day");
  assert.equal(await next("2027-11-25"), "2027-11-29", "Thanksgiving and the day after");
  assert.equal(await next("2027-12-24"), "2027-12-27", "Christmas Eve");
  assert.equal(await next("2027-02-15"), "2027-02-15", "Presidents' Day is a working day");
  assert.equal(await next("2027-10-11"), "2027-10-11", "Columbus Day is a working day");
  assert.equal(await next("2027-11-11"), "2027-11-11", "Veterans Day is a working day");
});

test("an unknown country is an error, not a silent guess", async () => {
  await assert.rejects(sql`select next_working_day('2026-12-01'::date, 'ZZ')`, /unknown country/);
});

test("US profile: wording is copied from today's code; exactly the agreed holidays", async () => {
  const code = readFileSync(new URL("../../../netlify/functions/lib/outreach.ts", import.meta.url), "utf8");
  const constant = (name) => new RegExp(`export const ${name} = (["'\`])(.*)\\1;`).exec(code)[2];
  const [us] = await sql`select * from country_profiles where code = 'US'`;
  assert.equal(us.opt_out_line, constant("FOOTER_OPT_OUT_LINE"));
  assert.equal(us.footer_signature, constant("FOOTER_SIGNATURE"));
  assert.deepEqual(us.working_days, [1, 2, 3, 4, 5]);
  assert.equal(us.spelling, "en-US");
  const days = await sql`select to_char(day, 'MM-DD') as d, name from public_holidays where country = 'US' and extract(year from day) = 2026 order by day`;
  assert.deepEqual(days.map((r) => r.d), ["01-01", "05-25", "07-04", "09-07", "11-26", "11-27", "12-24", "12-25"]);
  const blackouts = await sql`select to_char(starts_on, 'YYYY-MM-DD') as a, to_char(ends_on, 'YYYY-MM-DD') as b from blackout_dates order by starts_on`;
  assert.deepEqual(blackouts.map((r) => [r.a, r.b]), [["2026-11-26", "2026-11-29"], ["2026-12-21", "2027-01-01"]]);
});
