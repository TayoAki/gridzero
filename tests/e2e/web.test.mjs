// A connected table can come from a file at a web address, downloaded again on a schedule.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { Stack } from "./harness.mjs";

let stack, files, workbookId, connectionId;
let rows = 3;
const csv = () => ["sku,units", ...Array.from({ length: rows }, (_, i) => `S${i + 1},${(i + 1) * 10}`)].join("\n") + "\n";
const json = (res) => res.json();

before(async () => {
  // A stand-in for a published sheet or an export link.
  files = createServer((req, res) => {
    if (req.url === "/stock.csv") res.writeHead(200, { "Content-Type": "text/csv" }).end(csv());
    else res.writeHead(404).end("no such file");
  });
  await new Promise((r) => files.listen(8980, "127.0.0.1", r));
  // The host refuses addresses inside its own network unless told otherwise; the stand-in is on localhost.
  stack = new Stack({ controlPort: 8978, wbhostPort: 8979, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" }, controlEnv: { CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
});

after(async () => {
  stack?.stop();
  files?.close();
});

test("a web connection needs no host or password, and runs no SQL", async () => {
  const res = await stack.api("POST", "/api/v1/connections", { kind: "web", name: "Web files" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const made = await res.json();
  connectionId = made.id;
  assert.equal(made.kind, "web");
  assert.equal((await json(await stack.api("POST", `/api/v1/connections/${connectionId}/test`))).ok, true);
  // It cannot hold a metric model: there is no database behind it.
  const model = await stack.api("POST", "/api/v1/metrics", { connectionId, yaml: "name: x\ndatasets: []\nmetrics: []\n" });
  assert.equal(model.status, 400);
});

test("a table is downloaded from its address, and downloaded again on refresh", async () => {
  let res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId, name: "stock", sql: "http://127.0.0.1:8980/stock.csv", schedule: "0 6 * * *" });
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.equal(made.error, undefined, made.error);
  assert.equal(made.rows, 3);

  // It is a Data Table like any other: listed with its columns, ready to chart.
  const { tables } = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/tables`));
  assert.deepEqual(tables.map((t) => [t.table, t.rows]), [["stock", 3]]);
  assert.deepEqual(tables[0].columns.map((c) => [c.name, c.kind]), [["sku", "text"], ["units", "number"]]);
  const boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  const card = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Units", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT SUM("units") FROM "stock"', shape: "number" } }))).widget;
  assert.equal(card.data.value, 60);

  // The file grows; a refresh brings the new rows, in the same table, and the card follows.
  rows = 5;
  res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${made.id}/refresh`);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).rows, 5);
  assert.equal((await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/tables`))).tables.length, 1);
  assert.equal((await json(await stack.api("POST", `/api/v1/widgets/${card.id}/refresh`))).widget.data.value, 150);

  const listed = (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/connected-tables`))).tables;
  assert.equal(listed[0].lastStatus, "ok");
  assert.equal(listed[0].rowCount, 5);
  assert.ok(listed[0].nextRunAt);
});

test("an address that is not a web address is refused, and a missing file is reported", async () => {
  for (const sql of ["stock.csv", "ftp://example.com/stock.csv", "file:///etc/passwd", "https://user:secret@example.com/stock.csv", "select 1"]) {
    const res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId, name: "bad", sql });
    assert.equal(res.status, 400, sql);
  }
  const res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId, name: "gone", sql: "http://127.0.0.1:8980/missing.csv" });
  assert.equal(res.status, 201);
  assert.ok((await res.json()).error);
  const gone = (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/connected-tables`))).tables.find((t) => t.name === "gone");
  assert.equal(gone.lastStatus, "error");
});
