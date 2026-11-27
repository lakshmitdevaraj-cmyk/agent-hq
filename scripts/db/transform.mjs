// Pure: exported records in, table rows and a report out. No database and no network here.
import { areaCountry, nameKey, normaliseSocialUrl, phoneKey } from "./normalise.mjs";

const REDACTED = "[redacted]";
const P = "agent-hq-";

// ── Field converters: return undefined when a value cannot be converted, so it stays in `data`. ──
const str = (v) => (v === null || typeof v === "string" ? v : undefined);
const num = (v) => (v === null || (typeof v === "number" && Number.isFinite(v)) ? v : undefined);
const int = (v) => (v === null || Number.isInteger(v) ? v : undefined);
const bool = (v) => (typeof v === "boolean" ? v : undefined);
const json = (v) => v;
const time = (v) => (v === null || v === "" ? null : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined);
const review = (v) => (v === null || ["ready", "check", "blocked"].includes(v) ? v : undefined);

/** Columns taken from a record, and everything else as `data`. spec: { column: [field, converter, fallback] } */
function split(rec, spec, drop = []) {
  const data = { ...rec };
  const row = {};
  for (const [column, [field, convert, fallback = null]] of Object.entries(spec)) {
    const value = field in rec ? convert(rec[field]) : undefined;
    row[column] = value === undefined || value === null ? fallback : value;
    if (value !== undefined) delete data[field];
  }
  for (const field of drop) delete data[field];
  row.data = data;
  return row;
}

/** Removes what the export marked as secret (it never goes into the database) and characters Postgres rejects. */
function clean(node) {
  if (typeof node === "string") return node.replaceAll("\u0000", "");
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([, v]) => v !== REDACTED).map(([k, v]) => [k, clean(v)]));
}

const writer = (model) => (/^gemini/i.test(model ?? "") ? "gemini" : /^claude/i.test(model ?? "") ? "claude" : null);
const SOCIAL_STEP = { facebook: { message: 1, follow_up: 2, last: 3 }, instagram: { message: 1, follow_up: 2, last: 3 }, linkedin: { note: 1, dm: 2, follow_up: 3, last: 4 } };
const SENT = (status) => status !== "drafted" && status !== "failed";
const byCreated = (a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id);
const group = (rows, keyOf) => rows.reduce((m, r) => { const k = keyOf(r); (m.get(k) ?? m.set(k, []).get(k)).push(r); return m; }, new Map());

export function transform(stores, { rules, today, exportedAt = `${today}T00:00:00Z`, decisions = {} }) {
  const report = { stores: {}, duplicate_drafts: [], failed_emails: [], bounced_old_address: [], bounced_entry_from_failed_send: [], replied_without_reply_record: [], auto_replies_counted_as_replied: [], state_changes: [], duplicate_leads: [], first_send_at_later_step: [], orphans: {}, campaigns_without_country: [], social_links_unreadable: [], postal_address_filled: false, contact_plus_restored: 0 };

  /** The parsed records of one store, counted. */
  function read(name) {
    const store = P + name;
    const r = (report.stores[store] = { exported: (stores[store] ?? []).length, records: 0, parse_failed: 0, skipped: {} });
    const out = [];
    for (const { key, value } of stores[store] ?? []) {
      let v;
      try { v = JSON.parse(value); } catch { v = undefined; }
      if (!v || typeof v !== "object" || Array.isArray(v)) { r.parse_failed++; continue; }
      out.push({ key, v: clean(v) });
      r.records++;
    }
    return out;
  }
  const skip = (name, why) => { const s = report.stores[P + name].skipped; s[why] = (s[why] ?? 0) + 1; };
  /** One row per primary key; a repeat is counted as skipped. */
  function unique(name, rows, keyOf) {
    const seen = new Map();
    for (const row of rows) {
      const k = keyOf(row);
      if (!k) skip(name, "no id");
      else if (seen.has(k)) skip(name, "same id twice");
      else seen.set(k, row);
    }
    return [...seen.values()];
  }
  /** Stores that map straight across: id column plus the listed fields. */
  const simple = (name, idColumn, spec) => unique(name, read(name).map(({ key, v }) => ({ ...split(v, { [idColumn]: [idColumn, str], ...spec }), blob_key: key })), (r) => r[idColumn]);

  const settingsRows = read("outreach-settings");
  const settings = settingsRows.find((r) => r.key === "settings")?.v ?? {};
  report.postal_address_filled = !!String(settings.postal_address ?? "").trim();

  // ── Campaigns: settings in one table, job progress in another (F2/F3). ──
  const stateBy = new Map(read("outreach-campaign-state").map(({ key, v }) => [key, v]));
  const campaigns = [], jobs = [];
  const campaignZone = new Map();
  for (const { key, v } of unique("outreach-campaigns", read("outreach-campaigns"), (r) => r.v.id)) {
    const state = stateBy.get(v.id) ?? {};
    const merged = { ...v };
    for (const k of ["default_sender_name", "default_sender_company", "default_sender_offer", "default_framework", "default_sequence_total"]) if (k in state) merged[k] = state[k]; // saved state wins, as today
    const area = v.structured_query?.location ?? null;
    const { country, state: usState } = areaCountry(area, rules.STATE_TZ);
    if (!country) report.campaigns_without_country.push({ id: v.id, area });
    const JOB_FIELDS = ["apify_run_id", "apify_dataset_id", "apify_status", "error_message", "last_status_refresh_at", "leads_skipped_duplicate", "leads_skipped_by", "import_started_at"];
    const row = split(merged, {
      id: ["id", str], name: ["name", str, ""], description: ["description", str], niche: ["query", str], created_by: ["created_by", str],
      default_sender_name: ["default_sender_name", str], default_sender_company: ["default_sender_company", str], default_sender_offer: ["default_sender_offer", str],
      default_framework: ["default_framework", str], default_sequence_total: ["default_sequence_total", int], any_trade: ["any_trade", bool, true], // missing = true, as the live app reads it (decision 27 Nov 2026)
      agentmail_inbox_id: ["agentmail_inbox_id", str], created_at: ["created_at", time], updated_at: ["updated_at", time],
    }, ["job", "browser_checked_ids", "status", "total_leads_found", "leads_imported", "last_run_at", ...JOB_FIELDS]);
    Object.assign(row, { blob_key: key, area, country, time_zone: usState ? rules.STATE_TZ[usState] : null });
    campaigns.push(row);
    campaignZone.set(v.id, row.time_zone);

    const blank = { campaign_id: v.id, status: null, total: null, done: null, made: null, started_at: null, progress_at: null, finished_at: null };
    jobs.push({ ...blank, kind: "leads", status: v.status ?? null, total: int(v.total_leads_found) ?? null, done: int(v.leads_imported) ?? null, started_at: time(v.last_run_at) ?? null, data: Object.fromEntries([...JOB_FIELDS, "total_leads_found", "leads_imported", "last_run_at"].filter((k) => k in v).map((k) => [k, v[k]])) });
    const job = state.job ?? v.job;
    if (job?.kind) jobs.push({ ...blank, ...split(job, { status: ["status", str], total: ["total", int], done: ["done", int], made: ["made", int], started_at: ["started_at", time], progress_at: ["progress_at", time], finished_at: ["finished_at", time] }, ["kind"]), kind: job.kind });
    const checked = state.browser_checked_ids ?? v.browser_checked_ids;
    if (checked) jobs.push({ ...blank, kind: "browser_check", data: { browser_checked_ids: checked } });
  }
  const campaignIds = new Set(campaigns.map((c) => c.id));

  // ── Leads ──
  const merges = new Map((decisions.merges ?? []).map((m) => [m.merge, m.keep]));
  const leadOf = (id) => merges.get(id) ?? id;
  const rawLeads = unique("outreach-leads", read("outreach-leads").map(({ key, v }) => ({ ...v, blob_key: key })), (l) => l.id);
  const leads = rawLeads.map((v) => {
    const { blob_key, ...rec } = v;
    const row = split(rec, {
      id: ["id", str], campaign_id: ["campaign_id", str], name: ["name", str], owner_name: ["owner_name", str], contact_name: ["contact_name", str],
      email: ["email", str], phone: ["phone", str], website: ["website", str], address: ["address", str], category: ["category", str],
      rating: ["rating", num], reviews_count: ["reviews_count", int], status: ["status", str], is_test: ["is_test", bool, false],
      excluded: ["excluded", bool, false], excluded_at: ["excluded_at", time], excluded_reason: ["excluded_reason", str], excluded_note: ["excluded_note", str],
      not_fit_kept: ["not_fit_kept", bool, false], do_not_contact: ["do_not_contact", bool, false], do_not_contact_at: ["do_not_contact_at", time], do_not_contact_reason: ["do_not_contact_reason", str],
      gap_score: ["gap_score", num], site_check: ["site_check", json], enriched_at: ["enriched_at", time], browser_checked_at: ["browser_checked_at", time], contacted_at: ["contacted_at", time],
      created_at: ["created_at", time], updated_at: ["updated_at", time], email_source: ["email_source", str],
    });
    const email_key = rules.emailKey(row.email);
    if (!row.email_source && row.email) {
      const fromMaps = (rec.raw?.emails ?? []).some((e) => rules.emailKey(e) === email_key);
      row.email_source = row.is_test ? "manual" : fromMaps || !rec.enrichment_source ? "google_maps" : rec.site_check?.via === "browser" ? "browser" : "site_check";
    }
    const usState = rules.stateFromAddress(row.address);
    return {
      ...row, blob_key, email_key, website_key: rules.websiteKey(row.website),
      city: (typeof rec.raw?.city === "string" && rec.raw.city) || (/([^,]+),\s*[A-Z]{2}\b/.exec(row.address ?? "")?.[1].trim() ?? null),
      time_zone: (usState && rules.STATE_TZ[usState]) || campaignZone.get(row.campaign_id) || null,
      merged_into: merges.get(row.id) ?? null, stop_state: "none", stop_reason: null, stopped_at: null,
    };
  });
  const leadById = new Map(leads.map((l) => [l.id, l]));

  // ── Social links (F12/F13/F14) ──
  const pages = new Map(), links = new Map();
  for (const rec of rawLeads) {
    const source = rec.site_check?.via === "browser" ? "browser" : "site_check";
    for (const [kind, url] of Object.entries(rec.social ?? {})) {
      if (!url) continue;
      const n = normaliseSocialUrl(url);
      if (!n) { report.social_links_unreadable.push({ lead_id: rec.id, kind }); continue; }
      if (!pages.has(n.url_norm)) pages.set(n.url_norm, { platform: n.platform, url_norm: n.url_norm, url });
      links.set(`${rec.id}/${kind}`, { lead_id: rec.id, kind, url_norm: n.url_norm, url, source, updated_at: time(rec.enriched_at) || time(rec.created_at) || exportedAt });
    }
  }
  // An approved merge gives the kept lead any page only the merged one had.
  for (const [from, to] of merges) for (const l of [...links.values()]) if (l.lead_id === from && !links.has(`${to}/${l.kind}`)) links.set(`${to}/${l.kind}`, { ...l, lead_id: to });

  /** Moves a message of a merged lead to the kept one, remembering where it was. */
  const rehome = (row) => (row.lead_id && merges.has(row.lead_id) ? { ...row, lead_id: leadOf(row.lead_id), data: { ...row.data, original_lead_id: row.lead_id } } : row);

  // ── Emails ──
  const moves = new Map((decisions.email_steps ?? []).map((s) => [s.email_id, s]));
  const emails = unique("outreach-emails", read("outreach-emails").map(({ key, v }) => {
    const row = split(v, {
      id: ["id", str], campaign_id: ["campaign_id", str], lead_id: ["lead_id", str], to_email: ["to_email", str], to_name: ["to_name", str],
      subject: ["subject", str], body_text: ["body_text", str], body_html: ["body_html", str], sender_name: ["sender_name", str],
      step: ["sequence_position", int, 1], sequence_total: ["sequence_total", int], framework: ["framework", str], status: ["status", str, "drafted"], error: ["error", str],
      review_status: ["review_status", review], review_reasons: ["review_reasons", json], reviewed_by: ["reviewed_by", str], reviewed_at: ["reviewed_at", time],
      rules_version: ["rules_version", int], written_model: ["written_by", str], source: ["source", str], edited: ["edited", bool, false],
      agentmail_message_id: ["agentmail_message_id", str], agentmail_thread_id: ["agentmail_thread_id", str], agentmail_inbox_id: ["agentmail_inbox_id", str],
      sent_at: ["sent_at", time], delivered_at: ["delivered_at", time], bounced_at: ["bounced_at", time], replied_at: ["replied_at", time],
      click_count: ["click_count", int, 0], last_clicked_at: ["last_clicked_at", time], created_at: ["created_at", time], updated_at: ["updated_at", time],
    });
    const move = moves.get(row.id);
    if (move) {
      row.data.original_step = row.step;
      row.step = move.step;
      if (move.sequence_total) { row.data.original_sequence_total = row.sequence_total; row.sequence_total = move.sequence_total; }
    }
    return rehome({ ...row, blob_key: key, to_key: rules.emailKey(row.to_email), written_by: writer(row.written_model), is_duplicate: false });
  }), (e) => e.id);

  /** F9: when two rows claim one step, the sent (else newest) one counts; the rest are kept and marked. */
  function markDuplicates(rows, keyOf, what) {
    for (const [k, list] of group(rows, keyOf)) {
      if (!k || list.length < 2) continue;
      list.sort((a, b) => Number(SENT(b.status)) - Number(SENT(a.status)) || byCreated(b, a));
      for (const extra of list.slice(1)) extra.is_duplicate = true;
      report.duplicate_drafts.push({ what, kept: list[0].id, marked: list.slice(1).map((r) => ({ id: r.id, status: r.status })), lead_id: list[0].lead_id });
    }
  }
  markDuplicates(emails.filter((e) => e.status !== "failed"), (e) => (e.lead_id ? `${e.lead_id}/${e.step}` : null), "email");

  // ── Social messages: one row per step ──
  const socialRecords = unique("outreach-social", read("outreach-social").map(({ key, v }) => ({ ...v, blob_key: key })), (s) => s.id);
  const social = [];
  for (const s of socialRecords) {
    const { parts = [], blob_key, id, campaign_id, lead_id, channel, url, status, type, written_by, review_status, review_reasons, created_at, updated_at, sent_at, ...rest } = s;
    if (!lead_id || !channel || !parts.length) { skip("outreach-social", "no lead, channel or steps"); continue; }
    parts.forEach((p, i) => {
      const { key: stepKey, label, text, sent_at: partSent, skipped, review_status: partStatus, review_reasons: partReasons, touch_id, ...partRest } = p;
      social.push(rehome({
        id: `${id}:${stepKey}`, record_id: id, blob_key, campaign_id: campaign_id ?? null, lead_id, channel, step_key: stepKey, step: SOCIAL_STEP[channel]?.[stepKey] ?? i + 1,
        url: url ?? null, label: label ?? null, body: text ?? null,
        status: partSent || status === "sent" ? "sent" : skipped ? "skipped" : status ?? "drafted", type: type ?? null,
        review_status: review(partStatus) ?? review(review_status) ?? null, review_reasons: partReasons ?? review_reasons ?? null,
        written_by: writer(written_by), written_model: written_by ?? null,
        sent_at: time(partSent) || (status === "sent" ? time(sent_at) ?? null : null), skipped: skipped === true, touch_id: touch_id ?? null, is_duplicate: false,
        created_at: time(created_at) ?? null, updated_at: time(updated_at) ?? null, data: { ...rest, ...partRest },
      }));
    });
  }
  markDuplicates(social, (m) => `${m.lead_id}/${m.channel}/${m.step_key}`, "social");

  const touches = simple("outreach-touches", "id", { lead_id: ["lead_id", str], campaign_id: ["campaign_id", str], channel: ["channel", str], kind: ["kind", str], sent_at: ["sent_at", time], subject: ["subject", str], body: ["text", str], source: ["source", str], ref: ["ref", str] }).map(rehome);

  const followState = unique("outreach-followups", read("outreach-followups").map(({ key, v }) => rehome({
    ...split(v, { lead_id: ["lead_id", str], channel: ["channel", str], steps: ["steps", json, {}], accepted_at: ["accepted_at", time], withdrawn_at: ["withdrawn_at", time], replied_by_hand: ["replied_by_hand", time], updated_at: ["updated_at", time] }),
    blob_key: key,
  })), (f) => f.lead_id && f.channel && `${f.lead_id}/${f.channel}`);

  // ── Replies, with who really wrote them ──
  const emailById = new Map(emails.map((e) => [e.id, e]));
  const replies = unique("outreach-replies", read("outreach-replies").map(({ key, v }) => {
    const row = split(v, {
      id: ["id", str], campaign_id: ["campaign_id", str], lead_id: ["lead_id", str], original_email_id: ["original_email_id", str], agentmail_message_id: ["agentmail_message_id", str], agentmail_thread_id: ["agentmail_thread_id", str],
      from_address: ["from", str], subject: ["subject", str], body_text: ["text", str], body_html: ["html", str], received_at: ["received_at", time],
      handled: ["handled", bool, false], opt_out: ["opt_out", bool, false], flag: ["flag", str], source: ["source", str],
    });
    const who = { from: v.from, subject: v.subject, to: v.to, is_test: v.is_test };
    const kind = rules.isBounceReport(v.from, v.subject) ? "bounce_report" : rules.isSystemReply(who) ? "system" : rules.isTestReply(who) ? "test" : "person";
    const address = /<([^>]+)>/.exec(v.from ?? "")?.[1] ?? v.from;
    return rehome({ ...row, blob_key: key, from_key: rules.emailKey(address), kind, is_test: kind === "test" });
  }), (r) => r.id);

  const contacts = [];
  report.stores[`${P}outreach-contacts`] = { exported: (stores[`${P}outreach-contacts`] ?? []).length, records: 0, parse_failed: 0, skipped: {} };
  for (const { key, value } of stores[`${P}outreach-contacts`] ?? []) {
    const [kind, ...rest] = key.split("/");
    const campaign = kind === "sent" && rest.length > 1 ? rest.pop() : "";
    // The key listing gave "+" back as a space (6 addresses in the first export). An address cannot hold a space.
    const address = kind === "meta" ? "" : rest.join("/");
    if (address.includes(" ")) report.contact_plus_restored++;
    contacts.push({ blob_key: key, kind, email: address.replaceAll(" ", "+"), campaign_id: campaign, value }); // plain text, as stored today
    report.stores[`${P}outreach-contacts`].records++;
  }

  // ── Stop states (F7/F8) ──
  const dncAddress = new Set(), bounced = new Map(), realBounce = new Set();
  const note = (map, key, why, at) => { if (key && !map.has(key)) map.set(key, { why, at: at ?? null }); };
  for (const e of emails) if (e.status === "bounced" || e.bounced_at) { note(bounced, e.to_key, "bounce event", e.bounced_at); realBounce.add(e.to_key); }
  for (const r of replies) if (r.kind === "bounce_report") {
    const address = emailById.get(r.original_email_id)?.to_key ?? leadById.get(r.lead_id)?.email_key;
    note(bounced, address, "bounce report", r.received_at);
    realBounce.add(address);
  }
  const failedAddresses = new Set(emails.filter((e) => e.status === "failed").map((e) => e.to_key));
  for (const c of contacts) if (c.kind === "bounced") {
    if (failedAddresses.has(c.email) && !realBounce.has(c.email)) report.bounced_entry_from_failed_send.push(c.email);
    else note(bounced, c.email, "bounced list");
  }
  for (const e of emails) {
    if (e.status === "failed") report.failed_emails.push({ email_id: e.id, lead_id: e.lead_id, step: e.step, error: e.error ?? e.data.error_message ?? "(no error saved)" });
    if (e.status === "complained" && e.to_key) dncAddress.add(e.to_key);
  }
  for (const l of leads) if (l.do_not_contact && l.email_key) dncAddress.add(l.email_key);

  const repliesByLead = group(replies.filter((r) => r.lead_id), (r) => r.lead_id);
  const repliesByEmail = group(replies.filter((r) => r.original_email_id), (r) => r.original_email_id);
  const emailsByLead = group(emails.filter((e) => e.lead_id), (e) => e.lead_id);
  const byHand = new Map(followState.filter((f) => f.channel === "all" && f.replied_by_hand).map((f) => [f.lead_id, f.replied_by_hand]));
  const ownOnly = rules.ownReplyEmailIds(replies.map((r) => ({ original_email_id: r.original_email_id, is_test: r.is_test, from: r.from_address })));
  const optOutAddress = new Set(replies.filter((r) => r.opt_out && r.kind !== "test" && r.from_key).map((r) => r.from_key));

  for (const l of leads) {
    const own = emailsByLead.get(l.id) ?? [];
    const mine = repliesByLead.get(l.id) ?? [];
    const optOut = mine.find((r) => r.opt_out && r.kind !== "test");
    const complaint = own.find((e) => e.status === "complained");
    const person = mine.find((r) => r.kind === "person");
    const marked = own.find((e) => e.status === "replied" && !(repliesByEmail.get(e.id) ?? []).length);
    const set = (state, why, at) => Object.assign(l, { stop_state: state, stop_reason: why, stopped_at: at ?? null });

    if (l.do_not_contact) set("do_not_contact", l.do_not_contact_reason ?? "do not contact", l.do_not_contact_at);
    else if (optOut) set("do_not_contact", "opt-out reply", optOut.received_at);
    else if (l.email_key && optOutAddress.has(l.email_key)) set("do_not_contact", "opt-out reply from this address");
    else if (complaint) set("do_not_contact", "spam complaint", complaint.updated_at);
    else if (l.email_key && dncAddress.has(l.email_key)) set("do_not_contact", "same address as a do-not-contact lead or complaint");
    else if (person) set("replied", "reply", person.received_at);
    else if (byHand.has(l.id)) set("replied", "marked by hand", byHand.get(l.id));
    else if (marked) { set("replied", "email marked replied", marked.replied_at); report.replied_without_reply_record.push({ lead_id: l.id, email_id: marked.id }); }
    else {
      const ownBounce = own.find((e) => e.status === "bounced" || e.bounced_at || mine.some((r) => r.kind === "bounce_report"));
      const hit = l.email_key ? bounced.get(l.email_key) : ownBounce && { why: "bounce event", at: ownBounce.bounced_at };
      if (hit) set("bounced", hit.why, hit.at);
      else if (ownBounce) report.bounced_old_address.push({ lead_id: l.id, name: l.name, email_id: ownBounce.id });
    }
    if (l.stop_state === "replied" && mine.filter((r) => r.kind === "person").every((r) => rules.isAutoReply(r.subject, r.body_text)) && person) report.auto_replies_counted_as_replied.push({ lead_id: l.id, name: l.name, reply_id: person.id });

    // What the app shows today: the Prospects label and the Follow-ups stop reason.
    const prospects = l.do_not_contact ? "do_not_contact" : own.some((e) => ["bounced", "complained", "failed"].includes(e.status)) ? "bounced" : own.some((e) => e.status === "replied" && !ownOnly.has(e.id)) ? "replied" : "none";
    const followups = l.do_not_contact || mine.some((r) => r.opt_out) ? "do_not_contact" : own.some((e) => e.status === "replied" && !ownOnly.has(e.id)) || mine.some((r) => !r.is_test) || byHand.has(l.id) ? "replied" : "none";
    if (l.stop_state !== prospects || (followups !== "none" && followups !== l.stop_state)) {
      report.state_changes.push({ lead_id: l.id, name: l.name, campaign_id: l.campaign_id, today_prospects: prospects, today_followups: followups, after: l.stop_state, why: l.stop_reason });
    }
  }

  // ── Follow-up due dates, by the live rule ──
  const stateOf = new Map(followState.map((f) => [`${f.lead_id}/${f.channel}`, f]));
  const followUps = [];
  const nextFor = (lead, channel, list, gaps) => {
    const r = rules.nextFollowUp({
      lead_id: lead.id, campaign_id: lead.campaign_id, name: lead.name ?? lead.id, channel, steps: list, state: stateOf.get(`${lead.id}/${channel}`), gaps, today,
      stopped: lead.stop_state === "none" || (lead.stop_state === "bounced" && channel !== "email") ? null : lead.stop_state,
    });
    if (r) followUps.push({ lead_id: lead.id, channel, campaign_id: lead.campaign_id, step_key: r.step_key, position: r.position, due_date: r.due_date, stopped_reason: r.stopped_reason ?? null, email_id: r.email_id ?? null, computed_at: exportedAt });
  };
  for (const [leadId, list] of group(emails.filter((e) => e.framework === "four-step" && !e.is_duplicate && e.lead_id), (e) => e.lead_id)) {
    const lead = leadById.get(leadId);
    if (!lead || lead.excluded) continue;
    list.sort((a, b) => a.step - b.step);
    nextFor(lead, "email", list.map((e) => ({ key: String(e.step), label: `Email ${e.step}`, text: e.body_text ?? "", sent_at: SENT(e.status) ? e.sent_at : null, status: e.review_status, id: e.id })), rules.gapsOrDefault(settings.follow_up_gaps_email));
  }
  for (const list of group(social.filter((m) => m.type === "sequence" && !m.is_duplicate), (m) => `${m.lead_id}/${m.channel}`).values()) {
    const lead = leadById.get(list[0].lead_id);
    if (!lead || lead.excluded) continue;
    list.sort((a, b) => a.step - b.step);
    nextFor(lead, list[0].channel, list.map((m) => ({ key: m.step_key, label: m.label ?? m.step_key, text: m.body ?? "", sent_at: m.sent_at, status: m.review_status })), rules.gapsOrDefault(settings.follow_up_gaps_social));
  }

  // ── F17: the same business twice in a campaign, one with an email and one without ──
  for (const list of group(leads.filter((l) => !l.is_test), (l) => l.campaign_id).values()) {
    const keys = (l) => ({ name: nameKey(l.name), website: l.website_key, phone: phoneKey(l.phone), place: rules.placeIdKey(rawLeads.find((r) => r.id === l.id)?.raw) });
    const info = list.map((l) => ({ l, k: keys(l) }));
    for (const without of info.filter((x) => !x.l.email_key)) {
      for (const withEmail of info.filter((x) => x.l.email_key)) {
        const same = Object.keys(without.k).filter((k) => without.k[k] && without.k[k] === withEmail.k[k]);
        if (same.length) report.duplicate_leads.push({ campaign_id: without.l.campaign_id, keep: withEmail.l.id, keep_name: withEmail.l.name, merge: without.l.id, merge_name: without.l.name, same });
      }
    }
  }

  // ── F19: the first real send stored at a later position ──
  for (const [leadId, list] of emailsByLead) {
    // A bounced try never reached anyone, so it is not the first send.
    const sent = list.filter((e) => SENT(e.status) && e.status !== "bounced" && !e.bounced_at && !e.is_duplicate).sort((a, b) => String(a.sent_at ?? "").localeCompare(String(b.sent_at ?? "")));
    if (!sent.length || sent.some((e) => e.step === 1)) continue;
    const lead = leadById.get(leadId);
    report.first_send_at_later_step.push({ lead_id: leadId, name: lead?.name ?? null, campaign_id: lead?.campaign_id ?? null, email_id: sent[0].id, step: sent[0].step, emails: list.map((e) => ({ id: e.id, step: e.step, sequence_total: e.sequence_total, framework: e.framework, status: e.status, to: e.to_key, sent_at: e.sent_at, subject: e.subject })) });
  }

  // ── The other stores ──
  const clicks = simple("outreach-clicks", "id", { campaign_id: ["campaign_id", str], lead_id: ["lead_id", str], email_id: ["email_id", str], url: ["url", str], clicked_at: ["clicked_at", time] });
  const activity = simple("activity", "id", { agent_id: ["agent_id", str], category: ["category", str], summary: ["summary", str], details: ["details", json], created_at: ["created_at", time] });
  const tasks = simple("tasks", "id", { title: ["title", str], description: ["description", str], status: ["status", str], assignee_id: ["assignee_id", str], priority: ["priority", str], created_at: ["created_at", time], updated_at: ["updated_at", time] });
  const agents = simple("agents", "id", { name: ["name", str], sign_in_name: ["sign_in_name", str], role: ["role", str], status: ["status", str], last_heartbeat: ["last_heartbeat", time], created_at: ["created_at", time] });
  const forms = simple("forms", "slug", { title: ["title", str], created_at: ["created_at", time] });
  const submissions = simple("submissions", "id", { form_slug: ["form_slug", str], received_at: ["received_at", time] });
  const sitePages = simple("pages", "slug", { title: ["title", str], linked_form_slug: ["linked_form_slug", str], created_at: ["created_at", time], updated_at: ["updated_at", time] });
  const webhooks = simple("webhooks", "id", { name: ["name", str], service: ["service", str], event_count: ["event_count", int], created_at: ["created_at", time] });
  const webhookEvents = simple("webhook-events", "id", { webhook_id: ["webhook_id", str], headers: ["headers", json], body: ["body", json], received_at: ["received_at", time] });
  const voiceSessions = simple("voice-sessions", "id", { started_at: ["started_at", time], ended_at: ["ended_at", time], duration_seconds: ["duration_seconds", num], invitation_id: ["invitation_id", str] });
  const voiceInvitations = simple("voice-invitations", "id", { status: ["status", str], agent_id: ["agent_id", str], created_at: ["created_at", time] });
  const voiceConfig = read("voice-config").map(({ key, v }) => ({ key, data: v }));
  const screenshots = read("lead-screenshots").filter(({ v }) => v.jpeg_base64 || (skip("lead-screenshots", "no image"), false)).map(({ key, v }) => {
    const [campaign_id, lead_id] = key.split("/");
    return { campaign_id, lead_id, jpeg: Buffer.from(v.jpeg_base64, "base64"), bytes: int(v.bytes) ?? null, saved_at: time(v.saved_at) ?? null };
  });

  // ── Orphans: kept, only listed ──
  const without = (rows, test, id = (r) => r.id) => rows.filter(test).map(id);
  report.orphans = {
    leads_without_campaign: without(leads, (l) => !campaignIds.has(l.campaign_id)),
    emails_without_lead: without(emails, (e) => !leadById.has(e.lead_id)),
    emails_without_campaign: without(emails, (e) => !campaignIds.has(e.campaign_id)),
    social_without_lead: [...new Set(without(social, (m) => !leadById.has(m.lead_id), (m) => m.record_id))],
    touches_without_lead: without(touches, (t) => !leadById.has(t.lead_id)),
    follow_state_without_lead: without(followState, (f) => !leadById.has(f.lead_id), (f) => `${f.lead_id}/${f.channel}`),
    replies_without_campaign: without(replies, (r) => !campaignIds.has(r.campaign_id)),
    replies_without_lead: without(replies, (r) => !leadById.has(r.lead_id)),
    clicks_without_email: without(clicks, (c) => !emailById.has(c.email_id)),
    contact_entries_for_unknown_campaign: [contacts.filter((c) => c.campaign_id && !campaignIds.has(c.campaign_id)).length],
  };

  return {
    tables: {
      campaigns, campaign_jobs: jobs, leads, social_pages: [...pages.values()], lead_social_links: [...links.values()], lead_screenshots: screenshots,
      emails, social_messages: social, touches, follow_up_state: followState, follow_ups: followUps, replies, clicks, contacts,
      outreach_settings: settingsRows.map(({ key, v }) => ({ key, data: v })), activity, tasks, agents, forms, submissions, pages: sitePages,
      webhooks, webhook_events: webhookEvents, voice_config: voiceConfig, voice_sessions: voiceSessions, voice_invitations: voiceInvitations,
    },
    report,
  };
}
