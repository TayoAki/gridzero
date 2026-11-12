// Delta Lake and Unity Catalog: a table's rows kept version by version and compared record by record,
// entries written out as a Delta table and registered in a catalog, and a finished row handed on.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Stack } from "./harness.mjs";

let stack, files, unity, hook, workbookId, boardId, deals;
const dir = mkdtempSync(join(tmpdir(), "gz-delta-"));
const ADMIN = `admin-step7-${Date.now()}@example.com`;
const registered = [], hooked = [];
let csv = "deal,stage,amount\nD1,Open,100\nD2,Open,200\nD3,Won,300\n";
const json = (res) => res.json();
async function person(name, email = `${name.toLowerCase()}-${Date.now()}@example.com`) {
  const p = new Stack({ controlPort: 8985, wbhostPort: 8986 });
  p.base = stack.base;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

before(async () => {
  files = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/csv" }).end(csv));
  await new Promise((r) => files.listen(8987, "127.0.0.1", r));
  // A stand-in for a Unity Catalog server: it lists one catalog and records the tables registered.
  unity = createServer((req, res) => {
    const send = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== "Bearer uc-token") return send(401, {});
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname.endsWith("/tables")) {
      let body = "";
      req.on("data", (d) => (body += d));
      return req.on("end", () => { registered.push(JSON.parse(body)); send(200, { name: JSON.parse(body).name }); });
    }
    if (url.pathname.endsWith("/catalogs")) return send(200, { catalogs: [{ name: "finance" }] });
    if (url.pathname.endsWith("/schemas")) return send(200, { schemas: [{ name: "handoff" }] });
    if (url.pathname.endsWith("/tables")) return send(200, { tables: registered.map((t) => ({ name: t.name, table_type: t.table_type, data_source_format: t.data_source_format, storage_location: t.storage_location })) });
    send(404, {});
  });
  await new Promise((r) => unity.listen(8988, "127.0.0.1", r));
  hook = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { hooked.push(JSON.parse(b)); res.writeHead(200).end("ok"); }); });
  await new Promise((r) => hook.listen(8989, "127.0.0.1", r));
  stack = new Stack({ controlPort: 8985, wbhostPort: 8986, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" }, controlEnv: { CONNECTION_SECRET_KEY: "e2e-connection-key", WEBHOOK_ALLOW_PRIVATE: "1", DELTA_DIR: dir, UNITY_CATALOG_URL: "http://127.0.0.1:8988", UNITY_CATALOG_TOKEN: "uc-token", UNITY_CATALOG_NAME: "finance", UNITY_CATALOG_SCHEMA: "handoff", ADMIN_EMAILS: ADMIN } });
  await stack.start();
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  const conn = (await json(await stack.api("POST", "/api/v1/connections", { kind: "web", name: "CRM export" }))).id;
  deals = await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId: conn, name: "deals", sql: "http://127.0.0.1:8987/deals.csv" }));
});

after(async () => {
  stack?.stop();
  files?.close();
  unity?.close();
  hook?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a tracked table keeps each capture, and two captures are compared record by record", async () => {
  let res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/history`, { table: "deals", key: "nope" });
  assert.equal(res.status, 404);
  res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/history`, { table: "deals", key: "deal" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const made = await res.json();
  assert.equal(made.version, 0);
  assert.equal(made.rows, 3);
  // It is a real Delta table on disk.
  assert.ok(existsSync(join(dir, "history", made.id, "_delta_log")));

  // A week later: D1 moves on and grows, D2 is gone, D4 is new.
  csv = "deal,stage,amount\nD1,Won,150\nD3,Won,300\nD4,Open,400\n";
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${deals.id}/refresh`)).status, 200);
  const second = await json(await stack.api("POST", `/api/v1/history/${made.id}/capture`));
  assert.equal(second.version, 1);

  const list = await json(await stack.api("GET", `/api/v1/history/${made.id}`));
  assert.deepEqual(list.versions.map((v) => v.version).sort(), [0, 1]);
  const { diff } = await json(await stack.api("GET", `/api/v1/history/${made.id}?a=0&b=1`));
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1 });
  assert.equal(diff.added[0].deal, "D4");
  assert.equal(diff.removed[0].deal, "D2");
  assert.deepEqual(diff.changed[0], { key: "D1", was: { stage: "Open", amount: "100" }, now: { stage: "Won", amount: "150" } });
  assert.equal((await stack.api("GET", `/api/v1/history/${made.id}?a=0&b=7`)).status, 400);

  const stranger = await person("Zed");
  assert.equal((await stranger.api("GET", `/api/v1/history/${made.id}`)).status, 404);
  assert.equal((await stranger.api("POST", `/api/v1/workbooks/${workbookId}/history`, { table: "deals", key: "deal" })).status, 404);
});

test("entries are written out as a Delta table, registered in the catalog, and a finished row is handed on once", async () => {
  const card = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Deals", form: "table", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT "deal", "amount" FROM "deals" ORDER BY 1', shape: "table" } }))).widget;
  const table = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/inputs`, { name: "Renewals", columns: [{ name: "Owner", kind: "text" }, { name: "Status", kind: "choice", options: ["Open", "Renewed"] }], widgetId: card.id, keyColumn: "deal" }))).table;
  await stack.api("POST", `/api/v1/inputs/${table.id}/approve`);
  // Finished rows go to Finance's address.
  assert.equal((await stack.api("PUT", `/api/v1/inputs/${table.id}/handoff`, { webhook: "http://127.0.0.1:8989/finance", column: "Nope", value: "Renewed" })).status, 400);
  assert.equal((await stack.api("PUT", `/api/v1/inputs/${table.id}/handoff`, { webhook: "http://127.0.0.1:8989/finance", column: "Status", value: "Renewed" })).status, 200);
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "D1", values: { Owner: "Cy", Status: "Open" } });
  assert.equal(hooked.length, 0);
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "D1", values: { Status: "Renewed" } });
  assert.equal(hooked.length, 1);
  assert.equal(hooked[0].key, "D1");
  assert.deepEqual(hooked[0].values, { Owner: "Cy", Status: "Renewed" });
  // Saving it again as Renewed does not send it twice.
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "D1", values: { Owner: "Cy B" } });
  assert.equal(hooked.length, 1);
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "D3", values: { Owner: "Vi", Status: "Open" } });

  let res = await stack.api("POST", `/api/v1/inputs/${table.id}/export`);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const out = await res.json();
  assert.equal(out.format, "delta");
  assert.equal(out.rows, 2);
  assert.equal(out.version, 0);
  assert.ok(existsSync(join(out.location, "_delta_log")));
  assert.equal(out.unityTable, "finance.handoff.my_dashboard_renewals");
  assert.equal(registered[0].data_source_format, "DELTA");
  assert.equal(registered[0].storage_location, out.location);
  assert.deepEqual(registered[0].columns.map((c) => c.name), ["deal", "Owner", "Status", "entered_by", "entered_at"]);
  // Written out again after a change: a new version of the same table.
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "D4", values: { Owner: "Al" } });
  assert.equal((await json(await stack.api("POST", `/api/v1/inputs/${table.id}/export`))).version, 1);

  // Only the owner writes out; an administrator can see what the catalog holds.
  const ed = await person("Ed");
  assert.equal((await ed.api("POST", `/api/v1/inputs/${table.id}/export`)).status, 404);
  assert.equal((await stack.api("GET", "/api/v1/admin/unity")).status, 403);
  const admin = await person("Admin", ADMIN);
  const cat = await json(await admin.api("GET", "/api/v1/admin/unity"));
  assert.equal(cat.catalogs[0].name, "finance");
  assert.equal(cat.catalogs[0].schemas[0].tables[0].name, "my_dashboard_renewals");
  assert.equal(cat.catalogs[0].schemas[0].tables[0].format, "DELTA");
});
