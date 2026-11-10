// Agents, phase 6 (docs/AGENT-BUILD-SPEC.md §10.4): connected apps and approvals, with
// the in-memory app provider (APP_PROVIDER=fake).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake;
let stack;
let mine;
let agentId;

async function lines(res) {
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const chat = async (text) => lines(await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text }));

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 19457, wbhostPort: 19458, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", APP_PROVIDER: "fake" } });
  await stack.start();
  mine = stack.cookie;
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Mailer", avatar: "rocket", color: "pink", instructions: "" })).json()).agent.id;
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("an unconnected app asks the user to connect it", async () => {
  fake.script.push({ tools: [{ id: "tu_c", name: "check_app", input: { slug: "gmail" } }], stop: "tool_use" }, { text: "Please connect Gmail.", stop: "end_turn" });
  const out = await chat("Check my email");
  assert.deepEqual(out.find((l) => l.type === "app_connect"), { type: "app_connect", slug: "gmail", name: "Gmail" });
  const result = JSON.parse(fake.requests.at(-1).body.messages.at(-1).content[0].content);
  assert.equal(result.connected, false);

  let apps = (await (await stack.api("GET", "/api/v1/apps")).json()).apps;
  assert.equal(apps.find((a) => a.slug === "gmail").status, "none");
  const { url } = await (await stack.api("POST", "/api/v1/apps/gmail/connect", { returnUrl: "/agents" })).json();
  assert.match(url, /\/agents\?connected=gmail$/);
  apps = (await (await stack.api("GET", "/api/v1/apps")).json()).apps;
  assert.equal(apps.find((a) => a.slug === "gmail").status, "active");
});

test("a read action runs at once and turns the web tools off", async () => {
  const start = fake.requests.length;
  fake.script.push(
    { tools: [{ id: "tu_f", name: "find_app_actions", input: { slug: "gmail", query: "recent" } }], stop: "tool_use" },
    { tools: [{ id: "tu_r", name: "run_app_action", input: { name: "GMAIL_FETCH_EMAILS", args_json: '{"max":5}' } }], stop: "tool_use" },
    { text: "Your CEO wants numbers.", stop: "end_turn" },
  );
  const out = await chat("What's in my inbox?");
  assert.equal(out.at(-1).type, "done");
  const reqs = fake.requests.slice(start);
  const found = JSON.parse(reqs[1].body.messages.at(-1).content[0].content);
  assert.deepEqual(found.actions.map((a) => [a.name, a.readOnly]), [["GMAIL_FETCH_EMAILS", true], ["GMAIL_SEND_EMAIL", false]]);
  const ran = JSON.parse(reqs[2].body.messages.at(-1).content[0].content);
  assert.equal(ran.result.emails[0].subject, "Numbers?");
  assert.ok(!reqs[2].body.tools.some((t) => String(t.type).startsWith("web_")), "no web tools after reading app data");
  const { calls } = await (await stack.api("GET", "/api/v1/apps/fake-calls")).json();
  assert.deepEqual(calls.at(-1), { userId: calls.at(-1).userId, name: "GMAIL_FETCH_EMAILS", args: { max: 5 } });
});

test("a write action waits for approval and runs once with the stored arguments", async () => {
  fake.script.push(
    { tools: [{ id: "tu_w", name: "run_app_action", input: { name: "GMAIL_SEND_EMAIL", args_json: '{"to":"ceo@example.com","body":"Q3 is up 4%."}' } }], stop: "tool_use" },
    { text: "I drafted it; approve to send.", stop: "end_turn" },
  );
  const out = await chat("Reply to the CEO");
  const card = out.find((l) => l.type === "approval");
  assert.ok(card, JSON.stringify(out));
  const before = (await (await stack.api("GET", "/api/v1/apps/fake-calls")).json()).calls.length;
  assert.equal(JSON.parse(fake.requests.at(-1).body.messages.at(-1).content[0].content).status, "waiting for the user's approval");

  const got = await (await stack.api("GET", `/api/v1/approvals/${card.approvalId}`)).json();
  assert.equal(got.status, "pending");
  assert.deepEqual(got.args, { to: "ceo@example.com", body: "Q3 is up 4%." });

  fake.script.push({ text: "Sent.", stop: "end_turn" });
  const cont = await lines(await stack.api("POST", `/api/v1/approvals/${card.approvalId}/approve`));
  assert.equal(cont.at(-1).type, "done");
  const userTurn = fake.requests.at(-1).body.messages.at(-1);
  assert.match(userTurn.content[0].text, /^Approved: GMAIL_SEND_EMAIL\. Result: \{"sent":true/);

  const { calls } = await (await stack.api("GET", "/api/v1/apps/fake-calls")).json();
  assert.equal(calls.length, before + 1, "ran exactly once");
  assert.deepEqual(calls.at(-1).args, { to: "ceo@example.com", body: "Q3 is up 4%." }, "the stored arguments ran");

  const again = await stack.api("POST", `/api/v1/approvals/${card.approvalId}/approve`);
  assert.equal(again.status, 409);
  assert.equal((await (await stack.api("GET", "/api/v1/apps/fake-calls")).json()).calls.length, before + 1);
});

test("refusing records it and runs nothing", async () => {
  fake.script.push({ tools: [{ id: "tu_w2", name: "run_app_action", input: { name: "GMAIL_SEND_EMAIL", args_json: '{"to":"x@example.com"}' } }], stop: "tool_use" }, { text: "Waiting.", stop: "end_turn" });
  const card = (await chat("Send another")).find((l) => l.type === "approval");
  const before = (await (await stack.api("GET", "/api/v1/apps/fake-calls")).json()).calls.length;
  assert.equal((await stack.api("POST", `/api/v1/approvals/${card.approvalId}/refuse`)).status, 200);
  assert.equal((await stack.api("POST", `/api/v1/approvals/${card.approvalId}/approve`)).status, 409);
  assert.equal((await (await stack.api("GET", "/api/v1/apps/fake-calls")).json()).calls.length, before);
  const { messages } = await (await stack.api("GET", `/api/v1/agents/${agentId}/messages?limit=50`)).json();
  assert.equal(messages.at(-1).visible, "Refused: GMAIL_SEND_EMAIL.");
});

test("isolation: another user's approval is 404", async () => {
  fake.script.push({ tools: [{ id: "tu_w3", name: "run_app_action", input: { name: "GMAIL_SEND_EMAIL", args_json: "{}" } }], stop: "tool_use" }, { text: ".", stop: "end_turn" });
  const card = (await chat("one more")).find((l) => l.type === "approval");
  stack.cookie = "";
  await stack.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-a-${Date.now()}@example.com`, password: "correct-horse-9" });
  for (const [m, p] of [["GET", ""], ["POST", "/approve"], ["POST", "/refuse"]]) assert.equal((await stack.api(m, `/api/v1/approvals/${card.approvalId}${p}`)).status, 404, `${m} ${p}`);
  stack.cookie = mine;
});
