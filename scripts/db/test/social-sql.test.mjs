// Chunk 8 on Neon dev, every transaction rolled back: social messages and touches (lib/sql/social.ts).
// A5 (social blocks, hand-sent message recorded), F15 (record a hand-sent message with its date, also against an open
// step of a written run), F30 (do-not-contact: every social step skipped, verify blocked, mark as sent refused),
// F11 (Facebook page gone stops that channel), F34 (touch.delete removes only hand-recorded touches), F14 (a manual link
// is never overwritten), F41 (the social reviewer gets the same offer text as the email reviewer), F1 (read straight back).
// All data is made up. A real fetch is refused for the whole file.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CID = "s8-camp";
let n, so, loadError;
let realFetch;
before(async () => {
  n = (await import("../equiv/new-path.mjs")).openNew("dev");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`network refused in test: ${String(input?.url ?? input)}`); };
  try { so = await import("../../../netlify/functions/lib/sql/social.ts"); } catch (e) { loadError = e; }
});
after(() => { globalThis.fetch = realFetch; return n?.close(); });

const need = () => { if (loadError) throw new Error(`lib/sql/social.ts did not load: ${loadError.message}`); };
let idn = 0;
const deps = () => ({ newId: () => `s8-id-${++idn}`, now: () => new Date("2026-11-28T15:00:00.000Z") });
const act = (tx, action, params) => so.runSocialAction(tx, action, params, deps());
async function refused(p, status, code) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); return true; });
}

async function seed(tx, o = {}) {
  await tx`insert into campaigns (id, blob_key, name, niche, area, country, time_zone, any_trade, default_sender_name, created_at, updated_at, data)
           values (${CID}, ${CID}, 'Made-up Campaign S8', 'roofer', 'Madeupville, TX', 'US', 'America/Chicago', true, 'Made-up Sender', now(), now(), ${tx.json(o.campaignData ?? {})})`;
  await tx`insert into outreach_settings (key, data) values ('settings', ${tx.json({ time_zone: "America/Chicago", free_asset_1: "a made-up free asset", proof_line: "a made-up proof line", ...(o.settings ?? {}) })})
           on conflict (key) do update set data = excluded.data`;
  await tx`insert into leads (id, campaign_id, blob_key, name, created_at, stop_state, do_not_contact, merged_into, data) values
           ('s8-lead', ${CID}, 'k1', 'Made-up Roofing S8', now(), ${o.stop ?? "none"}, ${o.dnc ?? false}, null, ${tx.json(o.leadData ?? {})}),
           ('s8-merged', ${CID}, 'k2', 'Made-up Roofing S8 (twin)', now(), 'none', false, 's8-lead', '{}')`;
  const seqRow = (key, step, body, extra = {}) => ({
    id: `s8-lead-facebook:${key}`, record_id: "s8-lead-facebook", blob_key: `${CID}/s8-lead/facebook`, campaign_id: CID, lead_id: "s8-lead", channel: "facebook",
    step_key: key, step, url: "https://www.facebook.com/madeup-s8", label: key, body, status: "drafted", type: "sequence", review_status: "ready",
    review_reasons: [], written_by: "gemini", written_model: "gemini-made-up", sent_at: null, skipped: false, touch_id: null, is_duplicate: false,
    created_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:00:00Z", data: { angle: "made-up angle", fact_used: null, draft_facts: [] }, ...extra,
  });
  const rows = [
    seqRow("message", 1, "Hi there, a made-up first message about missed calls."),
    seqRow("follow_up", 2, "A made-up follow-up."),
    seqRow("last", 3, "A made-up last note."),
    { id: "s8-lead-instagram:message", record_id: "s8-lead-instagram", blob_key: `${CID}/s8-lead/instagram`, campaign_id: CID, lead_id: "s8-lead", channel: "instagram",
      step_key: "message", step: 1, url: "https://www.instagram.com/madeup_s8", label: "Message", body: "A made-up single Instagram message.", status: "drafted", type: "first",
      review_status: "check", review_reasons: ["made-up reason"], written_by: "gemini", written_model: "gemini-made-up", sent_at: null, skipped: false, touch_id: null, is_duplicate: false,
      created_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:00:00Z", data: {} },
    { ...seqRow("message", 1, "Twin lead message."), id: "s8-merged-facebook:message", record_id: "s8-merged-facebook", lead_id: "s8-merged", blob_key: `${CID}/s8-merged/facebook` },
  ];
  for (const r of rows) await tx`insert into social_messages ${tx(r)}`;
  await tx`insert into emails (id, blob_key, campaign_id, lead_id, to_email, to_key, subject, body_text, step, sequence_total, framework, status, sent_at, created_at, updated_at, data) values
           ('s8-e1', 'k3', ${CID}, 's8-lead', 'owner@madeup-s8.test', 'owner@madeup-s8.test', 'roofing', 'A made-up email 1.', 1, 4, 'four-step', 'sent', '2026-11-18T15:00:00Z', now(), now(), '{}')`;
  await tx`insert into touches (id, blob_key, lead_id, campaign_id, channel, kind, sent_at, body, source, data) values
           ('s8-t-manual', 'k4', 's8-lead', ${CID}, 'linkedin', 'first', '2026-11-19T12:00:00Z', 'A made-up LinkedIn note sent by hand.', 'manual', '{}'),
           ('s8-t-hq', 'k5', 's8-lead', ${CID}, 'instagram', 'first', '2026-11-19T13:00:00Z', 'A made-up Instagram message HQ wrote.', 'hq', '{}')`;
}
const rowsOf = (tx, record) => tx`select step_key, body, status, sent_at, touch_id, skipped, review_status, data from social_messages where record_id = ${record} order by step`;

describe("chunk 8 social and touches on SQL", () => {
  test("module loads", () => need());

  test("social.list: the old record shape (parts in step order, record fields from data); a merged lead is hidden", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const list = await act(tx, "outreach.social.list", { campaign_id: CID });
      assert.deepEqual(list.map((r) => `${r.lead_id}/${r.channel}`).sort(), ["s8-lead/facebook", "s8-lead/instagram"]);
      const fb = list.find((r) => r.channel === "facebook");
      assert.equal(fb.id, "s8-lead-facebook");
      assert.equal(fb.type, "sequence");
      assert.equal(fb.angle, "made-up angle");
      assert.equal(fb.url, "https://www.facebook.com/madeup-s8");
      assert.deepEqual(fb.parts.map((p) => p.key), ["message", "follow_up", "last"]);
      assert.equal(fb.status, "drafted");
      const one = await act(tx, "outreach.social.list", { campaign_id: CID, lead_id: "s8-lead" });
      assert.equal(one.length, 2);
    });
  });

  test("social.update: a step of a run is saved as written, marked not reviewed by the AI and never Ready; a sent step is not rewritten; read back (F1)", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      await tx`update social_messages set sent_at = '2026-11-21T12:00:00Z', status = 'sent', touch_id = 'x' where id = 's8-lead-facebook:message'`;
      const saved = await act(tx, "outreach.social.update", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", parts: { message: "Rewritten first", follow_up: "My own follow-up text." } });
      const fu = saved.parts.find((p) => p.key === "follow_up");
      assert.equal(fu.text, "My own follow-up text.");
      assert.notEqual(fu.review_status, "ready");
      assert.ok(fu.review_reasons.includes("Edited by you: not reviewed by the AI."));
      assert.equal(saved.reviewed_by, "you");
      const back = await rowsOf(tx, "s8-lead-facebook");
      assert.equal(back[0].body, "Hi there, a made-up first message about missed calls.", "the sent step stays as it was");
      assert.equal(back[1].body, "My own follow-up text.");
      await refused(act(tx, "outreach.social.update", { campaign_id: CID, lead_id: "s8-lead", channel: "tiktok", parts: {} }), 400);
      await refused(act(tx, "outreach.social.update", { campaign_id: CID, lead_id: "nobody", channel: "facebook", parts: { message: "x" } }), 404);
    });
  });

  test("social.verify: normal; F30 a do-not-contact lead is blocked; F11 Facebook page gone is blocked", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const v = await act(tx, "outreach.social.verify", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook" });
      assert.equal(typeof v.blocked, "boolean");
      await tx`update leads set stop_state = 'do_not_contact', do_not_contact = true where id = 's8-lead'`;
      const dnc = await act(tx, "outreach.social.verify", { campaign_id: CID, lead_id: "s8-lead", channel: "instagram" });
      assert.equal(dnc.blocked, true);
      assert.match(dnc.reasons.join(" "), /not to be contacted|do not contact/i);
    });
    await n.callWrite(async (tx) => {
      await seed(tx, { leadData: { fb_checked: { at: "2026-11-22T10:00:00Z", result: "gone", note: "" } } });
      const gone = await act(tx, "outreach.social.verify", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook" });
      assert.equal(gone.blocked, true);
      assert.match(gone.reasons.join(" "), /Facebook page gone/i);
      const ig = await act(tx, "outreach.social.verify", { campaign_id: CID, lead_id: "s8-lead", channel: "instagram" });
      assert.notEqual(ig.reasons.join(" ").includes("Facebook page gone"), true, "only Facebook stops");
    });
  });

  test("F30: when a lead becomes do-not-contact, every unsent social step is skipped (migration 0015 trigger)", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      await tx`update leads set stop_state = 'do_not_contact', do_not_contact = true, stop_reason = 'opt-out reply' where id = 's8-lead'`;
      const rows = await tx`select status, skipped, data->>'skipped_reason' as why from social_messages where lead_id = 's8-lead'`;
      assert.ok(rows.length > 0);
      for (const r of rows) { assert.equal(r.status, "skipped"); assert.equal(r.skipped, true); assert.equal(r.why, "do_not_contact"); }
    });
  });

  test("social.mark_sent: a whole message becomes an HQ touch and its draft goes; a step of a run keeps the rest; Undo restores; bad and future dates refused", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = await act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "instagram", sent_on: "2026-11-27" });
      assert.ok(r.touch_id);
      const [t] = await tx`select source, channel, sent_at, body from touches where id = ${r.touch_id}`;
      assert.equal(t.source, "hq");
      assert.equal(t.body, "A made-up single Instagram message.");
      assert.equal(new Date(t.sent_at).toISOString(), "2026-11-27T12:00:00.000Z");
      assert.equal((await rowsOf(tx, "s8-lead-instagram")).length, 0);
      const u = await act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "instagram", sent: false, touch_id: r.touch_id });
      assert.equal(u.undone, true);
      assert.equal(u.restored, true);
      assert.equal((await rowsOf(tx, "s8-lead-instagram")).length, 1);
      assert.equal((await tx`select 1 from touches where id = ${r.touch_id}`).length, 0);

      const p = await act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", part: "message", sent_on: "2026-11-26" });
      const steps = await rowsOf(tx, "s8-lead-facebook");
      assert.equal(steps.length, 3);
      assert.equal(steps[0].touch_id, p.touch_id);
      assert.ok(steps[0].sent_at);
      assert.equal(steps[1].sent_at, null);
      await refused(act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", part: "follow_up", sent_on: "2099-01-01" }), 400);
      await refused(act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", part: "follow_up", sent_on: "28/11/2026" }), 400);
    });
  });

  test("social.mark_sent is refused for a do-not-contact lead (F30) and on Facebook when the page is gone (F11)", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx, { stop: "do_not_contact", dnc: true });
      await refused(act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "instagram" }), 409, "do_not_contact");
    });
    await n.callWrite(async (tx) => {
      await seed(tx, { leadData: { fb_checked: { at: "2026-11-22T10:00:00Z", result: "gone", note: "" } } });
      await refused(act(tx, "outreach.social.mark_sent", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", part: "message" }), 409, "page_gone");
    });
  });

  test("social.record_hand (F15): a touch with its date and text, first or follow-up from earlier touches; with part the open step is marked sent with her own text", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const a = await act(tx, "outreach.social.record_hand", { campaign_id: CID, lead_id: "s8-lead", channel: "linkedin", text: "A made-up second LinkedIn note.", sent_on: "2026-11-25" });
      const [t] = await tx`select source, kind, body from touches where id = ${a.touch_id}`;
      assert.deepEqual({ ...t }, { source: "manual", kind: "follow_up", body: "A made-up second LinkedIn note." });
      const b = await act(tx, "outreach.social.record_hand", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", text: "What I really sent on Facebook.", sent_on: "2026-11-24", part: "message" });
      const steps = await rowsOf(tx, "s8-lead-facebook");
      assert.equal(steps[0].touch_id, b.touch_id);
      assert.ok(steps[0].sent_at);
      assert.equal(steps[0].data.sent_text_differs, true);
      const [t2] = await tx`select kind, body from touches where id = ${b.touch_id}`;
      assert.equal(t2.body, "What I really sent on Facebook.");
      assert.equal(t2.kind, "first");
      await refused(act(tx, "outreach.social.record_hand", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", text: "   " }), 400);
      await refused(act(tx, "outreach.social.record_hand", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook", text: "x".repeat(5001) }), 400);
      await refused(act(tx, "outreach.social.record_hand", { campaign_id: CID, lead_id: "s8-lead", channel: "fax", text: "x" }), 400);
    });
  });

  test("social.delete: unsent steps go, sent steps stay as history", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      await tx`update social_messages set sent_at = '2026-11-21T12:00:00Z', status = 'sent', touch_id = 'x' where id = 's8-lead-facebook:message'`;
      assert.deepEqual(await act(tx, "outreach.social.delete", { campaign_id: CID, lead_id: "s8-lead", channel: "facebook" }), { deleted: true });
      const left = await rowsOf(tx, "s8-lead-facebook");
      assert.deepEqual(left.map((r) => r.step_key), ["message"]);
    });
  });

  test("touch.delete (F34): only a hand-recorded touch can be removed; an HQ touch or an email is refused; unknown is 404", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const r = await act(tx, "outreach.touch.delete", { lead_id: "s8-lead", touch_id: "s8-t-manual" });
      assert.equal(r.deleted, true);
      assert.equal((await tx`select 1 from touches where id = 's8-t-manual'`).length, 0);
      await refused(act(tx, "outreach.touch.delete", { lead_id: "s8-lead", touch_id: "s8-t-hq" }), 409, "not_hand_recorded");
      await refused(act(tx, "outreach.touch.delete", { lead_id: "s8-lead", touch_id: "email-s8-e1" }), 409, "not_hand_recorded");
      await refused(act(tx, "outreach.touch.delete", { lead_id: "s8-lead", touch_id: "nothing-here" }), 404);
      assert.equal((await tx`select 1 from touches where id = 's8-t-hq'`).length, 1);
    });
  });

  test("lead.touches: the sent email and the stored touches, oldest first, with the summary", async () => {
    need();
    await n.callWrite(async (tx) => {
      await seed(tx);
      const s = await act(tx, "outreach.lead.touches", { campaign_id: CID, lead_id: "s8-lead" });
      assert.deepEqual(s.touches.map((t) => t.id), ["email-s8-e1", "s8-t-manual", "s8-t-hq"]);
      assert.equal(s.summary.total, 3);
      assert.equal(s.summary.counts.email, 1);
      assert.equal(s.summary.replied, false);
    });
  });

  test("the AI actions answer 501 on SQL until P4 (social.write, social.plan, batch.start / status / resume)", async () => {
    need();
    await n.callWrite(async (tx) => {
      for (const a of ["outreach.social.write", "outreach.social.plan", "outreach.social.batch.start", "outreach.social.batch.status", "outreach.social.batch.resume"]) {
        await refused(act(tx, a, { campaign_id: CID }), 501);
      }
    });
  });

  test("socialStop (F30, F11): the reason a channel is closed, for the P4 writer and planner", () => {
    need();
    assert.equal(so.socialStop({ stop_state: "do_not_contact", do_not_contact: true, data: {} }, "instagram")?.code, "do_not_contact");
    assert.equal(so.socialStop({ stop_state: "none", do_not_contact: false, data: { fb_checked: { result: "gone" } } }, "facebook")?.code, "page_gone");
    assert.equal(so.socialStop({ stop_state: "none", do_not_contact: false, data: { fb_checked: { result: "gone" } } }, "linkedin"), null);
    assert.equal(so.socialStop({ stop_state: "bounced", do_not_contact: false, data: {} }, "facebook"), null, "a bounce stops email only (F7)");
  });

  test("offerText (F41): campaign offer, then the Settings offer, then the default the email reviewer uses", async () => {
    need();
    const src = readFileSync(new URL("../../../netlify/functions/command.ts", import.meta.url), "utf8");
    const def = /const DEFAULT_OFFER = "([^"]+)";/.exec(src)[1];
    assert.equal(so.DEFAULT_OFFER, def);
    await n.callWrite(async (tx) => {
      await seed(tx, { campaignData: { default_sender_offer: "  A made-up campaign offer.  " }, settings: { default_sender_offer: "A made-up settings offer." } });
      assert.equal(await so.offerText(tx, CID), "A made-up campaign offer.");
      await tx`update campaigns set data = '{}' where id = ${CID}`;
      assert.equal(await so.offerText(tx, CID), "A made-up settings offer.");
      await tx`update outreach_settings set data = data - 'default_sender_offer' where key = 'settings'`;
      assert.equal(await so.offerText(tx, CID), def);
    });
  });

  test("F14: a manual link is never replaced by a site check's link", async () => {
    await n.callWrite(async (tx) => {
      await seed(tx);
      await tx`insert into lead_social_links (lead_id, kind, url, source) values ('s8-lead', 'facebook', 'https://www.facebook.com/madeup-own-page', 'manual')`;
      await tx`insert into lead_social_links (lead_id, kind, url, source) values ('s8-lead', 'facebook', 'https://www.facebook.com/madeup-other', 'site_check')
               on conflict (lead_id, kind) do update set url = excluded.url, source = excluded.source`;
      const [l] = await tx`select url, source from lead_social_links where lead_id = 's8-lead' and kind = 'facebook'`;
      assert.deepEqual({ ...l }, { url: "https://www.facebook.com/madeup-own-page", source: "manual" });
    });
  });
});
