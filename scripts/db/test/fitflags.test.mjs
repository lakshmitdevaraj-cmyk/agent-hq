// F32 / F33 lead flags (chunk 4): each rule with a made-up hit and a near-miss, the fix list's named cases (looked up
// on dev from a list kept OUTSIDE the repo, because lead names never go into this public repo), and draftAllowed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAMED = join(homedir(), "agent-hq-backups", "p2-named-cases.json");

describe("F32 / F33 lead flags", () => {
  let n, ff;
  before(async () => {
    n = (await import("../equiv/new-path.mjs")).openNew("dev");
    ff = await import("../../../netlify/functions/lib/sql/fitflags.ts");
  });
  after(() => n?.close());
  const codes = (lead) => ff.leadFlags(lead).map((f) => f.code);

  test("chain: a franchise location page, a brand name, 'franchise' wording; near-miss: a one-site business", () => {
    assert.ok(codes({ name: "Made-up Restoration of Spring", website: "https://www.bigbrand-test.com/locations/spring/" }).includes("chain"));
    assert.ok(codes({ name: "Made-up Restoration of Houston", website: "https://www.bigbrand-test.com/houston-tx-made-up/" }).includes("chain"));
    assert.ok(!codes({ name: "Made-up Restoration", website: "https://www.madeup-test.com/drain-in-katy" }).includes("chain"), "a word like \"in\" is not read as a state");
    assert.ok(codes({ name: "PuroClean of Somewhere", website: null }).includes("chain"));
    assert.ok(codes({ name: "Made-up Plumbing, an independently owned franchise", website: "https://madeup-test.com/" }).includes("chain"));
    assert.ok(!codes({ name: "Made-up Plumbing", website: "https://madeup-test.com/" }).includes("chain"));
    assert.ok(!codes({ name: "Made-up Plumbing", website: "https://madeup-test.com/services/drain-cleaning" }).includes("chain"));
  });

  test("not_home_service: gym, real estate, truck repair; near-miss: plumber", () => {
    for (const category of ["Gym", "Real estate rental agency", "Truck repair shop", "Restaurant"]) assert.ok(codes({ name: "Made-up", category }).includes("not_home_service"), category);
    assert.ok(!codes({ name: "Made-up", category: "Plumber" }).includes("not_home_service"));
  });

  test("too_big: 1,000+ reviews; near-miss: 999", () => {
    assert.ok(codes({ name: "Made-up", category: "Plumber", reviews_count: 1000 }).includes("too_big"));
    assert.ok(!codes({ name: "Made-up", category: "Plumber", reviews_count: 999 }).includes("too_big"));
  });

  test("has_answering_booking: online booking and chat or 24/7; near-miss: booking alone", () => {
    assert.ok(codes({ name: "Made-up", site_check: { booking_tool: "Made-up Booker", chat_widget: "Made-up Chat" } }).includes("has_answering_booking"));
    assert.ok(codes({ name: "Made-up", site_check: { booking_tool: "Made-up Booker", mentions_24_7: true } }).includes("has_answering_booking"));
    assert.ok(!codes({ name: "Made-up", site_check: { booking_tool: "Made-up Booker" } }).includes("has_answering_booking"));
  });

  test("not_call_driven: remodeler, design-build, custom builder, rentals, supplier; near-miss: HVAC repair", () => {
    for (const l of [{ name: "Made-up", category: "Remodeler" }, { name: "Made-up Design-Build", category: "General contractor" }, { name: "Made-up Custom Homes", category: "Home builder" },
      { name: "Made-up Air & Power Rentals", category: "HVAC contractor" }, { name: "Made-up Plumbing Supply", category: "Plumbing supply store" }]) assert.ok(codes(l).includes("not_call_driven"), l.name);
    assert.ok(!codes({ name: "Made-up Air", category: "HVAC contractor" }).includes("not_call_driven"));
  });

  test("template_site: a keyword domain; near-miss: a brand domain", () => {
    assert.ok(codes({ name: "Made-up Plumbing", address: "1 Test St, Katy, TX 77494", website: "https://katyplumbingrepair.com/" }).includes("template_site"));
    assert.ok(!codes({ name: "Made-up Plumbing", address: "1 Test St, Katy, TX 77494", website: "https://madeupplumbing-test.com/" }).includes("template_site"));
  });

  test("draftAllowed: no flags, or kept by her (not_fit_kept); a flagged lead is refused", () => {
    assert.equal(ff.draftAllowed({ name: "Made-up", category: "Plumber" }).ok, true);
    const flagged = { name: "Made-up", category: "Gym" };
    assert.equal(ff.draftAllowed(flagged).ok, false);
    assert.match(ff.draftAllowed(flagged).reason, /not a home service/i);
    assert.equal(ff.draftAllowed({ ...flagged, not_fit_kept: true }).ok, true);
  });

  test("the fix list's named cases on dev are each flagged (list kept outside the repo)", { skip: !existsSync(NAMED) && "named-cases list not found" }, async () => {
    const { cases } = JSON.parse(readFileSync(NAMED, "utf8"));
    const { leadRecord } = await import("../../../netlify/functions/lib/sql/leads.ts");
    let checked = 0;
    for (const c of cases) {
      const rows = await n.call((tx) => tx`select * from leads where lower(name) like ${`%${c.name_like}%`} and merged_into is null`);
      assert.ok(rows.length > 0, `named case ${checked + 1} is on dev`);
      for (const r of rows) assert.ok(codes(leadRecord(r)).includes(c.flag), `named case ${checked + 1}: expected ${c.flag}, got ${codes(leadRecord(r))}`);
      checked++;
    }
    console.log(`named cases: ${checked} of ${cases.length} flagged as the fix list expects`);
  });

  test("on dev: how many live leads each flag catches (for the report)", async () => {
    const { leadRecord } = await import("../../../netlify/functions/lib/sql/leads.ts");
    const rows = await n.call((tx) => tx`select * from leads where merged_into is null and not is_test`);
    const counts = {};
    for (const r of rows) for (const f of ff.leadFlags(leadRecord(r))) counts[f.code] = (counts[f.code] ?? 0) + 1;
    console.log(`flags on ${rows.length} live leads: ${JSON.stringify(counts)}`);
    assert.ok(rows.length > 0);
  });
});
