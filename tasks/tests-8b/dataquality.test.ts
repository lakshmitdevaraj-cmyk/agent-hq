import assert from "node:assert/strict";
import { isJunkEmail } from "../../netlify/functions/lib/outreach";
import { possibleTypoDomain, domainLeadGenFlag, categoryFitFlag } from "../../netlify/functions/lib/leadflags";
import { fitFlags, leadGenWebsite } from "../../netlify/functions/lib/sitecheck";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 160)); } };

t("placeholder addresses are junk: filler@godaddy.com, yourname@example.org and friends", () => {
  for (const e of ["filler@godaddy.com", "yourname@example.org", "name@wix.com", "info@domain.com", "abc@sentry.io", "x@godaddy.com", "someone@example.com"]) assert.equal(isJunkEmail(e), true, e);
  for (const e of ["info@mockplumbing.com", "service@aquatrailsplumbing.com", "owner@gmail.com"]) assert.equal(isJunkEmail(e), false, e);
});

t("possible-typo flag: consolidate.net yes, consolidated.net no; never changes the address", () => {
  const a = possibleTypoDomain("jim@consolidate.net");
  assert.ok(a);
  assert.equal(a!.suggestion, "consolidated.net");
  assert.equal(possibleTypoDomain("jim@consolidated.net"), null);
  assert.equal(possibleTypoDomain("jim@gmial.com")!.suggestion, "gmail.com");
  assert.equal(possibleTypoDomain("jim@gmail.com"), null);
  assert.equal(possibleTypoDomain(null), null);
  assert.equal(possibleTypoDomain("info@mockplumbing.com"), null);
});

const KEYWORD = [
  ["plumbingofcypress.com", "Cypress, TX"], ["911plumbingsugarland.com", "Sugar Land, TX"], ["plumbingofsugarland.com", "Sugar Land, TX"],
  ["waterheaterrepairmissouricity.com", "Missouri City, TX"], ["aircoductcleaningmissouricity.com", "Missouri City, TX"],
  ["txcypresswaterheater.com", "Cypress, TX"], ["plumbingcypresstx.com", "Cypress, TX"],
];
t("the 7 keyword domains are flagged (even with many reviews, and with no city known)", () => {
  for (const [host, city] of KEYWORD) {
    const f = domainLeadGenFlag({ website: `https://www.${host}/`, name: "Some Plumbing", address: `123 Main St, ${city} 77429`, reviews_count: 150 });
    assert.ok(f, `${host} should be flagged`);
  }
});

t("real company domains are not flagged", () => {
  for (const host of ["mockplumbing.com", "aquatrailsplumbing.com", "wilsonsplumbing.com", "gulfcoastair.com"]) {
    assert.equal(domainLeadGenFlag({ website: `https://${host}`, name: "Mock Plumbing", address: "1 Elm St, Houston, TX", reviews_count: 150 }), null, host);
  }
});

t("service@ on a keyword domain, a toll-free number and a throwaway ending add evidence", () => {
  const f = domainLeadGenFlag({ website: "https://plumbingofcypress.com", name: "x", address: "1 Main St, Cypress, TX 77429", email: "service@plumbingofcypress.com", phone: "(800) 555-0199" });
  assert.match(f ?? "", /service@/);
  assert.match(f ?? "", /toll-free/);
  assert.ok(domainLeadGenFlag({ website: "https://bestplumber.xyz", name: "Best Plumber", address: "1 Main St, Cypress, TX 77429" }));
  assert.equal(domainLeadGenFlag({ website: "https://mockplumbing.com", name: "Mock", address: "Houston", email: "service@mockplumbing.com" }), null);
});

t("site check also flags keyword domains with many reviews", () => {
  const r = leadGenWebsite([], "https://plumbingcypresstx.com", { name: "Plumbing Cypress", city: "Cypress", reviews_count: 200 });
  assert.ok(r);
  assert.equal(leadGenWebsite([], "https://mockplumbing.com", { name: "Mock Plumbing", city: "Houston", reviews_count: 200 }), null);
});

const page = (text: string) => [{ url: "https://x.com/", html: `<html><body><p>${text}</p></body></html>` }] as never;
t("fit: rental(s), chillers, nationwide, temporary count as not-home-service words", () => {
  const f = fitFlags(page("Mobile Air & Power Rentals: temporary cooling rental, chillers and generators, nationwide delivery."), "https://mobileair.com", { category: "Equipment rental service" });
  assert.ok(f.not_home_service, "Mobile Air should be flagged");
  assert.equal(fitFlags(page("Family AC repair for homeowners. We serve your home with fast service."), "https://ok.com", { category: "Air conditioning contractor" }).not_home_service, null);
});

t("fit: Engineering consultant / Construction company with industrial-or-commercial-only sites are flagged", () => {
  const f = fitFlags(page("E Contractors builds commercial and industrial projects for owners, general contractors and municipalities."), "https://e.com", { category: "Construction company" });
  assert.ok(f.not_home_service);
  const g = fitFlags(page("Engineering consultant for industrial plants and commercial buildings."), "https://e2.com", { category: "Engineering consultant" });
  assert.ok(g.not_home_service);
  const h = fitFlags(page("We remodel kitchens and bathrooms for homeowners in your home."), "https://h.com", { category: "Construction company" });
  assert.equal(h.not_home_service, null);
});

t("category alone: rental category is flagged at read time", () => {
  assert.ok(categoryFitFlag("Equipment rental service"));
  assert.ok(categoryFitFlag("Generator rental service"));
  assert.equal(categoryFitFlag("Plumber"), null);
  assert.equal(categoryFitFlag(null), null);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
