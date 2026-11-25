// Test I: a Workflow step that waits on a real network request for 30, 45 and 60 seconds.
import { call, startTail, sleep, save } from "./lib.mjs";

const tail = await startTail();
const J = (r) => { try { return JSON.parse(r.text); } catch { return { error: r.text.slice(0, 200) }; } };
const runs = [];
for (const s of [30, 45, 60]) {
  const start = await call({ path: `/wf/start?s=${s}`, method: "GET" });
  const { id } = J(start);
  let st = {};
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    st = J(await call({ path: `/wf/status?id=${id}`, method: "GET" }));
    if (["complete", "errored", "terminated"].includes(st.status)) break;
  }
  runs.push({ asked_s: s, start_status: start.status, status: st.status, step: st.output ? { http_status: st.output.status, wall_ms: st.output.wall_ms, answer: st.output.body } : null, error: st.error ? String(st.error.message ?? st.error).slice(0, 200) : null });
  console.log(JSON.stringify(runs.at(-1)));
}
// CPU: every Workflow and /slow record Cloudflare reported while the tail was open.
await sleep(20_000);
const events = tail.others();
tail.stop();
save("i-waits.json", { at: new Date().toISOString(), runs, tail_records: events });
console.log(events);
process.exit(0);
