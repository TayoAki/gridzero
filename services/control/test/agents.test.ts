// Agent pieces that need no database (agent spec §5.8, unit tests 1-5).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.CONNECTION_SECRET_KEY ??= "test-only-key";
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.BETTER_AUTH_SECRET ??= "test-only-secret-0123456789abcdef0123";
process.env.WB_TOKEN_SECRET ??= "test-only-0123456789";

const { costMicroUsd, systemPrompt } = await import("../src/agents/model.ts");
const { trimHistory } = await import("../src/agents/run.ts");
const { toolLabel } = await import("../src/agents/tools.ts");
const { AVATARS, COLORS } = await import("../src/agents/catalog.ts");

test("cost is counted in millionths of a dollar", () => {
  assert.equal(costMicroUsd({ input_tokens: 1_000_000, output_tokens: 0 }), 4_000_000);
  assert.equal(costMicroUsd({ output_tokens: 1000 }), 20_000);
  assert.equal(costMicroUsd({ cache_read_input_tokens: 1_000_000 }), 200_000);
  assert.equal(costMicroUsd({ server_tool_use: { web_search_requests: 3 } }), 30_000);
});

test("history starts at a plain user message and stays under the size limit", () => {
  const user = (t: string) => ({ role: "user" as const, content: [{ type: "text", text: t }] });
  const assistant = (t: string) => ({ role: "assistant" as const, content: [{ type: "text", text: t }] });
  const toolResult = { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] };

  assert.deepEqual(trimHistory([assistant("a"), user("u"), assistant("b")]), [user("u"), assistant("b")]);
  assert.deepEqual(trimHistory([toolResult, assistant("a"), user("u")]), [user("u")]);

  const rows = [user("x".repeat(100)), assistant("y".repeat(100)), user("short"), assistant("ok")];
  const kept = trimHistory(rows, 100);
  assert.deepEqual(kept, [user("short"), assistant("ok")]);
  assert.ok(kept.reduce((n, r) => n + JSON.stringify(r.content).length, 0) <= 100);
});

test("system prompt names the agent and carries its instructions", () => {
  const now = new Date("2026-03-04T12:00:00Z");
  const empty = systemPrompt({ name: "Scout", instructions: "" }, now);
  assert.match(empty, /You are Scout,/);
  assert.match(empty, /Today is 2026-03-04 \(UTC\)/);
  assert.match(empty, /\(none\)/);
  const full = systemPrompt({ name: "Scout", instructions: "Track competitor prices." }, now);
  assert.match(full, /Track competitor prices\./);
  assert.doesNotMatch(full, /\(none\)/);
});

test("the web app declares the same avatars and colors, in order", () => {
  const web = readFileSync(new URL("../../../apps/web/src/agents/catalog.ts", import.meta.url), "utf8");
  for (const list of [AVATARS, COLORS]) {
    let at = -1;
    for (const value of list) {
      const next = web.indexOf(`"${value}"`, at + 1);
      assert.ok(next > at, `${value} appears in order in apps/web/src/agents/catalog.ts`);
      at = next;
    }
  }
});

test("tool labels", () => {
  assert.equal(toolLabel("web_search", { query: "x" }), "Searched: x");
  assert.equal(toolLabel("web_fetch", { url: "https://a.example/" }), "Read: https://a.example/");
  assert.equal(toolLabel("read_sheet", {}), "Used read_sheet");
});

test("A1 ranges", async () => {
  const { parseA1Range } = await import("../src/agents/host.ts");
  assert.deepEqual(parseA1Range("B2:D10"), { r0: 1, c0: 1, r1: 9, c1: 3 });
  assert.deepEqual(parseA1Range("A1"), { r0: 0, c0: 0, r1: 0, c1: 0 });
  assert.deepEqual(parseA1Range("aa3:b1"), { r0: 0, c0: 1, r1: 2, c1: 26 });
  for (const bad of ["Z0", "", "A1:A", "A1:B2:C3", "1A"]) assert.throws(() => parseA1Range(bad), bad);
});

test("sheet text to CSV", async () => {
  const { gridToCsv } = await import("../src/agents/workbook-tools.ts");
  const grid = new Map([["0,0", "region"], ["0,1", "units"], ["1,0", "North, East"], ["1,1", "10"], ["5,0", "later"]]);
  assert.deepEqual(gridToCsv(grid, 3, 32), { csv: 'region,units\n"North, East",10\n', truncated: true });
  assert.deepEqual(gridToCsv(grid, 10, 32).truncated, false);
});

test("Ossie metrics compile to SQL", async () => {
  const { compileQuery, parseModel } = await import("../src/metrics/compile.ts");
  const model = parseModel(readFileSync(new URL("./fixtures/m3_sales.ossie.yaml", import.meta.url), "utf8"));
  const q = (extra = {}) => ({ metric: "completed_amount", group_by: [], filters: [], order: "desc" as const, limit: 100, ...extra });

  assert.equal(compileQuery(model, "POSTGRES", q()), `SELECT (SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)) AS "completed_amount" FROM samples.sales.orders`);
  assert.equal(
    compileQuery(model, "POSTGRES", q({ group_by: ["status"], filters: [{ field: "amount", op: ">", value: 10 }], order: "desc", limit: 5 })),
    `SELECT (status) AS "status", (SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)) AS "completed_amount" FROM samples.sales.orders WHERE (amount) > 10 GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  );
  assert.match(compileQuery(model, "BIGQUERY", q({ group_by: ["status"] })), /AS `status`, .* AS `completed_amount`/);
  assert.match(compileQuery(model, "POSTGRES", q({ filters: [{ field: "status", op: "=", value: "O'Brien" }] })), /WHERE \(status\) = 'O''Brien'$/);
  assert.match(compileQuery(model, "POSTGRES", q({ filters: [{ field: "status", op: "in", value: ["a", "b"] }] })), /WHERE \(status\) IN \('a', 'b'\)$/);
  assert.throws(() => compileQuery(model, "POSTGRES", q({ filters: [{ field: "status", op: "=", value: { x: 1 } }] })), /Unsupported filter value\./);
  assert.throws(() => compileQuery(model, "POSTGRES", q({ metric: "nope" })), /Unknown metric nope\./);
  assert.throws(() => compileQuery(model, "POSTGRES", q({ group_by: ["nope"] })), /Unknown field nope\./);

  const two = parseModel(`name: two
datasets:
  - { name: a, source: t1, fields: [] }
  - { name: b, source: t2, fields: [] }
metrics:
  - { name: n, expression: { dialects: [{ dialect: ANSI_SQL, expression: "COUNT(*)" }] } }
`);
  assert.throws(() => compileQuery(two, "POSTGRES", { ...q(), metric: "n" }), /more than one dataset, which GridZero cannot query yet\./);
  assert.throws(() => parseModel("name: 1bad\ndatasets: []"), /Error: name: /);
  assert.throws(() => parseModel("a: [unclosed"), /Error: yaml: /);
});

test("the web and control widget specs are the same file", () => {
  const web = readFileSync(new URL("../../../apps/web/src/widgets/spec.ts", import.meta.url), "utf8");
  const control = readFileSync(new URL("../src/widgets/spec.ts", import.meta.url), "utf8");
  assert.equal(web, control);
});

test("widget proposals: forms must suit the data", async () => {
  const { FORMS, FORM_DATA, proposal } = await import("../src/widgets/spec.ts");
  const samples = {
    number: { kind: "number", value: 3, unit: null, delta: null, label: null },
    series: { kind: "series", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] },
    table: { kind: "table", columns: ["x"], rows: [[1]] },
    list: { kind: "list", items: [{ title: "t", detail: null, url: "https://example.com/" }] },
    text: { kind: "text", text: "hi" },
  } as const;
  const src = { kind: "snapshot", prompt: "again" };
  for (const form of FORMS) {
    for (const [kind, data] of Object.entries(samples)) {
      const ok = proposal.safeParse({ title: "W", designs: [{ form, theme: "blue" }], data, source: src }).success;
      assert.equal(ok, FORM_DATA[form] === kind, `${form} with ${kind}`);
    }
  }
  const bad = proposal.safeParse({ title: "W", designs: [{ form: "list", theme: "blue" }], data: { kind: "list", items: [{ title: "t", detail: null, url: "http://x" }] }, source: src });
  assert.equal(bad.success, false);
  const shape = proposal.safeParse({
    title: "W",
    designs: [{ form: "number", theme: "rose" }],
    data: samples.number,
    source: { kind: "sheet", workbookId: "w", sheet: 0, range: "A1:B2", shape: "table" },
  });
  assert.equal(shape.success, false, "the source shape must match the data");
});

test("query results to widget data", async () => {
  const { parseCsv, rowsToData } = await import("../src/widgets/refresh.ts");
  const rows = parseCsv('month,units\nJan,3\nFeb,"1,200"\nMar,x\n');
  assert.deepEqual(rows, [["month", "units"], ["Jan", "3"], ["Feb", "1,200"], ["Mar", "x"]]);
  assert.deepEqual(rowsToData(rows, "number"), { kind: "number", value: 3, unit: null, delta: null, label: null });
  assert.deepEqual(rowsToData(rows, "number", { kind: "number", value: 1, unit: "$", delta: null, label: "Sales" }), { kind: "number", value: 3, unit: "$", delta: 2, label: "Sales" });
  assert.deepEqual(rowsToData(rows, "series"), { kind: "series", points: [{ label: "Jan", value: 3 }, { label: "Feb", value: 1200 }] });
  assert.deepEqual(rowsToData(rows, "table"), { kind: "table", columns: ["month", "units"], rows: [["Jan", 3], ["Feb", 1200], ["Mar", "x"]] });
  // A single cell (an agent pointing a number widget at A2) has no header row.
  assert.deepEqual(rowsToData([["471757.4"]], "number"), { kind: "number", value: 471757.4, unit: null, delta: null, label: null });
  assert.throws(() => rowsToData([["a"], ["x"]], "number"), /did not return a number/);
  assert.throws(() => rowsToData([["a", "b"], ["x", "1"]], "series"), /fewer than 2/);
});

test("local schedule times to UTC cron", async () => {
  const { toUtcCron, describe } = await import("../../../apps/web/src/agents/schedule-time.ts");
  assert.equal(toUtcCron({ day: null, hour: 8, minute: 0 }, 300), "0 13 * * *", "08:00 at UTC-5");
  assert.equal(toUtcCron({ day: 1, hour: 23, minute: 30 }, -120), "30 21 * * 1", "Monday 23:30 at UTC+2");
  assert.equal(toUtcCron({ day: 1, hour: 1, minute: 0 }, -120), "0 23 * * 0", "the day moves back across midnight");
  assert.equal(toUtcCron({ day: 6, hour: 22, minute: 15 }, 300), "15 3 * * 0", "Saturday night at UTC-5 is Sunday in UTC");
  assert.equal(toUtcCron({ day: null, hour: 0, minute: 30 }, -330), "0 19 * * *", "half-hour zones");
  assert.equal(describe({ day: 3, hour: 7, minute: 5 }), "Every Wednesday at 07:05 (your time)");
});

test("which tools each kind of run gets", async () => {
  await import("../src/agents/workbook-tools.ts");
  await import("../src/metrics/routes.ts");
  await import("../src/widgets/routes.ts");
  await import("../src/apps/routes.ts");
  const { toolDefinitions } = await import("../src/agents/tools.ts");
  const names = (kind: "chat" | "scheduled" | "widget_refresh") => toolDefinitions({ kind, webOff: false }).map((t) => (t as { name: string }).name);
  const chat = names("chat");
  for (const t of ["run_app_action", "propose_widget", "write_table", "create_chart"]) assert.ok(chat.includes(t), t);
  assert.ok(!chat.includes("update_widget_data"));
  const scheduled = names("scheduled");
  for (const t of ["run_app_action", "propose_widget", "write_table", "create_chart", "update_widget_data"]) assert.ok(!scheduled.includes(t), t);
  assert.ok(names("widget_refresh").includes("update_widget_data"));
  assert.ok(!names("widget_refresh").includes("run_app_action"));
});

test("app actions that only read", async () => {
  const { isReadOnly } = await import("../src/apps/provider.ts");
  for (const n of ["GMAIL_FETCH_EMAILS", "SLACK_LIST_CHANNELS", "GITHUB_GET_REPO", "NOTION_SEARCH", "READ_FILE"]) assert.equal(isReadOnly(n), true, n);
  for (const n of ["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE", "GITHUB_CREATE_ISSUE", "JIRA_GET_AND_UPDATE_ISSUE", "GMAIL_MOVE_TO_TRASH", "LINEAR_ISSUE"]) assert.equal(isReadOnly(n), false, n);
});

test("agent SQL must only read", async () => {
  const { readOnlySqlProblem } = await import("../src/agents/workbook-tools.ts");
  for (const ok of ["select 1 as x", "SELECT * FROM t;", "with a as (select 1) select * from a", "  -- note\nselect 'drop table x' as s", "show tables", "explain select 1", 'select "update" from t']) {
    assert.equal(readOnlySqlProblem(ok), null, ok);
  }
  for (const bad of ["delete from t", "select 1; drop table t", "with x as (delete from t returning *) select * from x", "update t set a = 1", "copy t to stdout", "", "call proc()", "select 1 /* ; */ ; insert into t values (1)"]) {
    assert.notEqual(readOnlySqlProblem(bad), null, bad);
  }
});

test("schedules run at most hourly", async () => {
  const { cronProblem } = await import("../src/schedules.ts");
  const from = new Date("2026-03-04T12:00:00Z");
  assert.equal(cronProblem("0 8 * * *", from), null);
  assert.equal(cronProblem("30 21 * * 1", from), null);
  assert.equal(cronProblem("0 * * * *", from), null, "hourly is allowed");
  assert.match(cronProblem("* * * * *", from)!, /at most once an hour/);
  assert.match(cronProblem("*/10 * * * *", from)!, /at most once an hour/);
  assert.match(cronProblem("0,30 9 * * *", from)!, /at most once an hour/);
  assert.match(cronProblem("nope", from)!, /5-field/);
});
