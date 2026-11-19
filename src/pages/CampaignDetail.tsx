import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Beaker,
  Check,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  MousePointerClick,
  Play,
  Send,
  Sparkles,
  Target,
  Trash2,
  Users,
  AlertCircle,
  FlaskConical,
  CheckCircle2,
  ExternalLink,
  Star,
  Phone,
  Globe,
  Pencil,
  X,
  MoreHorizontal,
  Radar,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
} from "lucide-react";
import { OwnerField, SiteDetails } from "@/components/SiteDetails";
import { GapBadge, LinkIcons, foundSocialText, leadLinks, ownerText, reachAnotherWay, shortDate, type LeadInfo } from "@/lib/leadInfo";
import PageHeader from "@/components/PageHeader";
import GlassCard from "@/components/GlassCard";
import Modal, { FormField, PrimaryButton, TextInput, TextArea } from "@/components/Modal";
import AnimatedNumber from "@/components/AnimatedNumber";
import { call, callBackground } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { mergeRecent, noteCreated, noteDeleted, recentlyCreated, noteExcluded, applyExcluded } from "@/lib/recent";
import { timeAgo } from "@/lib/utils";

type Campaign = {
  id: string;
  name: string;
  query: string;
  description?: string;
  structured_query: { location: string; searchTerms: string[]; maxResults: number } | null;
  status: string;
  total_leads_found: number;
  leads_skipped_duplicate?: number; // scraped leads skipped: already in an earlier campaign
  leads_imported: number;
  emails_generated: number;
  emails_sent: number;
  emails_delivered: number;
  emails_bounced: number;
  emails_clicked: number;
  emails_replied: number;
  error_message?: string;
  agentmail_inbox_id?: string;
  apify_run_id?: string | null;
  apify_status?: string | null;
  default_sender_name?: string | null;
  default_sender_company?: string | null;
  default_sender_offer?: string | null;
  any_trade?: boolean; // "Home services, any trade": no wrong-trade skipping, trade-neutral wording
  job?: Job | null;
  last_status_refresh_at?: string;
  created_at: string;
  updated_at: string;
};

// A long-running client-driven job (drafting / finding emails). Saved on the
// campaign so its progress survives page reloads and navigation. Progress
// itself is derived from the data (drafts / leads stamped since started_at).
type Job = {
  kind: "generate" | "enrich" | "sitecheck" | "browsercheck" | "review";
  resume?: boolean; // continue a stopped website check: keep its original start time
  status: "running" | "done" | "stopped";
  total: number;
  started_at: string;
  progress_at?: string;
  done?: number; // server-driven (background) jobs report their own progress
  made?: number;
  finished_at?: string;
  message?: string;
  failures?: Array<{ name: string; error: string }>;
};

type Lead = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  category: string | null;
  rating: number | null;
  reviews_count: number | null;
  maps_url: string | null;
  notes?: string | null;
  raw?: Record<string, unknown>;
  status: string;
  is_test: boolean;
  do_not_contact?: boolean;
  campaign_id?: string;
  skip_reason?: string; // .gov/.edu address, chain store, other trade, already contacted or bounced: never email-found or drafted
  skip_code?: string;
  trade_override?: boolean; // included although it looks like a different trade
  excluded?: boolean; // the user ticked this lead off: never drafted
  contacted_at?: string;
  enrich_checked_at?: string;
  enriched_at?: string;
  created_at: string;
} & LeadInfo;

type Framework = "one-off" | "pas" | "aida" | "sdr";

type EmailRow = {
  id: string;
  campaign_id: string;
  lead_id: string;
  to_email: string;
  to_name: string;
  subject: string;
  body_text: string;
  body_html: string;
  status: string;
  click_count?: number;
  sequence_position?: number;
  sequence_total?: number;
  framework?: Framework | null;
  source?: string; // "agent_drafted" when injected via emails.create
  edited?: boolean;
  review_status?: "ready" | "check" | "blocked"; // the AI reviewer's verdict (older drafts: "check", not reviewed yet)
  review_reasons?: string[];
  reviewed_by?: string | null; // model that reviewed it, "you", or "code checks"
  written_by?: string | null; // model that wrote it
  review_history?: Array<{ at: string; subject: string; body_text: string }>; // originals kept when the reviewer reworded a draft
  blocked_lead_skipped?: boolean; // its lead was skipped: this draft will never be sent
  sent_at?: string;
  blocked_do_not_contact?: boolean; // recipient said no: this draft will never be sent
  blocked_contact?: string; // "already contacted in another campaign" / "bounced earlier": will not be sent
  created_at: string;
  updated_at: string;
};

type Reply = {
  id: string;
  from: string | null;
  subject: string | null;
  text: string | null;
  received_at: string;
  handled: boolean;
};

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<"run" | "generate" | "send" | null>(null);
  const [leadDetail, setLeadDetail] = useState<Lead | null>(null);
  const [emailDetail, setEmailDetail] = useState<EmailRow | null>(null);
  const [generateProgress, setGenerateProgress] = useState<{ done: number; total: number } | null>(null);
  // Which job THIS tab is driving right now (so the banner can tell "running"
  // from "interrupted": a job left 'running' by a closed tab).
  const [localJob, setLocalJob] = useState<"generate" | "enrich" | "sitecheck" | null>(null);
  const [reviewFilter, setReviewFilter] = useState<"all" | "ready" | "check" | "blocked">("all");
  const [localDone, setLocalDone] = useState<number | null>(null);
  const [leadMenu, setLeadMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!leadMenu) return;
    const close = () => setLeadMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [leadMenu]);
  // Batch sending: how many queued drafts to send per click (oldest first).
  const [sendCount, setSendCount] = useState("5");
  const [lastSend, setLastSend] = useState<{ sent: number; queued: number; errors: number; skipped: number; notReady: number; blocked: number; excluded: number } | null>(null);
  const [editDraft, setEditDraft] = useState<EmailRow | null>(null);
  // Drafts ticked for "Send selected" (overrides the batch size).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Polling costs Netlify function calls, so it is slow, pauses while the tab is
  // hidden (see usePolling), and there is a Refresh button for "now". It speeds
  // up a little only while a drafting/finding job is running in another tab.
  const jobRunning = campaign?.job?.status === "running";
  usePolling(() => { if (id) void refresh(); }, jobRunning ? 10_000 : 30_000, [id, jobRunning]);

  // Sync: while a scrape runs it imports the leads when Apify finishes (every
  // 8s); otherwise, once a minute, it refreshes sent-email statuses from
  // AgentMail so a missed webhook cannot leave "sent" showing for days.
  const searching = campaign?.status === "searching";
  usePolling(
    async () => {
      if (!id) return;
      try {
        const result = await call<{ changed: boolean; status_refresh?: { updated: number } | null }>("outreach.campaign.sync", { id });
        if (result.changed || (result.status_refresh?.updated ?? 0) > 0) await refresh();
      } catch {
        // Quiet — the regular refresh surfaces persistent errors.
      }
    },
    searching ? 8000 : 60_000,
    [id, searching],
  );

  async function refresh() {
    if (!id) return;
    try {
      const [c, ls, es, rs] = await Promise.all([
        // A campaign created seconds ago may not be readable yet: fall back to what create returned.
        call<Campaign>("outreach.campaign.get", { id }).catch((e) => {
          const fresh = recentlyCreated<Campaign>("campaign", id);
          if (fresh) return fresh;
          throw e;
        }),
        call<Lead[]>("outreach.leads.list", { campaign_id: id }),
        call<EmailRow[]>("outreach.emails.list", { campaign_id: id }),
        call<Reply[]>("outreach.replies.list", { campaign_id: id, limit: 20 }),
      ]);
      setCampaign(c);
      setLeads(applyExcluded(mergeRecent("lead", ls, (l) => l.campaign_id === id)));
      setEmails(mergeRecent("email", es, (e) => e.campaign_id === id));
      setReplies(rs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  // "Refresh now": reload everything and ask AgentMail for fresh email statuses.
  const [refreshing, setRefreshing] = useState(false);
  async function refreshNow() {
    if (!id) return;
    setRefreshing(true);
    try {
      await call("outreach.campaign.sync", { id }).catch(() => undefined);
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  // Tick / untick a lead for drafting. Optimistic, rolled back if the server refuses.
  async function setLeadExcluded(leadId: string, excluded: boolean) {
    if (!id) return;
    // Skipping a lead that already has unsent drafts: offer to delete them (a draft for a skipped lead is never sent either way).
    const drafts = excluded ? emails.filter((e) => e.lead_id === leadId && e.status === "drafted").length : 0;
    const deleteDrafts = drafts > 0 && confirm(`This lead already has ${drafts} unsent draft${drafts === 1 ? "" : "s"}.\n\nOK = skip the lead AND delete the draft${drafts === 1 ? "" : "s"}.\nCancel = just skip the lead (the draft stays but will never be sent).`);
    if (deleteDrafts) {
      for (const e of emails) if (e.lead_id === leadId && e.status === "drafted") noteDeleted("email", e.id);
      setEmails((prev) => prev.filter((e) => !(e.lead_id === leadId && e.status === "drafted")));
    }
    noteExcluded(leadId, excluded);
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, excluded } : l)));
    try {
      await call("outreach.leads.update", { campaign_id: id, lead_id: leadId, excluded, ...(deleteDrafts ? { delete_drafts: true } : {}) });
    } catch (e) {
      noteExcluded(leadId, !excluded);
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, excluded: !excluded } : l)));
      setErr(e instanceof Error ? e.message : "Could not update the lead");
    }
  }

  // "Include anyway" for a lead skipped as a different trade (or back to skipping it).
  async function setTradeOverride(leadId: string, on: boolean) {
    if (!id) return;
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, trade_override: on, ...(on && l.skip_code === "other_trade" ? { skip_reason: undefined, skip_code: undefined } : {}) } : l)));
    try {
      await call("outreach.leads.update", { campaign_id: id, lead_id: leadId, trade_override: on });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update the lead");
      void refresh();
    }
  }

  async function setAnyTrade(on: boolean) {
    if (!id) return;
    try {
      setCampaign(await call<Campaign>("outreach.campaign.update", { id, any_trade: on }));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update the campaign");
    }
  }

  async function saveJob(job: Job | null) {
    if (!id) return;
    try {
      const c = await call<Campaign>("outreach.campaign.update", { id, job });
      setCampaign(c);
    } catch {
      // Progress display only — never block the work on it.
    }
  }

  async function runScrape() {
    if (!id) return;
    setBusyAction("run");
    setErr(null);
    try {
      // This call returns quickly now — it only *starts* the Apify run.
      // The sync poller effect will import leads once the run finishes.
      await call("outreach.campaign.run", { id });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Scrape failed to start");
    } finally {
      setBusyAction(null);
    }
  }

  // How many drafts to send this click: the number typed in "Send how many?",
  // at least 1 and never more than what is queued.
  function batchSize(queued: number): number {
    const n = Math.floor(Number(sendCount));
    return Math.min(Math.max(Number.isFinite(n) && n >= 1 ? n : 1, 1), Math.max(queued, 1));
  }

  const unsendable = (e: EmailRow) => !!(e.blocked_do_not_contact || e.blocked_contact || e.blocked_lead_skipped || (e.review_status ?? "check") === "blocked");
  const selectedDrafts = emails.filter((e) => e.status === "drafted" && !unsendable(e) && selectedIds.has(e.id)).length;
  const readyDrafts = emails.filter((e) => e.status === "drafted" && !unsendable(e) && (e.review_status ?? "check") === "ready").length;
  const checkDrafts = emails.filter((e) => e.status === "drafted" && !unsendable(e) && (e.review_status ?? "check") === "check").length;
  const blockedDrafts = emails.filter((e) => e.status === "drafted" && (e.review_status ?? "check") === "blocked").length;

  async function runSend(params: Record<string, unknown>, limit: number) {
    setBusyAction("send");
    setErr(null);
    try {
      const res = await call<{ sent: number; queued: number; errors: unknown[]; skipped_contacted?: unknown[]; skipped_not_ready?: number; skipped_blocked?: number; skipped_excluded?: number }>("outreach.emails.send", { campaign_id: id, limit, ...params });
      setLastSend({ sent: res.sent, queued: res.queued, errors: res.errors?.length ?? 0, skipped: res.skipped_contacted?.length ?? 0, notReady: res.skipped_not_ready ?? 0, blocked: res.skipped_blocked ?? 0, excluded: res.skipped_excluded ?? 0 });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusyAction(null);
    }
  }

  function toggleSelected(emailId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(emailId)) next.delete(emailId);
      else next.add(emailId);
      return next;
    });
  }

  // Sends exactly the ticked drafts, ignoring the batch size.
  async function sendSelected() {
    if (!id) return;
    const picked = emails.filter((e) => e.status === "drafted" && !unsendable(e) && selectedIds.has(e.id));
    if (picked.length === 0) return;
    const list = picked.map((e) => e.to_email).join("\n");
    const needCheck = picked.filter((e) => (e.review_status ?? "check") === "check").length;
    const warn = needCheck > 0 ? `\n\n${needCheck} of these ${needCheck === 1 ? "has" : "have"} NOT passed the AI check yet ("Check this"). Send ${needCheck === 1 ? "it" : "them"} anyway?` : "";
    if (!confirm(`Send ${picked.length} selected email${picked.length === 1 ? "" : "s"} via AgentMail? This will hit real recipients' inboxes.${warn}\n\n${list}`)) return;
    await runSend({ email_ids: picked.map((e) => e.id), ...(needCheck > 0 ? { allow_check: true } : {}) }, picked.length);
    setSelectedIds(new Set());
  }

  async function sendAll() {
    if (!id) return;
    const drafted = readyDrafts;
    if (drafted === 0) {
      alert(checkDrafts + blockedDrafts > 0 ? "No drafts are ready to send. Only drafts that passed the AI check ('Ready') are sent. Click 'Review all' in the Emails list, or tick drafts and use 'Send selected'." : "No drafted emails to send. Generate drafts first.");
      return;
    }
    const n = batchSize(drafted);
    if (!confirm(`Send ${n} of ${drafted} ready emails (oldest first) via AgentMail? This will hit real recipients' inboxes. The other ${drafted - n} stay queued.${checkDrafts + blockedDrafts > 0 ? `\n\n${checkDrafts + blockedDrafts} draft${checkDrafts + blockedDrafts === 1 ? "" : "s"} that did not pass the AI check will not be sent.` : ""}`)) return;
    await runSend({}, n);
  }

  // Sends only the drafted emails at a specific sequence step. Used by
  // the per-step buttons when the campaign has a 3-email framework.
  async function sendStep(step: number) {
    if (!id) return;
    const draftsAtStep = emails.filter(
      (e) => e.status === "drafted" && !unsendable(e) && (e.review_status ?? "check") === "ready" && (e.sequence_position ?? 1) === step,
    ).length;
    if (draftsAtStep === 0) {
      alert(`No ready drafts at step ${step}. Only drafts that passed the AI check are sent; use "Review all" in the Emails list.`);
      return;
    }
    const n = batchSize(draftsAtStep);
    const verb = step === 1 ? "Send step 1" : `Send follow-up step ${step}`;
    if (!confirm(`${verb} — ${n} of ${draftsAtStep} queued email${draftsAtStep === 1 ? "" : "s"} (oldest first) via AgentMail. Leads who already replied will be skipped automatically.`))
      return;
    await runSend({ sequence_position: step }, n);
  }

  async function removeLead(leadId: string) {
    if (!id) return;
    const drafts = emails.filter((e) => e.lead_id === leadId && e.status === "drafted").length;
    if (drafts > 0 && !confirm(`Delete this lead and its ${drafts} draft${drafts === 1 ? "" : "s"}?`)) return;
    try {
      await call("outreach.leads.delete", { campaign_id: id, lead_id: leadId });
      noteDeleted("lead", leadId);
      for (const e of emails) if (e.lead_id === leadId) noteDeleted("email", e.id); // its drafts went too
      setLeads((prev) => prev.filter((l) => l.id !== leadId));
      await refresh(); // the server also removed this lead's drafts
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function deleteDraft(email: EmailRow) {
    if (!id) return;
    if (!confirm(`Delete the draft to ${email.to_email}?`)) return;
    try {
      await call("outreach.emails.delete", { campaign_id: id, email_id: email.id });
      noteDeleted("email", email.id);
      setEmails((prev) => prev.filter((e) => e.id !== email.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // AI reviewer: checks every draft that is not "ready" yet (or just the given ones). Runs in the background.
  async function startReview(emailIds?: string[]) {
    if (!id) return;
    setErr(null);
    try {
      await call("outreach.emails.review.start", { campaign_id: id, ...(emailIds ? { email_ids: emailIds } : {}) });
      await callBackground("review", { campaign_id: id, ...(emailIds ? { email_ids: emailIds } : {}) });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the review");
    }
  }

  async function markReady(email: EmailRow) {
    if (!id) return;
    try {
      await call("outreach.emails.update", { campaign_id: id, email_id: email.id, review_status: "ready" });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not mark it ready");
    }
  }

  // Browser check: opens the sites in a real browser (Apify) because chat/booking widgets on site builders
  // load with JavaScript. Shows the estimated cost first. Drafting never waits for it.
  async function startBrowserCheck(leadId?: string) {
    if (!id) return;
    setErr(null);
    try {
      const plan = await call<{ lead_ids: string[]; names: string[]; leads: number; pages: number; est_usd: number; cap: number; used: number; remaining: number }>("outreach.browsercheck.plan", { campaign_id: id, ...(leadId ? { lead_id: leadId } : {}) });
      if (plan.leads === 0) {
        alert(plan.remaining <= 0 && plan.used > 0 ? `The browser check limit for this campaign (${plan.cap} leads) is reached. You can raise it in Settings.` : "No website needs a browser check right now.");
        return;
      }
      const names = plan.names.slice(0, 6).join(", ") + (plan.names.length > 6 ? `, and ${plan.names.length - 6} more` : "");
      if (!confirm(`Check ${plan.leads} website${plan.leads === 1 ? "" : "s"} in a real browser?\n\n${names}\n\nThis uses your Apify account: about ${plan.pages} pages, estimated cost about $${plan.est_usd.toFixed(2)}. It takes a few minutes and runs in the background. (Limit for this campaign: ${plan.cap} leads, ${plan.used} used.)`)) return;
      await call("outreach.browsercheck.start", { campaign_id: id, ...(leadId ? { lead_id: leadId } : {}) });
      await callBackground("browsercheck", { campaign_id: id, lead_ids: plan.lead_ids });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the browser check");
    }
  }

  // Loops through every lead that has a website but no email, scrapes
  // each site for a contact email, updates the lead record. Runs client-
  // side so the progress bar reflects real per-lead latency.
  async function enrichEmails() {
    if (!id) return;
    // Chains, .gov/.edu and out-of-state leads are skipped by the server too.
    const targets = leads.filter((l) => !l.email && l.website && !l.skip_reason);
    if (targets.length === 0) return;
    setLocalJob("enrich");
    setErr(null);
    await saveJob({ kind: "enrich", status: "running", total: targets.length, started_at: new Date().toISOString() });
    let found = 0;
    let done = 0;
    for (const lead of targets) {
      try {
        const result = await call<{ enriched?: boolean }>("outreach.leads.enrich_one", {
          campaign_id: id,
          lead_id: lead.id,
        });
        if (result.enriched) found++;
      } catch {
        // Per-lead failures shouldn't halt the loop — sites block, time out, etc.
      }
      done++;
      if (done % 3 === 0 || done === targets.length) await refresh();
    }
    await saveJob({
      kind: "enrich",
      status: "done",
      total: targets.length,
      started_at: campaign?.job?.started_at ?? new Date().toISOString(),
      finished_at: new Date().toISOString(),
      message: `${found} of ${targets.length} sites gave us an email.`,
    });
    setLocalJob(null);
    await refresh();
  }

  // Re-check websites: the same website check for EVERY lead, one at a time. Information only: it never
  // drafts or sends, and never changes do-not-contact / contacted / bounced flags. Progress survives a
  // reload (leads carry site_check.checked_at); a stopped run continues with the leads not yet checked.
  async function recheckSites() {
    if (!id) return;
    const prev = campaign?.job;
    const resume = prev?.kind === "sitecheck" && prev.status === "running";
    const since = resume ? Date.parse(prev!.started_at) : Date.now() - 5_000;
    const targets = leads.filter((l) => l.website && !l.is_test && !(resume && l.site_check?.checked_at && Date.parse(l.site_check.checked_at) >= since));
    if (targets.length === 0) return;
    setLocalJob("sitecheck");
    setLocalDone(0);
    setErr(null);
    await saveJob({ kind: "sitecheck", status: "running", total: resume ? prev!.total : targets.length, started_at: resume ? prev!.started_at : new Date().toISOString(), resume });
    let done = 0;
    for (const lead of targets) {
      try {
        await call("outreach.leads.check_site", { campaign_id: id, lead_id: lead.id });
      } catch {
        // One slow or blocked site must not stop the rest.
      }
      done++;
      setLocalDone(done);
      if (done % 4 === 0 || done === targets.length) await refresh();
    }
    await saveJob({ kind: "sitecheck", status: "done", total: resume ? prev!.total : targets.length, started_at: campaign?.job?.started_at ?? new Date().toISOString(), finished_at: new Date().toISOString(), message: "Nothing was drafted or sent." });
    setLocalJob(null);
    setLocalDone(null);
    await refresh();
  }

  // Progress of the saved job, derived from the data so it is still right after
  // a reload: drafts created / leads checked since the job started.
  const jobView = useMemo(() => {
    const job = campaign?.job;
    if (!job) return null;
    const since = Date.parse(job.started_at);
    let done = 0;
    let found = 0;
    let lastActivity = since;
    if (job.kind === "generate") {
      for (const e of emails) {
        const t = Date.parse(e.created_at);
        if (t >= since) {
          done++;
          lastActivity = Math.max(lastActivity, t);
        }
      }
    } else {
      for (const l of leads) {
        const stamp = job.kind === "sitecheck" ? l.site_check?.checked_at : l.enrich_checked_at;
        const t = stamp ? Date.parse(stamp) : 0;
        if (t >= since) {
          done++;
          lastActivity = Math.max(lastActivity, t);
          if (l.enriched_at && Date.parse(l.enriched_at) >= since) found++;
        }
      }
    }
    // Drafting, reviewing and the browser check run on the server and report their own count; other jobs are derived from the data.
    if ((job.kind === "generate" || job.kind === "browsercheck" || job.kind === "review") && typeof job.done === "number") {
      done = job.done;
      lastActivity = Date.parse(job.progress_at ?? job.started_at);
    }
    if (localJob === job.kind && localDone !== null) done = Math.max(done, localDone);
    done = Math.min(done, job.total);
    // 'running' with no loop in this tab (or no server progress) for a while = interrupted.
    // A server-side draft waits up to ~60 s per Gemini call plus a retry, so give it 4 minutes.
    const serverJob = job.kind === "generate" || job.kind === "browsercheck" || job.kind === "review";
    const interrupted =
      job.status === "running" &&
      (serverJob || localJob !== job.kind) &&
      Date.now() - lastActivity > (job.kind === "browsercheck" ? 900_000 : serverJob ? 240_000 : 120_000);
    return { job, done, found, interrupted };
  }, [campaign?.job, emails, leads, localJob, localDone]);

  // Derive counters from the emails array — race-free unlike the cached
  // counters on the campaign record (which can lose increments when
  // AgentMail fires sent + delivered webhooks in the same millisecond).
  // Delivered/clicked/replied are cumulative — once an email is "clicked"
  // it was also "delivered", etc.
  // When each lead was last emailed (from the emails themselves).
  const emailedAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of emails) {
      if (e.status === "drafted") continue;
      const at = e.sent_at ?? e.created_at;
      if (at && (!m.get(e.lead_id) || at > m.get(e.lead_id)!)) m.set(e.lead_id, at);
    }
    return m;
  }, [emails]);

  const counters = useMemo(() => {
    const drafts = emails.filter((e) => e.status === "drafted" && !e.blocked_do_not_contact && !e.blocked_contact).length;
    const postSend = emails.filter((e) => e.status !== "drafted" && !e.blocked_do_not_contact);
    const delivered = emails.filter((e) =>
      ["delivered", "clicked", "replied"].includes(e.status),
    ).length;
    const clicked = emails.filter(
      (e) => e.status === "clicked" || e.status === "replied" || (e.click_count ?? 0) > 0,
    ).length;
    const replied = emails.filter((e) => e.status === "replied").length;
    const bounced = emails.filter((e) => e.status === "bounced" || e.status === "complained" || e.status === "failed").length;
    return {
      leads: leads.length,
      leadsWithEmail: leads.filter((l) => l.email).length,
      drafts,
      sent: postSend.length,
      delivered,
      bounced,
      clicked,
      replied,
    };
  }, [emails, leads]);

  // Figure out if this is a sequence campaign and how each step is doing.
  // We infer sequence_total from emails (fall back to the campaign
  // default if no drafts yet).
  const sequenceInfo = useMemo(() => {
    const maxStep = emails.reduce((m, e) => Math.max(m, e.sequence_position ?? 1), 1);
    const isSequence = maxStep > 1;
    const stats: Array<{ step: number; drafted: number; sent: number; delivered: number; clicked: number; replied: number; framework: Framework | null }> = [];
    for (let s = 1; s <= maxStep; s++) {
      const emailsAtStep = emails.filter((e) => (e.sequence_position ?? 1) === s);
      stats.push({
        step: s,
        drafted: emailsAtStep.filter((e) => e.status === "drafted" && !e.blocked_do_not_contact && !e.blocked_contact).length,
        sent: emailsAtStep.filter((e) => e.status !== "drafted").length,
        delivered: emailsAtStep.filter((e) => ["delivered", "clicked", "replied"].includes(e.status)).length,
        clicked: emailsAtStep.filter((e) => e.status === "clicked" || e.status === "replied" || (e.click_count ?? 0) > 0).length,
        replied: emailsAtStep.filter((e) => e.status === "replied").length,
        framework: (emailsAtStep[0]?.framework ?? null) as Framework | null,
      });
    }
    const fw = (emails[0]?.framework ?? null) as Framework | null;
    return { isSequence, maxStep, stats, framework: fw };
  }, [emails]);

  if (!campaign) {
    return (
      <div className="flex items-center gap-3 text-white/60">
        <Loader2 size={16} className="animate-spin" /> Loading campaign…
      </div>
    );
  }

  const structured = campaign.structured_query;

  return (
    <>
      <PageHeader
        title={campaign.name}
        subtitle={`"${campaign.query}"`}
        right={
          <Link
            to="/outreach"
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 font-semibold transition"
          >
            <ArrowLeft size={14} /> All campaigns
          </Link>
        }
      />

      {err && (
        <GlassCard className="mb-5 border-red-500/40 bg-red-500/10">
          <div className="flex items-center gap-3 text-red-200">
            <AlertCircle size={18} />
            <span className="text-sm font-medium">{err}</span>
          </div>
        </GlassCard>
      )}

      {campaign.error_message && campaign.status === "failed" && (
        <GlassCard className="mb-5 border-red-500/40 bg-red-500/10">
          <div className="flex items-start gap-3 text-red-200">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold mb-1">Last action failed</p>
              <p className="text-xs text-red-300/80">{campaign.error_message}</p>
            </div>
          </div>
        </GlassCard>
      )}

      {/* Persistent job progress — stays until the job finishes (survives reloads) */}
      {jobView && (() => {
        const { job, done, found, interrupted } = jobView;
        const noun = job.kind === "generate" ? "drafts" : job.kind === "review" ? "drafts reviewed" : job.kind === "browsercheck" ? "sites opened in the browser" : job.kind === "sitecheck" ? "checked" : "sites checked";
        const title = job.kind === "generate" ? "Drafting" : job.kind === "review" ? "Reviewing drafts" : job.kind === "browsercheck" ? "Browser check" : job.kind === "sitecheck" ? "Checking websites" : "Finding emails";
        const again = job.kind === "generate" ? "Click Generate emails to finish the rest (existing drafts are kept)." : job.kind === "review" ? "Click Review all to carry on." : job.kind === "browsercheck" ? "Click Check in browser to try again." : job.kind === "sitecheck" ? "Click Check websites to carry on with the rest." : "Click Find emails to continue.";
        const running = job.status === "running" && !interrupted;
        const tone = running
          ? "border-primary/40 bg-primary/10 text-primary"
          : job.status === "done" && !(job.failures?.length)
            ? "border-green-500/40 bg-green-500/10 text-green-200"
            : "border-amber-500/40 bg-amber-500/10 text-amber-200";
        return (
          <div className={`mb-5 rounded-xl border px-4 py-3 ${tone}`}>
            <div className="flex items-center gap-3">
              {running ? <Loader2 size={15} className="animate-spin shrink-0" /> : <AlertCircle size={15} className="shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">
                  {running
                    ? `${title}: ${done} of ${job.total} ${noun}${job.kind === "enrich" ? ` · ${found} email${found === 1 ? "" : "s"} found` : ""}${job.message && job.kind === "browsercheck" ? ` · ${job.message}` : ""}`
                    : interrupted
                      ? `Stopped at ${done} of ${job.total} ${noun}. ${job.kind === "generate" || job.kind === "review" || job.kind === "browsercheck" ? "It stopped making progress." : "The tab driving it was closed."} ${again}`
                      : job.status === "stopped"
                        ? `Stopped at ${done} of ${job.total} ${noun}. ${job.message ?? ""}`
                        : `Finished: ${done} of ${job.total} ${noun}. ${job.message ?? ""}`}
                </div>
                {job.failures && job.failures.length > 0 && (
                  <ul className="mt-1 text-xs opacity-90 list-disc pl-5">
                    {job.failures.slice(0, 6).map((f, i) => (
                      <li key={i}><span className="font-semibold">{f.name}</span>: {f.error}</li>
                    ))}
                    {job.failures.length > 6 && <li>…and {job.failures.length - 6} more</li>}
                  </ul>
                )}
              </div>
              {!running && (
                <button onClick={() => void saveJob(null)} className="shrink-0 text-xs underline opacity-80 hover:opacity-100">Dismiss</button>
              )}
            </div>
            {running && (
              <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-primary transition-all duration-500" style={{ width: `${Math.round((done / Math.max(1, job.total)) * 100)}%` }} />
              </div>
            )}
          </div>
        );
      })()}

      {/* Scraping banner — Apify run in progress, UI polls every 4s */}
      {campaign.status === "searching" && (
        <GlassCard className="mb-5 bg-gradient-to-br from-primary/[0.08] to-purple/[0.08] border-primary/40">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/40 flex items-center justify-center shrink-0">
              <Loader2 size={18} className="text-primary animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white mb-0.5">Apify scraping Google Maps…</p>
              <p className="text-xs text-white/65">
                Typically 30 seconds to 2 minutes. Leads will appear here automatically when the run completes.
                {campaign.apify_status && (
                  <span className="font-mono text-primary ml-1">· {campaign.apify_status}</span>
                )}
              </p>
            </div>
            <a
              href={campaign.apify_run_id ? `https://console.apify.com/actors/runs/${campaign.apify_run_id}` : "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-xs text-primary hover:text-white font-mono"
            >
              View on Apify ↗
            </a>
          </div>
        </GlassCard>
      )}

      {/* Strategy summary */}
      <GlassCard className="mb-5 bg-gradient-to-br from-primary/[0.05] to-purple/[0.05]">
        <div className="flex items-start gap-5">
          <div className="w-12 h-12 rounded-xl bg-primary/20 border border-primary/40 flex items-center justify-center shrink-0">
            <Target size={20} className="text-primary" />
          </div>
          <div className="flex-1 space-y-2">
            {structured && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <MapPin size={14} className="text-primary" />
                  <span className="text-sm font-medium text-white">{structured.location}</span>
                  <span className="text-xs text-white/45">·</span>
                  <span className="text-xs text-white/55 font-mono">up to {structured.maxResults} leads</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {structured.searchTerms.map((t, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/65 text-[11px] font-mono"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="flex items-center gap-3 pt-1 flex-wrap">
              <p className="text-xs text-white/50">
                Status: <span className="text-white/80 font-semibold uppercase tracking-wider">{campaign.status}</span>
              </p>
              <span className="text-white/20">·</span>
              <SenderNameEditor campaign={campaign} onUpdate={() => void refresh()} />
              <span className="text-white/20">·</span>
              <label className="flex items-center gap-1.5 text-xs text-white/65 cursor-pointer" title="Turns off the 'different trade' skip and keeps the email wording trade-neutral">
                <input type="checkbox" className="accent-primary" checked={campaign.any_trade === true} onChange={(e) => void setAnyTrade(e.target.checked)} />
                Home services, any trade
              </label>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Action bar */}
      <div className={`grid gap-3 mb-5 ${sequenceInfo.isSequence ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-3"}`}>
        <ActionButton
          disabled={busyAction !== null || !structured || campaign.status === "searching"}
          onClick={runScrape}
          busy={busyAction === "run" || campaign.status === "searching"}
          label={
            campaign.status === "searching"
              ? "Scraping…"
              : counters && counters.leads > 0
              ? "Re-run scrape"
              : "Run Apify scrape"
          }
          sublabel={
            campaign.status === "searching"
              ? `Apify run ${campaign.apify_status?.toLowerCase() ?? "starting"} — results auto-import`
              : counters && counters.leads > 0
              ? `${counters.leads} leads imported`
              : "Fetch real businesses from Google Maps"
          }
          icon={<Play size={16} />}
          tint="primary"
        />
        <ActionButton
          disabled={busyAction !== null || leads.filter((l) => l.email).length === 0}
          onClick={() => setGenerateModalOpen(true)}
          busy={busyAction === "generate"}
          label="Generate emails"
          sublabel={
            counters && counters.drafts > 0
              ? `${counters.drafts} draft${counters.drafts === 1 ? "" : "s"} ready${sequenceInfo.isSequence ? ` · ${sequenceInfo.framework?.toUpperCase()} sequence` : ""}`
              : "Gemini drafts · pick a framework for a 3-email sequence"
          }
          icon={<Sparkles size={16} />}
          tint="purple"
        />
        {!sequenceInfo.isSequence && (
          <ActionButton
            disabled={busyAction !== null || (counters?.drafts ?? 0) === 0}
            onClick={sendAll}
            busy={busyAction === "send"}
            label="Send campaign"
            sublabel={counters && counters.sent > 0 ? `${counters.sent} sent · ${readyDrafts} ready to send` : "Sends the ready drafts, oldest first, up to the batch size"}
            icon={<Send size={16} />}
            tint="accent"
          />
        )}
      </div>

      {/* Batch send control — applies to "Send campaign" and to each step button */}
      {((counters?.drafts ?? 0) > 0 || (counters?.sent ?? 0) > 0) && (
        <div className="mb-5 flex items-center gap-3 flex-wrap rounded-xl bg-white/[0.03] border border-white/10 px-4 py-3">
          <label htmlFor="send-count" className="text-xs font-bold tracking-wider uppercase text-white/70">
            Send how many?
          </label>
          <input
            id="send-count"
            type="number"
            min={1}
            max={Math.max(counters?.drafts ?? 1, 1)}
            value={sendCount}
            onChange={(e) => setSendCount(e.target.value)}
            disabled={busyAction !== null}
            className="w-20 px-2 py-1.5 rounded-lg bg-black/30 border border-white/15 text-white text-sm font-mono focus:outline-none focus:border-accent/60"
          />
          <span className="text-sm text-white/80 font-mono" data-testid="send-summary">
            {counters?.sent ?? 0} sent, {counters?.drafts ?? 0} still queued
          </span>
          {(counters?.drafts ?? 0) > 0 && (
            <span className="text-xs font-mono text-white/60">
              <span className="text-green-300">{readyDrafts} ready</span> · <span className="text-amber-300">{checkDrafts} check this</span> · <span className="text-red-300">{blockedDrafts} blocked</span>
            </span>
          )}
          {lastSend && (
            <span className="text-xs text-white/50 font-mono">
              last send: {lastSend.sent} sent{lastSend.errors > 0 ? `, ${lastSend.errors} failed` : ""}{lastSend.skipped > 0 ? `, ${lastSend.skipped} skipped (already contacted or bounced)` : ""}{lastSend.notReady > 0 ? `, ${lastSend.notReady} not sent (not checked yet)` : ""}{lastSend.blocked > 0 ? `, ${lastSend.blocked} blocked` : ""}{lastSend.excluded > 0 ? `, ${lastSend.excluded} for skipped leads` : ""}
            </span>
          )}
          <button
            onClick={() => void sendSelected()}
            disabled={busyAction !== null || selectedDrafts === 0}
            className="px-3 py-1.5 rounded-lg bg-accent/20 hover:bg-accent/30 border border-accent/40 text-accent text-xs font-bold tracking-wide transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send selected ({selectedDrafts})
          </button>
          {selectedDrafts > 0 && (
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-white/50 hover:text-white underline">
              Clear selection
            </button>
          )}
          <span className="text-[11px] text-white/40 ml-auto">"Send" only sends drafts that passed the AI check. Tick drafts to send exact ones (a "check this" draft asks you to confirm first).</span>
        </div>
      )}

      {/* Per-step send bar — appears only for sequence campaigns. Each step
          is a separate send button so the user controls cadence manually. */}
      {sequenceInfo.isSequence && (
        <GlassCard className="mb-5 bg-gradient-to-br from-accent/[0.06] to-purple/[0.06]">
          <div className="flex items-center gap-2 mb-3">
            <Send size={14} className="text-accent" />
            <h3 className="font-display text-xs tracking-widest uppercase text-white/75 font-bold">
              Sequence · {sequenceInfo.framework?.toUpperCase()}
            </h3>
            <span className="text-[11px] text-white/45 font-mono">
              {sequenceInfo.maxStep} steps · send each on your own cadence
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {sequenceInfo.stats.map((step) => {
              const canSend = step.drafted > 0;
              const prevSent = step.step === 1 || (sequenceInfo.stats[step.step - 2]?.sent ?? 0) > 0;
              const disabled = busyAction !== null || !canSend || !prevSent;
              return (
                <div
                  key={step.step}
                  className="rounded-xl border border-white/10 bg-black/30 p-3 flex flex-col gap-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/40 flex items-center justify-center text-accent font-bold text-xs">
                      {step.step}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-white">Step {step.step}</div>
                      <div className="text-[11px] font-mono text-white/50">
                        {step.sent}/{step.sent + step.drafted} sent
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-white/55 font-mono">
                    <span>{step.drafted} drafts</span>
                    {step.replied > 0 && <span className="text-green-300">{step.replied} replied</span>}
                    {step.clicked > 0 && <span className="text-accent">{step.clicked} clicks</span>}
                  </div>
                  <button
                    onClick={() => sendStep(step.step)}
                    disabled={disabled}
                    title={!prevSent && step.step > 1 ? `Send step ${step.step - 1} first` : undefined}
                    className={`mt-1 px-3 py-2 rounded-lg text-xs font-bold tracking-wide transition ${
                      disabled
                        ? "bg-white/5 border border-white/10 text-white/40 cursor-not-allowed"
                        : "bg-accent/20 hover:bg-accent/30 border border-accent/50 text-accent"
                    }`}
                  >
                    {busyAction === "send" ? (
                      <Loader2 size={12} className="inline animate-spin mr-1" />
                    ) : (
                      <Send size={12} className="inline mr-1" />
                    )}
                    {canSend ? `Send ${step.drafted} email${step.drafted === 1 ? "" : "s"}` : "Nothing to send"}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-white/40 mt-3 font-mono">
            Leads who reply to an earlier step are auto-skipped on later sends.
          </p>
        </GlassCard>
      )}

      {/* Counters */}
      <div className="flex justify-end mb-2">
        <button
          onClick={() => void refreshNow()}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/70 text-[11px] font-semibold transition disabled:opacity-50"
          title="Reload this campaign and refresh email statuses from AgentMail"
        >
          {refreshing ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Refresh now
        </button>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-6">
        <MiniStat label="Leads" value={counters?.leads ?? 0} icon={<Users size={14} />} tint="primary" />
        <MiniStat label="Drafts" value={counters?.drafts ?? 0} icon={<Sparkles size={14} />} tint="purple" />
        <MiniStat label="Sent" value={counters?.sent ?? 0} icon={<Send size={14} />} tint="primary" />
        <MiniStat label="Delivered" value={counters?.delivered ?? 0} icon={<CheckCircle2 size={14} />} tint="green" />
        <MiniStat label="Clicks" value={counters?.clicked ?? 0} icon={<MousePointerClick size={14} />} tint="accent" />
        <MiniStat label="Replies" value={counters?.replied ?? 0} icon={<MessageSquare size={14} />} tint="green" />
      </div>

      {/* Recent replies — the stage-wow strip */}
      {replies.length > 0 && (
        <GlassCard className="mb-6 bg-gradient-to-br from-green-500/[0.06] to-transparent border-green-500/30">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare size={16} className="text-green-400" />
            <h3 className="font-display text-sm tracking-widest uppercase text-green-300 font-bold">Recent replies</h3>
            <span className="text-xs font-mono text-white/50">({replies.length})</span>
          </div>
          <div className="space-y-2">
            {replies.slice(0, 5).map((r) => (
              <div key={r.id} className="rounded-lg bg-black/30 border border-white/10 p-3 flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-green-500/20 border border-green-500/40 flex items-center justify-center shrink-0">
                  <MessageSquare size={13} className="text-green-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-white truncate">{r.from ?? "Unknown"}</span>
                    <span className="text-xs text-white/40 font-mono">{timeAgo(r.received_at)}</span>
                  </div>
                  <p className="text-xs text-white/65 mb-1 truncate">{r.subject ?? "(no subject)"}</p>
                  <p className="text-xs text-white/55 line-clamp-2">{r.text ?? ""}</p>
                </div>
                <Link
                  to="/inbox"
                  className="shrink-0 px-2.5 py-1 rounded-md bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 text-green-300 text-[10px] font-bold tracking-wider uppercase transition"
                >
                  Open
                </Link>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {/* Leads table */}
      <GlassCard className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-primary" />
            <h3 className="font-display text-sm tracking-widest uppercase text-white/75 font-bold">Leads</h3>
            <span className="text-xs font-mono text-white/50">({leads.length})</span>
          </div>
          <div className="flex items-center gap-2">
            {(() => {
              const withoutEmail = leads.filter((l) => !l.email && l.website && !l.skip_reason).length;
              const enriching = localJob === "enrich";
              if (withoutEmail === 0 && !enriching) return null;
              return (
                <button
                  onClick={enrichEmails}
                  disabled={enriching || withoutEmail === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-50"
                >
                  {enriching ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
                  {enriching ? `Finding emails ${jobView?.done ?? 0}/${jobView?.job.total ?? ""}` : `Find emails (${withoutEmail})`}
                </button>
              );
            })()}
            {leads.some((l) => l.website && !l.is_test) && (() => {
              const checking = localJob === "sitecheck";
              const stopped = jobView?.job.kind === "sitecheck" && jobView.interrupted;
              return (
                <button
                  onClick={recheckSites}
                  disabled={checking || localJob !== null}
                  title="Looks at every lead's website for chat, online booking, social links and the owner's name. Information only: nothing is drafted or sent."
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple/15 hover:bg-purple/25 border border-purple/40 text-purple text-xs font-bold tracking-wide transition disabled:opacity-50"
                >
                  {checking ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
                  {checking ? `Checking ${jobView?.done ?? 0} of ${jobView?.job.total ?? ""}` : stopped ? "Continue website check" : "Check websites"}
                </button>
              );
            })()}
            {(() => {
              const needing = leads.filter((l) => l.email && !l.excluded && !l.do_not_contact && !l.is_test && !l.skip_reason && l.site_check?.needs_browser && l.site_check?.via !== "browser").length;
              const running = campaign.job?.kind === "browsercheck" && campaign.job.status === "running";
              if (needing === 0 && !running) return null;
              return (
                <button
                  onClick={() => void startBrowserCheck()}
                  disabled={running}
                  title="Some websites load their chat and booking tools with JavaScript, so a plain look can miss them. This opens them in a real browser (Apify) before you write to them. You see the estimated cost first."
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 border border-primary/40 text-primary text-xs font-bold tracking-wide transition disabled:opacity-50"
                >
                  {running ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
                  {running ? "Browser check running…" : `Check in browser (${needing})`}
                </button>
              );
            })()}
            <button
              onClick={() => setTestModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/15 hover:bg-accent/25 border border-accent/40 text-accent text-xs font-bold tracking-wide transition"
            >
              <FlaskConical size={13} /> Add test lead
            </button>
          </div>
        </div>

        {leads.length === 0 ? (
          <div className="text-center py-10 text-white/50 text-sm">
            No leads yet. Click <span className="text-white font-semibold">Run Apify scrape</span> above, or add a test lead with your own email.
          </div>
        ) : (
          <>
            <p className="text-[11px] text-white/45 mb-2 font-mono">
              {counters.leadsWithEmail} of {counters.leads} leads have email addresses.
              {counters.leads - counters.leadsWithEmail > 0 && ` ${counters.leads - counters.leadsWithEmail} will be skipped at generate time.`}
            </p>
            {(campaign.total_leads_found ?? 0) > 0 && campaign.leads_skipped_duplicate !== undefined && (
              <p className="text-[11px] text-white/60 mb-2 font-mono" data-testid="dedupe-summary">
                {campaign.total_leads_found} found, {campaign.leads_skipped_duplicate} skipped as already contacted
              </p>
            )}
            <div className="space-y-1">
              {leads.map((l) => (
                <div key={l.id} className="group flex items-center gap-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/[0.12] px-3 py-2 transition cursor-pointer"
                     onClick={() => setLeadDetail(l)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white truncate">{l.name}</span>
                      {l.is_test && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/20 border border-accent/40 text-accent text-[9px] font-bold tracking-wider uppercase">
                          <Beaker size={9} /> Test
                        </span>
                      )}
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-white/45">
                        {l.status}
                      </span>
                      {l.do_not_contact && (
                        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/40 text-red-300 uppercase tracking-wider">
                          do not contact
                        </span>
                      )}
                      {l.excluded && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 border border-white/20 text-white/70">
                          excluded
                        </span>
                      )}
                      {l.contacted_at && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/30 text-green-300">
                          contacted
                        </span>
                      )}
                      {l.skip_reason && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                          {l.skip_reason.replace(/^Skipped: /, "skip: ")}
                        </span>
                      )}
                      {l.trade_override && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 border border-primary/30 text-primary">
                          included anyway
                        </span>
                      )}
                      {!l.email && !l.is_test && (reachAnotherWay(l).length > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple/15 border border-purple/40 text-purple">
                          Reach another way
                          <span className="inline-flex gap-1" onClick={(ev) => ev.stopPropagation()}>
                            <LinkIcons items={reachAnotherWay(l)} size={10} />
                          </span>
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                          no email
                        </span>
                      ))}
                      <GapBadge score={l.gap_score} reasons={l.gap_reasons} />
                      <FitLabels lead={l} />
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-white/50 font-mono mt-0.5 flex-wrap">
                      {l.email && <span className="text-white/70">{l.email}</span>}
                      {l.category && <span>· {l.category}</span>}
                      {l.rating !== null && <span>· <Star size={9} className="inline -mt-0.5" /> {l.rating}{l.reviews_count ? ` (${l.reviews_count})` : ""}</span>}
                      {l.address && <span className="truncate max-w-[220px]">· {l.address}</span>}
                      {ownerText(l) && <span className={l.owner_confidence === "low" ? "text-white/45" : "text-white/70"}>· Owner: {ownerText(l)}</span>}
                    </div>
                    {(l.gap_reasons?.length ?? 0) > 0 && (
                      <div className="text-[11px] text-white/50 mt-0.5">{l.gap_reasons!.join(" · ")}</div>
                    )}
                    {(() => {
                      const sentAt = emailedAt.get(l.id) ?? l.contacted_at;
                      if (!sentAt) return null;
                      const found = foundSocialText(l);
                      return <div className="text-[11px] text-green-300/80 mt-0.5">Emailed {shortDate(sentAt)}{found ? ` · ${found}` : ""}</div>;
                    })()}
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <LinkIcons items={leadLinks(l)} />
                    {l.phone && (
                      <a
                        href={`tel:${l.phone}`}
                        className="w-8 h-8 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white flex items-center justify-center transition"
                        title={l.phone}
                      >
                        <Phone size={12} />
                      </a>
                    )}
                    <button
                      onClick={() => removeLead(l.id)}
                      className="w-8 h-8 rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-red-300 flex items-center justify-center transition"
                      title="Remove"
                    >
                      <Trash2 size={12} />
                    </button>
                    <div className="relative">
                      <button
                        onClick={() => setLeadMenu(leadMenu === l.id ? null : l.id)}
                        className="w-8 h-8 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white flex items-center justify-center transition"
                        title="More"
                        aria-label={`More actions for ${l.name}`}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {leadMenu === l.id && (
                        <div className="absolute right-0 top-9 z-20 min-w-[210px] rounded-lg bg-[#14161f] border border-white/15 shadow-xl py-1 text-xs">
                          {!l.do_not_contact && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10"
                              onClick={() => { setLeadMenu(null); void setLeadExcluded(l.id, !l.excluded); }}
                            >
                              {l.excluded ? "Include this lead" : "Skip this lead"}
                            </button>
                          )}
                          {l.website && !l.is_test && (
                            <button className="w-full text-left px-3 py-2 hover:bg-white/10" onClick={() => { setLeadMenu(null); void startBrowserCheck(l.id); }}>
                              Re-check in browser
                            </button>
                          )}
                          {l.skip_code === "other_trade" && (
                            <button className="w-full text-left px-3 py-2 hover:bg-white/10" onClick={() => { setLeadMenu(null); void setTradeOverride(l.id, true); }}>
                              Include anyway (different trade)
                            </button>
                          )}
                          {l.trade_override && (
                            <button className="w-full text-left px-3 py-2 hover:bg-white/10" onClick={() => { setLeadMenu(null); void setTradeOverride(l.id, false); }}>
                              Go back to skipping other trades
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </GlassCard>

      {/* Email drafts */}
      <GlassCard className="mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Mail size={16} className="text-purple" />
          <h3 className="font-display text-sm tracking-widest uppercase text-white/75 font-bold">Emails</h3>
          <span className="text-xs font-mono text-white/50">({emails.length})</span>
          {emails.some((e) => e.status === "drafted") && (
            <div className="ml-auto flex items-center gap-1.5 flex-wrap">
              {(["all", "ready", "check", "blocked"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setReviewFilter(f)}
                  className={`px-2 py-1 rounded-md border text-[11px] font-semibold transition ${reviewFilter === f ? "bg-primary/20 border-primary/50 text-white" : "bg-white/5 border-white/10 text-white/60 hover:text-white"}`}
                >
                  {f === "all" ? "All" : f === "ready" ? `Ready (${readyDrafts})` : f === "check" ? `Check this (${checkDrafts})` : `Blocked (${blockedDrafts})`}
                </button>
              ))}
              <button
                onClick={() => void startReview()}
                disabled={campaign.job?.status === "running"}
                title="The AI checker reads each draft against what we found on the lead's website and marks it Ready, Check this or Blocked."
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-purple/15 hover:bg-purple/25 border border-purple/40 text-purple text-[11px] font-bold transition disabled:opacity-50"
              >
                <ShieldCheck size={11} /> Review all
              </button>
            </div>
          )}
        </div>
        {emails.length === 0 ? (
          <div className="text-center py-10 text-white/50 text-sm">
            <>No drafts yet. Click <span className="text-white font-semibold">Generate emails</span> after leads are in.</>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {emails.filter((e) => reviewFilter === "all" || (e.status === "drafted" && (e.review_status ?? "check") === reviewFilter)).map((e) => {
                const pos = e.sequence_position ?? 1;
                const total = e.sequence_total ?? 1;
                const showStep = total > 1;
                return (
                  <div
                    key={e.id}
                    onClick={() => setEmailDetail(e)}
                    className="rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/[0.12] p-3 cursor-pointer transition"
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      {e.status === "drafted" && !unsendable(e) && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(e.id)}
                          onChange={() => toggleSelected(e.id)}
                          onClick={(ev) => ev.stopPropagation()}
                          aria-label={`Select draft to ${e.to_email}`}
                          className="w-4 h-4 accent-cyan-400 cursor-pointer"
                        />
                      )}
                      {showStep && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/10 border border-accent/30 text-accent text-[10px] font-bold tracking-wider uppercase">
                          Step {pos}/{total}
                        </span>
                      )}
                      {e.source === "agent_drafted" && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-purple/15 border border-purple/30 text-purple text-[10px] font-bold tracking-wider uppercase">
                          Agent
                        </span>
                      )}
                      <span className="text-xs text-white/50 font-mono">to</span>
                      <span className="text-sm text-white font-medium truncate">{e.to_email}</span>
                      <StatusPill status={e.status} />
                      {e.status === "drafted" && <ReviewBadge status={e.review_status ?? "check"} />}
                      {e.blocked_lead_skipped && (
                        <span className="px-1.5 py-0.5 rounded-md bg-white/10 border border-white/20 text-white/70 text-[10px] font-bold tracking-wider uppercase" title="You skipped this lead, so this draft will never be sent.">
                          Lead skipped
                        </span>
                      )}
                      {e.blocked_contact && (
                        <span className="px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[10px] font-bold tracking-wider uppercase" title="This draft will not be sent.">
                          {/bounced/i.test(e.blocked_contact) ? "Bounced earlier" : "Already contacted"}
                        </span>
                      )}
                      {e.blocked_do_not_contact && (
                        <span className="px-1.5 py-0.5 rounded-md bg-red-500/15 border border-red-500/40 text-red-300 text-[10px] font-bold tracking-wider uppercase" title="This person asked not to be contacted. This draft will never be sent.">
                          Blocked: do not contact
                        </span>
                      )}
                      {(e.click_count ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/15 border border-accent/30 text-accent text-[10px] font-bold">
                          <MousePointerClick size={10} /> {e.click_count}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
                        {e.status === "drafted" && (
                          <>
                            {(e.review_status ?? "check") !== "ready" && (
                              <button
                                onClick={() => void markReady(e)}
                                className="flex items-center gap-1 px-2 py-1 rounded-md bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 text-green-300 text-[11px] font-semibold transition"
                                title="I have read it myself: mark it ready to send"
                              >
                                <Check size={11} /> Mark ready
                              </button>
                            )}
                            <button
                              onClick={() => void startReview([e.id])}
                              disabled={campaign.job?.status === "running"}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-purple/10 hover:bg-purple/20 border border-purple/30 text-purple text-[11px] font-semibold transition disabled:opacity-40"
                              title="Run the AI check on this draft again"
                            >
                              <ShieldCheck size={11} /> Review again
                            </button>
                            <button
                              onClick={() => setEditDraft(e)}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white text-[11px] font-semibold transition"
                              title="Edit subject and body"
                            >
                              <Pencil size={11} /> Edit
                            </button>
                            <button
                              onClick={() => void deleteDraft(e)}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-red-300 text-[11px] font-semibold transition"
                              title="Delete this draft"
                            >
                              <Trash2 size={11} /> Delete
                            </button>
                          </>
                        )}
                        <ExternalLink size={11} className="text-white/30" />
                      </div>
                    </div>
                    <p className="text-sm font-semibold text-white mb-0.5">{e.subject}</p>
                    <p className="text-xs text-white/55 line-clamp-2 whitespace-pre-wrap">{e.body_text}</p>
                    {e.status === "drafted" && (e.review_reasons?.length ?? 0) > 0 && (e.review_status ?? "check") !== "ready" && (
                      <ul className={`mt-1.5 text-[11px] list-disc pl-5 ${(e.review_status ?? "check") === "blocked" ? "text-red-300/90" : "text-amber-300/90"}`}>
                        {e.review_reasons!.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    )}
                    {e.status === "drafted" && (e.review_status ?? "check") === "ready" && (e.review_reasons?.length ?? 0) > 0 && (
                      <p className="mt-1 text-[11px] text-green-300/80">{e.review_reasons![0]}</p>
                    )}
                    {e.status === "drafted" && (e.written_by || e.reviewed_by) && (
                      <p className="mt-1 text-[10px] text-white/35 font-mono">{e.written_by ? `written by ${e.written_by}` : ""}{e.written_by && e.reviewed_by ? " · " : ""}{e.reviewed_by ? `checked by ${e.reviewed_by}` : ""}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </GlassCard>

      {/* Add test lead modal */}
      <AddTestLeadModal
        open={testModalOpen}
        onClose={() => setTestModalOpen(false)}
        campaignId={campaign.id}
        onAdded={() => void refresh()}
      />

      {/* Generate emails modal — per-lead with live progress */}
      <GenerateEmailsModal
        open={generateModalOpen}
        onClose={() => setGenerateModalOpen(false)}
        campaignId={campaign.id}
        leads={leads}
        existingEmails={emails}
        campaign={campaign}
        saveJob={saveJob}
        setLocalJob={setLocalJob}
        setBusyAction={setBusyAction}
        onComplete={() => void refresh()}
        setErr={setErr}
        progress={generateProgress}
        setProgress={setGenerateProgress}
      />

      {/* Lead detail */}
      {leadDetail && (
        <LeadDetailModal
          lead={leadDetail}
          onClose={() => setLeadDetail(null)}
          onChanged={(patch) => {
            setLeadDetail((cur) => (cur ? ({ ...cur, ...patch } as Lead) : cur));
            setLeads((prev) => prev.map((l) => (l.id === leadDetail.id ? ({ ...l, ...patch } as Lead) : l)));
          }}
        />
      )}

      {/* Edit draft */}
      {editDraft && (
        <EditDraftModal
          email={editDraft}
          onClose={() => setEditDraft(null)}
          onSaved={() => {
            setEditDraft(null);
            void refresh();
          }}
        />
      )}

      {/* Email detail */}
      {emailDetail && <EmailDetailModal email={emailDetail} onClose={() => setEmailDetail(null)} />}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Sub-components

function ReviewBadge({ status }: { status: "ready" | "check" | "blocked" }) {
  const map = {
    ready: { label: "Ready", cls: "bg-green-500/15 border-green-500/40 text-green-300", Icon: ShieldCheck },
    check: { label: "Check this", cls: "bg-amber-500/15 border-amber-500/40 text-amber-300", Icon: ShieldAlert },
    blocked: { label: "Blocked", cls: "bg-red-500/15 border-red-500/40 text-red-300", Icon: ShieldX },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-bold tracking-wider uppercase ${map.cls}`}>
      <map.Icon size={10} /> {map.label}
    </span>
  );
}

/** Warning labels from the website check. They only inform; you decide. */
function FitLabels({ lead }: { lead: Lead }) {
  const sc = lead.site_check;
  const items: Array<{ text: string; title: string }> = [];
  if (sc?.not_home_service) items.push({ text: "Check: may not be a home-service business", title: sc.not_home_service });
  if (sc?.lead_gen_listing) items.push({ text: "Check: may be a lead-gen listing", title: sc.lead_gen_listing });
  if (sc?.needs_browser && sc.via !== "browser") items.push({ text: "Needs browser check", title: sc.needs_browser_reason ?? "Chat and booking tools may load with JavaScript" });
  else if (sc?.via === "browser") items.push({ text: "Browser-checked", title: "Facts come from a real browser check" });
  return (
    <>
      {items.map((i) => (
        <span key={i.text} title={i.title} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${i.text === "Browser-checked" ? "bg-green-500/10 border-green-500/30 text-green-300" : "bg-amber-500/10 border-amber-500/30 text-amber-300"}`}>
          {i.text}
        </span>
      ))}
    </>
  );
}

function ActionButton({
  onClick,
  disabled,
  busy,
  label,
  sublabel,
  icon,
  tint,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
  tint: "primary" | "purple" | "accent";
}) {
  const tints: Record<typeof tint, string> = {
    primary: "from-primary/15 to-primary/5 border-primary/30 hover:border-primary/60 text-primary",
    purple: "from-purple/15 to-purple/5 border-purple/30 hover:border-purple/60 text-purple",
    accent: "from-accent/15 to-accent/5 border-accent/30 hover:border-accent/60 text-accent",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-xl p-4 bg-gradient-to-br ${tints[tint]} border transition disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {busy ? <Loader2 size={16} className="animate-spin" /> : icon}
        <span className="font-display text-sm font-bold tracking-wide text-white">{label}</span>
      </div>
      <p className="text-xs text-white/60">{sublabel}</p>
    </button>
  );
}

function MiniStat({ label, value, icon, tint }: { label: string; value: number; icon: React.ReactNode; tint: "primary" | "purple" | "accent" | "green" }) {
  const tints: Record<typeof tint, string> = {
    primary: "text-primary",
    purple: "text-purple",
    accent: "text-accent",
    green: "text-green-300",
  };
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] px-3 py-2">
      <div className={`flex items-center gap-1.5 mb-0.5 ${tints[tint]}`}>{icon}<span className="text-[10px] uppercase tracking-widest font-bold">{label}</span></div>
      <div className="font-display text-xl font-black text-white">
        <AnimatedNumber value={value} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    drafted: "bg-white/5 border-white/15 text-white/60",
    sent: "bg-primary/15 border-primary/40 text-primary",
    delivered: "bg-green-500/15 border-green-500/40 text-green-300",
    bounced: "bg-red-500/15 border-red-500/40 text-red-300",
    clicked: "bg-accent/15 border-accent/40 text-accent",
    replied: "bg-green-500/25 border-green-500/60 text-green-200",
    complained: "bg-red-500/15 border-red-500/40 text-red-300",
    failed: "bg-red-500/15 border-red-500/40 text-red-300",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-bold tracking-wider uppercase ${map[status] ?? "bg-white/5 border-white/10 text-white/50"}`}>
      {status}
    </span>
  );
}

function AddTestLeadModal({ open, onClose, campaignId, onAdded }: { open: boolean; onClose: () => void; campaignId: string; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("Use this lead to test the full send → reply loop.");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const lead = await call<{ id: string }>("outreach.leads.add_test", {
        campaign_id: campaignId,
        email: email.trim(),
        name: name.trim() || email.split("@")[0],
        notes,
      });
      noteCreated("lead", lead); // show it now, even if the list has not caught up yet
      setEmail("");
      setName("");
      onAdded();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a test lead" description="Seed your own email into this campaign so you can watch the send → reply loop end-to-end." maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Your email" required hint="Replies to this address will appear in your dashboard within seconds.">
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" required autoFocus />
        </FormField>
        <FormField label="Display name" hint="Optional — what the lead shows as in the table.">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Your Test Lead" />
        </FormField>
        <FormField label="Notes" hint="Passed to Gemini as context for the draft.">
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </FormField>
        {err && <div className="rounded-lg bg-red-500/15 border border-red-500/40 px-4 py-2 text-sm text-red-200">{err}</div>}
        <div className="flex items-center gap-3">
          <PrimaryButton type="submit" loading={busy} disabled={!email.trim() || busy}>
            <FlaskConical size={14} /> Add test lead
          </PrimaryButton>
          <button type="button" onClick={onClose} className="px-4 py-3 text-sm text-white/60 hover:text-white font-medium">Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

const FRAMEWORK_OPTIONS: Array<{ value: Framework; label: string; desc: string; stepLabels?: [string, string, string] }> = [
  {
    value: "one-off",
    label: "One-off",
    desc: "Single email per lead. Fast, no follow-ups.",
  },
  {
    value: "pas",
    label: "PAS · 3 emails",
    desc: "Problem → Agitate → Solution. Classic B2B pattern.",
    stepLabels: ["Name the pain", "Agitate the cost", "Propose solution"],
  },
  {
    value: "aida",
    label: "AIDA · 3 emails",
    desc: "Attention → Interest → Desire + Action. Hook-forward.",
    stepLabels: ["Grab attention", "Build interest", "Desire + CTA"],
  },
  {
    value: "sdr",
    label: "Short SDR · 3 emails",
    desc: "Direct pitch → Value-add → Breakup. Most polite.",
    stepLabels: ["Direct pitch", "Value-add", "Warm breakup"],
  },
];

function GenerateEmailsModal({
  open,
  onClose,
  campaignId,
  leads,
  existingEmails,
  campaign,
  saveJob,
  setLocalJob,
  setBusyAction,
  onComplete,
  setErr,
  progress,
  setProgress,
}: {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  leads: Lead[];
  existingEmails: EmailRow[];
  campaign: Campaign;
  saveJob: (j: Job | null) => Promise<void>;
  setLocalJob: (v: "generate" | "enrich" | "sitecheck" | null) => void;
  setBusyAction: (v: "run" | "generate" | "send" | null) => void;
  onComplete: () => void;
  setErr: (s: string | null) => void;
  progress: { done: number; total: number } | null;
  setProgress: (p: { done: number; total: number } | null) => void;
}) {
  const [senderName, setSenderName] = useState("");
  const [senderCompany, setSenderCompany] = useState("");
  const [senderOffer, setSenderOffer] = useState("");
  const [framework, setFramework] = useState<Framework>("one-off");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Prefill: the campaign's own saved sender details first, then the defaults
  // from Settings. Only fills fields still empty, so it never overwrites typing.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!open || prefilled.current) return;
    prefilled.current = true;
    const fromCampaign = {
      name: campaign.default_sender_name ?? "",
      company: campaign.default_sender_company ?? "",
      offer: campaign.default_sender_offer ?? "",
    };
    setSenderName((v) => v || fromCampaign.name);
    setSenderCompany((v) => v || fromCampaign.company);
    setSenderOffer((v) => v || fromCampaign.offer);
    call<{ default_sender_name: string; default_sender_company: string; default_sender_offer: string }>("outreach.settings.get")
      .then((d) => {
        setSenderName((v) => v || d.default_sender_name);
        setSenderCompany((v) => v || d.default_sender_company);
        setSenderOffer((v) => v || d.default_sender_offer);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalSteps = framework === "one-off" ? 1 : 3;
  const currentFramework = FRAMEWORK_OPTIONS.find((f) => f.value === framework)!;

  // Leads with an email are eligible. For sequences, we check per-(lead, step)
  // when drafting — skipping a lead only at a step that already has a draft.
  // For the pre-submit count display we show drafts-to-create = eligible × steps
  // minus any per-(lead, step) duplicates that already exist.
  const leadsWithEmail = leads.filter((l) => l.email && !l.skip_reason && !l.do_not_contact && !l.excluded);
  const skippedQuality = leads.filter((l) => l.email && l.skip_reason).length;
  const skippedExcluded = leads.filter((l) => l.excluded).length;
  const existingByLeadStep = new Set(
    existingEmails.map((e) => `${e.lead_id}__${e.sequence_position ?? 1}`),
  );
  const plannedPairs: Array<{ lead: Lead; step: number }> = [];
  for (const lead of leadsWithEmail) {
    for (let s = 1; s <= totalSteps; s++) {
      if (existingByLeadStep.has(`${lead.id}__${s}`)) continue;
      plannedPairs.push({ lead, step: s });
    }
  }
  const plannedCount = plannedPairs.length;
  const skippedNoEmail = leads.filter((l) => !l.email).length;
  const skippedNoEmailButWebsite = leads.filter((l) => !l.email && l.website).length;
  const skippedAlreadyDrafted = leadsWithEmail.length * totalSteps - plannedCount;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!senderOffer.trim() || plannedCount === 0) return;
    setBusy(true);
    setLocalErr(null);
    setErr(null);
    try {
      // The server validates, records the job and returns at once; the slow work then runs in the
      // background function (no browser tab needs to stay open, no gateway timeout). Progress
      // ("3 of 6 drafts") is read from the campaign job by the banner.
      const jobParams = {
        campaign_id: campaignId,
        sender_name: senderName,
        sender_company: senderCompany,
        sender_offer: senderOffer,
        framework,
        // Fallback for leads the server's list cannot see yet (no bulky raw data).
        leads: leads.map((l) => ({ ...l, raw: undefined, excluded: !!l.excluded })),
      };
      const started = await call<{ total: number; started_at: string }>("outreach.draft.start", jobParams);
      await callBackground("draft", jobParams);
      setProgress({ done: 0, total: started.total });
      onComplete();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start drafting";
      setLocalErr(msg);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate emails"
      description="Gemini drafts personalised emails per lead. Pick a framework for a 3-email sequence, or keep it to a single first-touch."
      maxWidth="max-w-2xl"
    >
      <form onSubmit={submit} className="space-y-4">
        {/* Framework picker — the new heart of the flow */}
        <div>
          <div className="text-xs uppercase tracking-widest text-white/80 font-display font-bold mb-2">
            Sequence framework
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {FRAMEWORK_OPTIONS.map((opt) => {
              const active = framework === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFramework(opt.value)}
                  className={`text-left rounded-xl border px-3 py-2.5 transition ${
                    active
                      ? "bg-primary/15 border-primary/50 shadow-glow"
                      : "bg-white/[0.02] border-white/10 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`font-display font-bold text-sm ${active ? "text-white" : "text-white/85"}`}>
                      {opt.label}
                    </span>
                    {active && <Check size={13} className="text-primary" />}
                  </div>
                  <p className={`text-[11px] ${active ? "text-white/75" : "text-white/50"}`}>{opt.desc}</p>
                  {opt.stepLabels && (
                    <div className="flex items-center gap-1 mt-2 text-[10px] font-mono text-white/50">
                      <span className="px-1.5 py-0.5 rounded bg-black/30">1· {opt.stepLabels[0]}</span>
                      <span>→</span>
                      <span className="px-1.5 py-0.5 rounded bg-black/30">2· {opt.stepLabels[1]}</span>
                      <span>→</span>
                      <span className="px-1.5 py-0.5 rounded bg-black/30">3· {opt.stepLabels[2]}</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {totalSteps > 1 && (
            <p className="text-[11px] text-white/55 mt-2">
              You'll send each step manually — "Send step 1" now, then "Send step 2" a few days later, etc.
              Leads who reply to an earlier step are auto-skipped on later sends.
            </p>
          )}
        </div>

        <div className="rounded-lg bg-white/[0.03] border border-white/[0.08] p-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-white/70">Drafts to create</span>
            <span className="font-mono font-bold text-primary">
              {plannedCount}
              {totalSteps > 1 && (
                <span className="text-white/50 font-normal text-xs ml-1">
                  ({leadsWithEmail.length} leads × {totalSteps} steps)
                </span>
              )}
            </span>
          </div>
          {skippedExcluded > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-amber-300/80">Leads you unticked (not drafted)</span>
              <span className="font-mono text-amber-300">{skippedExcluded}</span>
            </div>
          )}
          {(() => {
            const needing = leadsWithEmail.filter((l) => l.site_check?.needs_browser && l.site_check?.via !== "browser").length;
            if (needing === 0) return null;
            return (
              <div className="text-[11px] text-amber-300/90 pt-1">
                {needing} lead{needing === 1 ? "" : "s"} still need a browser check, so their emails are written without mentioning a website gap. Close this and click "Check in browser" first if you want the gap included. Drafting never waits for it.
              </div>
            );
          })()}
          <div className="text-[11px] text-white/45 pt-1">Every draft is checked by the AI reviewer after it is written. Only drafts marked Ready are sent by "Send".</div>
          {skippedQuality > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-amber-300/80">Chains, other trades, already contacted, bounced, .gov/.edu and out-of-state leads (skipped)</span>
              <span className="font-mono text-amber-300">{skippedQuality}</span>
            </div>
          )}
          {skippedNoEmail > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-amber-300/80">Leads without an email (skipped)</span>
              <span className="font-mono text-amber-300">{skippedNoEmail}</span>
            </div>
          )}
          {skippedNoEmailButWebsite > 0 && (
            <div className="pt-2 mt-1 border-t border-white/5 text-[11px] text-white/60">
              💡 Tip: {skippedNoEmailButWebsite} of those have websites. Close this and click
              <span className="font-semibold text-primary"> Find emails </span>
              in the Leads card to scrape them first — usually recovers 40–70%.
            </div>
          )}
          {skippedAlreadyDrafted > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-white/50">Already drafted (skipped)</span>
              <span className="font-mono text-white/50">{skippedAlreadyDrafted}</span>
            </div>
          )}
        </div>

        <FormField label="Your name" hint="Signed at the bottom of the email.">
          <TextInput value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="e.g. Mani" autoFocus />
        </FormField>
        <FormField label="Your company" hint="Optional — mentioned as credibility anchor.">
          <TextInput value={senderCompany} onChange={(e) => setSenderCompany(e.target.value)} placeholder="e.g. Vertical AI" />
        </FormField>
        <FormField label="Value / offer" hint="One sentence describing what you're offering. Gemini shapes the hook around this." required>
          <TextArea value={senderOffer} onChange={(e) => setSenderOffer(e.target.value)} rows={3} placeholder="e.g. We ship AI voice agents for SMBs in 30 days, flat-fee, no retainer." required />
        </FormField>

        {progress && (
          <div className="rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-primary mb-1.5">
              <Loader2 size={12} className="animate-spin" />
              <span className="font-mono">
                {totalSteps > 1
                  ? `Drafting sequence — ${progress.done} of ${progress.total}`
                  : `Drafting ${progress.done} of ${progress.total}`}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {note && (
          <div className="rounded-lg bg-amber-500/15 border border-amber-500/40 px-4 py-2 text-sm text-amber-200">{note}</div>
        )}
        {localErr && (
          <div className="rounded-lg bg-red-500/15 border border-red-500/40 px-4 py-2 text-sm text-red-200">{localErr}</div>
        )}

        <div className="flex items-center gap-3">
          <PrimaryButton type="submit" loading={busy} disabled={!senderOffer.trim() || busy || plannedCount === 0}>
            <Sparkles size={14} /> Generate {plannedCount} draft{plannedCount === 1 ? "" : "s"}
            {totalSteps > 1 && <span className="opacity-75">· {currentFramework.label.split(" ")[0]}</span>}
          </PrimaryButton>
          <button type="button" onClick={onClose} className="px-4 py-3 text-sm text-white/60 hover:text-white font-medium">
            {busy ? "Close (keeps running)" : "Cancel"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LeadDetailModal({ lead, onClose, onChanged }: { lead: Lead; onClose: () => void; onChanged: (patch: Record<string, unknown>) => void }) {
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={lead.name}
      description={lead.is_test ? "🧪 Test lead — seeded by you for the send→reply demo." : "Lead scraped by Apify from Google Maps."}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Contact block */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <DetailRow label="Email" value={lead.email} mono />
          <DetailRow label="Phone" value={lead.phone} mono href={lead.phone ? `tel:${lead.phone}` : null} />
          <DetailRow label="Website" value={lead.website} href={lead.website} external />
          <DetailRow label="Google Maps" value={lead.maps_url ? "View on Google Maps" : null} href={lead.maps_url} external />
        </div>

        {/* Website check + owner */}
        <OwnerField lead={lead} onSaved={onChanged} />
        <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3">
          <p className="text-[10px] uppercase tracking-wider text-white/50 font-bold mb-2">Website check</p>
          <SiteDetails lead={lead} />
        </div>

        {/* Metadata block */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <DetailRow label="Category" value={lead.category} />
          <DetailRow label="Rating" value={lead.rating !== null ? `★ ${lead.rating}${lead.reviews_count ? ` (${lead.reviews_count} reviews)` : ""}` : null} />
          <DetailRow label="Address" value={lead.address} full />
        </div>

        {lead.notes && <DetailRow label="Notes" value={lead.notes} full />}

        {/* Raw Apify data — collapsed by default */}
        {lead.raw && Object.keys(lead.raw).length > 0 && (
          <details className="rounded-lg bg-black/30 border border-white/[0.06]">
            <summary className="cursor-pointer px-3 py-2 text-xs text-white/60 font-mono hover:text-white/85 transition">
              Raw Apify data ({Object.keys(lead.raw).length} fields)
            </summary>
            <pre className="px-3 pb-3 text-[10px] text-white/70 overflow-x-auto max-h-80 font-mono">
              {JSON.stringify(lead.raw, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </Modal>
  );
}

// Read-only preview of what is appended automatically at send time.
function FooterPreview({ email }: { email: EmailRow }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    call<{ footer_text: string }>("outreach.footer.preview", { campaign_id: email.campaign_id, email_id: email.id })
      .then((r) => !cancelled && setText(r.footer_text))
      .catch(() => !cancelled && setText(null));
    return () => {
      cancelled = true;
    };
  }, [email.campaign_id, email.id, email.body_text]);
  if (!text) return null;
  return (
    <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-3">
      <div className="text-[10px] font-bold tracking-widest uppercase text-white/40 mb-1.5">Added automatically when sent</div>
      <pre className="whitespace-pre-wrap font-sans text-sm text-white/55 leading-relaxed">{text}</pre>
    </div>
  );
}

function EditDraftModal({ email, onClose, onSaved }: { email: EmailRow; onClose: () => void; onSaved: () => void }) {
  const [toEmail, setToEmail] = useState(email.to_email);
  const [subject, setSubject] = useState(email.subject);
  const [body, setBody] = useState(email.body_text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!subject.trim() || !body.trim()) {
      setErr("Subject and body can't be empty.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim())) {
      setErr("Enter a valid To address.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await call("outreach.emails.update", {
        campaign_id: email.campaign_id,
        email_id: email.id,
        subject: subject.trim(),
        body_text: body,
        ...(toEmail.trim().toLowerCase() !== email.to_email.toLowerCase() ? { to_email: toEmail.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={true} onClose={onClose} title="Edit draft" description="Change the address, subject or body of this draft" maxWidth="max-w-2xl">
      <form onSubmit={save} className="space-y-4">
        <FormField label="To">
          <TextInput type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} />
        </FormField>
        <FormField label="Subject">
          <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Body">
          <TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={12} />
        </FormField>
        <FooterPreview email={email} />
        <p className="text-[11px] text-white/45">Don't type the sign-off or opt-out line above — they are added automatically.</p>
        {err && <p className="text-xs text-red-300">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 text-sm font-semibold transition">
            Cancel
          </button>
          <PrimaryButton type="submit" loading={busy} disabled={busy}>
            Save changes
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
}

function EmailDetailModal({ email, onClose }: { email: EmailRow; onClose: () => void }) {
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={email.subject || "(no subject)"}
      description={`to ${email.to_email}`}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill status={email.status} />
          {(email.click_count ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/15 border border-accent/30 text-accent text-xs font-bold">
              <MousePointerClick size={11} /> {email.click_count} click{email.click_count === 1 ? "" : "s"}
            </span>
          )}
          <span className="text-[11px] text-white/40 font-mono ml-auto">
            Created {new Date(email.created_at).toLocaleString()}
          </span>
        </div>

        <div className="rounded-lg bg-black/30 border border-white/[0.06] p-4 max-h-[60vh] overflow-y-auto">
          {email.body_html ? (
            <div
              className="prose prose-invert prose-sm max-w-none text-white/85 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: email.body_html }}
            />
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm text-white/85 leading-relaxed">{email.body_text}</pre>
          )}
        </div>

        {email.status === "drafted" && <FooterPreview email={email} />}

        <details className="rounded-lg bg-black/20 border border-white/[0.04]">
          <summary className="cursor-pointer px-3 py-2 text-xs text-white/50 font-mono hover:text-white/80 transition">
            Plain text version
          </summary>
          <pre className="px-3 pb-3 text-[11px] text-white/60 whitespace-pre-wrap font-mono">{email.body_text}</pre>
        </details>
      </div>
    </Modal>
  );
}

function DetailRow({
  label,
  value,
  mono,
  href,
  external,
  full,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  href?: string | null;
  external?: boolean;
  full?: boolean;
}) {
  if (!value) return null;
  const content = href ? (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="text-primary hover:text-white transition inline-flex items-center gap-1"
    >
      <span className="truncate">{value}</span>
      {external && <ExternalLink size={11} className="shrink-0" />}
    </a>
  ) : (
    <span className="text-white/85 truncate">{value}</span>
  );
  return (
    <div className={`${full ? "col-span-full" : ""} rounded-lg bg-white/[0.02] border border-white/[0.06] px-3 py-2`}>
      <div className="text-[10px] uppercase tracking-widest text-white/45 font-bold mb-0.5">{label}</div>
      <div className={`text-sm ${mono ? "font-mono" : ""} truncate`}>{content}</div>
    </div>
  );
}

function SenderNameEditor({ campaign, onUpdate }: { campaign: Campaign; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(campaign.default_sender_name ?? "");
  const [busy, setBusy] = useState(false);

  // Keep local state in sync when campaign refreshes from the server.
  useEffect(() => {
    if (!editing) setValue(campaign.default_sender_name ?? "");
  }, [campaign.default_sender_name, editing]);

  async function save() {
    setBusy(true);
    try {
      await call("outreach.campaign.update", {
        id: campaign.id,
        default_sender_name: value.trim() || null,
      });
      setEditing(false);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-white/55">From:</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setEditing(false);
              setValue(campaign.default_sender_name ?? "");
            }
          }}
          placeholder="Your display name"
          autoFocus
          className="px-2 py-1 rounded-md bg-black/40 border border-primary/50 text-xs text-white font-medium placeholder:text-white/30 focus:outline-none focus:border-primary w-48"
        />
        <button
          onClick={save}
          disabled={busy}
          className="px-2 py-1 rounded-md bg-primary/20 hover:bg-primary/30 border border-primary/50 text-primary text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-50"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : "Save"}
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setValue(campaign.default_sender_name ?? "");
          }}
          className="px-2 py-1 rounded-md text-white/50 hover:text-white text-[10px] uppercase tracking-wider transition"
        >
          Cancel
        </button>
      </div>
    );
  }

  const current = campaign.default_sender_name;
  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1.5 text-xs transition"
      title="Edit the From display name recipients see"
    >
      <span className="text-white/55">From:</span>
      <span
        className={`font-semibold transition ${
          current ? "text-white/85 group-hover:text-white" : "text-amber-300 group-hover:text-amber-200"
        }`}
      >
        {current ?? "+ set your name"}
      </span>
      <span className="text-white/30 group-hover:text-white/60 transition">✏</span>
    </button>
  );
}

// Unused import guards
void Check;
void X;
