// Live cards: a card made by hand from a workbook table, and report filters that run its query again
// over the rows underneath, so a total follows a filter.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId;

// 300 orders over 300 days from 1 January 2026. amount = order number, so all orders sum to 45,150.
// Odd order numbers are Ads (sum 22,500), even ones Email (sum 22,650). Every tenth is cancelled.
const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const csv = ["order_id,status,source,amount,ordered_at", ...Array.from({ length: 300 }, (_, i) => `${i + 1},${(i + 1) % 10 === 0 ? "cancelled" : "paid"},${i % 2 ? "Email" : "Ads"},${i + 1},${day(i)}`)].join("\n") + "\n";

const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = async (res) => res.json();
const query = (sql, shape) => ({ kind: "table_query", workbookId, sql, shape });
const add = async (title, form, source) => {
  const res = await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title, form, theme: "blue", source });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await res.json()).widget;
};
const view = async (id, filters, compare = false) => json(await stack.api("POST", `/api/v1/widgets/${id}/view`, { filters, compare }));

let total, bySource, snapshot;

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8973, wbhostPort: 8974, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" })).json()).agent.id;
  workbookId = (await (await stack.api("POST", "/api/v1/workbooks")).json()).id;
  boardId = (await (await stack.api("GET", "/api/v1/dashboards")).json()).dashboards[0].id;
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "orders", csv }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import my orders" }).then((r) => r.text());
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("a workbook's tables and columns are listed for making a card by hand", async () => {
  const { tables } = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/tables`));
  assert.equal(tables.length, 1);
  assert.equal(tables[0].table, "orders");
  assert.equal(tables[0].rows, 300);
  assert.deepEqual(tables[0].columns.map((c) => [c.name, c.kind]), [["order_id", "number"], ["status", "text"], ["source", "text"], ["amount", "number"], ["ordered_at", "date"]]);
  assert.deepEqual(tables[0].columns[2].values, ["Ads", "Email"]);
  assert.deepEqual([tables[0].columns[4].min, tables[0].columns[4].max], ["2026-01-01", "2026-10-27"]);
});

test("a card is made from a table without an agent, previewed first, and held to the form rule", async () => {
  const source = query('SELECT "source", SUM("amount") AS "amount" FROM "orders" GROUP BY 1 ORDER BY 2 DESC', "series");
  const preview = await stack.api("POST", "/api/v1/widgets/preview", { title: "Revenue by source", form: "bars", theme: "blue", source });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).data, { kind: "series", points: [{ label: "Email", value: 22650 }, { label: "Ads", value: 22500 }] });

  bySource = await add("Revenue by source", "bars", source);
  assert.equal(bySource.agentId, null);
  assert.equal(bySource.source.kind, "table_query");
  total = await add("Revenue", "number", query('SELECT SUM("amount") FROM "orders"', "number"));
  assert.equal(total.data.value, 45150);
  // It refreshes like any live card.
  assert.equal((await stack.api("POST", `/api/v1/widgets/${total.id}/refresh`)).status, 200);

  for (const [body, why] of [
    [{ title: "x", form: "scatter", theme: "blue", source }, /cannot show series data/],
    [{ title: "x", form: "bars", theme: "blue", source: query('DELETE FROM "orders"', "series") }, /./],
    [{ title: "x", form: "bars", theme: "blue", source: query('SELECT "nope" FROM "orders"', "series") }, /no longer runs/],
    [{ title: "x", form: "bars", theme: "blue", source: { kind: "snapshot", prompt: "x" } }, /reads a workbook table/],
    [{ title: "x", form: "slicer", theme: "blue", source }, /form/],
  ]) {
    const res = await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, why);
  }
});

test("a filter runs the card's query again over fewer rows, so a total follows it", async () => {
  // Nothing chosen: the card as stored.
  assert.equal((await view(total.id, [])).data.value, 45150);

  let v = await view(total.id, [{ field: "source", values: ["Ads"] }]);
  assert.equal(v.live, true);
  assert.equal(v.data.value, 22500);
  assert.deepEqual(v.applied, ["source"]);

  // Field names match whatever their case; a field the table lacks reaches nothing.
  v = await view(total.id, [{ field: "Source", values: ["Email"] }, { field: "Country", values: ["US"] }]);
  assert.equal(v.data.value, 22650);
  assert.deepEqual(v.applied, ["Source"]);

  // A number range and a date range, together. Orders 1 to 31 are January; 1 to 20 sum to 210.
  v = await view(total.id, [{ field: "ordered_at", from: "2026-01-01", to: "2026-02-01" }, { field: "amount", range: [1, 20] }]);
  assert.equal(v.data.value, 210);
  assert.deepEqual(v.applied.sort(), ["amount", "ordered_at"]);

  // A split card loses the bars the filter leaves out, down to one or none.
  v = await view(bySource.id, [{ field: "status", values: ["cancelled"] }]);
  assert.deepEqual(v.data.points.map((p) => p.label).sort(), ["Email"]);
  v = await view(bySource.id, [{ field: "status", values: ["refunded"] }]);
  assert.equal(v.data, null);

  // Nothing is saved by looking.
  const stored = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.find((w) => w.id === total.id);
  assert.equal(stored.data.value, 45150);

  // A value cannot carry SQL: it is bound, so it simply matches nothing.
  v = await view(total.id, [{ field: "source", values: ["Ads' OR 1=1 --"] }]);
  assert.equal(v.data, null);
  for (const filters of [[{ field: "source" }], [{ field: "source", values: [] }], [{ field: "ordered_at", from: "January" }], [{ field: "source", values: ["a"], range: [1, 2] }]]) {
    assert.equal((await stack.api("POST", `/api/v1/widgets/${total.id}/view`, { filters })).status, 400, JSON.stringify(filters));
  }
});

test("a date range can be compared with the period just before it", async () => {
  // February 2026: orders 32 to 59, sum 1,274. The 28 days before: orders 4 to 31, sum 490.
  const v = await view(total.id, [{ field: "ordered_at", from: "2026-02-01", to: "2026-03-01" }], true);
  assert.equal(v.data.value, 1274);
  assert.equal(v.previous.value, 490);
  // Without a date range there is nothing to compare with.
  assert.equal((await view(total.id, [{ field: "source", values: ["Ads"] }], true)).previous, null);
});

test("a snapshot card says it cannot follow a filter, and keeps its data", async () => {
  fake.script.push(call("propose_widget", { title: "A note", designs: [{ form: "bars", theme: "blue" }], data: { kind: "series", points: [{ label: "Ads", value: 1 }, { label: "Email", value: 2 }] }, source: { kind: "snapshot", prompt: "sample" } }), { text: "Here.", stop: "end_turn" });
  const lines = (await (await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "widget" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  const proposalId = lines.find((l) => l.type === "widget_proposal").proposalId;
  snapshot = (await json(await stack.api("POST", `/api/v1/widget-proposals/${proposalId}/accept`, { dashboardId: boardId, design: 0 }))).widget;
  const v = await view(snapshot.id, [{ field: "source", values: ["Ads"] }]);
  assert.equal(v.live, false);
  assert.deepEqual(v.applied, []);
  assert.equal(v.data.points.length, 2);
});

test("a report lists what it can be filtered by and which cards follow", async () => {
  const { fields, cards } = await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/fields`));
  assert.deepEqual(fields.map((f) => [f.name, f.kind]), [["order_id", "number"], ["status", "text"], ["source", "text"], ["amount", "number"], ["ordered_at", "date"]]);
  assert.deepEqual(fields.find((f) => f.name === "status").values, ["cancelled", "paid"]);
  assert.deepEqual([fields.find((f) => f.name === "amount").min, fields.find((f) => f.name === "amount").max], [1, 300]);
  assert.equal(cards[total.id].live, true);
  assert.deepEqual(cards[bySource.id].columns, ["source", "amount"]);
  assert.ok(cards[bySource.id].fields.includes("ordered_at"));
  assert.equal(cards[snapshot.id].live, false);
});

test("the rows behind a card can be read, with the filters applied", async () => {
  const res = await stack.api("POST", `/api/v1/widgets/${bySource.id}/rows`, { filters: [{ field: "source", values: ["Ads"] }, { field: "amount", range: [1, 9] }] });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.table, "orders");
  assert.deepEqual(out.columns, ["order_id", "status", "source", "amount", "ordered_at"]);
  assert.deepEqual(out.rows.map((r) => r[0]), ["1", "3", "5", "7", "9"]);
  // The count and the totals are for every matching row, to check the card against.
  assert.equal(out.count, 5);
  assert.deepEqual(out.totals.find((t) => t.column === "amount"), { column: "amount", total: 25 });
  const all = await (await stack.api("POST", `/api/v1/widgets/${bySource.id}/rows`, { filters: [] })).json();
  assert.equal(all.truncated, true);
  assert.equal(all.rows.length, 200);
  assert.equal(all.count, 300);
  assert.equal(all.totals.find((t) => t.column === "amount").total, 45150);
  assert.equal((await stack.api("POST", `/api/v1/widgets/${snapshot.id}/rows`, { filters: [] })).status, 400);
});

test("someone else can neither look through your cards nor add to your report", async () => {
  const other = new Stack({ controlPort: 8973, wbhostPort: 8974 });
  other.base = stack.base;
  assert.equal((await other.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password: "correct-horse-9" })).status, 200);
  assert.equal((await other.api("POST", `/api/v1/widgets/${total.id}/view`, { filters: [] })).status, 404);
  assert.equal((await other.api("POST", `/api/v1/widgets/${bySource.id}/rows`, { filters: [] })).status, 404);
  assert.equal((await other.api("GET", `/api/v1/dashboards/${boardId}/fields`)).status, 404);
  assert.equal((await other.api("GET", `/api/v1/workbooks/${workbookId}/tables`)).status, 404);
  assert.equal((await other.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "x", form: "number", theme: "blue", source: query('SELECT 1', "number") })).status, 404);
  // Their own report cannot read your workbook either.
  const theirs = (await json(await other.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  assert.equal((await other.api("POST", `/api/v1/dashboards/${theirs}/widgets`, { title: "x", form: "number", theme: "blue", source: query('SELECT SUM("amount") FROM "orders"', "number") })).status, 404);
});
