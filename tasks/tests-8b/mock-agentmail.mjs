// Local test double for AgentMail (never used in production): serves read-only fixtures and RECORDS every request in a log file,
// so a test can prove that nothing but GETs arrived. Usage: node tasks/tests-8b/mock-agentmail.mjs 8898
import http from "node:http";
import fs from "node:fs";
const port = Number(process.argv[2] || 8898);
const log = (process.env.TMPDIR || "/tmp") + "/mock-agentmail-requests.log";
fs.writeFileSync(log, "");
const now = Date.now();
const ago = (d) => new Date(now - d * 86_400_000).toISOString();
const msgs = [
  { message_id: "mock-santhana-1", thread_id: "mock-thread-santhana", inbox_id: "lakshmi@team.shiftforge.ai", labels: ["received", "unread", "unauthenticated"], from: "Santhana Test <tester.santhana@example.net>", to: ["lakshmi@team.shiftforge.ai"], subject: "Re: hello", preview: "Got it, thanks.", timestamp: ago(1) },
  { message_id: "mock-sent-1", thread_id: "mock-thread-santhana", inbox_id: "lakshmi@team.shiftforge.ai", labels: ["sent"], from: "lakshmi@team.shiftforge.ai", to: ["tester.santhana@example.net"], subject: "hello", preview: "hi", timestamp: ago(2) },
  { message_id: "mock-health-1", inbox_id: "lakshmi@team.shiftforge.ai", labels: ["received"], from: "lakshmi@team.shiftforge.ai", to: ["lakshmi@team.shiftforge.ai"], subject: "ShiftForge HQ webhook health check", preview: "ok", timestamp: ago(1) },
  { message_id: "mock-old-1", inbox_id: "lakshmi@team.shiftforge.ai", labels: ["received"], from: "old@example.net", to: ["lakshmi@team.shiftforge.ai"], subject: "Re: old", preview: "old", timestamp: ago(40) },
];
http.createServer((req, res) => {
  fs.appendFileSync(log, `${req.method} ${req.url}\n`);
  res.setHeader("Content-Type", "application/json");
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/inboxes") return res.end(JSON.stringify({ inboxes: [{ inbox_id: "lakshmi@team.shiftforge.ai", email: "lakshmi@team.shiftforge.ai" }, { inbox_id: "saleslak@agentmail.to", email: "saleslak@agentmail.to" }] }));
  const m = /^\/inboxes\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(u.pathname);
  if (req.method === "GET" && m) {
    const inbox = decodeURIComponent(m[1]);
    const list = msgs.filter((x) => x.inbox_id === inbox);
    if (m[2]) { const one = list.find((x) => x.message_id === decodeURIComponent(m[2])); return one ? res.end(JSON.stringify({ ...one, text: one.preview, authentication_results: one.labels.includes("unauthenticated") ? { dkim: "none", dmarc: "none", spf: "none" } : null })) : ((res.statusCode = 404), res.end("{}")); }
    return res.end(JSON.stringify({ messages: list }));
  }
  if (req.method === "GET" && u.pathname === "/webhooks") return res.end(JSON.stringify({ webhooks: [{ webhook_id: "wh_mock_1", url: "https://shiftforge-hq.netlify.app/api/webhook/xyz", enabled: true, event_types: ["message.received", "message.sent", "message.delivered", "message.bounced", "message.complained", "message.rejected", "domain.verified"] }] }));
  res.statusCode = 404; res.end("{}");
}).listen(port, () => console.log(`mock agentmail on ${port}`));
