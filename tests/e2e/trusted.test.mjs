// Trusted answers: a reply someone marks as correct, or a confirmed number, becomes an example the
// agent is shown first and a test it is put through again when it changes.
// Needs python3 with sqlglot and duckdb for the engine.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, sourceId;

// 300 orders; every tenth is cancelled. amount = order number: paid Ads 22,500, paid Email 18,000.
const csv = ["order_id,status,source,amount", ...Array.from({ length: 300 }, (_, i) => `${i + 1},${(i + 1) % 10 === 0 ? "cancelled" : "paid"},${i % 2 ? "Email" : "Ads"},${i + 1}`)].join("\n") + "\n";
const SQL = "select source, sum(amount) as revenue from orders where status = 'paid' group by 1 order by 1";

async function chat(text) {
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return { lines, text: lines.filter((l) => l.type === "text").map((l) => l.delta).join("") };
}
const lastResults = () => fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const messages = async () => (await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json()).messages;
const answers = async () => (await (await stack.api("GET", `/api/v1/sources/${sourceId}/answers`)).json()).answers;

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8983, wbhostPort: 8984, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" })).json()).agent.id;
  workbookId = (await (await stack.api("POST", "/api/v1/workbooks")).json()).id;
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "orders", csv }), { text: "Imported.", stop: "end_turn" });
  await chat("Import my orders");
  assert.equal(lastResults()[0].is_error, undefined, lastResults()[0].content);
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("a reply that came from a query can be marked as correct; one that did not cannot", async () => {
  fake.script.push(call("list_tables", { workbook_id: workbookId }), call("query_tables", { workbook_id: workbookId, sql: SQL, max_rows: null }), { text: "Ads 22,500 and Email 18,000.", stop: "end_turn" });
  const out = await chat("Paid revenue by source?");
  assert.match(out.text, /Unconfirmed: no shared definition exists/);
  const runId = out.lines.find((l) => l.type === "run").runId;

  // The stored chat offers the control on that run's last reply only.
  const stored = await messages();
  const offered = stored.filter((m) => m.verifyRun);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].verifyRun, runId);
  assert.match(offered[0].visible, /22,500/);

  const res = await stack.api("POST", `/api/v1/agents/${agentId}/runs/${runId}/verify`);
  assert.equal(res.status, 200);
  const body = await res.json();
  sourceId = body.sourceId;
  assert.equal(body.answer.question, "Paid revenue by source?");
  assert.equal(body.answer.sql, SQL);
  assert.equal(body.answer.expected, "source,revenue\nAds,22500\nEmail,18000\n");
  assert.equal(body.answer.stale, true);

  // Marking it twice keeps one answer.
  assert.equal((await stack.api("POST", `/api/v1/agents/${agentId}/runs/${runId}/verify`)).status, 200);
  assert.equal((await answers()).length, 1);

  // The import run made no query: there is nothing to vouch for.
  const importRun = (await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json()).messages;
  assert.ok(importRun.length > 0);
  fake.script.push({ text: "Hello.", stop: "end_turn" });
  const hello = await chat("Hi");
  const helloRun = hello.lines.find((l) => l.type === "run").runId;
  assert.equal((await stack.api("POST", `/api/v1/agents/${agentId}/runs/${helloRun}/verify`)).status, 400);
});

test("the agent is shown trusted answers first, and repeating one exactly counts as confirmed", async () => {
  fake.script.push(call("list_tables", { workbook_id: workbookId }), call("query_tables", { workbook_id: workbookId, sql: `  ${SQL.replace(" from ", "\n  from ")} ;`, max_rows: null }), { text: "Ads 22,500 and Email 18,000, verified.", stop: "end_turn" });
  const out = await chat("Paid revenue by source?");
  const second = lastResults()[0];
  const first = fake.requests.at(-2).body.messages.at(-1).content.find((b) => b.type === "tool_result");
  const listed = JSON.parse(first.content);
  assert.equal(Object.keys(listed)[0], "trusted_examples");
  assert.deepEqual(listed.trusted_examples.map((e) => [e.question, e.use, e.sql, e.workbook_id]), [["Paid revenue by source?", "query_tables", SQL, workbookId]]);
  assert.ok(listed.trusted_examples[0].verified_by);
  assert.match(JSON.parse(second.content).verified, /marked as correct by/);
  assert.doesNotMatch(out.text, /Unconfirmed/);

  // A different query is still labelled.
  fake.script.push(call("query_tables", { workbook_id: workbookId, sql: "select sum(amount) from orders", max_rows: null }), { text: "45,150.", stop: "end_turn" });
  assert.match((await chat("Everything?")).text, /Unconfirmed: no shared definition exists/);
  // The system prompt tells the agent what trusted examples are for.
  assert.match(fake.requests.at(-1).body.system[0].text, /trusted_examples/);
});

test("confirming a metric adds it as a trusted answer", async () => {
  const review = await (await stack.api("GET", `/api/v1/sources/${sourceId}/review`)).json();
  const total = review.definitions.find((d) => d.kind === "metric" && d.body.expression === "SUM(orders.amount)");
  assert.equal((await stack.api("POST", `/api/v1/definitions/${total.id}/confirm`)).status, 200);
  const list = await answers();
  assert.equal(list.length, 2);
  const added = list.find((a) => a.origin === "confirmed");
  assert.equal(added.question, `What is ${total.label}?`);
  assert.equal(added.expected.trim(), "45150");
  assert.equal(added.definitionId, total.id);
});

test("rechecking puts each question to the agent, grades it against the trusted query, and stays out of the chat", async () => {
  const before = (await messages()).length;
  fake.script.push(
    // First answer: the agent reuses the trusted query.
    call("list_tables", { workbook_id: workbookId }),
    call("query_tables", { workbook_id: workbookId, sql: SQL, max_rows: null }),
    { text: "Ads 22,500 and Email 18,000.", stop: "end_turn" },
    // Second answer: the agent leaves out cancelled orders, which is not what was confirmed.
    call("query_tables", { workbook_id: workbookId, sql: "select sum(amount) from orders where status = 'paid'", max_rows: null }),
    { text: "It is 40,500.", stop: "end_turn" },
  );
  const res = await stack.api("POST", `/api/v1/sources/${sourceId}/answers/recheck`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.checked, 2);
  const [byChat, byConfirm] = [body.answers.find((a) => a.origin === "chat"), body.answers.find((a) => a.origin === "confirmed")];
  assert.equal(byChat.lastStatus, "pass");
  assert.equal(byConfirm.lastStatus, "fail");
  assert.match(byConfirm.lastDetail, /45150/);
  assert.ok(body.answers.every((a) => a.stale === false));

  // The agent was asked the stored question, told where the data is, and offered only tools that read.
  const asked = fake.requests.at(-1).body;
  assert.match(asked.messages[0].content[0].text, /^What is .+\?\n\n\(The data is in the workbook/);
  const offered = asked.tools.map((t) => t.name);
  assert.ok(offered.includes("query_tables"));
  assert.ok(!offered.includes("write_table") && !offered.includes("propose_widget"));
  assert.equal((await messages()).length, before);

  // Nothing is stale, so a plain recheck does nothing.
  assert.equal((await (await stack.api("POST", `/api/v1/sources/${sourceId}/answers/recheck`, {})).json()).checked, 0);
});

test("changing the agent's instructions makes every answer due again", async () => {
  assert.equal((await stack.api("PATCH", `/api/v1/agents/${agentId}`, { instructions: "Always answer in French." })).status, 200);
  assert.ok((await answers()).every((a) => a.stale === true));
});

test("only members see or change trusted answers, and removing one stops it being shown", async () => {
  const other = new Stack({ controlPort: 8983, wbhostPort: 8984 });
  other.base = stack.base;
  assert.equal((await other.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password: "correct-horse-9" })).status, 200);
  assert.equal((await other.api("GET", `/api/v1/sources/${sourceId}/answers`)).status, 404);
  assert.equal((await other.api("POST", `/api/v1/sources/${sourceId}/answers/recheck`, {})).status, 404);
  const [first] = await answers();
  assert.equal((await other.api("DELETE", `/api/v1/answers/${first.id}`)).status, 404);
  assert.equal((await other.api("POST", `/api/v1/agents/${agentId}/runs/x/verify`)).status, 404);

  const chatOne = (await answers()).find((a) => a.origin === "chat");
  assert.equal((await stack.api("DELETE", `/api/v1/answers/${chatOne.id}`)).status, 204);
  fake.script.push(call("query_tables", { workbook_id: workbookId, sql: SQL, max_rows: null }), { text: "Ads 22,500.", stop: "end_turn" });
  assert.match((await chat("Paid revenue by source?")).text, /Unconfirmed/);
});
