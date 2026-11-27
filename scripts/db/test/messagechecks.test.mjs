// P2 chunk 5b: the lead-aware message checks (F35, F36, F37, F40), each with a hit and a near-miss; codeCheckDraft
// runs them on save; a stale block the code checks made is lifted when the rules no longer find it (F38/F39); and the
// fix list's named cases on their real drafts on dev (names kept OUTSIDE this public repo).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAMED = join(homedir(), "agent-hq-backups", "p2-named-cases.json");
let n, mc, checks, rules;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  mc = await import("../../../netlify/functions/lib/sql/messagechecks.ts");
  checks = await import("../../../netlify/functions/lib/sql/emailchecks.ts");
  rules = await import("../../../netlify/functions/lib/messagerules.ts");
});
after(() => n?.close());

const LEAD = { name: "Made-up Plumbing", email: "office@madeupplumbing-test.com", website: "https://www.madeupplumbing-test.com/", owner_name: "Sam Lane" };
const ids = (body, lead = LEAD, kind = "email1", to) => mc.messageChecks(kind, body, lead, to).map((h) => `${h.id}:${h.level}`);
const B = (greet, rest = "Calls come in while the crew is out. Want me to send a short recording?") => `${greet}\n\n${rest}`;

describe("5b lead-aware checks", () => {
  test("F35 domain: another business's domain is Check this; near-misses: same site, a mail sub-domain, free mail", () => {
    assert.deepEqual(ids(B("Hi there,"), { ...LEAD, email: "rob@madeup-other-test.com" }), ["recipient-domain:soft"]);
    assert.deepEqual(ids(B("Hi there,")), []);
    assert.deepEqual(ids(B("Hi there,"), { ...LEAD, email: "office@mail.madeupplumbing-test.com" }), []);
    assert.deepEqual(ids(B("Hi there,"), { ...LEAD, email: "madeupplumbing@gmail.com" }), []);
    // The draft's own address wins over the lead's (an edited recipient is what gets sent).
    assert.deepEqual(ids(B("Hi there,"), LEAD, "email1", "pat@madeup-other-test.com"), ["recipient-domain:soft"]);
  });

  test("F35 greeting: \"Hi Dana\" to someone else's personal address is Check this; near-misses: her address, initial + surname, a shared mailbox", () => {
    const lead = { ...LEAD, owner_name: "Dana Lane", email: "robin@madeupplumbing-test.com" };
    assert.deepEqual(ids(B("Hi Dana,"), lead), ["greeting-recipient:soft"]);
    assert.deepEqual(ids(B("Hi Dana,"), { ...lead, email: "dana@madeupplumbing-test.com" }), []);
    assert.deepEqual(ids(B("Hi Dana,"), { ...lead, email: "dlane@madeupplumbing-test.com" }), []);
    assert.deepEqual(ids(B("Hi Dana,"), { ...lead, email: "dana.lane@madeupplumbing-test.com" }), []);
    assert.deepEqual(ids(B("Hi Dana,"), { ...lead, email: "office@madeupplumbing-test.com" }), []);
    assert.deepEqual(ids(B("Hi there,"), lead), [], "no name in the greeting");
  });

  test("F36: a greeting read from the address with no owner saved is Check this; near-miss: the owner is saved", () => {
    const lead = { ...LEAD, owner_name: null, email: "morgan@madeupplumbing-test.com" };
    assert.deepEqual(ids(B("Hi Morgan,"), lead), ["greeting-from-address:soft"]);
    assert.deepEqual(ids(B("Hi Morgan,"), { ...lead, owner_name: "Morgan Lane" }), []);
    assert.deepEqual(ids(B("Hi Morgan,"), { ...lead, email: "plumbing@madeupplumbing-test.com" }), [], "a trade word is no first name");
  });

  test("F37 \"your assistant\" is Check this; near-miss: \"an assistant\"", () => {
    assert.deepEqual(ids(B("Hi there,", "Your AI assistant could answer while you work. Want the recording?")), ["your-assistant:soft"]);
    assert.deepEqual(ids(B("Hi there,", "Your assistant could pick up while you work.")), ["your-assistant:soft"]);
    assert.deepEqual(ids(B("Hi there,", "An assistant could answer your calls while you work. Want the recording?")), []);
  });

  test("F37 email 4 must not pitch (Blocked); near-misses: email 4 closing the loop, email 2 describing the offer", () => {
    assert.deepEqual(ids(B("Hi there,", "Last note from me. We set up an AI assistant that answers calls. Want the recording?"), LEAD, "email4"), ["email4-pitch:hard"]);
    assert.deepEqual(ids(B("Hi there,", "Last note from me. If the recording would help, reply yes and I will send it."), LEAD, "email4"), []);
    assert.deepEqual(ids(B("Hi there,", "We set up an AI assistant that answers calls. Want the recording?"), LEAD, "email2"), []);
  });

  test("F37 opening hours only with a saved source (Blocked); near-misses: hours saved, no hours claim", () => {
    const claim = B("Hi there,", "Since you are open until 9 pm on weekdays, late calls still land. Want the recording?");
    assert.deepEqual(ids(claim), ["hours-unsourced:hard"]);
    assert.deepEqual(ids(B("Hi there,", "Closed on Sundays means Sunday calls wait a day.")), ["hours-unsourced:hard"]);
    const withHours = { ...LEAD, raw: { openingHours: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day) => ({ day, hours: "8 AM to 9 PM" })) } };
    assert.deepEqual(ids(claim, withHours), []);
    // Google's hours are a source even when the site's own wording makes them doubtful (hours_usable false): a real case on dev.
    assert.deepEqual(ids(B("Hi there,", "Closed on Sundays means Sunday calls wait a day."), { ...withHours, site_check: { hours_usable: false } }), []);
    assert.deepEqual(ids(B("Hi there,", "Calls come in while the crew is busy on a job.")), []);
  });

  test("F40: \"not tap-to-call\" is Blocked unless the page turns phone links off; near-miss: no such claim", () => {
    const claim = B("Hi there,", "Your number is not tappable on a phone, so callers give up.");
    assert.deepEqual(ids(claim), ["tap-claim:hard"]);
    assert.deepEqual(ids(claim, { ...LEAD, site_check: { facts: [{ key: "phone_not_tappable", value: true }] } }), ["tap-claim:hard"], "the fact alone is unconfirmed (phones link plain numbers)");
    assert.deepEqual(ids(claim, { ...LEAD, site_check: { facts: [{ key: "phone_not_tappable", value: true, no_autolink: true }] } }), []);
    assert.deepEqual(ids(B("Hi there,", "Callers reach you fast.")), []);
  });
});

describe("5b on save and on re-check (dev, rolled back)", () => {
  const seed = async (tx, body, extra = {}) => {
    await tx`insert into campaigns (id, blob_key, name, country, any_trade, created_at, updated_at, data) values ('mc-camp', 'mc-camp', 'Made-up Campaign', 'US', true, now(), now(), ${tx.json({})})`;
    await tx`insert into leads (id, campaign_id, blob_key, name, email, email_key, website, category, stop_state, created_at, data)
             values ('mc-l1', 'mc-camp', 'mc-camp/mc-l1', 'Made-up Plumbing', 'rob@madeup-other-test.com', 'rob@madeup-other-test.com', 'https://madeupplumbing-test.com/', 'Plumber', 'none', now(), ${tx.json({})})`;
    await tx`insert into emails ${tx({ id: "mc-e1", blob_key: "mc-camp/x-mc-e1", campaign_id: "mc-camp", lead_id: "mc-l1", to_email: "rob@madeup-other-test.com", to_key: "rob@madeup-other-test.com", to_name: "Made-up Plumbing", subject: "made-up calls", body_text: body, step: 1, sequence_total: 1, framework: "one-off", status: "drafted", created_at: new Date(), data: tx.json({}), ...extra })}`;
    return (await tx`select * from emails where id = 'mc-e1'`)[0];
  };

  test("codeCheckDraft runs the lead-aware checks on save (any framework)", async () => {
    const ck = await n.callWrite(async (tx) => checks.codeCheckDraft(tx, await seed(tx, B("Hi there,"))));
    assert.ok(ck.hits.some((h) => h.id === "recipient-domain"), JSON.stringify(ck.hits.map((h) => h.id)));
    assert.equal(ck.status, "check");
  });

  test("a stale block the code checks made is lifted to Check this when the rules no longer find it; read back (F1)", async () => {
    const row = await n.callWrite(async (tx) => {
      const r = await seed(tx, B("Hi there,"), { review_status: "blocked", review_reasons: tx.json(["Rating or review count repeated"]), reviewed_by: "code checks", rules_version: rules.RULES_VERSION - 1 });
      await checks.recheckStaleDrafts(tx, [r]);
      return (await tx`select review_status, reviewed_by, rules_version, review_reasons from emails where id = 'mc-e1'`)[0];
    });
    assert.equal(row.review_status, "check");
    assert.equal(row.reviewed_by, null);
    assert.equal(row.rules_version, rules.RULES_VERSION);
    assert.match(row.review_reasons[0], /rules changed/);
  });

  test("near-miss: a block she or the reviewer made is never lifted by a re-check", async () => {
    const row = await n.callWrite(async (tx) => {
      const r = await seed(tx, B("Hi there,"), { review_status: "blocked", review_reasons: tx.json(["Reviewer: wrong trade"]), reviewed_by: "gemini-reviewer", rules_version: rules.RULES_VERSION - 1 });
      await checks.recheckStaleDrafts(tx, [r]);
      return (await tx`select review_status from emails where id = 'mc-e1'`)[0];
    });
    assert.equal(row.review_status, "blocked");
  });
});

describe("5b named cases on their real drafts (dev, read only)", { skip: !existsSync(NAMED) && "named-cases list not found" }, () => {
  test("each named case gives the expected result", async () => {
    const { messages = [] } = JSON.parse(readFileSync(NAMED, "utf8"));
    assert.ok(messages.length > 0, "the list has message cases");
    let checked = 0;
    for (const c of messages) {
      const rows = await n.call((tx) => tx`select e.* from emails e join leads l on l.id = e.lead_id where lower(l.name) like ${`%${c.name_like}%`} and l.merged_into is null and e.status = 'drafted' and not e.is_duplicate order by e.step`);
      assert.ok(rows.length > 0, `named case ${checked + 1} has drafts on dev`);
      for (const r of rows) {
        if (c.expect_hit) {
          const ck = await n.call((tx) => checks.codeCheckDraft(tx, r));
          assert.ok(ck.hits.some((h) => h.id === c.expect_hit), `named case ${checked + 1} step ${r.step}: expected ${c.expect_hit}, got ${ck.hits.map((h) => h.id)}`);
          assert.notEqual(ck.status, "ready", `named case ${checked + 1} step ${r.step} is not ready`);
        }
        if (c.name_twice_passes) {
          // F38 on the real writer's text: the same draft with the business named a second time is not a repeated rating.
          const [lead] = await n.call((tx) => tx`select name from leads where id = ${r.lead_id}`);
          const text = `${r.body_text}\n\n${lead.name} again: ${lead.name} came up twice.`;
          const hits = rules.checkStep(`email${Math.min(4, r.step)}`, text, { ratingAlready: true, businessName: lead.name });
          assert.ok(!hits.some((h) => h.id === "rating-twice"), `named case ${checked + 1} step ${r.step}: the name is no rating`);
          const plain = rules.checkStep(`email${Math.min(4, r.step)}`, text, { ratingAlready: true });
          assert.ok(!plain.some((h) => h.id === "rating-twice"), `named case ${checked + 1} step ${r.step}: also without the name given (the old path)`);
        }
      }
      checked++;
    }
    console.log(`named message cases: ${checked} of ${messages.length} give the expected result`);
  });
});
