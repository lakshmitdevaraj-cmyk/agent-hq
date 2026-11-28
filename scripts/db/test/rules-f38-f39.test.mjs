// P2 chunk 5b: F38 ("5 Star" in a business name is not a rating) and F39 (the sameness check ignores the offer's core
// sentence; "busy service schedules" is not the assistant scheduling). Each is proved both ways: the false alarm is gone
// AND the real problem is still caught. The rule files are bundled in memory (they use extensionless imports).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

let mr, ag;
before(async () => {
  const out = await build({
    stdin: { contents: 'export * as mr from "./netlify/functions/lib/messagerules.ts"; export * as ag from "./netlify/functions/lib/angle.ts";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  });
  ({ mr, ag } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`));
});

describe("F38: a business called \"5 Star ...\" is not a rating", () => {
  const ids = (text, ctx = {}) => mr.checkStep("email2", text, { ratingAlready: true, ...ctx }).map((h) => h.id);

  test("the name mentioned twice passes (the rating rule does not fire)", () => {
    const text = "Hi there,\n\nI was looking at 5 Star Made-up Air again this week. When 5 Star Made-up Air is out on a job, calls still come in.\n\nWant me to send it over?";
    assert.ok(!ids(text).includes("rating-twice"), "5 Star Made-up Air named twice is not a repeated rating");
    assert.equal(mr.mentionsRating("Thanks for calling 5 Star Plumbing"), false);
    assert.equal(mr.mentionsRating("5 Star Heating & Air answers fast"), false);
    // With the lead's name given, a lower-case spelling of it is left out too.
    assert.ok(!ids("we wrote to 5 star pros last week", { businessName: "5 Star Pros" }).includes("rating-twice"));
  });

  test("a real rating claim is still Blocked when the rating was already used", () => {
    for (const claim of ["You have 5 stars on Google.", "You have 5 Stars On Google.", "a 4.9 star rating", "your 5-star reviews", "120 Google reviews", "You have 5 Stars.", "rated 4.8/5"]) {
      const hits = mr.checkStep("email2", `Hi there,\n\n${claim} Calls still come in while you are on a job.`, { ratingAlready: true });
      assert.ok(hits.some((h) => h.id === "rating-twice" && h.level === "hard"), `still caught: ${claim}`);
      assert.equal(mr.statusOf(hits).status, "blocked", claim);
      assert.equal(mr.mentionsRating(claim), true, claim);
    }
    // The name does not hide a real rating next to it.
    assert.ok(ids("5 Star Made-up Air has 5 stars on Google", { businessName: "5 Star Made-up Air" }).includes("rating-twice"));
  });
});

describe("F39: sameness ignores the offer sentence, still catches real copying", () => {
  const offer = "At Made-up AI, we set up a friendly AI assistant for local home service owners like you, so that no customer is ever lost.";
  const a = { subject: "missed calls at made-up plumbing", body: "Hi Sam,\n\nI saw Made-up Plumbing has been fixing water heaters in Katy since 2004. At Made-up AI we set up a friendly AI assistant for local home service owners like you, so that no customer is ever lost. Want me to send a short recording?" };
  const b = { subject: "made-up roofing after storms", body: "Hi Jo,\n\nStorm season must keep Made-up Roofing busy on ladders all day. At Made-up AI we set up a friendly AI assistant for local home service owners like you, so that no customer is ever lost. Should I send the recording?" };

  test("two drafts that share only the offer sentence pass", () => {
    assert.equal(ag.samenessProblem(a, [b], [], [offer]), null);
    // Without the offer to compare with, the same pair is flagged: the fix comes from the offer, not a looser limit.
    assert.match(ag.samenessProblem(a, [b], []) ?? "", /repeats 12\+ words/);
  });

  test("two drafts that are genuinely alike are still flagged", () => {
    const shared = "Most of the calls that come in while the crew is on a roof end up with whoever picks up first";
    const c = { ...a, body: a.body.replace("Want me", `${shared}. Want me`) };
    const d = { ...b, body: b.body.replace("Should I", `${shared}. Should I`) };
    assert.match(ag.samenessProblem(c, [d], [], [offer]) ?? "", /repeats 12\+ words/);
  });

  test("\"scheduling\": busy service schedules pass; the assistant scheduling is still caught", () => {
    const check = (body) => ag.checkModelDraft({ subject: "made-up plumbing calls", body, fact_used: null }, 0, {});
    const unoffered = (body) => check(body).some((f) => /scheduling, dispatch, quotes or payments/.test(f));
    assert.equal(unoffered("When it gets this busy, service schedules fill up and calls go to voicemail."), false);
    assert.equal(unoffered("We know a busy service schedule leaves little time for the phone."), false);
    assert.equal(unoffered("Our assistant schedules the job for you."), true);
    assert.equal(unoffered("The assistant also handles your scheduling and quotes."), true);
    assert.equal(unoffered("It books the appointment straight away."), true);
  });

  test("\"scheduling\": the busy/team/crew exception is their schedule only, never ours", () => {
    const check = (body) => ag.checkModelDraft({ subject: "made-up plumbing calls", body, fact_used: null }, 0, {});
    const unoffered = (body) => check(body).some((f) => /scheduling, dispatch, quotes or payments/.test(f));
    // Hits: "our team" / "we" is the one booking.
    assert.equal(unoffered("Our team books jobs fast."), true);
    assert.equal(unoffered("Our busy team books jobs while you work."), true);
    assert.equal(unoffered("Our crew schedules every visit for you."), true);
    assert.equal(unoffered("We're a team booking jobs around the clock."), true);
    assert.equal(unoffered("We are a crew dispatching techs for you."), true);
    // Near misses: their team, their crew, their schedule.
    assert.equal(unoffered("We answer calls so your team books more jobs."), false);
    assert.equal(unoffered("We pick up while your crew schedules the next visit."), false);
    assert.equal(unoffered("We know your busy service schedules fill up fast."), false);
    assert.equal(unoffered("It answers while your team schedules jobs."), false);
  });
});
