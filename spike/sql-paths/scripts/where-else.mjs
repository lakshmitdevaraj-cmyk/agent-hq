// Netlify credit estimate: rates from netlify.com/pricing and docs.netlify.com (25 Nov 2026); the usage figures are assumptions.
import { writeFileSync } from "node:fs";
const rates = { credits_per_gb_hour: 10, function_memory_gb: 1, credits_per_10k_requests: 2, credits_per_gb_bandwidth: 20, credits_per_production_deploy: 15, free_plan_credits: 300 };
const scenarios = [["light", 500, 1, 1, 4], ["typical", 2000, 1, 3, 4], ["heavy", 5000, 1, 5, 4]].map(([name, per_day, seconds, gb, deploys]) => {
  const requests = per_day * 30;
  const c = { compute: (requests * seconds * rates.function_memory_gb) / 3600 * rates.credits_per_gb_hour, requests: requests / 10000 * rates.credits_per_10k_requests, bandwidth: gb * rates.credits_per_gb_bandwidth, deploys: deploys * rates.credits_per_production_deploy };
  const credits = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v)]));
  return { name, assumed: { api_requests_per_day: per_day, seconds_per_request: seconds, bandwidth_gb_per_month: gb, production_deploys: deploys }, credits, total: Math.round(Object.values(c).reduce((a, b) => a + b, 0)) };
});
writeFileSync(new URL("../results/netlify-estimate.json", import.meta.url), JSON.stringify({ rates, scenarios }, null, 1));
for (const s of scenarios) console.log(s.name, JSON.stringify(s.credits), s.total);
