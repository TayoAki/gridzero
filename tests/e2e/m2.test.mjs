// M2 acceptance suite (BUILD-SPEC §11 M2: big data). Uploads files to the workbook
// host, imports them as Data Tables or cells, and times the §8 budgets.
//
// Needs, besides what m1 needs: the fixture generator
//   cargo build --release -p importer --features fixtures --bin gen-fixtures
// E2E_HEAVY=1 runs the budgets at full size (5M-row CSV, 1M-row XLSX); otherwise
// the same checks run on small files and budgets are reported but scaled down.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Stack, bin, pct, tileTexts } from "./harness.mjs";

const HEAVY = !!process.env.E2E_HEAVY;
const CSV_ROWS = HEAVY ? 5_000_000 : 50_000;
const XLSX_ROWS = HEAVY ? 1_000_000 : 20_000;
const stack = new Stack({ controlPort: 18887, wbhostPort: 18890, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" } });
const budgets = [];
let csvPath;
let xlsxPath;

function budget(label, ms, limit) {
  budgets.push({ label, ms, limit, ok: ms <= limit });
}

function generate(kind, path, rows) {
  execFileSync(bin("gen-fixtures"), [kind, path, String(rows)], { stdio: ["ignore", "ignore", "inherit"] });
}

before(async () => {
  await stack.start();
  csvPath = join(stack.dataDir, "orders.csv");
  xlsxPath = join(stack.dataDir, "orders.xlsx");
  generate("csv", csvPath, CSV_ROWS);
  generate("xlsx", xlsxPath, XLSX_ROWS);
});

after(() => {
  stack.stop();
  if (budgets.length) {
    console.log(`\nM2 budgets (BUILD-SPEC §8)${HEAVY ? "" : " — small files; run with E2E_HEAVY=1 for full size"}:`);
    for (const b of budgets) console.log(`  ${b.ok ? "PASS" : "FAIL"} ${b.label}: ${Math.round(b.ms)} ms (budget ≤ ${b.limit} ms)`);
  }
});

async function upload(s, name, body, headers = {}) {
  const importId = crypto.randomUUID();
  const res = await fetch(`${s.grant.http}/import?token=${s.grant.token}&import_id=${importId}&name=${encodeURIComponent(name)}`, { method: "POST", body, headers });
  assert.equal(res.status, 200, await res.clone().text());
  return { importId, ...(await res.json()) };
}

async function finalize(s, importId, mode, dest = { type: "NewSheet" }, name = "orders") {
  return s.send({ type: "FinalizeImport", import_id: importId, options: { header: true, separator: null, quote: null, skip_rows: 0 }, dest, mode, name });
}

async function meta(s, sheet) {
  return (await s.send({ type: "GetSheetMeta", sheet })).meta;
}

async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

let tableWb;
let tableSheet;
let tableId;

test(`${CSV_ROWS.toLocaleString()}-row CSV imports as a Data Table`, async () => {
  tableWb = await stack.newWorkbook();
  const s = await stack.open(tableWb);
  const [, total] = await timed(async () => {
    const { importId, bytes } = await upload(s, "orders.csv", readFileSync(csvPath));
    assert.ok(bytes > 0);
    const p = await s.send({ type: "ImportPreview", import_id: importId, options: { header: true, separator: null, quote: null, skip_rows: 0 } });
    assert.equal(p.preview.format, "csv");
    assert.deepEqual(p.preview.columns.map((c) => c.dtype), ["integer", "date", "text", "text", "integer", "number", "number", "number", "boolean"]);
    assert.ok(Math.abs(p.preview.total_rows - CSV_ROWS) / CSV_ROWS < 0.05, `estimate ${p.preview.total_rows}`);
    const r = await finalize(s, importId, "Table");
    assert.equal(r.rows, CSV_ROWS + 1);
    tableSheet = r.sheet;
    tableId = r.table;
  });
  budget(`import ${CSV_ROWS.toLocaleString()}-row CSV (upload + preview + finalize)`, total, 45_000);

  const m = await meta(s, tableSheet);
  assert.equal(m.tables[0].rows, CSV_ROWS);
  assert.ok(m.row_count >= CSV_ROWS + 1);
  const cells = await tileTexts(s, tableSheet);
  assert.equal(cells[0], "order_id");
  assert.equal(cells[16], "1");

  // Paging deep into the table: per-tile server time stays flat (scrolling at 60 fps
  // is measured in the browser; this is the server half of it).
  const times = [];
  for (let i = 0; i < 40; i++) {
    const tr = Math.floor(Math.random() * (CSV_ROWS / 64));
    const [t, ms] = await timed(() => s.send({ type: "GetTiles", sheet: tableSheet, tiles: [[tr, 0]] }));
    assert.ok(t.tiles[0].cells.length > 0);
    times.push(ms);
  }
  budget("GetTiles deep in the table (p95, one 64x16 tile)", pct(times, 95), 50);
  await s.close();
});

test("sort, filter and a computed column on the big table", async () => {
  const s = await stack.open(tableWb);
  const [, sortMs] = await timed(() => s.send({ type: "SortTable", table: tableId, keys: [{ col: 7, desc: true }] }));
  budget(`sort ${CSV_ROWS.toLocaleString()} rows (one column)`, sortMs, 2_000);
  const revenue = (cells, row) => Number(cells[row * 16 + 7]);
  let cells = await tileTexts(s, tableSheet);
  assert.ok(revenue(cells, 1) >= revenue(cells, 2) && revenue(cells, 2) >= revenue(cells, 3));

  const [, filterMs] = await timed(() => s.send({ type: "SetFilter", target: { type: "Table", table: tableId }, col: 2, filter: { type: "Values", values: ["North"] } }));
  budget(`filter ${CSV_ROWS.toLocaleString()} rows (one column)`, filterMs, 2_000);
  let m = await meta(s, tableSheet);
  const north = m.tables[0].rows;
  assert.ok(north > CSV_ROWS * 0.2 && north < CSV_ROWS * 0.3, `${north} North rows`);
  cells = await tileTexts(s, tableSheet);
  assert.ok([1, 2, 3].every((r) => cells[r * 16 + 2] === "North"));

  const distinct = await s.send({ type: "DistinctValues", target: { type: "Table", table: tableId }, col: 3, search: null, limit: 100 });
  assert.equal(distinct.total, 6);

  const [, computedMs] = await timed(() => s.send({ type: "AddComputedColumn", table: tableId, name: "net", expr: "=[revenue] * (1 - COALESCE([discount], 0))" }));
  budget(`computed column over ${CSV_ROWS.toLocaleString()} rows`, computedMs, 3_000);
  m = await meta(s, tableSheet);
  assert.equal(m.tables[0].columns[9].expr, "=[revenue] * (1 - COALESCE([discount], 0))");
  cells = await tileTexts(s, tableSheet);
  assert.equal(cells[9], "net");
  assert.ok(Number(cells[16 + 9]) <= Number(cells[16 + 7]));

  // Bad formulas are refused with the reason.
  await assert.rejects(s.send({ type: "AddComputedColumn", table: tableId, name: "x", expr: "=[nope] + 1" }), /nope/);

  // Selection stats over a whole table column come from Polars, not cells.
  const st = await s.send({ type: "SelectionStats", range: { sheet: tableSheet, r0: 1, c0: 4, r1: north, c1: 4 } });
  assert.equal(st.numbers, north);
  await s.close();
});

test("Data Tables survive a host restart (manifest + Parquet)", async () => {
  await stack.restartWbhost();
  const [[s, m], ms] = await timed(async () => {
    const s = await stack.open(tableWb);
    return [s, await meta(s, tableSheet)];
  });
  budget(`cold rehydrate of a ${CSV_ROWS.toLocaleString()}-row table workbook`, ms, 6_000);
  const t = m.tables[0];
  assert.equal(t.columns[2].filter.type, "Values");
  assert.equal(t.columns[7].sort, true);
  assert.equal(t.columns[9].name, "net");
  assert.ok(t.rows < CSV_ROWS);
  // Undo history is per session of the host, but the state itself is intact.
  const cells = await tileTexts(s, tableSheet);
  assert.equal(cells[16 + 2], "North");
  await s.close();
});

test(`${XLSX_ROWS.toLocaleString()}-row XLSX imports`, async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const [, ms] = await timed(async () => {
    const { importId } = await upload(s, "orders.xlsx", readFileSync(xlsxPath));
    const p = await s.send({ type: "ImportPreview", import_id: importId, options: { header: true, separator: null, quote: null, skip_rows: 0 } });
    assert.equal(p.preview.total_rows, XLSX_ROWS);
    assert.equal(p.preview.columns[1].dtype, "date");
    const r = await finalize(s, importId, "Table");
    assert.equal(r.rows, XLSX_ROWS + 1);
  });
  budget(`import ${XLSX_ROWS.toLocaleString()}-row XLSX`, ms, 120_000);
  const cells = await tileTexts(s, 1);
  assert.match(cells[16 + 1], /^2025-\d{2}-\d{2}$/);
  await s.close();
});

test("re-importing to the same destination recomputes dependent formulas", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  // Cells: a formula next to the import sums an imported column.
  const first = await upload(s, "q1.csv", "region,units\nNorth,10\nSouth,20\n");
  await finalize(s, first.importId, "Cells", { type: "Cell", sheet: 0, row: 0, col: 0 });
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 4, raw: "=SUM(B2:B10)" });
  assert.equal((await tileTexts(s, 0))[4], "30");
  const second = await upload(s, "q2.csv", "region,units\nNorth,1\nSouth,2\nEast,3\n");
  await finalize(s, second.importId, "Cells", { type: "Cell", sheet: 0, row: 0, col: 0 });
  assert.equal((await tileTexts(s, 0))[4], "6");

  // Data Table: the computed column, filter and sort apply to the new file.
  const t1 = await upload(s, "t1.csv", "item,qty,price\na,1,10\nb,2,10\n");
  const r = await finalize(s, t1.importId, "Table", { type: "Cell", sheet: 0, row: 0, col: 8 });
  await s.send({ type: "AddComputedColumn", table: r.table, name: "total", expr: "=[qty]*[price]" });
  await s.send({ type: "SortTable", table: r.table, keys: [{ col: 3, desc: true }] });
  let cells = await tileTexts(s, 0);
  assert.equal(cells[16 + 11], "20");
  const t2 = await upload(s, "t2.csv", "item,qty,price\na,5,10\nb,2,10\nc,9,1\n");
  const r2 = await finalize(s, t2.importId, "Table", { type: "Cell", sheet: 0, row: 0, col: 8 });
  assert.equal(r2.table, r.table);
  cells = await tileTexts(s, 0);
  assert.deepEqual([cells[16 + 11], cells[32 + 11], cells[48 + 11]], ["50", "20", "9"]);
  await s.close();
});

test("gzip uploads, URL import and bad uploads", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const gz = await upload(s, "small.csv.gz", gzipSync("a,b\n1,2\n3,4\n"));
  assert.equal(gz.name, "small.csv");
  const p = await s.send({ type: "ImportPreview", import_id: gz.importId, options: { header: true, separator: null, quote: null, skip_rows: 0 } });
  assert.equal(p.preview.total_rows, 2);
  await s.send({ type: "CancelImport", import_id: gz.importId });
  await assert.rejects(s.send({ type: "ImportPreview", import_id: gz.importId, options: { header: true, separator: null, quote: null, skip_rows: 0 } }), /no such upload/);

  const server = createServer((_, res) => res.end("x;y\n1;2\n")).listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/data.csv`;
  const importId = crypto.randomUUID();
  const res = await fetch(`${s.grant.http}/import_url?token=${s.grant.token}&import_id=${importId}&url=${encodeURIComponent(url)}`, { method: "POST" });
  server.close();
  assert.equal(res.status, 200, await res.clone().text());
  const up = await s.send({ type: "ImportPreview", import_id: importId, options: { header: true, separator: null, quote: null, skip_rows: 0 } });
  assert.equal(up.preview.separator, ";");

  const bad = await fetch(`${s.grant.http}/import?token=${s.grant.token}&import_id=${crypto.randomUUID()}&name=evil.exe`, { method: "POST", body: "x" });
  assert.equal(bad.status, 400);
  const forged = await fetch(`${s.grant.http}/import?token=nope&import_id=${crypto.randomUUID()}&name=a.csv`, { method: "POST", body: "x" });
  assert.equal(forged.status, 401);
  await s.close();
});

test("range tools: sort, filter, remove duplicates, text to columns", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "name\tn\nb\t3\na\t1\nc\t2\na\t1" });
  const range = { sheet: 0, r0: 0, c0: 0, r1: 4, c1: 1 };
  await s.send({ type: "SortRange", range, keys: [{ col: 1, desc: false }], header: true });
  let c = await tileTexts(s, 0);
  assert.deepEqual([c[16], c[32], c[48], c[64]], ["a", "a", "c", "b"]);
  await s.send({ type: "SetFilter", target: { type: "Range", range }, col: 0, filter: { type: "Values", values: ["a"] } });
  const m = await meta(s, 0);
  assert.deepEqual(m.row_heights.filter(([, h]) => h === 0).map(([r]) => r).sort(), [3, 4]);
  await s.send({ type: "ClearFilters", target: { type: "Range", range } });
  const removed = await s.send({ type: "RemoveDuplicates", target: { type: "Range", range }, cols: [], header: true });
  assert.equal(removed.removed, 1);
  await s.send({ type: "UpdateCell", sheet: 0, row: 10, col: 0, raw: "x|y|z" });
  await s.send({ type: "TextToColumns", range: { sheet: 0, r0: 10, c0: 0, r1: 10, c1: 0 }, delimiter: "|" });
  c = await tileTexts(s, 0);
  assert.deepEqual([c[160], c[161], c[162]], ["x", "y", "z"]);
  // Everything above is one undo step each.
  await s.send({ type: "Undo" });
  assert.equal((await tileTexts(s, 0))[160], "x|y|z");
  await s.close();
});

test("all M2 budgets met", { skip: !HEAVY && "budgets are enforced with E2E_HEAVY=1" }, () => {
  const failed = budgets.filter((b) => !b.ok);
  assert.deepEqual(failed, []);
});
