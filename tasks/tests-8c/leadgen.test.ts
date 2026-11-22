import assert from "node:assert/strict";
import { leadGenSigns, leadGenDecision, parseStoredSigns, otherRuleDecision } from "../../netlify/functions/lib/leadgen";
import { socialSkipReason } from "../../netlify/functions/lib/social";
import { leadGenWebsite } from "../../netlify/functions/lib/sitecheck";

let n = 0;
let failed = 0;
const t = (name: string, fn: () => void) => { try { fn(); n++; console.log("ok  " + name); } catch (e) { failed++; console.log("FAIL " + name + "  -> " + String((e as Error).message).split("\n")[0].slice(0, 200)); } };

const L = (o: Record<string, unknown> = {}) => ({ name: "Some Business", website: "https://acme-home.com", address: "1 Main St, League City, TX 77573", phone: "(281) 555-0101", reviews_count: 3, ...o });

// ── signs ─────────────────────────────────────────────────────────────
t("sign: website name is only trade words and a town", () => {
  const s = leadGenSigns(L({ name: "Wexlin HVAC", website: "https://hvacrepairleaguecity.com" }));
  assert.ok(s.some((x) => x.code === "domain_keyword"), JSON.stringify(s));
});
t("sign: free Google Sites page", () => {
  assert.ok(leadGenSigns(L({ website: "https://sites.google.com/view/water-heater-repair-houston" })).some((x) => x.code === "google_sites"));
});
t("sign: throwaway ending with trade word", () => {
  assert.ok(leadGenSigns(L({ website: "https://acmeplumbing.xyz" })).some((x) => x.code === "throwaway_domain"));
});
t("sign: domain unrelated to the business name on a throwaway ending", () => {
  assert.ok(leadGenSigns(L({ name: "Oasis System HVAC", website: "https://brooksdaniel.site" })).some((x) => x.code === "unrelated_domain"));
});
t("sign: one city page on a keyword website", () => {
  assert.ok(leadGenSigns(L({ website: "https://hvac-repair-guys.com/Dickinson" })).some((x) => x.code === "city_page"));
});
t("sign: a name with initials or LLC/Inc/Co is a company name, not trade words and a town", () => {
  for (const nm of ["MPG Plumbing LLC", "ABC Pasadena Air & Heating", "League City HVAC & Duct Services Co.", "Katy Plumbing Inc"]) assert.ok(!leadGenSigns(L({ name: nm, website: "https://acme-home.com" })).some((x) => x.code === "name_trade"), nm);
  // HVAC / AC / TX are trade words, not initials: these still count
  assert.ok(leadGenSigns(L({ name: "Conroe AC Repair", website: "https://acme-home.com", address: "1 Main St, Conroe, TX 77301" })).some((x) => x.code === "name_trade"));
  // an old stored name sign is dropped for such a name too
  assert.ok(!leadGenSigns(L({ name: "MPG Plumbing LLC", site_check: { lead_gen_listing: "The business name is only trade words and a town" } })).some((x) => x.code === "name_trade"));
  assert.equal(leadGenDecision(L({ name: "MPG Plumbing LLC", reviews_count: 2, address: "1 Main St, Katy, TX 77494" }), false), null);
});
t("sign: the Google business name is only trade words and a town", () => {
  assert.ok(leadGenSigns(L({ name: "HVAC Repair League City", website: "https://acme-home.com" })).some((x) => x.code === "name_trade"));
});
t("no sign for a normal local company", () => {
  assert.deepEqual(leadGenSigns(L({ name: "Bluewater Plumbing", website: "https://bluewaterplumbing.com" })), []);
});
t("an invalid security certificate is NEVER a sign (old stored text with only that and a toll-free number)", () => {
  const stored = "The website has an invalid security certificate; The main phone number is toll-free (800 555 1234)";
  assert.deepEqual(parseStoredSigns(stored), []);
  assert.deepEqual(leadGenSigns(L({ site_check: { lead_gen_listing: stored } })), []);
});
t("toll-free alone is no sign; toll-free plus a page title that does not name the business is", () => {
  assert.deepEqual(parseStoredSigns("The main phone number is toll-free (888 555 1234)"), []);
  const s = parseStoredSigns('The main phone number is toll-free (888 555 1234); The page title ("Best HVAC Repair Fast") does not name the business');
  assert.deepEqual(s.map((x) => x.code), ["toll_free_title"]);
});
t("old stored text: directory wording, network, listing host, keyword domain, city page are each read as a sign", () => {
  assert.deepEqual(parseStoredSigns('Site wording looks like a directory: "find a plumber near"').map((x) => x.code), ["directory"]);
  assert.deepEqual(parseStoredSigns("The site links to 5 other companies' websites as a network").map((x) => x.code), ["network"]);
  assert.deepEqual(parseStoredSigns("The website is angi.com, a listing site").map((x) => x.code), ["directory"]);
  assert.deepEqual(parseStoredSigns('The website name "x.com" is only trade words and the town, with no company name').map((x) => x.code), ["domain_keyword"]);
  assert.deepEqual(parseStoredSigns("The address x.com/Dickinson is one city page on a keyword website (a directory page)").map((x) => x.code), ["city_page"]);
  assert.deepEqual(parseStoredSigns("The site lists 9 towns it serves; The website has an invalid security certificate"), []);
});
t("old text for a lead with no website: a name stuffed with trade keywords is a sign", () => {
  assert.deepEqual(parseStoredSigns("No website, a name stuffed with trade keywords, and few reviews").map((x) => x.code), ["name_trade"]);
});
t("the OLD rule used an invalid certificate as a lead-gen sign; the new site check does not", () => {
  const r = leadGenWebsite([], "https://acme-home.com", { name: "Acme Home", phone: "800 555 1234", tls_problem: true, reviews_count: 3 });
  assert.equal(r, null);
});

// ── decision: hide / flag / flag-because-contacted ─────────────────────
const KW = { name: "HVAC Repair League City", website: "https://hvacrepairleaguecity.com" };
t("HIDE: under 10 reviews, one sign, not contacted", () => {
  const d = leadGenDecision(L({ ...KW, reviews_count: 3 }), false)!;
  assert.equal(d.hide, true);
});
t("HIDE: missing review count counts as 0", () => {
  assert.equal(leadGenDecision(L({ ...KW, reviews_count: undefined }), false)!.hide, true);
  assert.equal(leadGenDecision(L({ ...KW, reviews_count: null }), false)!.hide, true);
});
t("boundary: 9 reviews hides, 10 reviews is flagged and visible", () => {
  assert.equal(leadGenDecision(L({ ...KW, reviews_count: 9 }), false)!.hide, true);
  const d = leadGenDecision(L({ ...KW, reviews_count: 10 }), false)!;
  assert.equal(d.hide, false);
  assert.equal(d.why, "reviews");
});
t("FLAG: thousands of reviews (24/7 Plumbing 2098, Katy 3751) are never hidden", () => {
  for (const r of [2098, 3751, 1742, 1707, 1486, 1092]) assert.equal(leadGenDecision(L({ ...KW, reviews_count: r }), false)!.hide, false, String(r));
});
t("FLAG-BECAUSE-CONTACTED: low reviews and a sign, but already contacted", () => {
  const d = leadGenDecision(L({ ...KW, reviews_count: 2 }), true)!;
  assert.equal(d.hide, false);
  assert.equal(d.why, "contacted");
  assert.ok(d.reasons.length >= 1);
});
t("no sign means no decision at all, whatever the reviews", () => {
  assert.equal(leadGenDecision(L({ reviews_count: 0 }), false), null);
});
t("reasons are the sign texts", () => {
  const d = leadGenDecision(L({ name: "Oasis System HVAC", website: "https://brooksdaniel.site", reviews_count: 1 }), false)!;
  assert.ok(d.reasons.some((r) => /brooksdaniel\.site/.test(r)), d.reasons.join("|"));
});
t("borderline small real-looking business with a sign still hides (listed in the report, not special-cased)", () => {
  assert.equal(leadGenDecision(L({ name: "Trusty Plumbers", website: "https://trustyplumbers.xyz", reviews_count: 8 }), false)!.hide, true);
});

// ── the other auto rules never hide a contacted lead ───────────────────
t("chain, wholesaler, rental, not-home-service: hide when not contacted, FLAG when contacted", () => {
  for (const code of ["chain", "wholesaler", "not_home_service"]) {
    assert.equal(otherRuleDecision({ code, detail: "x" }, false).hide, true, code + " not contacted");
    const c = otherRuleDecision({ code, detail: "x" }, true);
    assert.equal(c.hide, false, code + " contacted");
    assert.equal(c.why, "contacted");
  }
  assert.equal(otherRuleDecision({ code: "other", detail: "x" }, true).hide, false);
});

// ── social skip follows the same decision ──────────────────────────────
const ctx = { location: null, query: "", anyTrade: true };
const sk = (lead: Record<string, unknown>, contacted = false) => socialSkipReason({ name: "Acme", email: null, site_check: { checked_at: "2026-11-01", ...(lead.site_check as object) }, ...lead } as never, ctx, { replied: false, manualStart: true, contacted });
const SIGN = 'The website name "x.com" is only trade words and the town, with no company name';
t("social: a lead the page would HIDE is skipped", () => assert.match(sk({ reviews_count: 2, site_check: { lead_gen_listing: SIGN } }) ?? "", /lead-gen/i));
t("social: a visible flagged lead (10+ reviews) is NOT skipped", () => assert.equal(sk({ reviews_count: 150, site_check: { lead_gen_listing: SIGN } }), null));
t("social: a flagged lead that was contacted is NOT skipped", () => assert.equal(sk({ reviews_count: 2, site_check: { lead_gen_listing: SIGN } }, true), null));

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
