// A report as it stood on a date, on demand and on a schedule; and a release of definitions with its test results.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId, total;
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const csvOf = (n) => ["order_id,status,amount", ...Array.from({ length: n }, (_, i) => `${i + 1},${(i + 1) % 5 ? "paid" : "cancelled"},${i + 1}`)].join("\n") + "\n";
const say = async (script) => {
  fake.script.push(...script);
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "go" }).then((r) => r.text());
};
async function person(name) {
  const p = new Stack({ controlPort: 8968, wbhostPort: 8969 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8968, wbhostPort: 8969, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", SCHEDULE_TICK_MS: "400" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await say([call("write_table", { workbook_id: workbookId, name: "orders", csv: csvOf(20) }), { text: "Imported.", stop: "end_turn" }]);
  total = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Revenue", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT SUM("amount") FROM "orders"', shape: "number" } }))).widget;
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("a snapshot keeps the report as it stood, and sets each figure beside what it is now", async () => {
  assert.equal(total.data.value, 210);
  let res = await stack.api("POST", `/api/v1/dashboards/${boardId}/snapshots`, { label: "Week 45" });
  assert.equal(res.status, 201);
  const snap = (await res.json()).snapshot;

  // The data grows: 30 orders now total 465.
  await say([call("write_table", { workbook_id: workbookId, name: "orders", csv: csvOf(30) }), { text: "Imported.", stop: "end_turn" }]);
  const tables = (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/tables`))).tables;
  const now = (await json(await stack.api("POST", `/api/v1/widgets/${total.id}/refresh`))).widget.data.value;

  const then = await json(await stack.api("GET", `/api/v1/snapshots/${snap.id}`));
  assert.equal(then.label, "Week 45");
  assert.equal(then.cards.length, 1);
  assert.equal(then.cards[0].data.value, 210);
  assert.deepEqual(then.figures.map((f) => [f.title, f.then, f.now, f.change]), [["Revenue", 210, now, now - 210]]);
  const list = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/snapshots`))).snapshots;
  assert.equal(list[0].label, "Week 45");
  assert.equal(list[0].by, "E2E");
  const log = await json(await stack.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  assert.ok(log.events.some((e) => e.kind === "snapshot.taken"));
  assert.ok(log.events.some((e) => e.kind === "snapshot.opened"));
});

test("someone held to certain rows cannot open a snapshot; a viewer can read one but not take one", async () => {
  const snapId = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/snapshots`))).snapshots[0].id;
  const ana = await person("Ana");
  let { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ana.email, role: "viewer", limits: [{ field: "status", values: ["paid"] }] }));
  await ana.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);
  assert.equal((await ana.api("GET", `/api/v1/snapshots/${snapId}`)).status, 404);
  assert.equal((await ana.api("GET", `/api/v1/dashboards/${boardId}/snapshots`)).status, 404);
  const bo = await person("Bo");
  ({ share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: bo.email, role: "viewer" })));
  await bo.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);
  assert.equal((await bo.api("GET", `/api/v1/snapshots/${snapId}`)).status, 200);
  assert.equal((await bo.api("POST", `/api/v1/dashboards/${boardId}/snapshots`, {})).status, 403);
  assert.equal((await bo.api("DELETE", `/api/v1/snapshots/${snapId}`)).status, 404);
});

test("a snapshot can be taken on a schedule, with the cards worked out again first", async () => {
  const before = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/snapshots`))).snapshots.length;
  const res = await stack.api("POST", "/api/v1/schedules", { kind: "report_snapshot", dashboardId: boardId, cron: "0 7 * * 1", label: "Every Monday" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const id = (await res.json()).schedule.id;
  assert.equal((await stack.api("POST", `/api/v1/schedules/${id}/run`)).status, 200);
  await wait(600);
  const list = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/snapshots`))).snapshots;
  assert.equal(list.length, before + 1);
  assert.equal(list[0].by, "a schedule");
  assert.equal(list[0].label, "Every Monday");
  await stack.api("DELETE", `/api/v1/schedules/${id}`);
});

test("a release records the definitions, what changed since the last one, and the tests it went out with", async () => {
  // Looking at the tables drafts definitions for the workbook.
  await say([call("list_tables", { workbook_id: workbookId }), { text: "Looked.", stop: "end_turn" }]);
  const spaces = (await json(await stack.api("GET", "/api/v1/workspaces"))).workspaces;
  const sources = (await json(await stack.api("GET", `/api/v1/workspaces/${spaces[0].id}/sources`))).sources;
  const sourceId = sources[0].id;

  let res = await stack.api("POST", `/api/v1/sources/${sourceId}/releases`, { label: "2026.11" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  let rel = (await res.json()).release;
  assert.equal(rel.results.passed, true);
  assert.ok(rel.results.definitions.length > 0);
  assert.ok(rel.results.changed.every((x) => x.what === "first release"));

  // A check that fails blocks the next release unless it is released knowingly.
  const check = (await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "No cancelled orders", sql: 'SELECT * FROM "orders" WHERE "status" = \'cancelled\'' }))).check;
  assert.equal(check.status, "failing");
  res = await stack.api("POST", `/api/v1/sources/${sourceId}/releases`, { label: "2026.12" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /No cancelled orders/);
  res = await stack.api("POST", `/api/v1/sources/${sourceId}/releases`, { label: "2026.12", notes: "Known: cancelled orders still present", evenIfFailing: true });
  assert.equal(res.status, 201);
  rel = (await res.json()).release;
  assert.equal(rel.results.passed, false);
  assert.deepEqual(rel.results.tests.checks.failing, ["No cancelled orders"]);
  assert.equal(rel.results.changed.length, 0);

  const list = (await json(await stack.api("GET", `/api/v1/sources/${sourceId}/releases`))).releases;
  assert.deepEqual(list.map((r) => r.label), ["2026.12", "2026.11"]);
  const cy = await person("Cy");
  assert.equal((await cy.api("GET", `/api/v1/sources/${sourceId}/releases`)).status, 404);
  assert.equal((await cy.api("POST", `/api/v1/sources/${sourceId}/releases`, { label: "x" })).status, 404);
});
