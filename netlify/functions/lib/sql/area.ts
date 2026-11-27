// A campaign's country and time zone from its area ("Katy, TX", "Pearland, Texas, USA"). The same rule as the
// P1 import (scripts/db/normalise.mjs areaCountry); a test checks they agree on every imported area.
import { STATE_TZ } from "../replydraft.ts";

const STATE_NAMES: Record<string, string> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };

/** US areas give { country: "US", time_zone }; anything else gives nulls (filled in when other countries are added). */
export function areaCountry(area: unknown): { country: string | null; time_zone: string | null } {
  const parts = String(area ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (/^(usa|us|united states)$/i.test(parts.at(-1) ?? "")) parts.pop();
  const last = parts.length > 1 ? parts.at(-1)! : "";
  const state = STATE_TZ[last.toUpperCase()] ? last.toUpperCase() : STATE_NAMES[last.toLowerCase()] ?? null;
  return state ? { country: "US", time_zone: STATE_TZ[state] ?? null } : { country: null, time_zone: null };
}
