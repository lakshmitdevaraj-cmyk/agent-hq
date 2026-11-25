// Fake Gemini / DeepSeek / Apify / AgentMail / Geoapify / lead websites. Fixed answers, every call counted.
// Any other host throws, so nothing can leave the Worker.
import { als } from "./context";

const J = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

const BODY = "Hi there,\n\nI noticed your website has no online booking, so callers after hours have to ring back.\n\nWould a short note on how other HVAC teams handle that be useful?\n\nLakshmi";
const AI_ANSWER = {
  subject: "after hours calls", body: BODY,
  email_1: BODY, email_2: BODY, email_3: BODY, email_4: BODY,
  connection_note: "Hi, I help local HVAC teams. Glad to connect.", first: BODY, follow_up: BODY, last: BODY,
  steps: [1, 2, 3, 4].map((step) => ({ step, verdict: "ready", reasons: [] })),
  verdict: "ready", reasons: [], fact_used: null,
  answer: "Yes, happy to explain how it works.", why_call: "On a call you can hear the assistant answer a call for your business.",
  location: "Faketown, TX", searchTerms: ["hvac"], owner_name: null,
};

/** A synthetic business website page of about `kb` kilobytes. */
export function synthPage(kb: number, n = 0): string {
  const block = '<div class="svc"><a href="/contact">Request service</a><p>Family owned heating and air since 1998. Call (555) 010-2000 or email office@fake.example.test. Open Mon - Fri 8am - 5pm.</p><script>var a={"k":"v"};</script></div>\n';
  return `<html><head><title>Fake Heating & Air ${n}</title></head><body><h1>Fake Heating & Air</h1>${block.repeat(Math.max(1, Math.ceil((kb * 1024) / block.length)))}</body></html>`;
}
const pageCache = new Map<number, string>();
const page = (kb: number) => pageCache.get(kb) ?? pageCache.set(kb, synthPage(kb)).get(kb)!;

let browserSites: Array<{ url: string; userData?: { lead_id?: string } }> = [];
const places = (n: number) => Array.from({ length: n }, (_, i) => ({
  title: `Imported Fake Air ${i}`, address: `${i} New St, Faketown, TX 75000`, phone: "(555) 010-3000", website: `https://imported${i}.example.test`,
  totalScore: 4.5, reviewsCount: 40, categoryName: "HVAC contractor", placeId: `fake-place-${i}`, url: `https://maps.example.test/${i}`,
}));

async function fake(url: URL, init: RequestInit | undefined): Promise<Response | null> {
  const h = url.hostname, p = url.pathname;
  const body = typeof init?.body === "string" ? init.body : "";
  if (h === "generativelanguage.googleapis.com") {
    if (p.endsWith("/models")) return J({ models: [{ name: "models/gemini-2.5-flash" }] });
    return J({ candidates: [{ content: { parts: [{ text: JSON.stringify(AI_ANSWER) }] }, finishReason: "STOP" }] });
  }
  if (h.endsWith("deepseek.com")) return J({ choices: [{ message: { content: JSON.stringify(AI_ANSWER) } }] });
  if (h === "api.geoapify.com") return J({ features: [] });
  if (h === "api.apify.com") {
    if (p.endsWith("/users/me")) return J({ data: { id: "fake" } });
    if (p.includes("/acts/") && p.endsWith("/runs")) {
      try { browserSites = (JSON.parse(body) as { startUrls?: typeof browserSites }).startUrls ?? []; } catch { browserSites = []; }
      return J({ data: { id: "fakerun", defaultDatasetId: "fakeset", status: "RUNNING" } }, 201);
    }
    if (p.endsWith("/log")) return new Response("fake log\n");
    if (p.includes("/actor-runs/")) return J({ data: { id: "fakerun", status: "SUCCEEDED", defaultDatasetId: "fakeset" } });
    if (p.includes("/datasets/")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset > 0) return J([]);
      return J(browserSites.length ? browserSites.map((s) => ({ lead_id: s.userData?.lead_id, url: s.url, html: page(100) })) : places(50));
    }
  }
  if (h === "api.agentmail.to") {
    if (/\/inboxes\/[^/]+$/.test(p)) return J({ inbox_id: "fake@agentmail.example.test", email: "fake@agentmail.example.test", display_name: "Fake" });
    if (p.endsWith("/inboxes")) return J(init?.method === "POST" ? { inbox_id: "fake@agentmail.example.test" } : { inboxes: [{ inbox_id: "fake@agentmail.example.test", email: "fake@agentmail.example.test", display_name: "Fake" }], count: 1 });
    if (p.endsWith("/send") || p.endsWith("/reply") || p.endsWith("/reply-all")) return J({ message_id: `fake-out-${crypto.randomUUID()}`, thread_id: `fake-thread-${crypto.randomUUID()}` });
    if (p.endsWith("/webhooks")) return J(init?.method === "POST" ? { webhook_id: "fake-hook" } : { webhooks: [{ webhook_id: "fake-hook", url: "https://fake.example.test/api/webhook/x", enabled: true, event_types: ["message.received"] }] });
    if (p.endsWith("/messages")) return J({ messages: Array.from({ length: 20 }, (_, i) => ({ message_id: `fake-in-${i}`, thread_id: `th-e${i}-1`, from: `Owner <someone${i}@fake.example.test>`, to: ["fake@agentmail.example.test"], subject: "Re: after hours calls", timestamp: new Date().toISOString(), labels: ["received"], preview: "sounds good" })), count: 20 });
    if (p.includes("/messages/")) return J({ message_id: "fake-in", thread_id: "th-e1-1", from: "Owner <someone@fake.example.test>", subject: "Re: after hours calls", text: "Sounds good, tell me more.", labels: ["received"] });
    return J({});
  }
  if (h.endsWith(".example.test")) {
    // Fake lead website. big300.example.test = 300 KB pages, big1000 = 1 MB, anything else 100 KB.
    const kb = h.startsWith("big1000") ? 1000 : h.startsWith("big300") ? 300 : 100;
    return new Response(page(kb), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return null;
}

const realFetch = globalThis.fetch.bind(globalThis);

export function installStubs() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = als.getStore();
    // Outside a request context (the wait-test Workflow) the real fetch is used; production handlers always run inside one.
    if (!c) return realFetch(input as RequestInfo, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const label = url.hostname.endsWith(".example.test") ? "lead-website" : url.hostname;
    c.outbound[label] = (c.outbound[label] ?? 0) + 1;
    const res = await fake(url, init);
    if (!res) throw new Error(`spike: blocked outbound call to ${url.hostname}`);
    Object.defineProperty(res, "url", { value: url.toString() });
    return res;
  }) as typeof fetch;
}
