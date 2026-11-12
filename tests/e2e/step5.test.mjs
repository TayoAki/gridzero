// The card builder's deeper queries, run against real tables: a looked-up table, several totals, a custom
// column, actual against plan, a funnel and retention by cohort. And tables people type into.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { buildSql, cohortSql, columnsOf, compareSql, funnelSql } from "../../apps/web/src/widgets/builderSql.ts";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId;
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const run = async (sql) => {
  const res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql });
  const body = await res.json();
  assert.equal(res.status, 200, `${body.error}\n${sql}`);
  return body;
};
const load = async (name, csv) => {
  fake.script.push(call("write_table", { workbook_id: workbookId, name, csv }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import" }).then((r) => r.text());
};
async function person(name) {
  const p = new Stack({ controlPort: 8973, wbhostPort: 8974 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

const ORDERS = [
  // order_id, customer_id, amount, ordered_at
  [1, "c1", 100, "2026-01-05"], [2, "c1", 50, "2026-02-10"], [3, "c2", 200, "2026-01-20"], [4, "c2", 80, "2026-03-02"],
  [5, "c3", 40, "2026-02-14"], [6, "c3", 60, "2026-03-09"], [7, "c4", 300, "2026-03-15"],
];
const CUSTOMERS = [["c1", "North"], ["c2", "North"], ["c3", "South"], ["c4", "South"]];
const PLAN = [["2026-01-01", 250], ["2026-02-01", 100], ["2026-03-01", 500], ["2026-04-01", 400]];
const EVENTS = [["u1", "visit"], ["u2", "visit"], ["u3", "visit"], ["u4", "visit"], ["u1", "signup"], ["u2", "signup"], ["u3", "signup"], ["u1", "paid"], ["u1", "paid"]];

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8973, wbhostPort: 8974, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await load("orders", ["order_id,customer_id,amount,ordered_at", ...ORDERS.map((r) => r.join(","))].join("\n") + "\n");
  await load("customers", ["customer_id,region", ...CUSTOMERS.map((r) => r.join(","))].join("\n") + "\n");
  await load("plan", ["month,planned", ...PLAN.map((r) => r.join(","))].join("\n") + "\n");
  await load("events", ["user_id,step", ...EVENTS.map((r) => r.join(","))].join("\n") + "\n");
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

const own = [{ name: "order_id", kind: "number" }, { name: "customer_id", kind: "text" }, { name: "amount", kind: "number" }, { name: "ordered_at", kind: "date" }];
const base = { table: "orders", measure: "sum", column: "amount", split: "", bucket: "month", second: "", keep: [] };

test("a looked-up table gives a column to split by, without counting any order twice", async () => {
  const choice = { ...base, join: { table: "customers", left: "customer_id", right: "customer_id" }, split: "customers.region" };
  const cols = columnsOf(choice, own, [{ name: "customer_id", kind: "text" }, { name: "region", kind: "text" }]);
  const built = buildSql(choice, cols);
  assert.equal(built.shape, "series");
  const out = await run(built.sql);
  assert.deepEqual(out.rows.map((r) => [r[0], Number(r[1])]).sort(), [["North", 430], ["South", 400]]);
  // The whole still adds up to every order once.
  assert.equal(Number((await run(buildSql({ ...choice, split: "" }, cols).sql)).rows[0][0]), 830);
});

test("several totals sit side by side, and a custom column can be totalled", async () => {
  const choice = { ...base, more: [{ measure: "count", column: "" }, { measure: "avg", column: "amount" }], split: "customer_id" };
  const built = buildSql(choice, own);
  assert.equal(built.shape, "table");
  const out = await run(built.sql);
  assert.deepEqual(out.columns, ["customer_id", "Total amount", "Rows", "Average amount"]);
  assert.deepEqual(out.rows.find((r) => r[0] === "c1").slice(1).map(Number), [150, 2, 75]);

  const custom = { ...base, custom: { name: "tax", expr: '"amount" * 0.2' }, column: "tax" };
  const total = await run(buildSql(custom, columnsOf(custom, own)).sql);
  assert.equal(Math.round(Number(total.rows[0][0])), 166);
  // A condition on the kept rows still applies.
  const kept = await run(buildSql({ ...base, keep: [{ column: "amount", op: ">=", value: "100" }] }, own).sql);
  assert.equal(Number(kept.rows[0][0]), 600);
});

test("actual against plan totals each side first, then lines them up, including months with only a plan", async () => {
  const built = compareSql({ table: "orders", measure: "sum", column: "amount", by: "ordered_at", name: "Actual" }, { table: "plan", measure: "sum", column: "planned", by: "month", name: "Plan" }, { isDate: true, bucket: "month" });
  const out = await run(built.sql);
  assert.deepEqual(out.columns, ["ordered_at", "Actual", "Plan", "Difference"]);
  const by = Object.fromEntries(out.rows.map((r) => [r[0], r.slice(1).map((v) => (v === null ? null : Number(v)))]));
  assert.deepEqual(by["2026-01"], [300, 250, 50]);
  assert.deepEqual(by["2026-02"], [90, 100, -10]);
  assert.deepEqual(by["2026-03"], [440, 500, -60]);
  assert.deepEqual(by["2026-04"], [null, 400, -400]);
});

test("a funnel counts distinct people at each step, in the order given", async () => {
  const built = funnelSql("events", "step", ["visit", "signup", "paid"], "user_id");
  assert.equal(built.shape, "series");
  const out = await run(built.sql);
  assert.deepEqual(out.rows.map((r) => [r[0], Number(r[1])]), [["visit", 4], ["signup", 3], ["paid", 1]]);
  // As a card, drawn as a funnel.
  const res = await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Sign-up funnel", form: "funnel", theme: "blue", source: { kind: "table_query", workbookId, sql: built.sql, shape: "series" } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
});

test("retention groups people by their first month and counts them in each month after", async () => {
  const built = cohortSql("orders", "customer_id", "ordered_at", "month");
  const out = await run(built.sql);
  assert.deepEqual(out.columns, ["Cohort", "Period", "Distinct customer_id"]);
  const cell = (cohort, period) => Number(out.rows.find((r) => r[0] === cohort && r[1] === period)?.[2] ?? 0);
  // January: c1 and c2 start. c1 comes back in February, c2 in March.
  assert.equal(cell("2026-01", "month 00"), 2);
  assert.equal(cell("2026-01", "month 01"), 1);
  assert.equal(cell("2026-01", "month 02"), 1);
  // February: c3 starts and returns in March. March: c4 starts.
  assert.equal(cell("2026-02", "month 00"), 1);
  assert.equal(cell("2026-02", "month 01"), 1);
  assert.equal(cell("2026-03", "month 00"), 1);
  const res = await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Retention", form: "heatmap", theme: "blue", source: { kind: "table_query", workbookId, sql: built.sql, shape: "table" } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
});

test("a table people type into takes entries only once the owner approves it, and records who made each", async () => {
  // A card listing accounts, and columns beside it for who is on each and where it stands.
  const card = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Accounts", form: "table", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT "customer_id", "region" FROM "customers" ORDER BY 1', shape: "table" } }))).widget;
  const ed = await person("Ed");
  let { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ed.email, role: "editor" }));
  await ed.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);
  const vi = await person("Vi");
  ({ share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: vi.email, role: "viewer" })));
  await vi.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);

  const columns = [{ name: "Owner", kind: "text" }, { name: "Status", kind: "choice", options: ["Open", "At risk", "Renewed"] }, { name: "Due", kind: "date" }, { name: "Value", kind: "number" }];
  assert.equal((await vi.api("POST", `/api/v1/dashboards/${boardId}/inputs`, { name: "Renewals", columns })).status, 403);
  assert.equal((await ed.api("POST", `/api/v1/dashboards/${boardId}/inputs`, { name: "Renewals", columns, widgetId: card.id, keyColumn: "nope" })).status, 400);
  let res = await ed.api("POST", `/api/v1/dashboards/${boardId}/inputs`, { name: "Renewals", columns, widgetId: card.id, keyColumn: "customer_id" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const table = (await res.json()).table;
  assert.equal(table.status, "draft");

  // Not published: no entries, and a viewer does not see it at all.
  assert.equal((await ed.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Status: "Open" } })).status, 409);
  assert.equal((await json(await vi.api("GET", `/api/v1/dashboards/${boardId}/inputs`))).tables.length, 0);
  // The editor asks; only the owner approves, and is told who would be able to type.
  assert.equal((await ed.api("POST", `/api/v1/inputs/${table.id}/approve`)).status, 403);
  assert.equal((await ed.api("POST", `/api/v1/inputs/${table.id}/submit`)).status, 200);
  const told = (await json(await stack.api("GET", "/api/v1/notifications"))).notifications[0];
  assert.match(told.title, /asks to publish a table people can type into/);
  assert.match(told.body, /people can open that report/);
  assert.equal((await stack.api("POST", `/api/v1/inputs/${table.id}/approve`)).status, 200);

  // Entries are checked against their column.
  assert.equal((await vi.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Status: "Maybe" } })).status, 400);
  assert.equal((await vi.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Due: "next week" } })).status, 400);
  assert.equal((await vi.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Value: "lots" } })).status, 400);
  assert.equal((await vi.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Nope: "x" } })).status, 400);
  res = await vi.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Owner: "Vi", Status: "At risk", Due: "2026-12-01", Value: "1,200" } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  // The same row, updated by someone else: one entry, the last hand recorded.
  assert.equal((await ed.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: { Status: "Renewed" } })).status, 200);
  const seen = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/inputs`))).tables[0];
  assert.equal(seen.rows.length, 1);
  assert.deepEqual(seen.rows[0].values, { Owner: "Vi", Status: "Renewed", Due: "2026-12-01", Value: 1200 });
  assert.equal(seen.rows[0].by, "Ed");
  await new Promise((r) => setTimeout(r, 200));
  const log = await json(await stack.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  assert.ok(log.events.filter((e) => e.kind === "input.saved").length >= 2);
  assert.ok(log.events.some((e) => e.kind === "input.approved"));

  // Taken back to a draft: no more entries. A stranger sees nothing.
  assert.equal((await stack.api("POST", `/api/v1/inputs/${table.id}/withdraw`)).status, 200);
  assert.equal((await vi.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c2", values: { Status: "Open" } })).status, 409);
  const stranger = await person("Zed");
  assert.equal((await stranger.api("GET", `/api/v1/dashboards/${boardId}/inputs`)).status, 404);
  assert.equal((await stranger.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "c1", values: {} })).status, 404);
});

test("free entries belong to whoever made them, and someone who sees part of the report sees only their own", async () => {
  const columns = [{ name: "Note", kind: "text" }];
  const table = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/inputs`, { name: "Notes", columns }))).table;
  assert.equal((await stack.api("POST", `/api/v1/inputs/${table.id}/approve`)).status, 200);
  const al = await person("Al");
  let { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: al.email, role: "viewer", limits: [{ field: "region", values: ["North"] }] }));
  await al.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);
  const bea = await person("Bea");
  ({ share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: bea.email, role: "viewer" })));
  await bea.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);

  const mine = (await json(await bea.api("PUT", `/api/v1/inputs/${table.id}/rows`, { values: { Note: "Bea's note" } }))).row;
  assert.equal((await al.api("PUT", `/api/v1/inputs/${table.id}/rows`, { values: { Note: "Al's note" } })).status, 200);
  // Al, who sees only North, gets only his own entry; Bea sees both.
  const als = (await json(await al.api("GET", `/api/v1/dashboards/${boardId}/inputs`))).tables.find((t) => t.id === table.id);
  assert.deepEqual(als.rows.map((r) => r.values.Note), ["Al's note"]);
  const beas = (await json(await bea.api("GET", `/api/v1/dashboards/${boardId}/inputs`))).tables.find((t) => t.id === table.id);
  assert.equal(beas.rows.length, 2);
  // Neither can change the other's.
  assert.equal((await al.api("PUT", `/api/v1/inputs/${table.id}/rows`, { id: mine.id, values: { Note: "changed" } })).status, 403);
  assert.equal((await al.api("DELETE", `/api/v1/inputs/${table.id}/rows/${mine.id}`)).status, 404);
  assert.equal((await bea.api("DELETE", `/api/v1/inputs/${table.id}/rows/${mine.id}`)).status, 204);
});
