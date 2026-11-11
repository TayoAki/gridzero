// Agents, phase 5 (docs/AGENT-BUILD-SPEC.md §9.5): schedules that only read.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack, root, waitFor } from "./harness.mjs";

const postgres = createRequire(join(root, "services", "control", "package.json"))("postgres");
const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/postgres");
const table = `s_orders_${Date.now()}`;
const env = { CONNECTION_SECRET_KEY: "e2e-connection-key", CONNECTOR_ALLOW_PRIVATE: "1", SCHEDULE_TICK_MS: "1000" };

let fake;
let stack;
let sql;
let mine;
let agentId;
let boardId;
let second;

const past = () => new Date(Date.now() - 60_000);
const getSchedule = async (id) => (await sql`select * from schedule where id = ${id}`)[0];

/** A metric widget on the user's first dashboard. */
async function metricWidget() {
  const conn = await (
    await stack.api("POST", "/api/v1/connections", {
      kind: "postgres",
      name: `sched-${Date.now()}-${Math.random()}`,
      config: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) || "postgres", user: decodeURIComponent(url.username || "postgres"), ssl: "disable" },
      secret: decodeURIComponent(url.password) || "unused",
    })
  ).json();
  const yaml = `name: s_${Date.now()}_${Math.floor(Math.random() * 1e6)}\ndatasets:\n  - name: o\n    source: ${table}\n    fields: []\nmetrics:\n  - name: n\n    expression: { dialects: [{ dialect: ANSI_SQL, expression: COUNT(*) }] }\n`;
  const modelId = (await (await stack.api("POST", "/api/v1/metrics", { connectionId: conn.id, yaml })).json()).model.id;
  const [{ owner_id }] = await sql`select owner_id from dashboard where id = ${boardId}`;
  const proposalId = `p${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const payload = { title: "Orders", designs: [{ form: "number", theme: "blue" }], data: { kind: "number", value: 0, unit: null, delta: null, label: null }, source: { kind: "metric", modelId, query: { metric: "n", group_by: [], filters: [], order: "desc", limit: 1 }, shape: "number" } };
  await sql`insert into widget_proposal (id, owner_id, agent_id, payload) values (${proposalId}, ${owner_id}, ${agentId}, ${sql.json(payload)})`;
  return (await (await stack.api("POST", `/api/v1/widget-proposals/${proposalId}/accept`, { dashboardId: boardId, design: 0 })).json()).widget;
}

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create table ${table}(id int)`);
  await sql.unsafe(`insert into ${table} values (1), (2), (3)`);
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 19447, wbhostPort: 19448, controlEnv: { ANTHROPIC_BASE_URL: fake.url, ...env } });
  await stack.start();
  mine = stack.cookie;
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Night owl", avatar: "owl", color: "purple", instructions: "" })).json()).agent.id;
  boardId = (await (await stack.api("GET", "/api/v1/dashboards")).json()).dashboards[0].id;
});

after(async () => {
  second?.kill();
  await sql?.unsafe(`drop table if exists ${table}`);
  await sql?.end();
  stack?.stop();
  await fake?.close();
});

test("schedule routes validate their input", async () => {
  const w = await metricWidget();
  assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "widget_refresh", widgetId: w.id, cron: "nope", label: "x" })).status, 400);
  assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "widget_refresh", widgetId: "missing", cron: "0 8 * * *", label: "x" })).status, 404);
  assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "task", agentId, cron: "0 8 * * *", label: "x", prompt: "" })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "widget_refresh", widgetId: w.id, cron: "0 8 * * *", label: `x${i}` })).status, 201);
  assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "widget_refresh", widgetId: w.id, cron: "0 9 * * *", label: "third" })).status, 400, "two per widget");
  const { schedules } = await (await stack.api("GET", "/api/v1/schedules")).json();
  const s = schedules[0];
  assert.ok(new Date(s.nextRunAt) > new Date());
  let res = await stack.api("PATCH", `/api/v1/schedules/${s.id}`, { paused: true, label: "Paused one" });
  assert.equal((await res.json()).schedule.paused, true);
  for (const x of schedules) assert.equal((await stack.api("DELETE", `/api/v1/schedules/${x.id}`)).status, 204);
});

test("a due widget schedule runs within 30 seconds and moves forward", async () => {
  const w = await metricWidget();
  const res = await stack.api("POST", "/api/v1/schedules", { kind: "widget_refresh", widgetId: w.id, cron: "0 8 * * *", label: "Every day at 08:00 (your time)" });
  const { schedule } = await res.json();
  await sql`update schedule set next_run_at = ${past()} where id = ${schedule.id}`;
  await waitFor(async () => (await getSchedule(schedule.id)).last_status !== null, "the schedule to run", 30_000);
  const row = await getSchedule(schedule.id);
  assert.equal(row.last_status, "ok", row.last_error);
  assert.ok(row.next_run_at > new Date(), "next run is in the future");
  const { widgets } = await (await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).json();
  assert.equal(widgets.find((x) => x.id === w.id).data.value, 3);
  await stack.api("DELETE", `/api/v1/schedules/${schedule.id}`);
});

test("a task schedule gets only read-only tools and posts its answer in the chat", async () => {
  const { schedule } = await (await stack.api("POST", "/api/v1/schedules", { kind: "task", agentId, prompt: "Summarize the night.", cron: "0 6 * * *", label: "Every day at 06:00 (your time)" })).json();
  const seen = fake.requests.length;
  fake.script.push({ text: "All quiet.", stop: "end_turn" });
  await sql`update schedule set next_run_at = ${past()} where id = ${schedule.id}`;
  await waitFor(async () => (await getSchedule(schedule.id)).last_status !== null, "the task to run", 30_000);
  assert.equal((await getSchedule(schedule.id)).last_status, "ok");

  const req = fake.requests[seen];
  const names = req.body.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_app", "find_app_actions", "list_connections", "list_definitions", "list_metrics", "list_workbooks", "query_definition", "query_metric", "read_sheet", "run_sql", "web_fetch", "web_search"]);
  assert.equal(req.body.output_config.effort, "medium");

  const { messages } = await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json();
  assert.equal(messages.at(-1).role, "assistant");
  assert.equal(messages.at(-1).visible, "Scheduled: Every day at 06:00 (your time)\n\nAll quiet.");
  assert.ok(!messages.some((m) => m.role === "user" && /Summarize the night/.test(m.visible ?? "")), "the request itself stays hidden");

  // The next chat replays it as ordinary alternating history.
  fake.script.push({ text: "Yes.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Anything else?" });
  const roles = fake.requests.at(-1).body.messages.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], "roles alternate");
  await stack.api("DELETE", `/api/v1/schedules/${schedule.id}`);
});

test("two control processes run a due schedule once", async () => {
  second = spawn(process.execPath, ["src/server.ts"], {
    cwd: join(root, "services", "control"),
    env: { ...process.env, ...env, PORT: "19449", BETTER_AUTH_SECRET: "e2e-auth-secret-0123456789abcdef0123", BETTER_AUTH_URL: "http://localhost:19449", WB_TOKEN_SECRET: stack.secret, WBHOST_PUBLIC_URL: `ws://localhost:${stack.wbhostPort}`, WEB_DIST: "", ANTHROPIC_BASE_URL: fake.url },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(() => fetch("http://localhost:19449/api/v1/health").then((r) => r.ok), "second control process");
  const { schedule } = await (await stack.api("POST", "/api/v1/schedules", { kind: "task", agentId, prompt: "Count once.", cron: "0 5 * * *", label: "once" })).json();
  const seen = fake.requests.length;
  const startedAt = new Date();
  fake.script.push({ text: "One.", stop: "end_turn" }, { text: "Two.", stop: "end_turn" });
  await sql`update schedule set next_run_at = ${past()} where id = ${schedule.id}`;
  await waitFor(async () => (await getSchedule(schedule.id)).last_status !== null, "the task to run", 30_000);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(fake.requests.length - seen, 1, JSON.stringify(fake.requests.slice(seen).map((r) => r.body.messages.map((m) => JSON.stringify(m.content).slice(0, 80)))));
  const runs = await sql`select count(*)::int as n from agent_run where agent_id = ${agentId} and kind = 'scheduled' and started_at >= ${startedAt}`;
  assert.equal(runs[0].n, 1);
  fake.script.length = 0;
  await stack.api("DELETE", `/api/v1/schedules/${schedule.id}`);
});

test("an owner without a key gets an error and the model is not called", async () => {
  assert.equal((await stack.api("DELETE", "/api/v1/ai-key")).status, 204);
  const { schedule } = await (await stack.api("POST", "/api/v1/schedules", { kind: "task", agentId, prompt: "Anything?", cron: "0 4 * * *", label: "nokey" })).json();
  const seen = fake.requests.length;
  await sql`update schedule set next_run_at = ${past()} where id = ${schedule.id}`;
  await waitFor(async () => (await getSchedule(schedule.id)).last_status !== null, "the task to run", 30_000);
  const row = await getSchedule(schedule.id);
  assert.equal(row.last_status, "error");
  assert.equal(row.last_error, "Add your own AI key in Settings to use agents.");
  assert.equal(fake.requests.length, seen);
});

test("isolation: another user's schedules are 404", async () => {
  const { schedules } = await (await stack.api("GET", "/api/v1/schedules")).json();
  const id = schedules[0].id;
  stack.cookie = "";
  await stack.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-s-${Date.now()}@example.com`, password: "correct-horse-9" });
  assert.equal((await stack.api("PATCH", `/api/v1/schedules/${id}`, { paused: true })).status, 404);
  assert.equal((await stack.api("DELETE", `/api/v1/schedules/${id}`)).status, 404);
  assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "task", agentId, prompt: "x", cron: "0 4 * * *", label: "x" })).status, 404);
  assert.deepEqual((await (await stack.api("GET", "/api/v1/schedules")).json()).schedules, []);
  stack.cookie = mine;
});
