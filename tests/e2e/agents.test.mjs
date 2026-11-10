// Agents, phase 1 (docs/AGENT-BUILD-SPEC.md §5.8): keys, chat streaming, caps and
// isolation, against the fake Anthropic server.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack, root } from "./harness.mjs";

const postgres = createRequire(join(root, "services", "control", "package.json"))("postgres");

let fake;
let stack;
let sql;
let agentId;

/** POST a chat message and collect the NDJSON lines. */
async function chat(id, text) {
  const res = await stack.api("POST", `/api/v1/agents/${id}/chat`, { text });
  if (!res.headers.get("content-type")?.includes("ndjson")) return { status: res.status, body: await res.json(), lines: [] };
  const raw = await res.text();
  return { status: res.status, lines: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

async function newAgent(name = "Scout") {
  const res = await stack.api("POST", "/api/v1/agents", { name, avatar: "owl", color: "teal", instructions: "" });
  assert.equal(res.status, 201);
  return (await res.json()).agent.id;
}

async function signUp(name) {
  stack.cookie = "";
  const res = await stack.api("POST", "/api/auth/sign-up/email", { name, email: `${name.toLowerCase()}-${Date.now()}-${Math.random()}@example.com`, password: "correct-horse-9" });
  assert.equal(res.status, 200);
  return stack.cookie;
}

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 19397, wbhostPort: 19398, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
});

after(async () => {
  await sql?.end();
  stack?.stop();
  await fake?.close();
});

test("key: shape check, Anthropic check, sealed storage, removal", async () => {
  const seen = fake.requests.length;
  let res = await stack.api("PUT", "/api/v1/ai-key", { key: "not-a-key" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not accepted/);
  assert.equal(fake.requests.length, seen, "a malformed key never reaches Anthropic");

  res = await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-bad" });
  assert.equal(res.status, 400);
  assert.equal(fake.requests.at(-1).apiKey, "sk-ant-test-bad");

  res = await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { provider: "anthropic", last4: "good" });

  const status = await (await stack.api("GET", "/api/v1/ai-key")).text();
  assert.doesNotMatch(status, /sk-ant/);
  assert.equal(JSON.parse(status).provider, "anthropic");
  const rows = await sql`select secret from ai_key`;
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.doesNotMatch(r.secret, /sk-ant/);

  assert.equal((await stack.api("DELETE", "/api/v1/ai-key")).status, 204);
  assert.deepEqual(await (await stack.api("GET", "/api/v1/ai-key")).json(), { provider: null });
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
});

test("no key: chat says to add one", async () => {
  const mine = stack.cookie;
  await signUp("Keyless");
  const id = await newAgent();
  const res = await chat(id, "hi");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "E_NO_KEY");
  stack.cookie = mine;
});

test("plain chat streams text and stores the turn", async () => {
  agentId = await newAgent("Scout");
  fake.script.push({ text: "Hello there", stop: "end_turn" });
  const { status, lines } = await chat(agentId, "Say hello");
  assert.equal(status, 200);
  assert.equal(lines[0].type, "run");
  assert.equal(lines.filter((l) => l.type === "text").map((l) => l.delta).join(""), "Hello there ");
  assert.equal(lines.at(-1).type, "done");

  const req = fake.requests.at(-1);
  assert.equal(req.apiKey, "sk-ant-test-good");
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
  assert.match(JSON.stringify(req.body.system), /You are Scout,/);
  const types = req.body.tools.map((t) => t.type);
  assert.ok(types.includes("web_search_20260209"));
  assert.ok(types.includes("web_fetch_20260209"));

  const { messages } = await (await stack.api("GET", `/api/v1/agents/${agentId}/messages`)).json();
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
  const [run] = await sql`select status, cost_micro_usd from agent_run where id = ${lines[0].runId}`;
  assert.equal(run.status, "ok");
  assert.equal(Number(run.cost_micro_usd), 100 * 4 + 20 * 20);
});

test("history replay sends the stored turn back unchanged", async () => {
  const [stored] = await sql`select content from agent_message where agent_id = ${agentId} and role = 'assistant' order by seq`;
  fake.script.push({ text: "Again", stop: "end_turn" });
  const { lines } = await chat(agentId, "Once more");
  assert.equal(lines.at(-1).type, "done");
  const { messages } = fake.requests.at(-1).body;
  assert.deepEqual(messages[0], { role: "user", content: [{ type: "text", text: "Say hello" }] });
  assert.deepEqual(messages[1].content, stored.content);
  assert.equal(messages.length, 3);
});

test("refusal ends the stream with E_REFUSED", async () => {
  const id = await newAgent("Refuser");
  fake.script.push({ stop: "refusal" });
  const { lines } = await chat(id, "Do something");
  const last = lines.at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.code, "E_REFUSED");
  const [run] = await sql`select status from agent_run where id = ${lines[0].runId}`;
  assert.equal(run.status, "error");
});

test("busy: one reply at a time per agent", async () => {
  const id = await newAgent("Busy");
  const [{ owner_id }] = await sql`select owner_id from agent where id = ${id}`;
  await sql`insert into agent_run (id, agent_id, owner_id, kind, status, model) values (${"busy" + Date.now()}, ${id}, ${owner_id}, 'chat', 'running', 'claude-opus-5-5')`;
  const res = await chat(id, "hi");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "E_BUSY");
});

test("cap: spending stops at the monthly cap", async () => {
  const id = await newAgent("Spender");
  assert.equal((await stack.api("PATCH", "/api/v1/ai-key", { monthlyCapUsd: 1 })).status, 200);
  const [{ owner_id }] = await sql`select owner_id from agent where id = ${id}`;
  await sql`insert into agent_run (id, agent_id, owner_id, kind, status, model, cost_micro_usd) values (${"cap" + Date.now()}, ${id}, ${owner_id}, 'chat', 'ok', 'claude-opus-5-5', 1000000)`;
  const res = await chat(id, "hi");
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "E_LIMIT");
  const key = await (await stack.api("GET", "/api/v1/ai-key")).json();
  assert.ok(key.spentThisMonthUsd >= 1);

  const usage = await (await stack.api("GET", "/api/v1/usage?days=30")).json();
  assert.ok(usage.runs >= 3, "the chats above and this run are counted");
  assert.ok(usage.totalCostUsd >= 1);
  assert.equal(usage.byDay.at(-1).date, new Date().toISOString().slice(0, 10));
  assert.equal(usage.byAgent.find((a) => a.agentId === id)?.costUsd, 1);
  assert.equal((await stack.api("PATCH", "/api/v1/ai-key", { monthlyCapUsd: 20 })).status, 200);
});

test("isolation: another user cannot see or use the agent", async () => {
  const mine = stack.cookie;
  await signUp("Other");
  const routes = [
    ["PATCH", `/api/v1/agents/${agentId}`, { name: "Mine now" }],
    ["DELETE", `/api/v1/agents/${agentId}`],
    ["GET", `/api/v1/agents/${agentId}/messages`],
    ["DELETE", `/api/v1/agents/${agentId}/messages`],
    ["POST", `/api/v1/agents/${agentId}/chat`, { text: "hi" }],
  ];
  for (const [method, path, body] of routes) assert.equal((await stack.api(method, path, body)).status, 404, `${method} ${path}`);
  const { agents } = await (await stack.api("GET", "/api/v1/agents")).json();
  assert.deepEqual(agents, []);
  stack.cookie = mine;
});
