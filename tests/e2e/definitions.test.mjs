// Confirmed definitions, end to end against a real Postgres (docs/specs/DEFINITIONS-SPEC.md §11):
// workspace, source, each member's own sign-in, scan, questions with numbers, confirm, correct,
// export, and agents that label anything unconfirmed. Needs python3 with sqlglot for the engine.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { root, waitFor } from "./harness.mjs";

const require = createRequire(join(root, "services", "control", "package.json"));
const postgres = require("postgres");
const { parse: parseYaml } = require("yaml");

const dbUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/postgres");
const address = { host: dbUrl.hostname, port: Number(dbUrl.port || 5432), database: dbUrl.pathname.slice(1) || "postgres", ssl: "disable" };
const tag = Math.random().toString(36).slice(2, 8);
const schema = `shop_${tag}`;
const ana = `ana_${tag}`;
const ben = `ben_${tag}`;
const PASSWORD = "definitions-test-pw-1";
const PORT = 8961;
const base = `http://localhost:${PORT}`;

let fake, control, admin, hasQueryLog, checksPasswords;

/** A signed-in person: keeps their own cookie. */
class Person {
  cookie = "";
  async api(method, path, body) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.match(/better-auth\.session_token=[^;]+/)?.[0] ?? this.cookie;
    return res;
  }
  async json(method, path, body) {
    const res = await this.api(method, path, body);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }
  static async signUp(name) {
    const p = new Person();
    p.email = `${name}-${tag}@example.com`;
    const res = await p.api("POST", "/api/auth/sign-up/email", { name, email: p.email, password: "correct-horse-9" });
    assert.equal(res.status, 200);
    p.id = (await p.json("GET", "/api/v1/me")).body.id;
    return p;
  }
}

before(async () => {
  admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  // The "warehouse": a small shop. Store 9 is a test store; two orders are cancelled.
  await admin.unsafe(`
    create schema ${schema};
    create table ${schema}.stores (store_id int primary key, name text, is_test boolean not null);
    create table ${schema}.orders (order_id int primary key, store_id int references ${schema}.stores, status text, amount numeric(10,2), fee numeric(10,2), ordered_at timestamp);
    create table ${schema}.refunds (refund_id int primary key, order_id int references ${schema}.orders, amount numeric(10,2));
    insert into ${schema}.stores values (1, 'Portland', false), (2, 'Seattle', false), (3, 'Bend', false), (9, 'QA Store', true);
    insert into ${schema}.orders
      select g, case when g % 10 = 0 then 9 else 1 + g % 3 end, case when g % 20 = 7 then 'cancelled' else 'completed' end, 10 + g, 1, timestamp '2026-10-01' + g * interval '3 hours'
      from generate_series(1, 60) g;
    insert into ${schema}.refunds values (1, 5, 5), (2, 12, 6), (3, 31, 7);
    create role ${ana} login password '${PASSWORD}';
    create role ${ben} login password '${PASSWORD}';
    grant usage on schema ${schema} to ${ana}, ${ben};
    grant select on all tables in schema ${schema} to ${ana}, ${ben};
    alter role ${ana} set search_path = ${schema};
    alter role ${ben} set search_path = ${schema};
  `);
  // Query history, when this Postgres keeps one: two people work out order_count differently.
  try {
    if (process.env.E2E_NO_QUERY_LOG) throw new Error("run as if the database kept no query log");
    await admin.unsafe("create extension if not exists pg_stat_statements; grant pg_read_all_stats to " + ana);
    await admin.unsafe("select count(*) from pg_stat_statements");
    hasQueryLog = true;
  } catch {
    hasQueryLog = false;
  }
  const as = (role) => postgres({ ...address, ssl: false, username: role, password: PASSWORD, max: 1, onnotice: () => {} });
  const wrong = postgres({ ...address, ssl: false, username: ana, password: "wrong", max: 1, onnotice: () => {} });
  checksPasswords = await wrong`select 1`.then(() => false, () => true);
  await wrong.end({ timeout: 1 });
  const a = as(ana);
  const b = as(ben);
  await a.unsafe("select count(*) as order_count from orders");
  await a.unsafe("select s.name, count(*) as order_count from orders o join stores s on s.store_id = o.store_id group by s.name");
  await b.unsafe("select count(distinct store_id) as order_count from orders");
  await b.unsafe("select sum(amount) as revenue from orders");
  await a.unsafe("select sum(amount) as revenue from orders o join stores s on s.store_id = o.store_id");
  await a.end();
  await b.end();

  fake = await startFakeAnthropic();
  control = spawn(process.execPath, ["src/server.ts"], {
    cwd: join(root, "services", "control"),
    env: {
      ...process.env,
      PORT: String(PORT),
      BETTER_AUTH_SECRET: "e2e-auth-secret-0123456789abcdef0123",
      BETTER_AUTH_URL: base,
      WB_TOKEN_SECRET: "e2e-wb-token-secret-0123456789abcdef",
      WEB_DIST: "",
      ANTHROPIC_BASE_URL: fake.url,
      CONNECTION_SECRET_KEY: "e2e-connection-key",
      CONNECTOR_ALLOW_PRIVATE: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(() => fetch(`${base}/api/v1/health`).then((r) => r.ok), "control plane");
});

after(async () => {
  control?.kill();
  await fake?.close();
  await admin.unsafe(`drop schema if exists ${schema} cascade; drop owned by ${ana}, ${ben}; drop role ${ana}; drop role ${ben};`).catch(() => {});
  await admin.end();
});

let owner, analyst, viewer, outsider, workspaceId, sourceId, review;
const loadReview = async (who = owner) => (review = (await who.json("GET", `/api/v1/sources/${sourceId}/review`)).body);
const def = (kind, name) => review.definitions.find((d) => d.kind === kind && d.name === name);
// The total of orders.amount: named "revenue" when the query log shows people calling it that, else suggested from the column.
const totalMetric = () => def("metric", "revenue") ?? def("metric", "total_amount");
const value = async (who, id) => (await who.json("GET", `/api/v1/definitions/${id}/value`)).body;

test("a workspace has members with roles, and a source holds only the address", async () => {
  owner = await Person.signUp("Olive");
  analyst = await Person.signUp("Arun");
  viewer = await Person.signUp("Vera");
  outsider = await Person.signUp("Oscar");
  const ws = await owner.json("POST", "/api/v1/workspaces", { name: "Larkspur" });
  assert.equal(ws.status, 201);
  workspaceId = ws.body.id;
  assert.equal((await owner.json("POST", `/api/v1/workspaces/${workspaceId}/members`, { email: analyst.email, role: "editor", team: "Finance" })).status, 201);
  assert.equal((await owner.json("POST", `/api/v1/workspaces/${workspaceId}/members`, { email: viewer.email, role: "viewer" })).status, 201);
  assert.equal((await analyst.json("POST", `/api/v1/workspaces/${workspaceId}/members`, { email: outsider.email, role: "editor" })).status, 403);
  assert.equal((await outsider.json("GET", `/api/v1/workspaces/${workspaceId}/sources`)).status, 404);

  assert.equal((await analyst.json("POST", `/api/v1/workspaces/${workspaceId}/sources`, { name: "Shop", ...address, schemas: [schema] })).status, 403);
  const src = await owner.json("POST", `/api/v1/workspaces/${workspaceId}/sources`, { name: "Shop", ...address, schemas: [schema] });
  assert.equal(src.status, 201);
  sourceId = src.body.id;
  assert.equal(JSON.stringify(src.body).includes(PASSWORD), false);
  assert.equal(src.body.config.user, undefined);
});

test("each member signs in with their own database user, and nothing runs without one", async () => {
  const blocked = await owner.json("POST", `/api/v1/sources/${sourceId}/scan`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "E_NO_CREDENTIAL");
  // A wrong password is refused (unless this Postgres trusts every local connection, as some dev setups do).
  if (checksPasswords) assert.equal((await owner.json("PUT", `/api/v1/sources/${sourceId}/credential`, { username: ana, password: "wrong" })).status, 400);
  assert.equal((await owner.json("PUT", `/api/v1/sources/${sourceId}/credential`, { username: ana, password: PASSWORD })).status, 200);
  assert.equal((await analyst.json("PUT", `/api/v1/sources/${sourceId}/credential`, { username: ben, password: PASSWORD })).status, 200);
  const listed = await analyst.json("GET", `/api/v1/workspaces/${workspaceId}/sources`);
  assert.equal(listed.body.sources[0].mySignIn, ben);
  assert.equal(JSON.stringify(listed.body).includes(PASSWORD), false);
});

test("a scan shows what it will read, then drafts keys, links and metrics with evidence", async () => {
  const est = await owner.json("GET", `/api/v1/sources/${sourceId}/scan/estimate`);
  assert.equal(est.status, 200);
  assert.equal(est.body.tables, 3);
  assert.equal((await viewer.json("POST", `/api/v1/sources/${sourceId}/scan`)).status, 403);

  const scan = await owner.json("POST", `/api/v1/sources/${sourceId}/scan`);
  assert.equal(scan.status, 200, JSON.stringify(scan.body));

  assert.equal(scan.body.tables, 3);
  await loadReview();

  const orders = def("entity", "orders");
  assert.deepEqual(orders.body.grain, ["order_id"]);
  assert.equal(orders.confidence, "high"); // declared as the primary key
  assert.ok(orders.evidence.some((e) => e.type === "declared"));
  const link = review.definitions.find((d) => d.kind === "link" && d.body.to_entity === `${schema}.stores`);
  assert.equal(link.body.from_entity, `${schema}.orders`);
  assert.equal(link.body.to_entity, `${schema}.stores`);
  assert.equal(link.body.cardinality, "many_to_one");
  assert.ok(link.evidence.some((e) => e.type === "declared"));

  // Two tables have an `amount` column: each total gets its own name.
  const totals = review.definitions.filter((d) => d.kind === "metric" && /SUM\(\w+\.amount\)/.test(d.body.expression));
  assert.equal(totals.length, 2);
  assert.notEqual(totals[0].name, totals[1].name);

  // A total nobody was seen using is still suggested, marked low confidence.
  const fee = def("metric", "total_fee");
  assert.equal(fee.body.expression, "SUM(orders.fee)");
  assert.equal(fee.confidence, "low");
  const total = totalMetric();
  assert.equal(total.body.expression, "SUM(orders.amount)");
  assert.equal(total.status, "inferred");
  if (hasQueryLog) {
    assert.equal(total.name, "revenue");
    assert.ok(total.evidence.some((e) => e.type === "usage" && e.people === 2));
  }
  assert.equal(Number((await value(owner, total.id)).value), 2430); // 60 orders of 10+g

  // No scan result keeps row data beyond common values, and no secret leaves the server.
  assert.equal(JSON.stringify(review).includes(PASSWORD), false);
});

test("questions offer choices with numbers, and choosing one applies it", async () => {
  const q = review.questions.find((x) => x.kind === "excluded_rows" && /test/i.test(x.topic));
  assert.ok(q, "a question about the test store");
  assert.match(q.prompt, /1 of 4 stores are marked as test/);
  const [leaveOut, count] = q.options;
  // 6 orders (g = 10..60 by 10) belong to the test store: 2430 - (20+30+40+50+60+70) = 2160
  assert.equal(Number(count.value), 2430);
  assert.equal(Number(leaveOut.value), 2160);
  assert.match(leaveOut.text, /2,160/);
  assert.equal(q.assigneeId, owner.id);

  assert.equal((await viewer.json("POST", `/api/v1/questions/${q.id}/answer`, { option: 0 })).status, 403);
  const done = await analyst.json("POST", `/api/v1/questions/${q.id}/answer`, { option: 0 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.applied.some((line) => /rule/.test(line)));
  assert.equal((await analyst.json("POST", `/api/v1/questions/${q.id}/answer`, { option: 1 })).status, 409);

  await loadReview();
  const rule = review.definitions.find((d) => d.kind === "rule" && /is_test/.test(d.body.expression));
  assert.equal(rule.status, "confirmed");
  assert.equal(rule.confirmedBy, analyst.id);
  const total = totalMetric();
  assert.deepEqual(total.body.filters, [rule.name]);
  const now = await value(owner, total.id);
  assert.equal(Number(now.value), 2160);
  assert.match(now.sql, /LEFT JOIN/);
  assert.ok(now.estimate.rows > 1); // rows read, not the one row a total returns

  // The status question lists every value and offers to leave out cancelled orders.
  const status = review.questions.find((x) => x.kind === "excluded_rows" && /status/i.test(x.topic));
  assert.match(status.prompt, /cancelled/);
  assert.ok(Number(status.options[0].value) < Number(status.options[1].value));
});

test("the same name worked out two ways becomes a question with both numbers", { skip: false }, async (t) => {
  if (!hasQueryLog) return t.skip("this Postgres does not load pg_stat_statements");
  const q = review.questions.find((x) => x.kind === "conflict");
  assert.ok(q, "a conflict question for order_count");
  const byFormula = Object.fromEntries(q.options.map((o) => [o.expression, Number(o.value)]));
  assert.equal(byFormula["COUNT(*)"], 60);
  assert.equal(byFormula["COUNT(DISTINCT orders.store_id)"], 4);
  assert.equal(def("metric", "order_count").status, "needs_answer");
  const pick = q.options.findIndex((o) => o.expression === "COUNT(*)");
  assert.equal((await owner.json("POST", `/api/v1/questions/${q.id}/answer`, { option: pick })).status, 200);
  await loadReview();
  const metric = def("metric", "order_count");
  assert.equal(metric.status, "confirmed");
  assert.equal(Number(metric.checkNumber.value), 54); // 60 orders less the 6 from the test store, left out by the answer above
  assert.ok(metric.evidence.some((e) => e.type === "usage"));
});

test("confirming is for editors, stores a check number, and can be disputed", async () => {
  const total = totalMetric();
  assert.equal((await viewer.json("POST", `/api/v1/definitions/${total.id}/confirm`)).status, 403);
  assert.equal((await outsider.json("POST", `/api/v1/definitions/${total.id}/confirm`)).status, 404);
  const ok = await owner.json("POST", `/api/v1/definitions/${total.id}/confirm`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.definition.status, "confirmed");
  assert.equal(ok.body.definition.confirmedBy, owner.id);
  assert.equal(Number(ok.body.definition.checkNumber.value), 2160);
  assert.ok(ok.body.definition.evidence.some((e) => /Confirmed by Olive/.test(e.text)));

  const disputed = await viewer.json("POST", `/api/v1/definitions/${total.id}/dispute`, { reason: "Finance reports net of cancelled orders." });
  assert.equal(disputed.body.definition.status, "disputed");
  const history = await owner.json("GET", `/api/v1/definitions/${total.id}/history`);
  assert.deepEqual(history.body.events.map((e) => e.event).slice(-2), ["confirmed", "disputed"]);
});

test("a trusted number that does not match marks the metric instead of changing it", async () => {
  const q = review.questions.find((x) => x.kind === "trusted_number");
  const total = totalMetric();
  const res = await owner.json("POST", `/api/v1/questions/${q.id}/answer`, { definitionId: total.id, value: 2000 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.applied[0], /2,160, not 2,000/);
  await loadReview();
  assert.ok(totalMetric().evidence.some((e) => e.type === "conflict"));
  assert.equal(Number((await value(owner, total.id)).value), 2160);
});

test("a correction shows old and new numbers before anything is published", async () => {
  const total = totalMetric();
  const bad = await owner.json("POST", `/api/v1/definitions/${total.id}/correct`, { expression: "SUM(orders.net_amount)" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /no column/);
  assert.equal((await viewer.json("POST", `/api/v1/definitions/${total.id}/correct`, { expression: "AVG(orders.amount)" })).status, 403);

  // In plain words: the AI proposes, the server checks every column and works out the numbers.
  assert.equal((await owner.json("POST", `/api/v1/definitions/${total.id}/correct`, { request: "Leave out cancelled orders." })).body.code, "E_AI");
  assert.equal((await owner.json("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  const rule = review.definitions.find((d) => d.kind === "rule");
  fake.script.push({
    text: JSON.stringify({ expression: "SUM(orders.amount)", filters: [rule.name, "not_cancelled"], new_rules: [{ name: "not_cancelled", label: "Orders that were not cancelled", entity: `${schema}.orders`, expression: "orders.status <> 'cancelled'", meaning: "Cancelled orders do not count." }], explanation: "Added a rule that leaves out cancelled orders." }),
    stop: "end_turn",
  });
  const proposed = await owner.json("POST", `/api/v1/definitions/${total.id}/correct`, { request: "Leave out cancelled orders." });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const { preview } = proposed.body.change;
  assert.equal(Number(preview.oldValue), 2160);
  // cancelled: g = 7, 27, 47 (store 2, 1, 3): 17 + 37 + 57 = 111
  assert.equal(Number(preview.newValue), 2049);
  assert.match(preview.newSql, /status <> 'cancelled'/);
  assert.equal(preview.impact.length, 1);
  // Nothing has changed yet.
  assert.equal(Number((await value(owner, total.id)).value), 2160);

  // An AI answer that names a column that does not exist is refused, not published.
  fake.script.push({ text: JSON.stringify({ expression: "SUM(orders.amount)", filters: ["x"], new_rules: [{ name: "x", label: "x", entity: `${schema}.orders`, expression: "orders.refunded = false" }] }), stop: "end_turn" });
  assert.equal((await owner.json("POST", `/api/v1/definitions/${total.id}/correct`, { request: "Leave out refunded orders." })).status, 400);

  assert.equal((await viewer.json("POST", `/api/v1/changes/${proposed.body.change.id}/publish`)).status, 403);
  const published = await owner.json("POST", `/api/v1/changes/${proposed.body.change.id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.definition.status, "confirmed");
  assert.equal(published.body.definition.version, total.version + 1);
  assert.equal(Number(published.body.definition.checkNumber.value), 2049);
  assert.equal((await owner.json("POST", `/api/v1/changes/${proposed.body.change.id}/publish`)).status, 400);
  const history = await owner.json("GET", `/api/v1/definitions/${total.id}/history`);
  const event = history.body.events.find((e) => e.event === "published");
  assert.deepEqual(event.detail.oldBody.filters, [rule.name]); // the old version is kept
});

test("the export is Apache Ossie with only confirmed definitions unless asked", async () => {
  const res = await owner.api("GET", `/api/v1/sources/${sourceId}/export`);
  assert.equal(res.status, 200);
  const doc = parseYaml(await res.text());
  assert.equal(doc.version, "0.3.0.dev0");
  const total = doc.metrics.find((m) => m.name === totalMetric().name);
  assert.match(total.expression.dialects[0].expression, /SUM\(CASE WHEN .*is_test.* AND .*cancelled.* THEN orders.amount END\)/);
  const carried = JSON.parse(total.custom_extensions[0].data);
  assert.equal(total.custom_extensions[0].vendor_name, "GRIDZERO");
  assert.equal(carried.status, "confirmed");
  assert.equal(carried.rules.length, 2);
  assert.ok(doc.metrics.every((m) => JSON.parse(m.custom_extensions[0].data).status === "confirmed"));
  assert.deepEqual(doc.datasets.find((d) => d.name === "orders").primary_key, ["order_id"]);
  const all = parseYaml(await (await owner.api("GET", `/api/v1/sources/${sourceId}/export?all=1`)).text());
  assert.ok(all.metrics.length > doc.metrics.length);
  assert.ok(all.relationships.some((r) => r.from === "orders" && r.to === "stores"));
});

async function chat(who, agentId, text) {
  const res = await who.api("POST", `/api/v1/agents/${agentId}/chat`, { text });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return { lines, text: lines.filter((l) => l.type === "text").map((l) => l.delta).join("") };
}
const toolResults = (req) => req.body.messages.at(-1).content.filter((b) => b.type === "tool_result");

test("agents answer from confirmed definitions and the server labels anything else", async () => {
  const agent = (await owner.json("POST", "/api/v1/agents", { name: "Numbers", avatar: "owl", color: "blue", instructions: "" })).body.agent;
  const total = totalMetric();
  await loadReview();
  const unconfirmed = def("metric", "total_fee");

  // A confirmed metric: answered as the asker, with who confirmed it, and no label.
  fake.script.push(
    { tools: [{ id: "tu_l", name: "list_definitions", input: {} }], stop: "tool_use" },
    { tools: [{ id: "tu_q", name: "query_definition", input: { definition_id: total.id, group_by: [], limit: null } }], stop: "tool_use" },
    { text: "Total amount is 2,049, confirmed by Olive.", stop: "end_turn" },
  );
  let out = await chat(owner, agent.id, "What is our total amount?");
  let result = JSON.parse(toolResults(fake.requests.at(-1))[0].content);
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmed_by, "Olive");
  assert.match(result.csv, /2049/);
  assert.doesNotMatch(out.text, /Unconfirmed/);
  assert.equal(fake.requests.at(-1).body.tools.some((t) => t.name === "web_search"), false); // private data read

  // An unconfirmed metric: the label is added whatever the model wrote, and is kept in the chat history.
  fake.script.push(
    { tools: [{ id: "tu_l2", name: "list_definitions", input: {} }], stop: "tool_use" },
    { tools: [{ id: "tu_q2", name: "query_definition", input: { definition_id: unconfirmed.id, group_by: [], limit: null } }], stop: "tool_use" },
    { text: "It is 54.", stop: "end_turn" },
  );
  out = await chat(owner, agent.id, `What is ${unconfirmed.label}?`);
  assert.match(out.text, /It is 54\.\s+Unconfirmed: this uses a definition nobody has confirmed yet\./);
  const messages = (await owner.json("GET", `/api/v1/agents/${agent.id}/messages`)).body.messages;
  assert.match(messages.at(-1).visible, /Unconfirmed: this uses a definition nobody has confirmed yet\./);

  // A correction in chat becomes a proposed change; the definition itself does not move.
  fake.script.push({ tools: [{ id: "tu_p", name: "propose_definition_change", input: { definition_id: total.id, request: "Revenue should also leave out the Bend store." } }], stop: "tool_use" }, { text: "I have filed that for review.", stop: "end_turn" });
  out = await chat(owner, agent.id, "That's wrong, leave out Bend too.");
  assert.match(out.text, /Unconfirmed/);
  await loadReview();
  assert.equal(review.changes.find((ch) => ch.origin === "chat").request, "Revenue should also leave out the Bend store.");
  assert.equal(totalMetric().status, "confirmed");

  // Someone outside the workspace cannot reach the definition through their own agent.
  await outsider.json("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  const theirs = (await outsider.json("POST", "/api/v1/agents", { name: "Spy", avatar: "fox", color: "gray", instructions: "" })).body.agent;
  fake.script.push({ tools: [{ id: "tu_x", name: "query_definition", input: { definition_id: total.id, group_by: [], limit: null } }], stop: "tool_use" }, { text: "I cannot.", stop: "end_turn" });
  await chat(outsider, theirs.id, "total amount?");
  assert.equal(toolResults(fake.requests.at(-1))[0].is_error, true);

  // A member with no sign-in of their own gets no number.
  await viewer.json("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  const hers = (await viewer.json("POST", "/api/v1/agents", { name: "Viewer", avatar: "cat", color: "pink", instructions: "" })).body.agent;
  fake.script.push({ tools: [{ id: "tu_v", name: "query_definition", input: { definition_id: total.id, group_by: [], limit: null } }], stop: "tool_use" }, { text: "You need to sign in to the source.", stop: "end_turn" });
  await chat(viewer, hers.id, "total amount?");
  assert.match(toolResults(fake.requests.at(-1))[0].content, /Save your own sign-in/);
});

test("with shared definitions in place, SQL must come after them and is always labelled", async () => {
  const conn = (await owner.json("POST", "/api/v1/connections", { kind: "postgres", name: `shop-${tag}`, config: { ...address, user: ana }, secret: PASSWORD })).body;
  const agent = (await owner.json("POST", "/api/v1/agents", { name: "Sql", avatar: "robot", color: "green", instructions: "" })).body.agent;
  fake.script.push(
    { tools: [{ id: "tu_s1", name: "run_sql", input: { connection_id: conn.id, sql: "select count(*) from orders", max_rows: null } }], stop: "tool_use" },
    { tools: [{ id: "tu_l", name: "list_definitions", input: {} }], stop: "tool_use" },
    { tools: [{ id: "tu_s2", name: "run_sql", input: { connection_id: conn.id, sql: "select count(*) from orders where store_id = 2", max_rows: null } }], stop: "tool_use" },
    { text: "Seattle has 18 orders.", stop: "end_turn" },
  );
  const start = fake.requests.length;
  const out = await chat(owner, agent.id, "How many orders did Seattle take?");
  const reqs = fake.requests.slice(start);
  assert.equal(toolResults(reqs[1])[0].is_error, true);
  assert.match(toolResults(reqs[1])[0].content, /list_definitions first/);
  assert.match(toolResults(reqs[3])[0].content, /18/);
  assert.match(out.text, /Unconfirmed: no shared definition exists for this, so I wrote a query\./);
});

test("deleting an account removes a workspace the person was alone in and keeps a shared one", async () => {
  const solo = await outsider.json("POST", "/api/v1/workspaces", { name: "Solo" });
  assert.equal((await outsider.api("DELETE", "/api/v1/account", { password: "correct-horse-9", confirm: "DELETE" })).status, 204);
  const [gone] = await admin`select count(*)::int as n from workspace where id = ${solo.body.id}`;
  assert.equal(gone.n, 0);

  assert.equal((await owner.api("DELETE", "/api/v1/account", { password: "correct-horse-9", confirm: "DELETE" })).status, 204);
  const listed = await analyst.json("GET", "/api/v1/workspaces");
  assert.deepEqual(listed.body.workspaces.map((w) => [w.id, w.role]), [[workspaceId, "admin"]]); // the next member becomes admin
  await loadReview(analyst);
  assert.equal(totalMetric().status, "confirmed");
  assert.equal(totalMetric().confirmedBy, null); // the person is gone; the definition stays
});
