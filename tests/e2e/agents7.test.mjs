// AI keys: GridZero's included AI through OpenRouter, a person's own OpenRouter or Anthropic key,
// and the caps on each. The stand-in server plays both Anthropic and OpenRouter.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack, root } from "./harness.mjs";

const postgres = createRequire(join(root, "services", "control", "package.json"))("postgres");
const PLATFORM_KEY = "sk-or-test-platform-key";

let fake, stack, sql, agentId;

async function chat(text) {
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text });
  const body = await res.text();
  return { status: res.status, body, lines: res.status === 200 ? body.trim().split("\n").map((l) => JSON.parse(l)) : [] };
}
const lastRun = async () => (await sql`select key_source, model, cost_micro_usd from agent_run where agent_id = ${agentId} order by started_at desc limit 1`)[0];

before(async () => {
  fake = await startFakeAnthropic();
  sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  stack = new Stack({
    controlPort: 8975,
    wbhostPort: 8976,
    controlEnv: { ANTHROPIC_BASE_URL: fake.url, OPENROUTER_BASE_URL: fake.url, OPENROUTER_API_KEY: PLATFORM_KEY, PLATFORM_AI_USER_CAP_USD: "1", CONNECTION_SECRET_KEY: "e2e-connection-key" },
  });
  await stack.start();
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Helper", avatar: "owl", color: "blue", instructions: "" })).json()).agent.id;
});

after(async () => {
  stack?.stop();
  await fake?.close();
  await sql?.end();
});

test("with no key of their own, a person's agent runs on GridZero's key through OpenRouter", async () => {
  const status = await (await stack.api("GET", "/api/v1/ai-key")).json();
  assert.deepEqual(status, { provider: null, included: { monthlyCapUsd: 1, spentThisMonthUsd: 0 } });
  assert.equal(JSON.stringify(status).includes(PLATFORM_KEY), false);

  fake.script.push({ text: "Hello there.", stop: "end_turn" });
  const out = await chat("Hi");
  assert.equal(out.status, 200);
  assert.ok(out.lines.some((l) => l.type === "done"));
  const req = fake.requests.at(-1);
  assert.equal(req.apiKey, PLATFORM_KEY);
  assert.equal(req.body.model, "anthropic/claude-opus-5.5");
  assert.equal("fallbacks" in req.body, false); // OpenRouter rejects it
  const run = await lastRun();
  assert.equal(run.key_source, "platform");
  assert.equal(run.model, "anthropic/claude-opus-5.5");
  assert.equal(out.body.includes(PLATFORM_KEY), false);
});

test("the included AI stops at its monthly allowance and says what to do", async () => {
  // One expensive reply: 300,000 input tokens at $4 per million is $1.20, over the $1 allowance.
  fake.script.push({ text: "Long answer.", stop: "end_turn", usage: { input_tokens: 300_000, output_tokens: 10 } });
  assert.equal((await chat("Summarise everything")).status, 200);
  const blocked = await chat("And again");
  assert.equal(blocked.status, 429);
  assert.equal(JSON.parse(blocked.body).code, "E_PLATFORM_LIMIT");
  assert.match(JSON.parse(blocked.body).error, /Add your own key/);
  const status = await (await stack.api("GET", "/api/v1/ai-key")).json();
  assert.ok(status.included.spentThisMonthUsd >= 1);
});

test("a person's own OpenRouter key is checked, used for their runs, and held to their own cap", async () => {
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-or-wrong-key-0000" })).status, 400);
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "not-a-key" })).status, 400);
  const saved = await stack.api("PUT", "/api/v1/ai-key", { key: "sk-or-test-own-1234" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { provider: "openrouter", last4: "1234" });
  const status = await (await stack.api("GET", "/api/v1/ai-key")).json();
  assert.equal(status.provider, "openrouter");
  assert.equal(status.spentThisMonthUsd, 0); // what GridZero's key spent is not charged to theirs
  assert.equal(JSON.stringify(status).includes("sk-or-test-own"), false);

  fake.script.push({ text: "On your key.", stop: "end_turn" });
  const out = await chat("Hi again");
  assert.equal(out.status, 200);
  assert.equal(fake.requests.at(-1).apiKey, "sk-or-test-own-1234");
  assert.equal(fake.requests.at(-1).body.model, "anthropic/claude-opus-5.5");
  assert.equal((await lastRun()).key_source, "own");
});

test("an Anthropic key still works, with Anthropic's own model name and options", async () => {
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  fake.script.push({ text: "Direct.", stop: "end_turn" });
  assert.equal((await chat("Hi")).status, 200);
  const req = fake.requests.at(-1);
  assert.equal(req.apiKey, "sk-ant-test-good");
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
});

test("removing their key puts a person back on the included AI, still over its allowance", async () => {
  assert.equal((await stack.api("DELETE", "/api/v1/ai-key")).status, 204);
  assert.equal((await (await stack.api("GET", "/api/v1/ai-key")).json()).provider, null);
  assert.equal((await chat("Hi")).status, 429);
});
