// Threading test against mock-agentmail ONLY (the dev server must run with AGENTMAIL_TEST_BASE_URL=http://localhost:8898).
// Seeds a test lead with three "four-step" drafts, sends step 1, then 2 and 3, and checks the mock log:
// step 1 -> POST .../messages/send, steps 2 and 3 -> POST .../messages/{email 1 message_id}/reply with {text, html} only (no subject, no to).
// Also: a lead that replied is never sent step 2 even when ticked. Usage: node tasks/tests-8c/threading.mjs
import fs from "node:fs";
const KEY = fs.readFileSync((process.env.TMPDIR || "/tmp") + "/tests-8b-key.txt", "utf8").trim();
const LOG = (process.env.TMPDIR || "/tmp") + "/mock-agentmail-requests.log";
const base = "http://localhost:8890";
const call = async (action, params = {}) => (await (await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY }, body: JSON.stringify({ action, params }) })).json());
const imp = (store, rows) => call("data.import", { store, overwrite: true, records: rows.map(([key, v]) => ({ key, value: JSON.stringify(v) })) });
fs.writeFileSync(LOG, "");
let fail = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fail++; };
const stamp = Date.now().toString(36), t0 = "2026-11-10T10:00:00.000Z";
const camp = `thr-${stamp}`;
await imp("agent-hq-outreach-campaigns", [[camp, { id: camp, name: `Threading test ${stamp}`, status: "ready", created_at: t0, query: "plumbing", location: "Katy, TX", any_trade: true, default_sender_name: "Lakshmi Devaraj" }]]);
const mkLead = (id) => ({ id, campaign_id: camp, name: id, email: `shiftforge.ai+${id}@gmail.com`, is_test: true, created_at: t0, category: "Plumber", address: "1 Main St, Katy, TX 77494", reviews_count: 50, rating: 4.7 });
const row = (lead, pos, n) => ({ id: `e-${lead}-${pos}`, campaign_id: camp, lead_id: lead, to_email: `shiftforge.ai+${lead}@gmail.com`, subject: "plumbing calls", body_text: `Hi there,\n\nStep ${pos} text.`, status: "drafted", framework: "four-step", sequence_position: pos, sequence_total: 4, review_status: "ready", created_at: `2026-11-10T10:00:0${n}.000Z`, updated_at: t0 });
const A = `a${stamp}`, B = `b${stamp}`;
await imp("agent-hq-outreach-leads", [[`${camp}/${t0}-a`, mkLead(A)], [`${camp}/${t0}-b`, mkLead(B)]]);
await imp("agent-hq-outreach-emails", [A, B].flatMap((l, i) => [1, 2, 3].map((p) => [`${camp}/${row(l, p, p).created_at}-e-${l}-${p}`, row(l, p, p)])));
const sendStep = (pos, lead) => call("outreach.emails.send", { campaign_id: camp, email_ids: [`e-${lead}-${pos}`], confirm: true, base_url: base });
const log = () => fs.readFileSync(LOG, "utf8");

// step 2 before step 1 must refuse
let r = await sendStep(2, A);
ok(JSON.stringify(r).includes("Send the earlier email first") || (r.data?.errors?.length ?? 0) > 0, "step 2 before step 1 is refused: " + JSON.stringify(r).slice(0, 160));
r = await sendStep(1, A);
ok(r.ok !== false && (r.data?.sent ?? 0) === 1, "step 1 sent via the mock: " + JSON.stringify(r).slice(0, 160));
const m1 = ((await call("outreach.emails.list", { campaign_id: camp })).data ?? []).find((e) => e.id === `e-${A}-1`);
ok(!!m1?.agentmail_message_id, "email 1 has a stored message id: " + m1?.agentmail_message_id);
r = await sendStep(2, A);
r = await sendStep(3, A);
const L = log();
ok(new RegExp(`REPLY /inboxes/[^/]+/messages/${m1?.agentmail_message_id}/reply BODY`).test(L), "step 2 went to the reply route of email 1's message id");
const replies = L.split("\n").filter((x) => x.startsWith("REPLY"));
ok(replies.length === 2, `exactly two reply calls (got ${replies.length})`);
const bodies = replies.map((x) => JSON.parse(x.split(" BODY ")[1]));
ok(bodies.every((b) => b.text && b.html && !("subject" in b) && !("to" in b)), "reply bodies carry text and html only, no subject, no fake Re:");
ok(!/Re:/.test(L.split("\n").filter((x) => x.startsWith("BODY") || x.startsWith("REPLY")).join("\n")), "no 'Re:' anywhere in what was sent");
// a lead that replied never gets a later step
await sendStep(1, B);
// the replied status is stored on the email row (how the replies flow marks it)
await imp("agent-hq-outreach-emails", [[`${camp}/${row(B, 1, 1).created_at}-e-${B}-1`, { ...row(B, 1, 1), status: "replied", agentmail_message_id: "mock-b-1", agentmail_inbox_id: "lakshmi@team.shiftforge.ai", sent_at: t0 }]]);
const before = replies.length;
r = await sendStep(2, B);
const after = log().split("\n").filter((x) => x.startsWith("REPLY")).length;
ok(after === before, "a lead who replied is not sent step 2 even when ticked: " + JSON.stringify(r).slice(0, 160));
console.log(fail ? `\n${fail} FAILED` : "\nall passed (mock only; nothing real was sent)");
process.exit(fail ? 1 : 0);
