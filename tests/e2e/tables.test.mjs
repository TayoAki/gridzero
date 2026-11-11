// Agents over uploaded tables: list_tables profiles a workbook's Data Tables and drafts definitions
// and questions for them; query_tables runs SQL over every row; widgets rerun a query or a definition.
// Needs python3 with sqlglot and duckdb for the engine.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId, listed;

// 300 orders, more than an agent can read from a sheet. Every tenth is cancelled.
// amount = order number, so all orders sum to 45,150 and the 270 paid ones to 40,500.
const csv = ["order_id,status,source,amount", ...Array.from({ length: 300 }, (_, i) => `${i + 1},${(i + 1) % 10 === 0 ? "cancelled" : "paid"},${i % 2 ? "Email" : "Ads"},${i + 1}`)].join("\n") + "\n";

async function chat(text) {
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return { lines, text: lines.filter((l) => l.type === "text").map((l) => l.delta).join("") };
}
const lastResults = () => fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8981, wbhostPort: 8982, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" })).json()).agent.id;
  workbookId = (await (await stack.api("POST", "/api/v1/workbooks")).json()).id;
  boardId = (await (await stack.api("GET", "/api/v1/dashboards")).json()).dashboards[0].id;
  // Put the file in the workbook as a Data Table, the way an import does.
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "orders", csv }), { text: "Imported.", stop: "end_turn" });
  await chat("Import my orders");
  assert.equal(lastResults()[0].is_error, undefined, lastResults()[0].content);
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("list_tables profiles every row and drafts definitions and questions with numbers, with no setup", async () => {
  assert.deepEqual((await (await stack.api("GET", "/api/v1/workspaces")).json()).workspaces, []);
  fake.script.push(call("list_tables", { workbook_id: workbookId }), { text: "Here is what I found.", stop: "end_turn" });
  await chat("What is in my orders?");
  const result = lastResults()[0];
  assert.equal(result.is_error, undefined, result.content);
  listed = JSON.parse(result.content);

  const [table] = listed.tables;
  assert.equal(table.name, "orders");
  assert.equal(table.rows, 300);
  assert.deepEqual(table.one_row_per, ["order_id"]);
  const status = table.columns.find((c) => c.name === "status");
  assert.deepEqual(status.common_values, ["paid (270)", "cancelled (30)"]);

  // A total was drafted from the amount column, and the cancelled orders became a question with both numbers.
  const total = listed.definitions.find((d) => d.kind === "metric" && d.expression === "SUM(orders.amount)");
  assert.equal(total.status, "inferred");
  const q = listed.open_questions.find((x) => /status/i.test(x.topic));
  assert.match(q.question, /30 of 300 are cancelled/);
  assert.ok(q.choices.some((c) => /40,500/.test(c)));
  assert.ok(q.choices.some((c) => /45,150/.test(c)));
  assert.match(listed.review_page, /^\/definitions\/[0-9a-f]+$/);

  // A person with no workspace got one of their own, holding the workbook as a source.
  const { workspaces } = await (await stack.api("GET", "/api/v1/workspaces")).json();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].role, "admin");
  const { sources } = await (await stack.api("GET", `/api/v1/workspaces/${workspaces[0].id}/sources`)).json();
  assert.equal(sources[0].kind, "workbook");

  // Asking again does not scan again or make a second source.
  fake.script.push(call("list_tables", { workbook_id: workbookId }), { text: "Same.", stop: "end_turn" });
  await chat("Again?");
  assert.equal(JSON.parse(lastResults()[0].content).definitions.length, listed.definitions.length);
  assert.equal((await (await stack.api("GET", `/api/v1/workspaces/${workspaces[0].id}/sources`)).json()).sources.length, 1);
});

test("query_tables totals all 300 rows, only reads, and its answers are labelled", async () => {
  fake.script.push(
    call("query_tables", { workbook_id: workbookId, sql: "select source, sum(amount) as revenue, count(*) as orders from orders where status = 'paid' group by 1 order by 1", max_rows: null }),
    { text: "Ads brought in 22,500.", stop: "end_turn" },
  );
  const out = await chat("Revenue by source?");
  const result = JSON.parse(lastResults()[0].content);
  assert.equal(result.csv, "source,revenue,orders\nAds,22500,150\nEmail,18000,120\n");
  assert.match(out.text, /Unconfirmed: no shared definition exists for this, so I wrote a query\./);

  for (const sql of ["delete from orders", "select * from read_csv('/etc/passwd')", "select 1; select 2", "copy orders to '/tmp/x.csv'"]) {
    fake.script.push(call("query_tables", { workbook_id: workbookId, sql, max_rows: null }), { text: "No.", stop: "end_turn" });
    await chat("try");
    assert.equal(lastResults()[0].is_error, true, sql);
  }
  // A wrong column comes back as the database's own message, so the agent can fix its query.
  fake.script.push(call("query_tables", { workbook_id: workbookId, sql: "select sum(total) from orders", max_rows: null }), { text: "Oops.", stop: "end_turn" });
  await chat("try");
  assert.match(lastResults()[0].content, /total/);
});

test("answering the question and confirming turns the draft into a confirmed number", async () => {
  const sourceId = listed.review_page.split("/").pop();
  let review = await (await stack.api("GET", `/api/v1/sources/${sourceId}/review`)).json();
  const q = review.questions.find((x) => x.kind === "excluded_rows");
  assert.equal((await stack.api("POST", `/api/v1/questions/${q.id}/answer`, { option: 0 })).status, 200);
  const total = review.definitions.find((d) => d.kind === "metric" && d.body.expression === "SUM(orders.amount)");

  fake.script.push(call("list_definitions", {}), call("query_definition", { definition_id: total.id, group_by: [], limit: null }), { text: "40,500.", stop: "end_turn" });
  let out = await chat("Total amount?");
  assert.match(JSON.parse(lastResults()[0].content).csv, /40500/);
  assert.match(out.text, /Unconfirmed: this uses a definition nobody has confirmed yet\./);

  const confirmed = await (await stack.api("POST", `/api/v1/definitions/${total.id}/confirm`)).json();
  assert.equal(Number(confirmed.definition.checkNumber.value), 40500);
  fake.script.push(call("list_definitions", {}), call("query_definition", { definition_id: total.id, group_by: [], limit: null }), { text: "40,500, confirmed.", stop: "end_turn" });
  out = await chat("Total amount?");
  assert.doesNotMatch(out.text, /Unconfirmed/);
  listed.totalId = total.id;
});

test("widgets rerun the query or the definition, so they follow the data", async () => {
  const propose = async (title, data, source) => {
    fake.script.push(call("propose_widget", { title, designs: [{ form: data.kind === "number" ? "number" : "bars", theme: "blue" }], data, source }), { text: "Here.", stop: "end_turn" });
    const { lines } = await chat(`Widget: ${title}`);
    const line = lines.find((l) => l.type === "widget_proposal");
    assert.ok(line, lastResults()[0]?.content);
    return (await (await stack.api("POST", `/api/v1/widget-proposals/${line.proposalId}/accept`, { dashboardId: boardId, design: 0 })).json()).widget;
  };
  const number = (value) => ({ kind: "number", value, unit: null, delta: null, label: null });

  // Stale numbers on purpose: the refresh must replace them with what the data says.
  const byQuery = await propose("Paid revenue", number(1), { kind: "table_query", workbookId, sql: "select sum(amount) as revenue from orders where status = 'paid'", shape: "number" });
  let res = await stack.api("POST", `/api/v1/widgets/${byQuery.id}/refresh`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).widget.data.value, 40500);

  const bySource = await propose("Revenue by source", { kind: "series", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, { kind: "table_query", workbookId, sql: "select source, sum(amount) from orders group by 1 order by 1", shape: "series" });
  res = await stack.api("POST", `/api/v1/widgets/${bySource.id}/refresh`);
  assert.deepEqual((await res.json()).widget.data.points, [{ label: "Ads", value: 22500 }, { label: "Email", value: 22650 }]);

  const byDefinition = await propose("Total amount", number(1), { kind: "definition", definitionId: listed.totalId, groupBy: [], shape: "number" });
  res = await stack.api("POST", `/api/v1/widgets/${byDefinition.id}/refresh`);
  assert.equal((await res.json()).widget.data.value, 40500);

  // A widget may only read: a query that writes is refused when proposed.
  fake.script.push(call("propose_widget", { title: "Bad", designs: [{ form: "number", theme: "blue" }], data: number(1), source: { kind: "table_query", workbookId, sql: "drop table orders", shape: "number" } }), { text: "No.", stop: "end_turn" });
  await chat("Widget: bad");
  assert.equal(lastResults()[0].is_error, true);
});

test("someone who cannot open the workbook gets nothing from its tables", async () => {
  const other = new Stack({ controlPort: 8981, wbhostPort: 8982 });
  other.base = stack.base;
  assert.equal((await other.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password: "correct-horse-9" })).status, 200);
  await other.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  const theirs = (await (await other.api("POST", "/api/v1/agents", { name: "Spy", avatar: "fox", color: "gray", instructions: "" })).json()).agent.id;
  for (const [name, input] of [["list_tables", { workbook_id: workbookId }], ["query_tables", { workbook_id: workbookId, sql: "select * from orders", max_rows: null }]]) {
    fake.script.push(call(name, input), { text: "Nothing.", stop: "end_turn" });
    await other.api("POST", `/api/v1/agents/${theirs}/chat`, { text: "peek" }).then((r) => r.text());
    assert.equal(lastResults()[0].is_error, true, name);
    assert.match(lastResults()[0].content, /Workbook not found/);
  }
  const sourceId = listed.review_page.split("/").pop();
  assert.equal((await other.api("GET", `/api/v1/sources/${sourceId}/review`)).status, 404);
});
