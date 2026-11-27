// R13 case: outreach.campaign.update, a run of patches on one campaign, each answer compared, then read back (F1).
import { get, update } from "../../../../netlify/functions/lib/sql/campaigns.ts";
import { asResponse } from "./shared.mjs";

export const action = "outreach.campaign.update";

/** Patches in order; each builds on the one before (on both sides). */
export const steps = [
  { name: "Renamed by the equivalence test" },
  { any_trade: false },
  { default_sender_name: null },
  { default_sender_company: "Test Co", default_framework: "four-step" },
  { job: { kind: "generate", status: "running", total: 5, done: 0, made: 0 } },
  { job: { kind: "generate", status: "running", total: 5, done: 2, made: 2, resume: true } },
  { job: { kind: "generate", status: "done", total: 5, done: 5, made: 5 } },
  { browser_checked_ids: ["equiv-a", "equiv-b"] },
  { status: "ready" },
  { equiv_new_flag: "kept in data" },
  { any_trade: true, description: "both at once" },
  { job: null },
];

export async function sqlVersion(tx, { id }) {
  const answers = [];
  for (const patch of steps) answers.push(await asResponse(() => update(tx, { id, ...patch })));
  const missingId = await asResponse(() => update(tx, { name: "x" }));
  const unknownId = await asResponse(() => update(tx, { id: "no-such-campaign-equiv", name: "x" }));
  const readBack = await asResponse(() => get(tx, id));
  return { answers, missingId, unknownId, readBack };
}
