// M1 acceptance suite (BUILD-SPEC §11 M1). Starts its own control plane and
// workbook host on spare ports, then drives them over HTTP and the sheet socket.
//
// Needs: a built wbhost (cargo build -p wbhost), DATABASE_URL pointing at Postgres,
// and optionally E2E_RELEASE=1 to use target/release/wbhost.
// Run: pnpm --filter @gridzero/e2e test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { unpack } from "msgpackr";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CONTROL_PORT = 18787;
const WBHOST_PORT = 18790;
const BASE = `http://localhost:${CONTROL_PORT}`;
const ORIGIN = BASE;
const WB_SECRET = "e2e-wb-token-secret-0123456789abcdef";
const dataDir = mkdtempSync(join(tmpdir(), "gz-e2e-"));
const wbhostBin = join(root, "target", process.env.E2E_RELEASE ? "release" : "debug", process.platform === "win32" ? "wbhost.exe" : "wbhost");

const budgets = [];

// ------------------------------------------------------------- processes

let control;
let wbhost;

function startWbhost() {
  wbhost = spawn(wbhostBin, [], {
    env: { ...process.env, PORT: String(WBHOST_PORT), DATA_DIR: dataDir, WB_TOKEN_SECRET: WB_SECRET, IDLE_EVICT_SECS: "2", RUST_LOG: "warn" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return waitFor(() => fetch(`http://localhost:${WBHOST_PORT}/health`).then((r) => r.ok), "wbhost");
}

async function waitFor(fn, label, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  control = spawn(process.execPath, ["src/server.ts"], {
    cwd: join(root, "services", "control"),
    env: {
      ...process.env,
      PORT: String(CONTROL_PORT),
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-auth-secret-0123456789abcdef0123",
      BETTER_AUTH_URL: BASE,
      WB_TOKEN_SECRET: WB_SECRET,
      WBHOST_PUBLIC_URL: `ws://localhost:${WBHOST_PORT}`,
      WEB_DIST: "",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(() => fetch(`${BASE}/api/v1/health`).then((r) => r.ok), "control plane");
  await startWbhost();
});

after(() => {
  control?.kill();
  wbhost?.kill();
  rmSync(dataDir, { recursive: true, force: true });
  if (budgets.length) {
    console.log("\nM1 budgets (BUILD-SPEC §8):");
    for (const b of budgets) console.log(`  ${b.ok ? "PASS" : "FAIL"} ${b.label}: ${b.value} (budget ${b.budget})`);
  }
});

// ------------------------------------------------------------- client helpers

let cookie = "";
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.match(/better-auth\.session_token=[^;]+/)?.[0] ?? cookie;
  return res;
}

async function newWorkbook() {
  const { id } = await (await api("POST", "/api/v1/workbooks")).json();
  return id;
}

/** Open a workbook socket; resolves after Welcome. */
async function open(id) {
  const grant = await (await api("POST", `/api/v1/workbooks/${id}/open`)).json();
  const ws = new WebSocket(`${grant.endpoint}?token=${grant.token}`);
  ws.binaryType = "arraybuffer";
  const replies = new Map();
  const listeners = new Set();
  let welcome;
  const welcomed = new Promise((r) => (welcome = r));
  ws.onmessage = (ev) => {
    const m = unpack(new Uint8Array(ev.data));
    if (m.t === "Welcome") return welcome(m);
    if (m.t === "Changed") return listeners.forEach((f) => f(m));
    const pending = replies.get(m.req_id);
    replies.delete(m.req_id);
    if (m.t === "Error") pending?.reject(new Error(`${m.code}: ${m.message}`));
    else pending?.resolve(m.body);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("socket error"));
  });
  let reqId = 0;
  ws.send(JSON.stringify({ reqId: ++reqId, action: { type: "Hello" } }));
  const state = await welcomed;
  const send = (action) =>
    new Promise((resolve, reject) => {
      const id = ++reqId;
      replies.set(id, { resolve, reject });
      ws.send(JSON.stringify({ reqId: id, action }));
    });
  const close = () => new Promise((r) => { ws.onclose = r; ws.close(); });
  return { ws, send, state, close, onChanged: (f) => listeners.add(f) };
}

const cell = (s, row, col, raw) => s.send({ type: "UpdateCell", sheet: 0, row, col, raw });
const raw = async (s, row, col, sheet = 0) => (await s.send({ type: "GetCell", sheet, row, col })).raw;
const R = (r0, c0, r1, c1, sheet = 0) => ({ sheet, r0, c0, r1, c1 });

async function tileCells(s, sheet = 0) {
  const t = await s.send({ type: "GetTiles", sheet, tiles: [[0, 0]] });
  const tile = t.tiles[0];
  return Object.fromEntries(tile.cells.map(([i, display, kind, style]) => [i, { display, kind, style: tile.styles[style] }]));
}

function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function budget(label, value, limit, unit = "ms") {
  budgets.push({ label, value: `${Math.round(value)} ${unit}`, budget: `≤ ${limit} ${unit}`, ok: value <= limit });
}

// ------------------------------------------------------------- tests

test("sign up", async () => {
  const res = await api("POST", "/api/auth/sign-up/email", { name: "E2E", email: `e2e-${Date.now()}@example.com`, password: "correct-horse-9" });
  assert.equal(res.status, 200);
});

test("values and formulas persist across reconnect and host restart", async () => {
  const id = await newWorkbook();
  let s = await open(id);
  await cell(s, 0, 0, "2");
  await cell(s, 1, 0, "=A1*21");
  await s.close();

  s = await open(id);
  assert.equal(await raw(s, 1, 0), "=A1*21");
  assert.equal((await tileCells(s))[16].display, "42");
  await s.close();

  // Clean restart: wbhost exits, comes back, rehydrates from disk.
  wbhost.kill();
  await new Promise((r) => wbhost.once("exit", r));
  await startWbhost();
  s = await open(id);
  assert.equal((await tileCells(s))[16].display, "42");
  await s.close();
});

test("killing the host loses no acknowledged edit", async () => {
  const id = await newWorkbook();
  const s = await open(id);
  for (let i = 0; i < 25; i++) await cell(s, i, 0, String(i + 1));
  await cell(s, 25, 0, "=SUM(A1:A25)");
  // No clean shutdown, no final snapshot: only the fsynced op-log survives.
  wbhost.kill("SIGKILL");
  await new Promise((r) => wbhost.once("exit", r));
  await startWbhost();
  const t0 = performance.now();
  const s2 = await open(id);
  const cells = await tileCells(s2);
  budget("rehydrate after crash -> first tile", performance.now() - t0, 6000);
  assert.equal(cells[25 * 16].display, "325");
  await s2.close();
});

test("50-step undo and redo", async () => {
  const id = await newWorkbook();
  const s = await open(id);
  for (let i = 0; i < 50; i++) await cell(s, i, 0, String(i + 1));
  for (let i = 0; i < 50; i++) await s.send({ type: "Undo" });
  assert.equal(await raw(s, 0, 0), "");
  for (let i = 0; i < 50; i++) await s.send({ type: "Redo" });
  assert.equal(await raw(s, 49, 0), "50");
  await s.close();
});

test("paste a 10k-cell range from Excel (TSV)", async () => {
  const id = await newWorkbook();
  const s = await open(id);
  let tsv = "";
  for (let r = 0; r < 1000; r++) tsv += Array.from({ length: 10 }, (_, c) => (c === 9 ? `item ${r}` : String(r * 10 + c))).join("\t") + "\r\n";
  const t0 = performance.now();
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: tsv });
  budget("paste 10k cells", performance.now() - t0, 2000);
  const stats = await s.send({ type: "SelectionStats", range: R(0, 0, 999, 9) });
  assert.deepEqual([stats.count, stats.numbers], [10_000, 9_000]);
  assert.equal(await raw(s, 999, 9), "item 999");
  assert.equal(await raw(s, 1000, 0), "", "trailing newline adds no row");
  await s.close();
});

test("Ctrl+arrow, freeze, merge, number formats and borders", async () => {
  const id = await newWorkbook();
  const s = await open(id);
  for (let r = 0; r < 5; r++) await cell(s, r, 0, String(r));
  await cell(s, 9, 0, "end");
  assert.equal((await s.send({ type: "CtrlJump", sheet: 0, row: 0, col: 0, dir: "Down" })).row, 4);
  assert.equal((await s.send({ type: "CtrlJump", sheet: 0, row: 4, col: 0, dir: "Down" })).row, 9);

  await s.send({ type: "Freeze", sheet: 0, rows: 1, cols: 2 });
  await s.send({ type: "Merge", range: R(0, 2, 0, 4) });
  await cell(s, 1, 1, "1234.5");
  await s.send({ type: "SetStyle", range: R(1, 1, 1, 1), path: "num_fmt", value: "#,##0.00" });
  await s.send({ type: "SetBorder", range: R(3, 3, 4, 4), kind: "Outer", style: "medium", color: "#1A73E8" });
  const meta = (await s.send({ type: "GetSheetMeta", sheet: 0 })).meta;
  assert.deepEqual([meta.frozen_rows, meta.frozen_cols], [1, 2]);
  assert.deepEqual(meta.merges, [R(0, 2, 0, 4)]);
  const cells = await tileCells(s);
  assert.equal(cells[16 + 1].display, "1,234.50");
  assert.deepEqual(cells[3 * 16 + 3].style.top, ["medium", "#1A73E8"]);
  assert.deepEqual(cells[3 * 16 + 3].style.left, ["medium", "#1A73E8"]);
  assert.equal(cells[4 * 16 + 4].style.top, null, "outer border leaves the inside open");
  await s.close();
});

test("sheets and named ranges", async () => {
  const id = await newWorkbook();
  const s = await open(id);
  await s.send({ type: "AddSheet" });
  await s.send({ type: "RenameSheet", sheet: 1, name: "Inputs" });
  await s.send({ type: "UpdateCell", sheet: 1, row: 0, col: 0, raw: "0.2" });
  await s.send({ type: "CreateName", name: "TaxRate", scope: null, formula: "Inputs!$A$1" });
  await cell(s, 0, 0, "=100*(1+TaxRate)");
  assert.equal((await tileCells(s))[0].display, "120");
  const names = await s.send({ type: "ListNames" });
  assert.equal(names.names[0].name, "TaxRate");
  await s.close();
});

test("collaborators see each other's edits", async () => {
  const id = await newWorkbook();
  const a = await open(id);
  const b = await open(id);
  const seen = new Promise((r) => b.onChanged(r));
  await cell(a, 0, 0, "hello");
  await seen;
  assert.equal(await raw(b, 0, 0), "hello");
  await a.close();
  await b.close();
});

test("budgets: open and edit latency", async () => {
  const id = await newWorkbook();
  let s = await open(id);
  // A sheet with real recalculation work: 2,000 inputs and 2,000 dependent formulas.
  let tsv = "";
  for (let r = 0; r < 2000; r++) tsv += `${r}\r\n`;
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: tsv });
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 1, raw: "=A1*2" });
  await s.send({ type: "Fill", source: R(0, 1, 0, 1), to_row: 1999, to_col: null });
  await s.close();

  // Warm open: actor still loaded.
  const opens = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const o = await open(id);
    await tileCells(o);
    opens.push(performance.now() - t0);
    await o.close();
  }
  budget("open warm workbook -> first tile (p95)", pct(opens, 95), 800);

  s = await open(id);
  const latencies = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    const changed = new Promise((r) => s.onChanged(r));
    await cell(s, 0, 0, String(i));
    await changed;
    latencies.push(performance.now() - t0);
  }
  budget("UpdateCell -> Changed (p95, 4k cells)", pct(latencies, 95), 120);
  await s.close();

  // Cold rehydrate: wait for idle eviction, then reopen.
  await new Promise((r) => setTimeout(r, 3500));
  const t0 = performance.now();
  const cold = await open(id);
  await tileCells(cold);
  budget("cold rehydrate -> first tile", performance.now() - t0, 6000);
  await cold.close();

  for (const b of budgets) assert.ok(b.ok, `${b.label}: ${b.value} exceeds ${b.budget}`);
});

// Every edit triggers a full IronCalc recalculation (S1 finding / obligation A1), so
// edit latency grows with sheet size. Opt-in because it needs a release wbhost.
test("budgets: edit latency on a 100k-formula sheet", { skip: !process.env.E2E_HEAVY && "set E2E_HEAVY=1 (with E2E_RELEASE=1)" }, async () => {
  const id = await newWorkbook();
  const s = await open(id);
  let tsv = "";
  for (let r = 0; r < 100_000; r++) tsv += `${r}\r\n`;
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: tsv });
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 1, raw: "=A1*2" });
  await s.send({ type: "Fill", source: R(0, 1, 0, 1), to_row: 99_999, to_col: null });
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 2, raw: "=SUM(B1:B100000)" });
  const latencies = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const changed = new Promise((r) => s.onChanged(r));
    await cell(s, 0, 0, String(i));
    await changed;
    latencies.push(performance.now() - t0);
  }
  budget("UpdateCell -> Changed (p95, 100k formulas)", pct(latencies, 95), 120);
  assert.equal((await tileCells(s))[2].display, String(2 * (29 + (99_999 * 100_000) / 2 - 0)));
  await s.close();
});
