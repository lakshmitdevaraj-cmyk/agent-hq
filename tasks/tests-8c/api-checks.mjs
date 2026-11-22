// Integration checks against the LOCAL server (http://localhost:8890, mock only). Usage: node tasks/tests-8c/api-checks.mjs <campaign_id> <lead_id>
// Proves: an agent-created bad draft is Blocked at once (no Review pressed); an edit to bad text is re-checked and "ready" is refused; a good edit can be marked ready.
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const [campaign_id, lead_id] = process.argv.slice(2);
const call = async (action, params) => { const r = await fetch("http://localhost:8890/api/command", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) }); return r.json(); };
let n = 0, failed = 0;
const t = (name, ok, extra = "") => { if (ok) { n++; console.log("ok  " + name); } else { failed++; console.log("FAIL " + name + " " + extra); } };
const GOOD = "Hi there,\n\nYou have 4.8 stars from 210 Google reviews, and callers who reach voicemail tend to ring the next company. I help home-service companies keep those calls. Want me to send a short recording of it answering a call for your business?";
const BAD = "Hi there,\n\nAs we discussed, your website offers a contact form but no live chat or online booking. Can we book a call?";
// Uses the first step the lead has no draft for (a step that already has a draft is skipped by the server).
let made;
for (const pos of [1, 2, 3, 4]) { made = await call("outreach.emails.create", { campaign_id, lead_id, subject: "missed calls", body_text: BAD, framework: "four-step", sequence_position: pos, sequence_total: 4 }); if (!made.data?.skipped) break; }
const id = made.data?.id ?? made.data?.email?.id;
t("agent-created bad draft is saved", !!id, JSON.stringify(made).slice(0, 200));
const row = made.data?.email ?? made.data;
t("it is Blocked at once, without Review", row?.review_status === "blocked", String(row?.review_status));
t("with the reasons listed", Array.isArray(row?.review_reasons) && row.review_reasons.length >= 2, JSON.stringify(row?.review_reasons));
const refused = await call("outreach.emails.update", { campaign_id, email_id: id, review_status: "ready" });
t("Mark ready is refused while a hard hit remains, and says why", refused.ok === false && /Cannot mark this ready/.test(refused.error ?? ""), JSON.stringify(refused).slice(0, 200));
const fixed = await call("outreach.emails.update", { campaign_id, email_id: id, body_text: GOOD });
t("editing it to good text re-checks it (no longer Blocked)", fixed.ok && (fixed.data?.review_status ?? fixed.data?.email?.review_status) !== "blocked", JSON.stringify(fixed).slice(0, 200));
const ready = await call("outreach.emails.update", { campaign_id, email_id: id, review_status: "ready" });
t("a clean draft can be marked ready", ready.ok === true, JSON.stringify(ready).slice(0, 200));
const worse = await call("outreach.emails.update", { campaign_id, email_id: id, body_text: BAD });
t("editing a Ready draft to bad text blocks it at once", (worse.data?.review_status ?? worse.data?.email?.review_status) === "blocked", JSON.stringify(worse).slice(0, 200));
const again = await call("outreach.emails.update", { campaign_id, email_id: id, review_status: "ready" });
t("edit to bad then Mark ready is refused", again.ok === false, JSON.stringify(again).slice(0, 200));
await call("outreach.emails.delete", { campaign_id, email_id: id });
// ── old drafts: re-checked on read, refused at send, and every refusal says why ──
const OLD_ID = "oldready" + Date.now().toString(36);
const createdAt = new Date().toISOString();
const free = [1, 2, 3, 4];
const taken = (await call("outreach.emails.list", { campaign_id })).data.filter((e) => e.lead_id === lead_id).map((e) => e.sequence_position ?? 1);
const pos = free.find((x) => !taken.includes(x));
if (pos) {
  const OLD = { id: OLD_ID, campaign_id, lead_id, to_email: "shiftforge.ai+old@gmail.com", to_name: "Old Draft Test", subject: "missed calls", body_text: "Hi there,\n\nI use the same assistant on my own home-services website, where it answers business owners' questions about missed calls. Do you still want the recording?", body_html: "<p>x</p>", sequence_position: pos, sequence_total: 4, framework: "four-step", source: "gemini", status: "drafted", review_status: "ready", review_reasons: [], reviewed_by: "gemini-2.5-flash", created_at: createdAt, updated_at: createdAt };
  await call("data.import", { store: "agent-hq-outreach-emails", overwrite: true, records: [{ key: `${campaign_id}/${createdAt}-${OLD_ID}`, value: JSON.stringify(OLD) }] });
  const sent = await call("outreach.emails.send", { campaign_id, email_ids: [OLD_ID], limit: 1 });
  t("an old Ready draft with 'same assistant' is refused at send", sent.data?.sent === 0, JSON.stringify(sent).slice(0, 200));
  t("the refusal says why (not_sent + reason) and counts skipped_blocked", sent.data?.not_sent?.[0]?.email_id === OLD_ID && /Blocked/.test(sent.data?.reason ?? "") && sent.data?.skipped_blocked >= 1, JSON.stringify(sent.data).slice(0, 300));
  // put it back to an unchecked old Ready draft, then list
  await call("data.import", { store: "agent-hq-outreach-emails", overwrite: true, records: [{ key: `${campaign_id}/${createdAt}-${OLD_ID}`, value: JSON.stringify(OLD) }] });
  const listed = (await call("outreach.emails.list", { campaign_id })).data.find((e) => e.id === OLD_ID);
  t("an old Ready draft is Blocked after list (re-check on read)", listed?.review_status === "blocked", String(listed?.review_status));
  await call("outreach.emails.delete", { campaign_id, email_id: OLD_ID });
} else t("a free step exists for the old-draft check", false, "all four steps already have drafts");
// a chosen draft that cannot go out always says why
const replied = await call("outreach.emails.send", { campaign_id, email_ids: ["does-not-exist"], limit: 1 });
t("an unknown id is reported, not silently dropped", replied.data?.sent === 0 && /No draft with this id/.test(replied.data?.reason ?? ""), JSON.stringify(replied).slice(0, 200));
console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
