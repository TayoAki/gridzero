// Load test: N active workbooks, each with a socket editing at a steady rate.
// Reports UpdateCell latency against the §8 budget (≤ 120 ms p95) and host memory.
//
//   DATABASE_URL=... node tests/load/many-workbooks.mjs [workbooks=200] [seconds=30] [edits/s per workbook=1]
//
// Needs a built wbhost (target/debug, or release with E2E_RELEASE=1). A debug build
// says nothing about budgets; it only shows the test runs.

import { execSync } from "node:child_process";

import { Stack, pct } from "../e2e/harness.mjs";

const [workbooks = 200, seconds = 30, rate = 1] = process.argv.slice(2).map(Number);
const stack = new Stack({ controlPort: 19287, wbhostPort: 19290, wbhostEnv: { IDLE_EVICT_SECS: "900" } });
await stack.start();

function hostMegabytes() {
  const pid = stack.wbhost.pid;
  try {
    if (process.platform === "win32") return Number(execSync(`powershell -NoProfile -c "[int]((Get-Process -Id ${pid}).WorkingSet64/1MB)"`).toString().trim());
    return Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024);
  } catch {
    return NaN;
  }
}

const t0 = Date.now();
const sessions = [];
for (let i = 0; i < workbooks; i++) sessions.push(await stack.open(await stack.newWorkbook()));
console.log(`opened ${workbooks} workbooks in ${((Date.now() - t0) / 1000).toFixed(1)} s, host ${hostMegabytes()} MB`);

const latencies = [];
let failures = 0;
const until = Date.now() + seconds * 1000;
await Promise.all(
  sessions.map(async (s, i) => {
    // Spread the workbooks across the interval.
    await new Promise((r) => setTimeout(r, (i / workbooks) * (1000 / rate)));
    let n = 0;
    while (Date.now() < until) {
      const started = performance.now();
      await s.send({ type: "UpdateCell", sheet: 0, row: n % 100, col: 0, raw: String(n) }).then(
        () => latencies.push(performance.now() - started),
        () => failures++,
      );
      n++;
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 / rate - (performance.now() - started))));
    }
  }),
);

const p95 = pct(latencies, 95);
console.log(`${latencies.length} edits, ${failures} failed`);
console.log(`UpdateCell p50 ${pct(latencies, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...latencies).toFixed(1)} ms (budget p95 ≤ 120 ms)`);
console.log(`host ${hostMegabytes()} MB`);
await Promise.all(sessions.map((s) => s.close()));
stack.stop();
process.exit(failures === 0 ? 0 : 1);
