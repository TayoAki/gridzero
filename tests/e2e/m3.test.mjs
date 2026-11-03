// M3 acceptance suite (BUILD-SPEC §11 M3: analysis objects): pivots, charts and
// slicers over cells and Data Tables, and chart references across row inserts.
//
// E2E_HEAVY=1 runs the pivot budget on a 5M-row table (needs gen-fixtures, see m2).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Stack, bin, tileTexts } from "./harness.mjs";

const HEAVY = !!process.env.E2E_HEAVY;
const ROWS = HEAVY ? 5_000_000 : 50_000;
const stack = new Stack({ controlPort: 18987, wbhostPort: 18990 });
const budgets = [];
const OPTS = { header: true, separator: null, quote: null, skip_rows: 0 };

before(() => stack.start());
after(() => {
  stack.stop();
  if (budgets.length) {
    console.log(`\nM3 budgets (BUILD-SPEC §8)${HEAVY ? "" : " — small table; E2E_HEAVY=1 for 5M rows"}:`);
    for (const b of budgets) console.log(`  ${b.ok ? "PASS" : "FAIL"} ${b.label}: ${Math.round(b.ms)} ms (budget ≤ ${b.limit} ms)`);
  }
});

const pivot = (source, extra = {}) => ({
  id: "", sheet: 0, row: 0, col: 0, source, rows: [], columns: [], values: [], filters: [], totals: true, ...extra,
});
const chartSpec = (extra) => ({ id: "", sheet: 0, row: 0, col: 10, w: 400, h: 300, kind: "Column", title: "", x: null, series: [], bins: null, stacked: false, ...extra });
const range = (r0, c0, r1, c1, sheet = 0) => ({ sheet, r0, c0, r1, c1 });

async function importTable(s, text, name = "sales.csv") {
  const importId = crypto.randomUUID();
  const res = await fetch(`${s.grant.http}/import?token=${s.grant.token}&import_id=${importId}&name=${name}`, { method: "POST", body: text });
  assert.equal(res.status, 200);
  return s.send({ type: "FinalizeImport", import_id: importId, options: OPTS, dest: { type: "NewSheet" }, mode: "Table", name });
}

async function cells(s, sheet, r0, c0, rows, cols) {
  const t = await tileTexts(s, sheet);
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => t[(r0 + r) * 16 + c0 + c] ?? ""));
}

test(`pivot over ${ROWS.toLocaleString()} rows (2 group-bys, 1 sum) meets the §8 budget`, async () => {
  const csv = join(stack.dataDir, "orders.csv");
  execFileSync(bin("gen-fixtures"), ["csv", csv, String(ROWS)], { stdio: "ignore" });
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const t = await importTable(s, readFileSync(csv), "orders.csv");
  const created = await s.send({ type: "CreatePivot", spec: pivot({ type: "Table", table: t.table }), new_sheet: true });
  const spec = pivot({ type: "Table", table: t.table }, {
    id: created.id, sheet: created.sheet,
    rows: [{ field: "region", group: null }, { field: "product", group: null }],
    values: [{ field: "revenue", agg: "Sum", percentile: null }],
  });
  const t0 = performance.now();
  await s.send({ type: "UpdatePivot", spec });
  const out = await cells(s, created.sheet, 0, 0, 3, 3);
  const ms = performance.now() - t0;
  budgets.push({ label: `pivot ${ROWS.toLocaleString()} rows, 2 group-bys, 1 sum (update → tiles)`, ms, limit: 3000, ok: ms <= 3000 });
  assert.deepEqual(out[0], ["region", "product", "Sum of revenue"]);
  assert.equal(out[1][0], "East");
  const meta = (await s.send({ type: "GetSheetMeta", sheet: created.sheet })).meta;
  assert.equal(meta.pivots[0].rows, 4 * 6 + 2); // header + 24 groups + grand total
  if (HEAVY) assert.ok(ms <= 3000, `pivot took ${Math.round(ms)} ms`);
  await s.close();
});

test("editing source cells updates the pivot, chart and slicer in one patch cycle", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "region\tunits\nNorth\t1\nSouth\t2\nNorth\t3\nEast\t4" });
  const src = range(0, 0, 4, 1);
  await s.send({ type: "SetFilter", target: { type: "Range", range: src }, col: 0, filter: null });
  await s.send({ type: "CreatePivot", spec: pivot({ type: "Range", range: src }, { col: 4, rows: [{ field: "region", group: null }], values: [{ field: "units", agg: "Sum", percentile: null }] }), new_sheet: false });
  const chart = await s.send({ type: "CreateChart", spec: chartSpec({ x: range(1, 4, 3, 4), series: [{ range: range(1, 5, 3, 5), name: "units", kind: null, axis: "Left" }] }) });
  const slicer = await s.send({ type: "CreateSlicer", spec: { id: "", sheet: 0, row: 8, col: 0, target: { type: "Range", range: src }, column: 0, title: "" } });

  // One edit: the next reads show it everywhere.
  await s.send({ type: "UpdateCell", sheet: 0, row: 1, col: 1, raw: "10" });
  assert.deepEqual(await cells(s, 0, 1, 4, 3, 2), [["East", "4"], ["North", "13"], ["South", "2"]]);
  const data = (await s.send({ type: "GetChart", id: chart.id })).data;
  assert.deepEqual(data.series[0].values, [4, 13, 2]);
  // A new value in the source appears in the slicer's list.
  await s.send({ type: "UpdateCell", sheet: 0, row: 4, col: 0, raw: "West" });
  const distinct = await s.send({ type: "DistinctValues", target: { type: "Range", range: src }, col: 0, search: null, limit: 100 });
  assert.deepEqual(distinct.values.map(([v]) => v), ["North", "South", "West"]);
  // Choosing values in the slicer filters the pivot and the chart.
  await s.send({ type: "SetFilter", target: { type: "Range", range: src }, col: 0, filter: { type: "Values", values: ["North"] } });
  assert.deepEqual(await cells(s, 0, 1, 4, 2, 2), [["North", "13"], ["Grand Total", "13"]]);
  const meta = (await s.send({ type: "GetSheetMeta", sheet: 0 })).meta;
  assert.equal(meta.slicers[0].spec.id, slicer.id);
  assert.deepEqual(meta.slicers[0].filter, { type: "Values", values: ["North"] });
  await s.close();
});

test("a slicer filters two pivots and a chart at the same time", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const t = await importTable(s, "region,product,units\nNorth,A,1\nSouth,A,2\nNorth,B,3\nEast,A,4\nSouth,B,5\nNorth,A,6\n");
  const source = { type: "Table", table: t.table };
  const p1 = await s.send({ type: "CreatePivot", spec: pivot(source, { rows: [{ field: "region", group: null }], values: [{ field: "units", agg: "Sum", percentile: null }] }), new_sheet: true });
  const p2 = await s.send({ type: "CreatePivot", spec: pivot(source, { sheet: p1.sheet, col: 4, rows: [{ field: "product", group: null }], values: [{ field: "units", agg: "Count", percentile: null }] }), new_sheet: false });
  assert.equal(p2.sheet, p1.sheet);
  const chart = await s.send({ type: "CreateChart", spec: chartSpec({ sheet: p1.sheet, x: range(1, 0, 3, 0, p1.sheet), series: [{ range: range(1, 1, 3, 1, p1.sheet), name: null, kind: null, axis: "Left" }] }) });
  await s.send({ type: "CreateSlicer", spec: { id: "", sheet: p1.sheet, row: 10, col: 0, target: source, column: 1, title: "Product" } });

  await s.send({ type: "SetFilter", target: source, col: 1, filter: { type: "Values", values: ["B"] } });
  assert.deepEqual(await cells(s, p1.sheet, 0, 0, 4, 2), [["region", "Sum of units"], ["North", "3"], ["South", "5"], ["Grand Total", "8"]]);
  assert.deepEqual(await cells(s, p1.sheet, 0, 4, 3, 2), [["product", "Count of units"], ["B", "2"], ["Grand Total", "2"]]);
  const data = (await s.send({ type: "GetChart", id: chart.id })).data;
  assert.deepEqual(data.x, ["North", "South", "Grand Total"]);
  assert.deepEqual(data.series[0].values, [3, 5, 8]);
  await s.close();
});

test("chart references survive inserted and deleted rows", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "m\tv\nJan\t1\nFeb\t2\nMar\t3" });
  const chart = await s.send({ type: "CreateChart", spec: chartSpec({ kind: "Line", x: range(1, 0, 3, 0), series: [{ range: range(1, 1, 3, 1), name: "v", kind: null, axis: "Left" }] }) });
  const read = async () => (await s.send({ type: "GetChart", id: chart.id })).data;
  await s.send({ type: "InsertRows", sheet: 0, row: 0, count: 3 });
  let d = await read();
  assert.deepEqual([d.x, d.series[0].values, d.refs[1]], [["Jan", "Feb", "Mar"], [1, 2, 3], "='Sheet1'!B5:B7"]);
  await s.send({ type: "InsertRows", sheet: 0, row: 5, count: 1 });
  await s.send({ type: "UpdateCell", sheet: 0, row: 5, col: 0, raw: "Feb½" });
  await s.send({ type: "UpdateCell", sheet: 0, row: 5, col: 1, raw: "1.5" });
  d = await read();
  assert.deepEqual(d.series[0].values, [1, 1.5, 2, 3]);
  await s.send({ type: "DeleteRows", sheet: 0, row: 0, count: 5 });
  d = await read();
  assert.deepEqual(d.series[0].values, [1.5, 2, 3]);
  assert.equal(d.refs[1], "='Sheet1'!B1:B3");
  // Undo brings the deleted row (and the reference) back.
  await s.send({ type: "Undo" });
  assert.deepEqual((await read()).series[0].values, [1, 1.5, 2, 3]);
  await s.close();
});

test("conditional formats and dropdown lists", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "5\n15\n25" });
  await s.send({ type: "AddCondFormat", range: range(0, 0, 2, 0), rule: { type: "CellIs", op: "Gt", value: "10", value2: null }, style: { fill: "#FCE8E6", color: null, bold: false } });
  const t = (await s.send({ type: "GetTiles", sheet: 0, tiles: [[0, 0]] })).tiles[0];
  const fill = (i) => t.styles[t.cells.find((c) => c[0] === i)[3]].fill;
  assert.deepEqual([fill(0), fill(16), fill(32)], [null, "#FCE8E6", "#FCE8E6"]);
  await s.send({ type: "SetValidation", spec: { id: "", range: range(0, 2, 9, 2), values: ["Yes", "No"], source: null, strict: true } });
  await assert.rejects(s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 2, raw: "Maybe" }), /Yes, No/);
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 2, raw: "yes" });
  const choices = await s.send({ type: "GetChoices", sheet: 0, row: 4, col: 2 });
  assert.deepEqual(choices.values, ["Yes", "No"]);
  await s.close();
});

test("cell formulas read table and pivot cells", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "region\tunits\nNorth\t1\nSouth\t2\nNorth\t3\nEast\t4" });
  const spec = pivot({ type: "Range", range: range(0, 0, 4, 1) }, {
    col: 4, rows: [{ field: "region", group: null }], values: [{ field: "units", agg: "Sum", percentile: null }],
  });
  await s.send({ type: "CreatePivot", spec, new_sheet: false });
  // Pivot E1:F5 = header, East 4, North 4, South 2, Grand Total 10.
  await s.send({ type: "UpdateCell", sheet: 0, row: 9, col: 0, raw: "=SUM(F2:F4)*10" });
  await s.send({ type: "UpdateCell", sheet: 0, row: 10, col: 0, raw: '=VLOOKUP("South",E2:F4,2,FALSE)' });
  const t = await importTable(s, "name,score\nAda,7\nBo,5\n", "scores.csv");
  await s.send({ type: "UpdateCell", sheet: 0, row: 11, col: 0, raw: "=SUM(scores!B:B)+COUNTA(scores!A2:A3)" });
  let texts = await tileTexts(s, 0);
  assert.deepEqual([texts[9 * 16], texts[10 * 16], texts[11 * 16]], ["100", "2", "14"]);
  // Editing the pivot's source and sorting the table flow into the formulas.
  await s.send({ type: "UpdateCell", sheet: 0, row: 2, col: 1, raw: "12" });
  await s.send({ type: "UpdateCell", sheet: 0, row: 12, col: 0, raw: "=scores!A2" });
  await s.send({ type: "SortTable", table: t.table, keys: [{ col: 1, desc: false }] });
  texts = await tileTexts(s, 0);
  assert.deepEqual([texts[9 * 16], texts[10 * 16], texts[12 * 16]], ["200", "12", "Bo"]);
  // They survive a reconnect after the actor reloads from disk.
  await s.close();
  await stack.restartWbhost();
  const again = await stack.open(id);
  texts = await tileTexts(again, 0);
  assert.deepEqual([texts[9 * 16], texts[11 * 16], texts[12 * 16]], ["200", "14", "Bo"]);
  await again.close();
});

test("pivot drill-down, icon sets, and chart data over HTTP", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "region\tunits\nNorth\t1\nSouth\t2\nNorth\t3\nEast\t4" });
  const spec = pivot({ type: "Range", range: range(0, 0, 4, 1) }, {
    col: 4, rows: [{ field: "region", group: null }], values: [{ field: "units", agg: "Sum", percentile: null }],
  });
  await s.send({ type: "CreatePivot", spec, new_sheet: false });
  const drilled = await s.send({ type: "DrillDown", sheet: 0, row: 2, col: 5 });
  assert.deepEqual(await cells(s, drilled.sheet, 0, 0, 3, 2), [["region", "units"], ["North", "1"], ["North", "3"]]);

  await s.send({ type: "AddCondFormat", range: range(1, 1, 4, 1), rule: { type: "IconSet", set: "Arrows", reverse: false }, style: { fill: null, color: null, bold: false } });
  const tile = (await s.send({ type: "GetTiles", sheet: 0, tiles: [[0, 0]] })).tiles[0];
  const icon = (i) => tile.styles[tile.cells.find((c) => c[0] === i)[3]].icon?.[0];
  assert.deepEqual([icon(16 + 1), icon(4 * 16 + 1)], ["down", "up"]);

  const chart = await s.send({ type: "CreateChart", spec: chartSpec({ x: range(1, 0, 4, 0), series: [{ range: range(1, 1, 4, 1), name: null, kind: null, axis: "Left" }] }) });
  const url = `${s.grant.http}/chart/${chart.id}?token=${s.grant.token}`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).series[0].values, [1, 2, 3, 4]);
  const etag = res.headers.get("etag");
  assert.equal((await fetch(url, { headers: { "If-None-Match": etag } })).status, 304);
  await s.send({ type: "UpdateCell", sheet: 0, row: 1, col: 1, raw: "9" });
  const changed = await fetch(url, { headers: { "If-None-Match": etag } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).series[0].values[0], 9);
  assert.equal((await fetch(`${s.grant.http}/chart/${chart.id}?token=bad`)).status, 401);
  await s.close();
});

test("the M3 budget is met", { skip: !HEAVY && "enforced with E2E_HEAVY=1" }, () => {
  assert.deepEqual(budgets.filter((b) => !b.ok), []);
});
