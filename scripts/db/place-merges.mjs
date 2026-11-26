// Duplicates where neither row has an email: merged only when the Google place id is the same.
// Keeps the row that has messages, touches, follow-up records or a Facebook-checked note.
// If both have any of these (or the merge would drop a flag), the pair is left for Lakshmi.

export function placeMerges(tables, placeOf) {
  const count = (name, id) => tables[name].filter((r) => r.lead_id === id).length;
  const records = (l) => ({
    messages: count("emails", l.id) + count("social_messages", l.id) + count("replies", l.id),
    touches: count("touches", l.id),
    followups: count("follow_up_state", l.id) + count("follow_ups", l.id),
    facebook: l.data?.fb_checked || /facebook checked/i.test(l.excluded_note ?? "") ? 1 : 0,
  });
  const hasRecords = (l) => Object.values(records(l)).some(Boolean);
  const holds = (l) => [l.site_check, l.owner_name, l.data?.notes, l.excluded, l.not_fit_kept, l.do_not_contact].filter(Boolean).length + count("lead_social_links", l.id);
  const flagLost = (keep, merge) => ["excluded", "do_not_contact", "not_fit_kept"].filter((f) => merge[f] && !keep[f]);

  const groups = new Map();
  for (const l of tables.leads) {
    const place = !l.email_key && !l.is_test && !l.merged_into ? placeOf(l) : null;
    if (!place) continue;
    const key = `${l.campaign_id}|${place}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(l);
  }

  const merges = [], left = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ids = group.map((l) => l.id).sort();
    const withRecords = group.filter(hasRecords);
    if (withRecords.length > 1) { left.push({ ids, why: "more than one row has records" }); continue; }
    const [keep, ...rest] = [...group].sort((a, b) => Number(hasRecords(b)) - Number(hasRecords(a)) || holds(b) - holds(a) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
    const lost = rest.flatMap((l) => flagLost(keep, l));
    if (lost.length) { left.push({ ids, why: `merging would drop: ${[...new Set(lost)].join(", ")}` }); continue; }
    const reason = hasRecords(keep) ? "has records" : holds(keep) > Math.max(...rest.map(holds)) ? "holds more (website check, links, owner)" : "older (both empty alike)";
    for (const l of rest) merges.push({ keep: keep.id, merge: l.id, reason, kept: records(keep) });
  }
  return { merges, left };
}
