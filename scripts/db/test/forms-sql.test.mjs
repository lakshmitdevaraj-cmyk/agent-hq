// Chunk 10 on Neon dev, every module transaction rolled back: forms (A2, lib/sql/forms.ts).
// Form builder data, a personal link per lead, a submission that marks the lead interested and stops its follow-ups,
// the spam trap, the rate limit and the size limit. The old April forms are gone (chunk 12, X8).
// Through the real form-submit.ts handler on dev with made-up rows that are removed afterwards. All data is made up.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXPORT = join(homedir(), "agent-hq-backups", "p1-2026-11-26");
const CID = "a2-camp";
let n, forms, loadError, realFetch;
let seq = 0;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { forms = await import("../../../netlify/functions/lib/sql/forms.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });
const need = () => { if (loadError) throw new Error(`lib/sql/forms.ts did not load: ${loadError.message}`); };

const deps = (extra = {}) => ({ newId: () => `a2-id-${++seq}`, baseUrl: "https://made-up.test", ...extra });
const act = (tx, action, p, extra) => forms.runFormAction(tx, action, p, deps(extra));
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); return true; });
}
const FIELDS = [
  { name: "name", label: "Your name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "message", label: "Anything else?", type: "textarea" },
];
async function seed(tx) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign A2', 'plumber', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), '{}')`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", follow_up_gaps_email: [3, 8, 15], postal_address: "1 Made Up Street" })})
           on conflict (key) do update set data = excluded.data`;
  for (const [id, stop] of [["a2-lead", "none"], ["a2-dnc", "do_not_contact"], ["a2-other", "none"]]) {
    await tx`insert into leads (id, campaign_id, blob_key, name, created_at, stop_state, do_not_contact, data)
             values (${id}, ${CID}, ${id}, ${`Made-up Plumbing ${id}`}, now(), ${stop}, ${stop === "do_not_contact"}, '{}')`;
    for (const step of [1, 2]) {
      await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, subject, body_text, step, sequence_total, framework, status, review_status, sent_at, created_at, updated_at, data)
               values (${`${id}-e${step}`}, ${`${id}-e${step}`}, ${CID}, ${id}, ${`owner@${id}.test`}, ${`owner@${id}.test`}, 'plumbing', 'Made-up', ${step}, 4, 'four-step',
                       ${step === 1 ? "sent" : "drafted"}, 'ready', ${step === 1 ? "2026-11-20T15:00:00Z" : null}, now(), now(), '{}')`;
    }
  }
  await act(tx, "form.create", { slug: "a2-quote", title: "Made-up quote form", description: "Tell us a little", fields: FIELDS, thank_you: "Thanks, we'll be in touch.", campaign_id: CID });
}
const withFx = (fn) => n.callWrite(async (tx) => { await seed(tx); return fn(tx); });
const post = (tx, o = {}) => forms.submit(tx, {
  slug: o.slug ?? "a2-quote", method: o.method ?? "POST", token: o.token ?? null,
  body: o.raw ?? JSON.stringify(o.data ?? { name: "Made-up Person", email: "person@a2.test", message: "Call me" }),
  contentType: o.contentType ?? "application/json", ip: o.ip ?? "203.0.113.7", userAgent: "made-up",
}, deps(o.now ? { now: () => o.now } : {}));
const linkFor = async (tx, lead_id, slug = "a2-quote") => (await act(tx, "form.link", { slug, lead_id })).token;

describe("A2: form builder data", () => {
  test("create, list (A2 forms only; the old April forms went in chunk 12, X8), update, read straight back (F1); the same slug twice is refused", () => withFx(async (tx) => {
    need();
    const list = await act(tx, "form.list", {});
    const mine = list.find((f) => f.slug === "a2-quote");
    assert.ok(mine, "the new form is listed");
    assert.equal(mine.legacy, false);
    assert.deepEqual(mine.fields.map((f) => f.name), ["name", "email", "message"]);
    assert.ok(list.every((f) => f.legacy === false), "no old April form is listed");
    await refused(act(tx, "form.create", { slug: "a2-quote", title: "again", fields: FIELDS }), 409);
    await refused(act(tx, "form.create", { slug: "Bad Slug!", title: "x", fields: FIELDS }), 400);
    await refused(act(tx, "form.create", { slug: "a2-nofields", title: "x", fields: [] }), 400);
    await act(tx, "form.update", { slug: "a2-quote", title: "Made-up quote form v2" });
    const again = (await act(tx, "form.list", {})).find((f) => f.slug === "a2-quote");
    assert.equal(again.title, "Made-up quote form v2");
    assert.equal(again.thank_you, "Thanks, we'll be in touch.", "only the given field changed");
    await refused(act(tx, "form.update", { slug: "a2-none", title: "x" }), 404);
  }));

  test("a field type outside the list becomes text; names are cleaned; a field named like the spam trap is refused", () => withFx(async (tx) => {
    need();
    const f = await act(tx, "form.create", { slug: "a2-types", title: "Types", fields: [{ name: "Phone Number!", label: "Phone", type: "tel" }, { name: "x", label: "X", type: "script" }] });
    assert.deepEqual(f.fields.map((x) => [x.name, x.type]), [["phone_number", "tel"], ["x", "text"]]);
    await refused(act(tx, "form.create", { slug: "a2-trap", title: "T", fields: [{ name: "_trap", label: "T" }] }), 400);
  }));

  test("form.link: one personal link per lead and form (asked twice, the same token); a lead that doesn't exist is refused", () => withFx(async (tx) => {
    need();
    const a = await act(tx, "form.link", { slug: "a2-quote", lead_id: "a2-lead" });
    const b = await act(tx, "form.link", { slug: "a2-quote", lead_id: "a2-lead" });
    assert.match(a.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(a.token, b.token);
    assert.equal(a.url, `https://made-up.test/form/a2-quote?l=${a.token}`);
    assert.equal(a.api_url, `https://made-up.test/api/form/a2-quote?l=${a.token}`);
    await refused(act(tx, "form.link", { slug: "a2-quote", lead_id: "a2-no-such-lead" }), 404);
    await refused(act(tx, "form.link", { slug: "a2-none", lead_id: "a2-lead" }), 404);
  }));

  test("form.delete removes the form and its personal links; its submissions stay", () => withFx(async (tx) => {
    need();
    await linkFor(tx, "a2-lead");
    await post(tx, {});
    await act(tx, "form.delete", { slug: "a2-quote" });
    assert.equal((await tx`select count(*)::int as n from form_links where form_slug = 'a2-quote'`)[0].n, 0);
    assert.equal((await tx`select count(*)::int as n from form_submissions where form_slug = 'a2-quote'`)[0].n, 1);
    assert.equal((await post(tx, {})).statusCode, 404);
  }));
});

describe("A2: a submission", () => {
  test("GET gives only the form, never lead data", () => withFx(async (tx) => {
    need();
    const t = await linkFor(tx, "a2-lead");
    const r = await post(tx, { method: "GET", token: t });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["description", "fields", "slug", "thank_you", "title"]);
    assert.ok(!JSON.stringify(r.body).includes("Made-up Plumbing"), "no lead name");
    assert.equal((await post(tx, { method: "GET", slug: "a2-none" })).statusCode, 404);
  }));

  test("with a valid personal link: stored with the lead, the lead is interested and stopped (replied, 'form submission'), its follow-ups are stopped, one activity row without the form text, one outbox row (read straight back)", () => withFx(async (tx) => {
    need();
    const t = await linkFor(tx, "a2-lead");
    const r = await post(tx, { token: t });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.thank_you, "Thanks, we'll be in touch.");
    const [s] = await tx`select * from form_submissions where id = ${r.body.submission_id}`;
    assert.equal(s.lead_id, "a2-lead");
    assert.equal(s.spam, false);
    assert.deepEqual(s.data, { name: "Made-up Person", email: "person@a2.test", message: "Call me" });
    assert.match(s.ip_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(s).includes("203.0.113.7"), "the address itself is never stored");
    const [l] = await tx`select stop_state, stop_reason, data from leads where id = 'a2-lead'`;
    assert.equal(l.stop_state, "replied");
    assert.equal(l.stop_reason, "form submission");
    assert.equal(l.data.interested, true);
    assert.equal(l.data.interested_form, "a2-quote");
    assert.ok(l.data.interested_at);
    const fu = await tx`select stopped_reason from follow_ups where lead_id = 'a2-lead'`;
    assert.ok(fu.length > 0, "follow_ups rows written for the lead");
    assert.ok(fu.every((x) => x.stopped_reason), `every follow-up of the lead is stopped: ${JSON.stringify(fu)}`);
    const act1 = await tx`select summary, details from activity where details->>'submission_id' = ${r.body.submission_id}`;
    assert.equal(act1.length, 1);
    assert.ok(!JSON.stringify(act1[0]).includes("Call me"), "the form text is not copied into the activity log");
    const ob = await tx`select kind, payload from outbox where payload->>'submission_id' = ${r.body.submission_id}`;
    assert.equal(ob.length, 1);
    assert.equal(ob[0].kind, "crm.form_submitted");
    assert.equal((await tx`select count(*)::int as n from leads where id = 'a2-other' and stop_state = 'none'`)[0].n, 1, "another lead is untouched");
  }));

  test("a do-not-contact lead stays do-not-contact; it is still marked interested", () => withFx(async (tx) => {
    need();
    const r = await post(tx, { token: await linkFor(tx, "a2-dnc") });
    assert.equal(r.statusCode, 200);
    const [l] = await tx`select stop_state, data from leads where id = 'a2-dnc'`;
    assert.equal(l.stop_state, "do_not_contact");
    assert.equal(l.data.interested, true);
  }));

  test("an unknown token, or one made for another form, is stored with no lead and changes no lead", () => withFx(async (tx) => {
    need();
    await act(tx, "form.create", { slug: "a2-other-form", title: "Other", fields: FIELDS });
    const otherTok = await linkFor(tx, "a2-lead", "a2-other-form");
    for (const token of ["BBBBBBBBBBBBBBBBBBBBBB", otherTok, "not-a-token"]) {
      const r = await post(tx, { token, ip: `198.51.100.${++seq % 200}` });
      assert.equal(r.statusCode, 200);
      const [s] = await tx`select lead_id from form_submissions where id = ${r.body.submission_id}`;
      assert.equal(s.lead_id, null);
    }
    assert.equal((await tx`select stop_state from leads where id = 'a2-lead'`)[0].stop_state, "none");
  }));

  test("spam trap: a filled hidden field is stored as spam, the answer looks like a success, the lead is untouched and nothing goes to the outbox", () => withFx(async (tx) => {
    need();
    const t = await linkFor(tx, "a2-lead");
    const r = await post(tx, { token: t, data: { name: "Bot", email: "bot@a2.test", _trap: "http://spam.example" } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    const [s] = await tx`select spam, spam_reason, data from form_submissions where id = ${r.body.submission_id}`;
    assert.equal(s.spam, true);
    assert.equal(s.spam_reason, "trap");
    assert.equal(s.data._trap, undefined, "the trap value is not kept as a field");
    assert.equal((await tx`select stop_state from leads where id = 'a2-lead'`)[0].stop_state, "none");
    assert.equal((await tx`select count(*)::int as n from outbox where payload->>'submission_id' = ${r.body.submission_id}`)[0].n, 0);
    const list = await act(tx, "form.submissions", { slug: "a2-quote" });
    assert.equal(list.length, 0, "spam is left out of the list");
    assert.equal((await act(tx, "form.submissions", { slug: "a2-quote", include_spam: true })).length, 1);
  }));

  test("rate limit: the 6th post in 10 minutes from one address is 429 with retry_after, and nothing is stored", () => withFx(async (tx) => {
    need();
    for (let i = 0; i < 5; i++) assert.equal((await post(tx, { ip: "203.0.113.50" })).statusCode, 200, `post ${i + 1}`);
    const r = await post(tx, { ip: "203.0.113.50" });
    assert.equal(r.statusCode, 429);
    assert.ok(r.body.retry_after > 0);
    assert.equal((await tx`select count(*)::int as n from form_submissions where form_slug = 'a2-quote'`)[0].n, 5);
    assert.equal((await post(tx, { ip: "203.0.113.51" })).statusCode, 200, "another address is not limited");
  }));

  test("rate limit: one personal link takes at most 3 posts a day", () => withFx(async (tx) => {
    need();
    const t = await linkFor(tx, "a2-lead");
    for (let i = 0; i < 3; i++) assert.equal((await post(tx, { token: t, ip: `192.0.2.${i + 1}` })).statusCode, 200);
    assert.equal((await post(tx, { token: t, ip: "192.0.2.99" })).statusCode, 429);
  }));

  test("size and shape: over 10 KB is 413; bad JSON 400; a missing required field 400 naming it; a bad email 400; unknown fields dropped; long values refused", () => withFx(async (tx) => {
    need();
    assert.equal((await post(tx, { raw: JSON.stringify({ name: "x".repeat(11_000), email: "a@a2.test" }) })).statusCode, 413);
    assert.equal((await post(tx, { raw: "{not json" })).statusCode, 400);
    const miss = await post(tx, { data: { email: "a@a2.test" }, ip: "203.0.113.60" });
    assert.equal(miss.statusCode, 400);
    assert.deepEqual(miss.body.missing, ["name"]);
    assert.equal((await post(tx, { data: { name: "A", email: "not-an-address" }, ip: "203.0.113.61" })).statusCode, 400);
    assert.equal((await post(tx, { data: { name: "A", email: "a@a2.test", message: "y".repeat(2001) }, ip: "203.0.113.62" })).statusCode, 400);
    const ok = await post(tx, { data: { name: "A", email: "a@a2.test", admin: true, extra: "z" }, ip: "203.0.113.63" });
    assert.equal(ok.statusCode, 200);
    const [s] = await tx`select data from form_submissions where id = ${ok.body.submission_id}`;
    assert.deepEqual(Object.keys(s.data).sort(), ["email", "name"]);
  }));

  test("a plain HTML form post (urlencoded) works", () => withFx(async (tx) => {
    need();
    const r = await post(tx, { raw: "name=Made-up+Person&email=person%40a2.test", contentType: "application/x-www-form-urlencoded" });
    assert.equal(r.statusCode, 200);
    const [s] = await tx`select data from form_submissions where id = ${r.body.submission_id}`;
    assert.deepEqual(s.data, { name: "Made-up Person", email: "person@a2.test" });
  }));

  test("an old April form slug no longer answers on SQL (chunk 12, X8): GET and POST are 404, nothing is stored", () => withFx(async (tx) => {
    need();
    assert.equal((await post(tx, { method: "GET", slug: "a2-old-april" })).statusCode, 404);
    assert.equal((await post(tx, { slug: "a2-old-april", data: { name: "Newer person" } })).statusCode, 404);
    assert.equal((await tx`select count(*)::int as n from form_submissions where form_slug = 'a2-old-april'`)[0].n, 0);
    assert.deepEqual(await act(tx, "form.submissions", { slug: "a2-old-april" }), []);
  }));
});

describe("A2: through the real form-submit.ts handler on dev (DATA_BACKEND=sql)", { skip: !existsSync(join(EXPORT, "manifest.json")) && "P1 export folder not found" }, () => {
  test("a personal-link post stops the lead; the spam trap is 200 and leaves it; a 6th post is 429", async () => {
    const { openOld } = await import("../equiv/old-path.mjs");
    const { localVar } = await import("../env.mjs");
    const SLUG = `a2h-${Date.now().toString(36)}`;
    const LEAD = `${SLUG}-lead`;
    const TOKEN = `${SLUG}xxxxxxxxxxxxxxxxxxxxxx`.replace(/[^A-Za-z0-9_-]/g, "x").slice(0, 22);
    await n.commit(async (tx) => {
      await tx`insert into leads (id, campaign_id, blob_key, name, created_at, data) values (${LEAD}, null, ${LEAD}, 'Made-up Handler Lead', now(), '{}')`;
      await tx`insert into lead_forms (slug, title, fields) values (${SLUG}, 'Made-up handler form', ${tx.json([{ name: "name", label: "Name", type: "text", required: true }])})`;
      await tx`insert into form_links (token, form_slug, lead_id) values (${TOKEN}, ${SLUG}, ${LEAD})`;
    });
    process.env.DATA_BACKEND = "sql";
    process.env.DATABASE_URL = localVar("DEV_DATABASE_URL");
    try {
      const h = await openOld(EXPORT, { allowDb: true, fn: "form-submit" });
      const ev = (body, ip, token) => ({ httpMethod: "POST", path: `/.netlify/functions/form-submit/${SLUG}`, queryStringParameters: token ? { l: token } : {}, headers: { "content-type": "application/json", "x-nf-client-connection-ip": ip }, body: JSON.stringify(body) });
      const trap = await h.raw(ev({ name: "Bot", _trap: "x" }, "203.0.113.90", TOKEN));
      assert.equal(trap.status, 200);
      const [l0] = await n.call((tx) => tx`select stop_state from leads where id = ${LEAD}`);
      assert.equal(l0.stop_state, "none", "the spam trap leaves the lead");
      const ok = await h.raw(ev({ name: "Made-up Person" }, "203.0.113.91", TOKEN));
      assert.equal(ok.status, 200);
      const [l1] = await n.call((tx) => tx`select stop_state from leads where id = ${LEAD}`);
      assert.equal(l1.stop_state, "replied");
      for (let i = 0; i < 4; i++) await h.raw(ev({ name: "Again" }, "203.0.113.92", null));
      assert.equal((await h.raw(ev({ name: "Again" }, "203.0.113.92", null))).status, 200, "5th");
      assert.equal((await h.raw(ev({ name: "Again" }, "203.0.113.92", null))).status, 429, "6th");
    } finally {
      delete process.env.DATA_BACKEND; delete process.env.DATABASE_URL;
      await n.commit(async (tx) => {
        const subs = (await tx`select id from form_submissions where form_slug = ${SLUG}`).map((r) => r.id);
        await tx`delete from outbox where payload->>'submission_id' = any(${subs})`;
        await tx`delete from activity where details->>'submission_id' = any(${subs})`;
        await tx`delete from form_submissions where form_slug = ${SLUG}`;
        await tx`delete from follow_ups where lead_id = ${LEAD}`;
        await tx`delete from lead_forms where slug = ${SLUG}`;
        await tx`delete from leads where id = ${LEAD}`;
      });
    }
  });
});
