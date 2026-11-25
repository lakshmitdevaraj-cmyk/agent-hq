// Tests B and D. B sends the 10 real test emails (the Worker allows one real run only).
import { writeFileSync } from "node:fs";
import { call, startTail, sleep } from "./remote.mjs";

const J = (r) => { try { return JSON.parse(r.text); } catch { return { raw: r.text.slice(0, 200) }; } };
const which = process.argv[2];
const tail = await startTail(which);
const cpuOf = (pred) => tail.events().filter(pred).map((e) => ({ cpu: e.cpuTime, wall: e.wallTime, outcome: e.outcome }));

if (which === "b") {
  const t0 = Date.now();
  const start = await call("/queue/start", "b1", { method: "POST" });
  console.log("start", start.status, JSON.stringify(J(start)));
  let rows = [];
  while (Date.now() - t0 < 180_000) {
    await sleep(3000);
    rows = J(await call("/queue/status?run=real")).rows ?? [];
    if (rows.length === 10 && rows.every((r) => r.status === "sent" || r.status === "failed")) break;
  }
  const done = rows.map((r) => Date.parse(r.done_at)).filter(Boolean);
  const queued = rows.map((r) => Date.parse(r.queued_at));
  const limit = J(await call("/limit", "b2"));
  const again = await call("/queue/start", "b3", { method: "POST" });
  await sleep(5000);
  await tail.stop();
  const out = {
    at: new Date().toISOString(), rows: rows.map(({ n, status, http_status, detail }) => ({ n, status, http_status, detail })),
    sent: rows.filter((r) => r.status === "sent").length, seconds_queue_to_last_send: done.length ? (Math.max(...done) - Math.min(...queued)) / 1000 : null,
    second_start_status: again.status, consumer_invocations: cpuOf((e) => e.event?.queue), producer: cpuOf((e) => e.event?.request?.url?.includes("rid=b1")),
    sixty_fetches: limit,
  };
  writeFileSync("results/b-queue.json", JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, rows: out.rows.map((r) => `${r.n}:${r.status}:${r.http_status}`).join(" "), detail: [...new Set(out.rows.map((r) => r.detail))] }));
}

if (which === "d") {
  const t0 = Date.now();
  const start = J(await call("/workflow/start", "d1", { method: "POST" }));
  console.log("started", JSON.stringify(start));
  let s = {};
  while (Date.now() - t0 < 560_000) {
    await sleep(20_000);
    s = J(await call(`/workflow/status?id=${start.id}`));
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s steps=${s.steps?.length} ${s.instance?.status}`);
    if (["complete", "errored", "terminated"].includes(s.instance?.status)) break;
  }
  await tail.stop();
  const first = s.steps?.[0]?.started_at, last = s.steps?.at(-1)?.finished_at;
  const out = {
    at: new Date().toISOString(), instance: s.instance, steps_done: s.steps?.length, wall_seconds_first_to_last_step: first && last ? (Date.parse(last) - Date.parse(first)) / 1000 : null,
    steps: s.steps?.map((x) => ({ step: x.step, source: x.source, seconds: (Date.parse(x.finished_at) - Date.parse(x.started_at)) / 1000 })),
    workflow_invocations: cpuOf((e) => !e.event?.request && !e.event?.queue),
  };
  writeFileSync("results/d-workflow.json", JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
}
