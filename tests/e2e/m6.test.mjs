// M6 acceptance without Stripe (BUILD-SPEC §11): Postgres connections and connected
// tables against the test database, scheduled refresh, audit log, and a host crash.
// Snowflake is covered by services/control/test/connectors.test.ts.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Stack, tileTexts, waitFor } from "./harness.mjs";

process.env.CONNECTOR_ALLOW_PRIVATE = "1";
process.env.CONNECTION_SECRET_KEY ??= "e2e-only-connection-key";
const stack = new Stack({ controlPort: 19187, wbhostPort: 19190 });
const HEAVY = !!process.env.E2E_HEAVY;
const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/postgres");
const body = () => ({
  kind: "postgres",
  name: `test-${Date.now()}-${Math.random()}`,
  config: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) || "postgres", user: decodeURIComponent(url.username || "postgres"), ssl: "disable" },
  secret: decodeURIComponent(url.password) || "unused",
});

before(() => stack.start());
after(() => stack.stop());

async function connection() {
  const res = await stack.api("POST", "/api/v1/connections", body());
  assert.equal(res.status, 201);
  const c = await res.json();
  assert.equal("secret" in c, false, "the secret never comes back");
  return c.id;
}

const create = async (id, connectionId, sql, schedule) => (await stack.api("POST", `/api/v1/workbooks/${id}/connected-tables`, { connectionId, name: "orders", sql, schedule })).json();

test("a query lands as a table and refreshes in place", async () => {
  const id = await stack.newWorkbook();
  const conn = await connection();
  assert.deepEqual(await (await stack.api("POST", `/api/v1/connections/${conn}/test`)).json(), { ok: true });

  const made = await create(id, conn, "select n, 'item ' || n as label from generate_series(1, 3) n;");
  assert.equal(made.error, undefined);
  assert.equal(made.rows, 3);
  const s = await stack.open(id);
  const sheet = s.state.sheets.length - 1;
  assert.equal(s.state.sheets[sheet].name, "orders");
  const before = await tileTexts(s, sheet);
  assert.equal(before[0], "n");
  assert.equal(before[16 * 3 + 1], "item 3");

  await stack.api("PATCH", `/api/v1/workbooks/${id}/connected-tables/${made.id}`, { sql: "select n from generate_series(1, 5) n" });
  const again = await (await stack.api("POST", `/api/v1/workbooks/${id}/connected-tables/${made.id}/refresh`)).json();
  assert.equal(again.rows, 5);
  assert.equal(again.table, made.table, "the same Data Table");
  assert.equal((await s.send({ type: "GetSheetMeta", sheet })).meta.tables[0].total_rows, 5);
  await s.close();
});

test("queries are read-only and failures are recorded", async () => {
  const id = await stack.newWorkbook();
  const conn = await connection();
  const bad = await create(id, conn, "with x as (insert into \"workbook\"(id, owner_id) values ('x','x') returning id) select * from x");
  assert.ok(bad.error, "writing is refused");
  const list = await (await stack.api("GET", `/api/v1/workbooks/${id}/connected-tables`)).json();
  assert.equal(list.tables[0].lastStatus, "error");
  const log = await (await stack.api("GET", `/api/v1/workbooks/${id}/audit`)).json();
  assert.ok(log.events.some((e) => e.event === "connected_table.refresh_failed"));
  assert.ok(log.events.some((e) => e.event === "connected_table.create"));
});

test("a scheduled refresh runs within a minute of its time", { timeout: 150_000 }, async () => {
  const id = await stack.newWorkbook();
  const conn = await connection();
  const made = await create(id, conn, "select now()::text as at", "* * * * *");
  const started = Date.now();
  const first = (await (await stack.api("GET", `/api/v1/workbooks/${id}/connected-tables`)).json()).tables[0];
  const due = new Date(first.nextRunAt).getTime();
  let row;
  await waitFor(
    async () => {
      row = (await (await stack.api("GET", `/api/v1/workbooks/${id}/connected-tables`)).json()).tables[0];
      return row.lastRunAt && new Date(row.lastRunAt).getTime() >= due;
    },
    "the scheduled run",
    100_000,
  );
  assert.equal(row.lastStatus, "ok", row.lastError ?? "");
  assert.ok(Math.abs(new Date(row.lastRunAt).getTime() - due) <= 60_000, `ran ${new Date(row.lastRunAt).getTime() - due} ms from its time`);
  assert.ok(Date.now() - started < 120_000);
  await stack.api("DELETE", `/api/v1/workbooks/${id}/connected-tables/${made.id}`);
});

test(`a ${HEAVY ? "1,000,000" : "100,000"}-row query lands within budget`, { timeout: 180_000 }, async () => {
  const n = HEAVY ? 1_000_000 : 100_000;
  const id = await stack.newWorkbook();
  const conn = await connection();
  const t0 = Date.now();
  const made = await create(id, conn, `select n, n * 2 as d, 'row ' || n as label from generate_series(1, ${n}) n`);
  const seconds = (Date.now() - t0) / 1000;
  console.log(`${n} rows from Postgres in ${seconds.toFixed(1)} s`);
  assert.equal(made.rows, n);
  if (HEAVY) assert.ok(seconds <= 20, `took ${seconds} s`);
});

test("killing the host loses no acknowledged edit", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const edits = 200;
  for (let i = 0; i < edits; i++) await s.send({ type: "UpdateCell", sheet: 0, row: i, col: 0, raw: String(i * 3) });
  const exited = new Promise((r) => stack.wbhost.once("exit", r));
  stack.wbhost.kill("SIGKILL");
  await exited;
  await stack.startWbhost();
  const back = await stack.open(id);
  const tiles = await back.send({ type: "GetTiles", sheet: 0, tiles: [[3, 0]] });
  const last = tiles.tiles[0].cells.find(([i]) => i === (edits - 1 - 192) * 16);
  assert.equal(last[1], String((edits - 1) * 3));
  await back.close();
});

test("other people's connections are out of reach", async () => {
  const conn = await connection();
  const owner = stack.cookie;
  stack.cookie = "";
  await stack.api("POST", "/api/auth/sign-up/email", { name: "X", email: `x-${Date.now()}@example.com`, password: "correct-horse-9" });
  const mine = await stack.newWorkbook();
  assert.equal((await stack.api("POST", `/api/v1/connections/${conn}/test`)).status, 404);
  assert.equal((await stack.api("DELETE", `/api/v1/connections/${conn}`)).status, 404);
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${mine}/connected-tables`, { connectionId: conn, name: "x", sql: "select 1" })).status, 400);
  stack.cookie = owner;
});
