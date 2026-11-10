// Agents, phase 2 (docs/AGENT-BUILD-SPEC.md §6.3): workbook and warehouse tools, against
// the fake Anthropic server.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake;
let stack;
let agentId;
let mine;

const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/postgres");

async function chat(text) {
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The tool_result blocks the model received in the last request. */
function toolResults(req = fake.requests.at(-1)) {
  return req.body.messages.at(-1).content.filter((b) => b.type === "tool_result");
}

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({
    controlPort: 19417,
    wbhostPort: 19418,
    controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", CONNECTOR_ALLOW_PRIVATE: "1" },
  });
  await stack.start();
  mine = stack.cookie;
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  const res = await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" });
  agentId = (await res.json()).agent.id;
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("read_sheet returns CSV and turns off the web tools for the rest of the run", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: "region\tunits\nNorth\t10" });
  await s.close();

  const start = fake.requests.length;
  fake.script.push(
    { tools: [{ id: "tu_1", name: "list_workbooks", input: {} }], stop: "tool_use" },
    { tools: [{ id: "tu_2", name: "read_sheet", input: { workbook_id: id, sheet: null, max_rows: null } }], stop: "tool_use" },
    { text: "North sold 10.", stop: "end_turn" },
  );
  const lines = await chat("How many units did North sell?");
  assert.equal(lines.at(-1).type, "done", JSON.stringify(lines));
  const reqs = fake.requests.slice(start);
  assert.equal(reqs.length, 3);

  const listed = JSON.parse(toolResults(reqs[1])[0].content);
  assert.ok(listed.workbooks.some((w) => w.id === id && w.role === "owner"));
  assert.ok(reqs[1].body.tools.some((t) => t.type === "web_search_20260209"), "web tools stay on after list_workbooks");

  const read = toolResults(reqs[2])[0];
  assert.notEqual(read.is_error, true);
  const out = JSON.parse(read.content);
  assert.match(out.csv, /region,units/);
  assert.match(out.csv, /North,10/);
  assert.equal(out.truncated, false);
  assert.equal(out._title, undefined, "private label fields are not sent to the model");
  assert.ok(!reqs[2].body.tools.some((t) => String(t.type).startsWith("web_")), "no web tools after reading a sheet");

  const toolLines = lines.filter((l) => l.type === "tool" && l.status === "done").map((l) => l.summary);
  assert.ok(toolLines.some((t) => /^Read Untitled Workbook \/ /.test(t)), toolLines.join(" | "));
});

test("read_sheet on another user's workbook is an error", async () => {
  stack.cookie = "";
  await stack.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password: "correct-horse-9" });
  const theirs = await stack.newWorkbook();
  stack.cookie = mine;

  fake.script.push({ tools: [{ id: "tu_x", name: "read_sheet", input: { workbook_id: theirs, sheet: 0, max_rows: 5 } }], stop: "tool_use" }, { text: "I cannot.", stop: "end_turn" });
  await chat("Read that one");
  const [result] = toolResults();
  assert.equal(result.is_error, true);
  assert.equal(result.content, "Workbook not found.");
});

test("run_sql queries a saved connection", async () => {
  const res = await stack.api("POST", "/api/v1/connections", {
    kind: "postgres",
    name: `agent-${Date.now()}`,
    config: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) || "postgres", user: decodeURIComponent(url.username || "postgres"), ssl: "disable" },
    secret: decodeURIComponent(url.password) || "unused",
  });
  assert.equal(res.status, 201);
  const conn = (await res.json()).id;

  fake.script.push({ tools: [{ id: "tu_sql", name: "run_sql", input: { connection_id: conn, sql: "select 1 as x", max_rows: null } }], stop: "tool_use" }, { text: "One.", stop: "end_turn" });
  await chat("Run it");
  const [result] = toolResults();
  assert.notEqual(result.is_error, true, result.content);
  assert.equal(JSON.parse(result.content).csv.trim(), "x\n1");

  fake.script.push({ tools: [{ id: "tu_sql2", name: "run_sql", input: { connection_id: "nope", sql: "select 1", max_rows: 1 } }], stop: "tool_use" }, { text: "No.", stop: "end_turn" });
  await chat("Run another");
  assert.equal(toolResults()[0].content, "Connection not found.");
});

test("write_table makes a Data Table and create_chart a chart", async () => {
  const id = await stack.newWorkbook();
  fake.script.push(
    { tools: [{ id: "tu_w", name: "write_table", input: { workbook_id: id, name: "Sales", csv: "month,units\nJan,3\nFeb,5\nMar,4\n" } }], stop: "tool_use" },
    { tools: [{ id: "tu_c", name: "create_chart", input: { workbook_id: id, sheet: 1, range: "A1:B4", kind: "Column", title: "Units" } }], stop: "tool_use" },
    { text: "Done.", stop: "end_turn" },
  );
  const lines = await chat("Make a table and chart");
  assert.equal(lines.at(-1).type, "done", JSON.stringify(lines));
  const reqs = fake.requests.slice(-3);
  const wrote = JSON.parse(toolResults(reqs[1])[0].content);
  assert.equal(wrote.rows, 3);
  assert.equal(wrote.sheet, 1);
  const chart = toolResults(reqs[2])[0];
  assert.notEqual(chart.is_error, true, chart.content);
  const { chart_id } = JSON.parse(chart.content);

  const s = await stack.open(id);
  const meta = (await s.send({ type: "GetSheetMeta", sheet: 1 })).meta;
  await s.close();
  assert.equal(meta.tables.length, 1);
  assert.equal(meta.tables[0].total_rows, 3);
  const made = meta.charts.find((c) => c.id === chart_id);
  assert.ok(made, "the chart is on the sheet");
  assert.equal(made.series.length, 1);
  assert.equal(made.series[0].name, "units");
});

test("the host refuses actions agents may not send", async () => {
  const id = await stack.newWorkbook();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ wb: id, sub: "control", role: "owner", admin: true, exp: Math.floor(Date.now() / 1000) + 60 })}`;
  const token = `${unsigned}.${createHmac("sha256", stack.secret).update(unsigned).digest("base64url")}`;
  const res = await fetch(`http://localhost:${stack.wbhostPort}/wb/${id}/agent?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "x" }),
  });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "action not allowed");
});
