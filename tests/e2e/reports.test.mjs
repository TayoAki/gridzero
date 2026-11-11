// Reports: which chart form fits which data, and where cards sit on the grid.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, boardId;

const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const table = (columns, rows) => ({ kind: "table", columns, rows });
const series = (pairs) => ({ kind: "series", points: pairs.map(([label, value]) => ({ label, value })) });
const lastResult = () => fake.requests.at(-1).body.messages.at(-1).content.find((b) => b.type === "tool_result");

/** Ask the agent to propose a widget. Gives the proposal id, or the reason it was refused. */
async function propose(title, form, data) {
  fake.script.push(call("propose_widget", { title, designs: [{ form, theme: "blue" }], data, source: { kind: "snapshot", prompt: "sample" } }), { text: "Here.", stop: "end_turn" });
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: `widget ${title}` });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  const line = lines.find((l) => l.type === "widget_proposal");
  return { proposalId: line?.proposalId ?? null, refused: lastResult()?.is_error ? lastResult().content : null };
}
async function add(title, form, data) {
  const { proposalId, refused } = await propose(title, form, data);
  assert.ok(proposalId, refused);
  return (await (await stack.api("POST", `/api/v1/widget-proposals/${proposalId}/accept`, { dashboardId: boardId, design: 0 })).json()).widget;
}
const widgets = async () => (await (await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).json()).widgets;

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8971, wbhostPort: 8972, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" })).json()).agent.id;
  boardId = (await (await stack.api("GET", "/api/v1/dashboards")).json()).dashboards[0].id;
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("a chart form is accepted when the data has the columns it needs, and refused with the reason when it does not", async () => {
  const good = [
    ["gauge", { kind: "number", value: 8.9, unit: "%", delta: null, label: "Refund rate" }],
    ["radar", series([["Revenue", 82], ["Orders", 74], ["Repeat rate", 48]])],
    ["histogram", series([["0-25", 410], ["25-50", 1320], ["50+", 760]])],
    ["combo", table(["Source", "Revenue", "Return"], [["Ads", 100, 5.2], ["Email", 90, 41.3]])],
    ["scatter", table(["Spend", "Revenue"], [[10, 100], [20, 150]])],
    ["bubble", table(["Source", "Spend", "Revenue", "Orders"], [["Ads", 10, 100, 5], ["Email", 2, 90, 4]])],
    ["sunburst", table(["Store", "Source", "Revenue"], [["US", "Ads", 10], ["US", "Email", 8], ["CA", "Ads", 4]])],
    ["sankey", table(["From", "To", "Visitors"], [["Ads", "Cart", 10], ["Cart", "Paid", 4]])],
    ["boxplot", table(["Source", "Low", "Q1", "Mid", "Q3", "High"], [["Ads", 1, 2, 3, 4, 5]])],
    ["stacked", table(["Source", "Paid", "Refunded"], [["Ads", 10, 1], ["Email", 9, 2]])],
    ["heatmap", table(["Source", "Country", "Revenue"], [["Ads", "US", 10], ["Ads", "GB", 4]])],
  ];
  for (const [form, data] of good) {
    const { proposalId, refused } = await propose(`Good ${form}`, form, data);
    assert.ok(proposalId, `${form}: ${refused}`);
  }

  const bad = [
    ["scatter", table(["Source", "Revenue"], [["Ads", 1], ["Email", 2]]), /two number columns/],
    ["bubble", table(["Spend", "Revenue"], [[1, 2]]), /three number columns/],
    ["combo", table(["Source", "Revenue"], [["Ads", 1]]), /a label column and two number columns/],
    ["sankey", table(["From", "Visitors"], [["Ads", 1]]), /two label columns and a number column/],
    ["sunburst", table(["A", "B"], [[1, 2]]), /two label columns/],
    ["boxplot", table(["Source", "A", "B"], [["Ads", 1, 2]]), /five number columns/],
    ["heatmap", table(["Source", "Revenue"], [["Ads", 1]]), /two label columns and a number column, or one label column and two or more/],
    ["gauge", series([["a", 1], ["b", 2]]), /cannot show series data/],
    ["radar", table(["A", "B"], [["x", 1]]), /cannot show table data/],
  ];
  for (const [form, data, why] of bad) {
    const { proposalId, refused } = await propose(`Bad ${form}`, form, data);
    assert.equal(proposalId, null, form);
    assert.match(refused, why, form);
  }

  // The agent is told what each form is for, so it can choose.
  const tool = fake.requests.at(-1).body.tools.find((t) => t.name === "propose_widget");
  assert.equal(tool.input_schema.properties.designs.items.properties.form.enum.length, 23);
  for (const hint of [/gauge \(one figure against a scale/, /sankey \(flow from one set of things to another/, /Choose the form from the question/, /a form is refused when the data lacks the columns it needs/]) assert.match(tool.description, hint);
});

test("changing a card's form is held to the same rule", async () => {
  const w = await add("Revenue by source", "bars", series([["Ads", 10], ["Email", 9], ["Organic", 4]]));
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${w.id}`, { form: "donut" })).status, 200);
  const res = await stack.api("PATCH", `/api/v1/widgets/${w.id}`, { form: "scatter" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cannot show series data/);

  const t = await add("Spend and revenue", "table", table(["Source", "Spend", "Revenue"], [["Ads", 10, 100], ["Email", 2, 90]]));
  for (const form of ["scatter", "combo", "stacked", "heatmap"]) assert.equal((await stack.api("PATCH", `/api/v1/widgets/${t.id}`, { form })).status, 200, form);
  const no = await stack.api("PATCH", `/api/v1/widgets/${t.id}`, { form: "sankey" });
  assert.equal(no.status, 400);
  assert.match((await no.json()).error, /two label columns and a number column/);
});

test("cards keep the place and size they are given on the grid", async () => {
  let list = await widgets();
  assert.ok(list.length >= 2);
  // Nobody has moved anything yet.
  assert.ok(list.every((w) => w.layout === null));
  const [a, b] = list;

  let res = await stack.api("PUT", `/api/v1/dashboards/${boardId}/layout`, { items: [{ id: a.id, x: 6, y: 2, w: 6, h: 3 }, { id: b.id, x: 0, y: 0, w: 3, h: 1 }] });
  assert.equal(res.status, 200);
  list = (await res.json()).widgets;
  // Reading order follows the grid: b is now first.
  assert.deepEqual(list.slice(0, 2).map((w) => w.id), [b.id, a.id]);
  assert.deepEqual(list.find((w) => w.id === a.id).layout, { x: 6, y: 2, w: 6, h: 3 });
  // The drawing size follows too: a narrow card is small, a tall one large.
  assert.equal(list.find((w) => w.id === b.id).size, "s");
  assert.equal(list.find((w) => w.id === a.id).size, "l");
  assert.deepEqual((await widgets()).find((w) => w.id === a.id).layout, { x: 6, y: 2, w: 6, h: 3 });

  // Moving one card leaves the others where they were.
  res = await stack.api("PUT", `/api/v1/dashboards/${boardId}/layout`, { items: [{ id: b.id, x: 3, y: 0, w: 4, h: 1 }] });
  assert.equal(res.status, 200);
  list = await widgets();
  assert.deepEqual(list.find((w) => w.id === b.id).layout, { x: 3, y: 0, w: 4, h: 1 });
  assert.equal(list.find((w) => w.id === b.id).size, "m");
  assert.deepEqual(list.find((w) => w.id === a.id).layout, { x: 6, y: 2, w: 6, h: 3 });

  for (const items of [
    [{ id: a.id, x: 8, y: 0, w: 6, h: 1 }], // past the twelfth column
    [{ id: a.id, x: 0, y: 0, w: 0, h: 1 }], // no width
    [{ id: a.id, x: 0, y: 0, w: 6, h: 1 }, { id: a.id, x: 6, y: 0, w: 6, h: 1 }], // the same card twice
    [{ id: "not-a-widget", x: 0, y: 0, w: 6, h: 1 }],
    [],
  ]) {
    assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/layout`, { items })).status, 400, JSON.stringify(items));
  }
  assert.deepEqual((await widgets()).find((w) => w.id === a.id).layout, { x: 6, y: 2, w: 6, h: 3 });
});

test("someone else cannot move the cards on your report", async () => {
  const other = new Stack({ controlPort: 8971, wbhostPort: 8972 });
  other.base = stack.base;
  assert.equal((await other.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password: "correct-horse-9" })).status, 200);
  const [a] = await widgets();
  assert.equal((await other.api("PUT", `/api/v1/dashboards/${boardId}/layout`, { items: [{ id: a.id, x: 0, y: 0, w: 6, h: 1 }] })).status, 404);
});

test("a slicer is a card a person adds; the agent cannot propose one", async () => {
  let res = await stack.api("POST", `/api/v1/dashboards/${boardId}/slicers`, { field: "Source", style: "buttons" });
  assert.equal(res.status, 201);
  const slicer = (await res.json()).widget;
  assert.equal(slicer.form, "slicer");
  assert.equal(slicer.title, "Source");
  assert.equal(slicer.agentId, null);
  assert.deepEqual(slicer.data, { kind: "slicer", field: "Source", style: "buttons" });
  assert.ok((await widgets()).some((w) => w.id === slicer.id));

  // It can be drawn another way, and placed on the grid like any card.
  res = await stack.api("PATCH", `/api/v1/widgets/${slicer.id}`, { style: "list" });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).widget.data, { kind: "slicer", field: "Source", style: "list" });
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/layout`, { items: [{ id: slicer.id, x: 0, y: 0, w: 3, h: 2 }] })).status, 200);

  // Only a slicer has a style, and a slicer cannot become a chart or a chart a slicer.
  const [chart] = (await widgets()).filter((w) => w.form !== "slicer");
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${chart.id}`, { style: "list" })).status, 400);
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${chart.id}`, { form: "slicer" })).status, 400);
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${slicer.id}`, { form: "bars" })).status, 400);
  for (const body of [{ field: "", style: "list" }, { field: "Source", style: "wheel" }, { field: "Source" }]) {
    assert.equal((await stack.api("POST", `/api/v1/dashboards/${boardId}/slicers`, body)).status, 400, JSON.stringify(body));
  }

  // The agent is not offered the form, and is refused if it tries.
  const { proposalId, refused } = await propose("Agent slicer", "slicer", { kind: "slicer", field: "Source", style: "list" });
  assert.equal(proposalId, null);
  assert.ok(refused);
  const tool = fake.requests.at(-1).body.tools.find((t) => t.name === "propose_widget");
  assert.ok(!tool.input_schema.properties.designs.items.properties.form.enum.includes("slicer"));

  assert.equal((await stack.api("DELETE", `/api/v1/widgets/${slicer.id}`)).status, 204);
});

test("someone else cannot add a slicer to your report", async () => {
  const other = new Stack({ controlPort: 8971, wbhostPort: 8972 });
  other.base = stack.base;
  assert.equal((await other.api("POST", "/api/auth/sign-up/email", { name: "Other2", email: `other2-${Date.now()}@example.com`, password: "correct-horse-9" })).status, 200);
  assert.equal((await other.api("POST", `/api/v1/dashboards/${boardId}/slicers`, { field: "Source", style: "list" })).status, 404);
});
