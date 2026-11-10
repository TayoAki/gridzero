// Runs the benchmark tasks (bench/README.md) against a deployed GridZero and writes
// bench/results/gridzero-<host>-<date>.json.
//
//   node bench/gridzero.mjs https://<control-domain> [rows=100000,1000000]
//
// Signs up a throwaway @example.test account, uses the same API and socket as the
// browser, and deletes its workbooks at the end. Times are round trips from this
// machine, so they include the network, as a person's clicks would. Drawing in the
// browser is not measured.

import { createRequire } from "node:module";
import { mkdirSync, openAsBlob, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeDataset } from "./dataset.mjs";
import { DATA, FORMULAS, matches } from "./formulas.mjs";

/** The import dialog gzips files larger than this before uploading (apps/web ImportDialog). */
const COMPRESS_OVER = 4 << 20;

const here = dirname(fileURLToPath(import.meta.url));
const { unpack } = createRequire(join(here, "../tests/e2e/"))("msgpackr");
const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
const SIZES = (process.argv[3] ?? "100000,1000000").split(",").map(Number);
if (!BASE.startsWith("http")) {
  console.error("usage: node bench/gridzero.mjs https://<control-domain> [rows,rows]");
  process.exit(1);
}

// --- API ---------------------------------------------------------------------

let cookie = "";
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.match(/(__Secure-)?better-auth\.session_token=[^;]+/)?.[0] ?? cookie;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

async function open(id) {
  const grant = await (await api("POST", `/api/v1/workbooks/${id}/open`)).json();
  const ws = new WebSocket(`${grant.endpoint}?token=${grant.token}`);
  ws.binaryType = "arraybuffer";
  const replies = new Map();
  let welcome;
  const welcomed = new Promise((r) => (welcome = r));
  ws.onmessage = (ev) => {
    const m = unpack(new Uint8Array(ev.data));
    if (m.t === "Welcome") return welcome(m);
    const p = replies.get(m.req_id);
    if (!p) return;
    replies.delete(m.req_id);
    m.t === "Error" ? p.reject(new Error(m.message)) : p.resolve(m.body);
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("socket error"));
  });
  let n = 0;
  ws.send(JSON.stringify({ reqId: ++n, action: { type: "Hello" } }));
  const state = await welcomed;
  const send = (action) =>
    new Promise((resolve, reject) => {
      const reqId = ++n;
      replies.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ reqId, action }));
    });
  const http = grant.endpoint.replace(/^ws/, "http").replace(/\/ws$/, "");
  return { send, state, grant, http, close: () => ws.close() };
}

const OPTIONS = { header: true, separator: null, quote: null, skip_rows: 0 };

async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

// --- tasks -------------------------------------------------------------------

const results = [];
function record(id, label, size, value, unit, note = "") {
  results.push({ id, label, size, value: Math.round(value * 10) / 10, unit, note });
  console.log(`${id.padEnd(4)} ${label.padEnd(44)} ${String(size || "").padStart(9)}  ${(Math.round(value * 10) / 10).toLocaleString().padStart(10)} ${unit}`);
}

const workbooks = [];
async function newWorkbook() {
  const { id } = await (await api("POST", "/api/v1/workbooks")).json();
  workbooks.push(id);
  return id;
}

async function tableTasks(rows) {
  const file = join(tmpdir(), `gridzero-bench-${rows}.csv`);
  await writeDataset(rows, file);
  const mb = statSync(file).size / 1e6;
  try {
    const id = await newWorkbook();
    let s = await open(id);

    // T1: upload, preview and import as a Data Table.
    const [imported, importMs] = await timed(async () => {
      const importId = crypto.randomUUID();
      // Like the import dialog: files over 4 MB are gzipped before upload (the
      // compression time counts toward the import).
      const big = statSync(file).size > COMPRESS_OVER;
      const body = big ? gzipSync(readFileSync(file)) : await openAsBlob(file);
      const name = big ? "sales.csv.gz" : "sales.csv";
      const res = await fetch(`${s.http}/import?token=${s.grant.token}&import_id=${importId}&name=${name}`, { method: "POST", body, duplex: "half" });
      if (!res.ok) throw new Error(`upload ${res.status} ${await res.text()}`);
      await s.send({ type: "ImportPreview", import_id: importId, options: OPTIONS });
      return s.send({ type: "FinalizeImport", import_id: importId, options: OPTIONS, dest: { type: "NewSheet" }, mode: "Table", name: "sales" });
    });
    if (imported.rows !== rows + 1) throw new Error(`imported ${imported.rows} rows, expected ${rows + 1}`);
    record("T1", "Import CSV (upload, preview, import)", rows, importMs / 1000, "s", `${mb.toFixed(0)} MB file${mb > COMPRESS_OVER / 1e6 ? ", gzipped before upload as the app does" : ""}`);
    const { sheet, table } = imported;

    // T2: open the workbook again and show the first screen.
    s.close();
    const [reopened, openMs] = await timed(async () => {
      const again = await open(id);
      await again.send({ type: "GetTiles", sheet, tiles: [[0, 0], [0, 1]] });
      return again;
    });
    s = reopened;
    record("T2", "Reopen workbook to first screen", rows, openMs, "ms");

    // T3: jump to random places in the table (server and network; not browser drawing).
    const jumps = [];
    for (let i = 0; i < 30; i++) {
      const tr = Math.floor(Math.random() * (rows / 64));
      jumps.push((await timed(() => s.send({ type: "GetTiles", sheet, tiles: [[tr, 0]] })))[1]);
    }
    record("T3", "Jump to a random row (p95)", rows, pct(jumps, 95), "ms", "one screen of data, round trip");

    // T4â€“T7.
    record("T4", "Sort by revenue, descending", rows, (await timed(() => s.send({ type: "SortTable", table, keys: [{ col: 7, desc: true }] })))[1], "ms");
    record("T5", "Filter region = North", rows, (await timed(() => s.send({ type: "SetFilter", target: { type: "Table", table }, col: 2, filter: { type: "Values", values: ["North"] } })))[1], "ms");
    await s.send({ type: "SetFilter", target: { type: "Table", table }, col: 2, filter: null });
    const pivot = {
      id: "", sheet: 0, row: 0, col: 0,
      source: { type: "Table", table },
      rows: [{ field: "region", group: null }],
      columns: [{ field: "channel", group: null }],
      values: [{ field: "revenue", agg: "Sum", percentile: null }],
      filters: [], totals: true,
    };
    record("T6", "Pivot: revenue by region and channel", rows, (await timed(() => s.send({ type: "CreatePivot", spec: pivot, new_sheet: true })))[1], "ms");
    record("T7", "Add a formula column to every row", rows, (await timed(() => s.send({ type: "AddComputedColumn", table, name: "net", expr: "=[revenue] * (1 - COALESCE([discount], 0))" })))[1], "ms");
    s.close();
  } finally {
    rmSync(file, { force: true });
  }
}

/** T8: change one input that 20,000 formulas and a total depend on. */
async function recalcTask() {
  const n = 20_000;
  const id = await newWorkbook();
  const s = await open(id);
  const lines = [];
  for (let r = 1; r <= n; r++) lines.push(`${r}\t${(r % 7) + 1}\t=A${r}*B${r}*$E$1`);
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 4, raw: "1" });
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: lines.join("\n") });
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 3, raw: `=SUM(C1:C${n})` });
  const times = [];
  for (let k = 2; k <= 11; k++) times.push((await timed(() => s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 4, raw: String(k) })))[1]);
  const tile = (await s.send({ type: "GetTiles", sheet: 0, tiles: [[0, 0]] })).tiles[0];
  const total = tile.cells.find(([i]) => i === 3)?.[1];
  let expected = 0;
  for (let r = 1; r <= n; r++) expected += r * ((r % 7) + 1) * 11;
  record("T8", "Edit one input, 20,000 formulas recalculate", n, pct(times, 50), "ms", Number(String(total).replace(/,/g, "")) === expected ? "total checked" : `total ${total}, expected ${expected}`);
  s.close();
}

/** T9: the formula coverage list. */
async function formulaTask() {
  const id = await newWorkbook();
  const s = await open(id);
  DATA.forEach((row, r) => row.forEach((v, c) => void s.send({ type: "UpdateCell", sheet: 0, row: r, col: c, raw: String(v) })));
  await Promise.all(FORMULAS.map(([, f], r) => s.send({ type: "UpdateCell", sheet: 0, row: r, col: 4, raw: f })));
  const tiles = (await s.send({ type: "GetTiles", sheet: 0, tiles: [[0, 0], [1, 0]] })).tiles;
  const shown = (r) => tiles[Math.floor(r / 64)].cells.find(([i]) => i === (r % 64) * 16 + 4)?.[1];
  const misses = [];
  FORMULAS.forEach(([area, f, want], r) => {
    if (!matches(shown(r), want)) misses.push({ area, formula: f, expected: want, got: shown(r) ?? "" });
  });
  const passed = FORMULAS.length - misses.length;
  record("T9", "Formulas matching Excel", FORMULAS.length, passed, `of ${FORMULAS.length}`);
  for (const m of misses) console.log(`     differs: ${m.formula}  expected ${m.expected}, got ${m.got}`);
  s.close();
  return misses;
}

/** T0: an empty round trip, so the others can be read as network plus server work. */
async function networkTask() {
  const s = await open(await newWorkbook());
  const times = [];
  for (let i = 0; i < 20; i++) times.push((await timed(() => s.send({ type: "Ping" })))[1]);
  record("T0", "Network round trip (baseline)", 0, pct(times, 50), "ms", "median of 20 empty requests");
  s.close();
}

// --- run ---------------------------------------------------------------------

await api("POST", "/api/auth/sign-up/email", { email: `bench+${Date.now()}@example.test`, password: `bench-${crypto.randomUUID()}-A1!`, name: "Benchmark" });
console.log(`GridZero at ${BASE}\n`);
let misses = [];
try {
  await networkTask();
  for (const rows of SIZES) await tableTasks(rows);
  await recalcTask();
  misses = await formulaTask();
} finally {
  for (const id of workbooks) await api("DELETE", `/api/v1/workbooks/${id}`).catch(() => {});
}

const out = join(here, "results", `gridzero-${new URL(BASE).hostname.split(".")[0]}-${new Date().toISOString().slice(0, 10)}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ product: "GridZero", target: BASE, ranAt: new Date().toISOString(), results, formulaMisses: misses }, null, 2) + "\n");
console.log(`\nwrote ${out}`);
process.exit(0);
