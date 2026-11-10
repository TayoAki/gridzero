// Agents, phase 3 (docs/AGENT-BUILD-SPEC.md §7.7): Apache Ossie metric models.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack, root } from "./harness.mjs";

const postgres = createRequire(join(root, "services", "control", "package.json"))("postgres");
const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/postgres");
const table = `m_orders_${Date.now()}`;

let fake;
let stack;
let sql;
let conn;

const yaml = `# A model for the test table. Comments and key order are kept on export.
version: "0.3.0.dev0"
name: orders_${Date.now()}
datasets:
  - name: orders
    source: ${table}
    fields:
      - name: status
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: status
      - name: amount
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: amount
metrics:
  - name: completed_amount
    description: Money from completed orders
    expression:
      dialects:
        - dialect: ANSI_SQL
          expression: SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)
  - name: order_count
    expression:
      dialects:
        - dialect: POSTGRES
          expression: COUNT(*)
`;

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create table ${table}(status text, amount numeric)`);
  await sql.unsafe(`insert into ${table} values ('completed', 10), ('completed', 15.5), ('cancelled', 99)`);
  fake = await startFakeAnthropic();
  stack = new Stack({
    controlPort: 19427,
    wbhostPort: 19428,
    controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", CONNECTOR_ALLOW_PRIVATE: "1" },
  });
  await stack.start();
  const res = await stack.api("POST", "/api/v1/connections", {
    kind: "postgres",
    name: `metrics-${Date.now()}`,
    config: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) || "postgres", user: decodeURIComponent(url.username || "postgres"), ssl: "disable" },
    secret: decodeURIComponent(url.password) || "unused",
  });
  conn = (await res.json()).id;
});

after(async () => {
  await sql?.unsafe(`drop table if exists ${table}`);
  await sql?.end();
  stack?.stop();
  await fake?.close();
});

test("upload, query, export and delete a metric model", async () => {
  let res = await stack.api("POST", "/api/v1/metrics", { connectionId: conn, yaml: "name: 1bad\ndatasets: []" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /^name: /);

  res = await stack.api("POST", "/api/v1/metrics", { connectionId: conn, yaml });
  assert.equal(res.status, 201);
  const { model } = await res.json();
  assert.deepEqual(model.metrics.map((m) => m.name), ["completed_amount", "order_count"]);
  assert.deepEqual(model.fields, ["status", "amount"]);

  res = await stack.api("POST", `/api/v1/metrics/${model.id}/query`, { metric: "completed_amount" });
  let out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.sql, `SELECT (SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)) AS "completed_amount" FROM ${table}`);
  assert.equal(out.csv.trim(), "completed_amount\n25.5");

  res = await stack.api("POST", `/api/v1/metrics/${model.id}/query`, { metric: "order_count", group_by: ["status"], order: "desc", limit: 5 });
  out = await res.json();
  assert.equal(out.csv.trim(), "status,order_count\ncompleted,2\ncancelled,1");

  res = await stack.api("POST", `/api/v1/metrics/${model.id}/query`, { metric: "nope" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Unknown metric nope.");

  res = await stack.api("GET", `/api/v1/metrics/${model.id}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /\.ossie\.yaml"$/);
  assert.equal(await res.text(), yaml, "export is byte-for-byte what was uploaded");

  assert.equal((await stack.api("POST", "/api/v1/metrics", { connectionId: conn, yaml })).status, 409, "names are unique per user");
  assert.equal((await stack.api("DELETE", `/api/v1/metrics/${model.id}`)).status, 204);
  assert.deepEqual((await (await stack.api("GET", "/api/v1/metrics")).json()).models, []);
});

test("agents measure metrics and then lose the web tools", async () => {
  const { model } = await (await stack.api("POST", "/api/v1/metrics", { connectionId: conn, yaml })).json();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  const agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Counter", avatar: "fox", color: "green", instructions: "" })).json()).agent.id;

  const start = fake.requests.length;
  fake.script.push(
    { tools: [{ id: "tu_l", name: "list_metrics", input: {} }], stop: "tool_use" },
    {
      tools: [{ id: "tu_q", name: "query_metric", input: { model_id: model.id, metric: "completed_amount", group_by: [], filters: [{ field: "amount", op: ">", value: 12 }], order: "desc", limit: 10 } }],
      stop: "tool_use",
    },
    { text: "15.5", stop: "end_turn" },
  );
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Completed revenue over 12?" });
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).type, "done", JSON.stringify(lines));

  const reqs = fake.requests.slice(start);
  assert.match(reqs[0].body.system[0].text, /use query_metric instead of writing SQL/);
  const listed = JSON.parse(reqs[1].body.messages.at(-1).content[0].content);
  assert.ok(listed.models.some((m) => m.id === model.id));
  const measured = JSON.parse(reqs[2].body.messages.at(-1).content[0].content);
  assert.equal(measured.csv.trim(), "completed_amount\n15.5");
  assert.ok(!reqs[2].body.tools.some((t) => String(t.type).startsWith("web_")), "metric results keep the web tools off");
  assert.ok(lines.some((l) => l.type === "tool" && l.summary === "Measured completed_amount"));
});
