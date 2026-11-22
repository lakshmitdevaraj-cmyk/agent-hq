// Local test double for Gemini (never used in production). Writes a canned social message and says "ready" to every review.
// Usage: node tasks/tests-8b/mock-gemini.mjs 8899   then start netlify dev with GEMINI_TEST_BASE_URL=http://localhost:8899
import http from "node:http";
import fs from "node:fs";
// Create the file $TMPDIR/mock-gemini-quota to make the mock answer "daily limit used up" (429), remove it to recover.
const quotaFile = (process.env.TMPDIR || "/tmp") + "/mock-gemini-quota";
const port = Number(process.argv[2] || 8899);
let calls = 0;
const variants = [
  "I help local trade businesses stay on top of the phone. When your crew is out on a job, an assistant can pick up calls, take the customer's details and pass them straight to you, so nothing slips away.",
  "Most owners I talk to in your line of work lose their best evenings returning missed messages. A simple assistant can take the call, note what the customer needs and send it to your phone before the caller moves on.",
  "Running a crew means the phone rings at the worst possible moments. An assistant that answers for you, writes down the address and the problem, and texts you the summary keeps good jobs from going to the next company on the list.",
  "Busy weeks are good news until the voicemail fills up. Picture every caller getting a friendly answer, a few questions about the job and a promise that you will call back, while you stay under the sink.",
];
const msg = (greeting, type, ch) => {
  const call = "Would you be open to a 30-minute free call this week to see whether it fits how you work?";
  if (type === "follow_up_email") return `${greeting}, I sent a short email to your office earlier this week and wanted to say hello here as well. I set up a simple assistant for local trade businesses that picks up calls and website messages while your crew is on a job, takes the details and passes them straight to you. ${call}`;
  if (type === "follow_up_channel") return `${greeting}, one more thought from me. Many owners tell me the hardest calls to catch are the ones that come in during a long job. An assistant can answer those, take the customer's details and hand them to you so the work is not lost. ${call}`;
  return `${greeting}, I run ShiftForge AI in the Houston area. I set up a simple assistant for local trade businesses that answers calls and website messages when your crew is out on a job, takes the customer's details and sends them straight to you, so a missed call does not turn into a lost job. ${call}`;
};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    if (fs.existsSync(quotaFile)) { res.statusCode = 429; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: { code: 429, message: "Quota exceeded: GenerateRequestsPerDay" } })); return; }
    let text = "{}";
    try {
      const j = JSON.parse(body);
      const user = j.contents?.[0]?.parts?.[0]?.text ?? "";
      const sys = j.systemInstruction?.parts?.[0]?.text ?? "";
      if (/^CHANNEL:/m.test(user) && !/"DRAFTS"/.test(user)) fs.appendFileSync((process.env.TMPDIR || "/tmp") + "/mock-gemini-social-prompts.log", "=== SOCIAL WRITER PROMPT ===\n" + user + "\n\n");
      if (/"DRAFTS"/.test(user)) {
        const d = JSON.parse(user).DRAFTS ?? [];
        text = JSON.stringify({ results: d.map((x) => ({ id: x.ID, verdict: "ready", problem: "none", reasons: [], rewrite: null })) });
      } else if (/^OPENING STYLE:/m.test(user)) {
        const biz = /^BUSINESS: (.+)$/m.exec(user)?.[1] ?? "the business";
        const g = /^GREETING: (.+)$/m.exec(user)?.[1] ?? "Hi there";
        const w = biz.split(/\s+/).slice(0, 2).join(" ");
        text = JSON.stringify({ subject: `Calls at ${w}`, body: `${g},\n\n${variants[[...biz].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % variants.length]} Would you be open to a 30-minute free call this week to see whether it fits how you work?`, fact_used: null });
      } else if (/^CHANNEL:/m.test(user)) {
        const ch = /^CHANNEL: (\w+)/m.exec(user)?.[1] ?? "facebook";
        const g = /^GREETING: (.+)$/m.exec(user)?.[1] ?? "Hi there";
        const type = /^MESSAGE_TYPE: (\w+)/m.exec(user)?.[1] ?? "first";
        const m = msg(g, type, ch);
        text = JSON.stringify(ch === "linkedin" ? { note: `${g}, I work with local trade owners nearby and would like to connect.`, dm: m, fact_used: null } : { message: ch === "instagram" ? m.split(". ").slice(0, 2).join(". ") + ". Open to a 30-minute free call?" : m, fact_used: null });
      }
    } catch { /* fall through with {} */ }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }, _mock_calls: calls }));
  });
}).listen(port, () => console.log(`mock gemini on ${port}`));
