// Agents, phase 4 (docs/AGENT-BUILD-SPEC.md §8.7): dashboards, widget proposals and refresh.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack, root } from "./harness.mjs";

const postgres = createRequire(join(root, "services", "control", "package.json"))("postgres");
const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/postgres");
const table = `w_orders_${Date.now()}`;

let fake;
let stack;
let sql;
let mine;
let agentId;
let modelId;
let boardId;
let metricWidget;

async function chat(text) {
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text });
  assert.equal(res.status, 200);
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const metricSource = () => ({ kind: "metric", modelId, query: { metric: "total", group_by: [], filters: [], order: "desc", limit: 10 }, shape: "number" });

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create table ${table}(amount numeric)`);
  await sql.unsafe(`insert into ${table} values (10), (20)`);
  fake = await startFakeAnthropic();
  stack = new Stack({
    controlPort: 19437,
    wbhostPort: 19438,
    controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", CONNECTOR_ALLOW_PRIVATE: "1" },
  });
  await stack.start();
  mine = stack.cookie;
  const conn = await (
    await stack.api("POST", "/api/v1/connections", {
      kind: "postgres",
      name: `widgets-${Date.now()}`,
      config: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) || "postgres", user: decodeURIComponent(url.username || "postgres"), ssl: "disable" },
      secret: decodeURIComponent(url.password) || "unused",
    })
  ).json();
  const yaml = `name: w_${Date.now()}\ndatasets:\n  - name: o\n    source: ${table}\n    fields:\n      - name: amount\n        expression: { dialects: [{ dialect: ANSI_SQL, expression: amount }] }\nmetrics:\n  - name: total\n    expression: { dialects: [{ dialect: ANSI_SQL, expression: SUM(amount) }] }\n`;
  modelId = (await (await stack.api("POST", "/api/v1/metrics", { connectionId: conn.id, yaml })).json()).model.id;
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Builder", avatar: "bear", color: "orange", instructions: "" })).json()).agent.id;
  const { dashboards } = await (await stack.api("GET", "/api/v1/dashboards")).json();
  assert.deepEqual(dashboards.map((d) => d.name), ["My dashboard"], "a first dashboard is made for you");
  boardId = dashboards[0].id;
});

after(async () => {
  await sql?.unsafe(`drop table if exists ${table}`);
  await sql?.end();
  stack?.stop();
  await fake?.close();
});

test("an agent proposes a widget and the user adds it once", async () => {
  fake.script.push(
    {
      tools: [
        {
          id: "tu_p",
          name: "propose_widget",
          input: {
            title: "Total sales",
            designs: [{ form: "number", theme: "green" }, { form: "number", theme: "slate" }],
            data: { kind: "number", value: 30, unit: "$", delta: null, label: "All orders" },
            source: metricSource(),
          },
        },
      ],
      stop: "tool_use",
    },
    { text: "Pick a design above.", stop: "end_turn" },
  );
  const lines = await chat("Make me a total sales widget");
  const line = lines.find((l) => l.type === "widget_proposal");
  assert.ok(line, JSON.stringify(lines));
  assert.ok(fake.requests.at(-2).body.tools.some((t) => t.name === "propose_widget"));
  assert.ok(!fake.requests.at(-2).body.tools.some((t) => t.name === "update_widget_data"), "refresh-only tool is not offered in chat");

  const { messages } = await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json();
  assert.ok(messages.some((m) => m.role === "assistant" && m.proposals.includes(line.proposalId)), "the proposal card survives a reload");
  const got = await (await stack.api("GET", `/api/v1/widget-proposals/${line.proposalId}`)).json();
  assert.equal(got.payload.title, "Total sales");
  assert.equal(got.acceptedWidgetId, null);

  let res = await stack.api("POST", `/api/v1/widget-proposals/${line.proposalId}/accept`, { dashboardId: boardId, design: 1 });
  assert.equal(res.status, 201);
  metricWidget = (await res.json()).widget;
  assert.equal(metricWidget.size, "m");
  assert.equal(metricWidget.theme, "slate");
  assert.equal(metricWidget.position, 0);
  res = await stack.api("POST", `/api/v1/widget-proposals/${line.proposalId}/accept`, { dashboardId: boardId, design: 0 });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Already added.");
});

test("a proposal with someone else's source is refused", async () => {
  fake.script.push(
    { tools: [{ id: "tu_bad", name: "propose_widget", input: { title: "X", designs: [{ form: "number", theme: "blue" }], data: { kind: "number", value: 1, unit: null, delta: null, label: null }, source: { ...metricSource(), modelId: "nope" } } }], stop: "tool_use" },
    { text: "Sorry.", stop: "end_turn" },
  );
  await chat("Try a bad one");
  const [result] = fake.requests.at(-1).body.messages.at(-1).content;
  assert.equal(result.is_error, true);
  assert.equal(result.content, "Metric model not found.");
});

test("a metric widget refreshes from the warehouse without the model", async () => {
  await sql.unsafe(`insert into ${table} values (5)`);
  const seen = fake.requests.length;
  const res = await stack.api("POST", `/api/v1/widgets/${metricWidget.id}/refresh`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.widget.data, { kind: "number", value: 35, unit: "$", delta: 5, label: "All orders" });
  assert.equal(fake.requests.length, seen, "no request reached the model");
  assert.ok(new Date(body.widget.refreshedAt) > new Date(metricWidget.refreshedAt));
});

async function snapshotWidget() {
  fake.script.push(
    { tools: [{ id: `tu_s${Date.now()}`, name: "propose_widget", input: { title: "Headlines", designs: [{ form: "list", theme: "rose" }], data: { kind: "list", items: [{ title: "Old news", detail: null, url: null }] }, source: { kind: "snapshot", prompt: "Find today's top headline." } } }], stop: "tool_use" },
    { text: "Here.", stop: "end_turn" },
  );
  const proposalId = (await chat("Headlines widget")).find((l) => l.type === "widget_proposal").proposalId;
  return (await (await stack.api("POST", `/api/v1/widget-proposals/${proposalId}/accept`, { dashboardId: boardId, design: 0 })).json()).widget;
}

test("a snapshot widget refreshes by running its agent", async () => {
  const w = await snapshotWidget();
  const messagesBefore = (await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json()).messages.length;
  fake.script.push(
    { tools: [{ id: "tu_u", name: "update_widget_data", input: { widget_id: w.id, data: { kind: "list", items: [{ title: "New news", detail: "today", url: "https://example.com/n" }] } } }], stop: "tool_use" },
    { text: "Updated.", stop: "end_turn" },
  );
  let res = await stack.api("POST", `/api/v1/widgets/${w.id}/refresh`);
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.widget.data.items[0].title, "New news");
  const req = fake.requests.at(-2).body;
  assert.match(req.messages[0].content[0].text, /Find today's top headline\.\n\nUpdate the widget "Headlines" by calling update_widget_data\./);
  assert.ok(req.tools.some((t) => t.name === "update_widget_data"));
  assert.ok(!req.tools.some((t) => t.name === "write_table" || t.name === "propose_widget"), "refresh runs only get read tools");
  const messagesAfter = (await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json()).messages.length;
  assert.equal(messagesAfter, messagesBefore, "refresh runs are not stored in the chat");

  fake.script.push({ text: "Nothing new.", stop: "end_turn" });
  res = await stack.api("POST", `/api/v1/widgets/${w.id}/refresh`);
  body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error, "The agent did not return new data.");
  const { widgets } = await (await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).json();
  assert.equal(widgets.find((x) => x.id === w.id).data.items[0].title, "New news", "unchanged");
});

test("edit, reorder and delete widgets", async () => {
  let { widgets } = await (await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).json();
  assert.ok(widgets.length >= 2);
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${metricWidget.id}`, { size: "l", title: "Sales" })).status, 200);
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${metricWidget.id}`, { form: "trend" })).status, 400, "forms stay compatible");
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${metricWidget.id}`, { size: "xl" })).status, 400);

  const ids = widgets.map((w) => w.id);
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/order`, { widgetIds: ids.slice(1) })).status, 400, "a missing id is refused");
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/order`, { widgetIds: [...ids].reverse() })).status, 204);
  ({ widgets } = await (await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).json());
  assert.deepEqual(widgets.map((w) => w.id), [...ids].reverse());
  assert.equal(widgets.find((w) => w.id === metricWidget.id).size, "l");

  const made = await (await stack.api("POST", "/api/v1/dashboards", { name: "Second" })).json();
  assert.equal((await stack.api("PATCH", `/api/v1/dashboards/${made.dashboard.id}`, { name: "Renamed" })).status, 200);
  assert.equal((await stack.api("DELETE", `/api/v1/dashboards/${made.dashboard.id}`)).status, 204);
  assert.equal((await stack.api("DELETE", `/api/v1/widgets/${ids[0]}`)).status, 204);
});

test("isolation: another user's dashboards, widgets and proposals are 404", async () => {
  fake.script.push(
    { tools: [{ id: "tu_iso", name: "propose_widget", input: { title: "Mine", designs: [{ form: "text", theme: "blue" }], data: { kind: "text", text: "hi" }, source: { kind: "snapshot", prompt: "p" } } }], stop: "tool_use" },
    { text: ".", stop: "end_turn" },
  );
  const proposalId = (await chat("one more")).find((l) => l.type === "widget_proposal").proposalId;

  stack.cookie = "";
  await stack.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-w-${Date.now()}@example.com`, password: "correct-horse-9" });
  const theirBoard = (await (await stack.api("GET", "/api/v1/dashboards")).json()).dashboards[0].id;
  const checks = [
    ["GET", `/api/v1/dashboards/${boardId}/widgets`],
    ["PATCH", `/api/v1/dashboards/${boardId}`, { name: "x" }],
    ["DELETE", `/api/v1/dashboards/${boardId}`],
    ["PUT", `/api/v1/dashboards/${boardId}/order`, { widgetIds: [] }],
    ["PATCH", `/api/v1/widgets/${metricWidget.id}`, { title: "x" }],
    ["POST", `/api/v1/widgets/${metricWidget.id}/refresh`],
    ["DELETE", `/api/v1/widgets/${metricWidget.id}`],
    ["GET", `/api/v1/widget-proposals/${proposalId}`],
    ["POST", `/api/v1/widget-proposals/${proposalId}/accept`, { dashboardId: theirBoard, design: 0 }],
  ];
  for (const [method, path, body] of checks) assert.equal((await stack.api(method, path, body)).status, 404, `${method} ${path}`);
  stack.cookie = mine;
});

test("a sheet widget refreshes from the workbook range", async () => {
  const wb = await stack.newWorkbook();
  const s = await stack.open(wb);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "month\tunits\nJan\t3\nFeb\t5" });
  fake.script.push(
    { tools: [{ id: "tu_sh", name: "propose_widget", input: { title: "Units", designs: [{ form: "bars", theme: "purple" }], data: { kind: "series", points: [{ label: "Jan", value: 3 }, { label: "Feb", value: 5 }] }, source: { kind: "sheet", workbookId: wb, sheet: 0, range: "A1:B3", shape: "series" } } }], stop: "tool_use" },
    { text: ".", stop: "end_turn" },
  );
  const proposalId = (await chat("units chart")).find((l) => l.type === "widget_proposal").proposalId;
  const w = (await (await stack.api("POST", `/api/v1/widget-proposals/${proposalId}/accept`, { dashboardId: boardId, design: 0 })).json()).widget;
  await s.send({ type: "UpdateCell", sheet: 0, row: 2, col: 1, raw: "=4*2" });
  await s.close();
  const res = await stack.api("POST", `/api/v1/widgets/${w.id}/refresh`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.widget.data.points, [{ label: "Jan", value: 3 }, { label: "Feb", value: 8 }]);
});
