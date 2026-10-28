// Runs the S2 in-page benchmark in Chrome over CDP for several viewports.
// Usage: node bench/run.mjs [--headful] [--chrome <path>]
// Requires a prior `vite build`; serves dist/ with `vite preview`.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const headful = args.includes("--headful");
const chrome = args.includes("--chrome") ? args[args.indexOf("--chrome") + 1] : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const latency = args.includes("--latency") ? Number(args[args.indexOf("--latency") + 1]) : 30;
const CDP_PORT = 9333;
const APP = "http://localhost:4317/";

const VIEWPORTS = [
  { name: "720p@1x", width: 1280, height: 720, dpr: 1 },
  { name: "720p@2x", width: 1280, height: 720, dpr: 2 },
  { name: "1440p@1x", width: 2560, height: 1440, dpr: 1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    ready.then(() => new Promise((resolve, reject) => {
      const msgId = ++id;
      waiting.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    }));
  return { send, close: () => ws.close() };
}

async function evaluate(page, expression) {
  const res = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  return res.result.value;
}

const preview = spawn("pnpm", ["exec", "vite", "preview", "--port", "4317", "--strictPort"], { cwd: here, shell: true, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "s2-chrome-"));
const browser = spawn(chrome, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  ...(headful ? [] : ["--headless=new"]), "--window-size=2600,1500", "about:blank",
], { stdio: "ignore" });

const results = { chrome: null, mode: headful ? "headful" : "headless", runs: [] };
try {
  await waitFor(() => fetch(APP).then((r) => r.ok), "vite preview");
  const version = await waitFor(() => fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()), "chrome");
  results.chrome = version.Browser;
  const target = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())).find((t) => t.type === "page");
  const page = cdp(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");

  for (const vp of VIEWPORTS) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false });
    await page.send("Page.navigate", { url: `${APP}?rows=1000000&cols=50&latency=${latency}&jitter=${latency > 0 ? 10 : 0}` });
    await waitFor(() => evaluate(page, "window.__s2?.ready === true"), "app ready");
    process.stdout.write(`running ${vp.name}… `);
    const run = await evaluate(page, "window.__s2.runAll()");
    console.log("done");
    results.runs.push({ name: vp.name, latencyMs: latency, ...run });
  }
  page.close();
} finally {
  browser.kill();
  spawn("taskkill", ["/pid", String(preview.pid), "/T", "/F"], { stdio: "ignore", shell: true });
}

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `s2_${results.mode}_lat${latency}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));

for (const r of results.runs) {
  console.log(`\n== ${r.name}, latency ${r.latencyMs} ms (cold fill ${r.coldFillMs} ms)`);
  for (const s of r.scroll) {
    console.log(`   scroll ${s.axis} ${s.pxPerSecond}px/s: ${s.fps} fps, interval p95 ${s.intervalMs.p95} ms, draw p50/p95/max ${s.drawMs.p50}/${s.drawMs.p95}/${s.drawMs.max} ms, long frames ${s.longFramePct}%, blank frames ${s.blankFrames}, max blank ${s.maxBlankEpisodeMs} ms`);
  }
  console.log(`   jumps: fill p50/p95/max ${r.jumps.fillMs.p50}/${r.jumps.fillMs.p95}/${r.jumps.fillMs.max} ms, over 100 ms: ${r.jumps.over100ms}/${r.jumps.count}; per response server ${r.jumps.perResponse.serverMs} ms, client decode ${r.jumps.perResponse.decodeMs} ms`);
  console.log(`   hit-test: ${r.hittest.mismatches} mismatches / ${r.hittest.checked} points`);
}
console.log(`\nwrote ${out}`);
