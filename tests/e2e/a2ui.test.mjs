// A2UI 1.0: an agent shows a small interface in chat; every message is checked before it is drawn.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId;
const BASIC = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
const GRIDZERO = "https://gridzero.app/a2ui/catalogs/report/v1/catalog.json";
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const lastResult = () => fake.requests.at(-1).body.messages.at(-1).content.find((b) => b.type === "tool_result");

/** Have the agent call show_ui. Gives the surface line the chat received, or why it was refused. */
async function show(messages) {
  fake.script.push(call("show_ui", { messages }), { text: "Pick one.", stop: "end_turn" });
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "show me" });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return { line: lines.find((l) => l.type === "a2ui") ?? null, refused: lastResult()?.is_error ? lastResult().content : null };
}

const surface = (id, components, extra = {}) => [{ version: "1.0", createSurface: { surfaceId: id, components, ...extra } }];
const picker = [
  { id: "root", component: "Card", child: "col" },
  { id: "col", component: "Column", children: ["ask", "period", "chart", "go"] },
  { id: "ask", component: "Text", text: "Which period?" },
  { id: "period", component: "ChoicePicker", label: "Period", variant: "mutuallyExclusive", displayStyle: "chips", options: [{ label: "Last 30 days", value: "30d" }, { label: "This year", value: "year" }], value: { "@path": "/form/period" } },
  { id: "chart", component: "GridZeroChart", "@catalogId": GRIDZERO, title: "Revenue by source", form: "bars", theme: "green", data: { kind: "series", points: [{ label: "Ads", value: 10 }, { label: "Email", value: 7 }] } },
  { id: "go", component: "Button", child: "go_label", variant: "primary", action: { event: { name: "period_chosen", userMessage: "Use the chosen period", context: { period: { "@path": "/form/period" } } } } },
  { id: "go_label", component: "Text", text: "Show it" },
];

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8983, wbhostPort: 8984, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await (await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" })).json()).agent.id;
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("the renderer says what it can draw, and serves its own catalog", async () => {
  const caps = await (await fetch(stack.base + "/api/v1/a2ui/capabilities")).json();
  assert.equal(caps.version, "1.0");
  assert.equal(caps.mimeType, "application/a2ui+json");
  assert.deepEqual(caps.rendererCapabilities.supportedCatalogIds, [BASIC, GRIDZERO]);
  const catalog = await (await fetch(stack.base + "/api/v1/a2ui/catalog.json")).json();
  assert.equal(catalog.catalogId, GRIDZERO);
  assert.equal(catalog.protocolVersion, "1.0");
  assert.deepEqual(Object.keys(catalog.components), ["GridZeroChart"]);
  assert.deepEqual(catalog.components.GridZeroChart.required, ["component", "form", "data"]);
});

test("an agent shows a surface, it reaches the chat, and it is there again when the chat is reopened", async () => {
  const messages = [...surface("pick_period", picker, { dataModel: { form: { period: ["30d"] } } }), { version: "1.0", updateDataModel: { surfaceId: "pick_period", path: "/form/note", value: "hello" } }];
  const { line, refused } = await show(messages);
  assert.equal(refused, null);
  assert.equal(line.surfaceId, "pick_period");
  assert.deepEqual(line.messages, messages);
  // The agent is told the tool and the format.
  const tool = fake.requests.at(-1).body.tools.find((t) => t.name === "show_ui");
  for (const hint of [/A2UI 1\.0/, /GridZeroChart/, /"@path"/, /\(A2UI action: /]) assert.match(tool.description, hint);

  const history = await (await stack.api("GET", `/api/v1/agents/${agentId}/messages`)).json();
  const reply = history.messages.filter((m) => m.role === "assistant").find((m) => m.surfaces.length);
  assert.deepEqual(reply.surfaces, [messages]);
});

test("what the person does on a surface goes back to the agent as an A2UI action", async () => {
  const action = { name: "period_chosen", userMessage: "Use the chosen period", surfaceId: "pick_period", sourceComponentId: "go", timestamp: new Date().toISOString(), context: { period: ["year"] } };
  fake.script.push({ text: "This year it is.", stop: "end_turn" });
  const res = await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: `Use the chosen period\n\n(A2UI action: ${JSON.stringify({ version: "1.0", action })})` });
  await res.text();
  const sent = fake.requests.at(-1).body.messages.at(-1).content;
  const text = typeof sent === "string" ? sent : sent.map((b) => b.text ?? "").join("");
  assert.match(text, /\(A2UI action: \{"version":"1\.0","action":\{"name":"period_chosen"/);
  assert.match(text, /"context":\{"period":\["year"\]\}/);
});

test("a surface that could mislead or break is refused, with the reason", async () => {
  const text = (id, t = "x") => ({ id, component: "Text", text: t });
  const cases = [
    [[{ version: "0.9", createSurface: { surfaceId: "a", components: [text("root")] } }], /version/],
    [[{ version: "1.0", updateComponents: { surfaceId: "a", components: [text("root")] } }], /first message must be createSurface/],
    [surface("a", [text("top")]), /id "root"/],
    [surface("a", [{ id: "root", component: "Column", children: ["missing"] }]), /names a child, missing, that is not defined/],
    [surface("a", [{ id: "root", component: "Video", url: "https://example.com/v.mp4" }]), /Video is not drawn here/],
    [surface("a", [{ id: "root", component: "Script", src: "https://example.com/x.js" }]), /Script is not drawn here/],
    [surface("a", [{ id: "root", component: "Image", url: "http://example.com/a.png" }]), /https:\/\//],
    [surface("a", [{ id: "root", component: "Image", url: { "@path": "/img" } }]), /written out/],
    [surface("a", [{ id: "root", component: "Button", child: "t", action: { functionCall: { "@call": "openUrl", args: { url: "javascript:alert(1)" } } } }, text("t")]), /https:\/\//],
    [surface("a", [{ id: "root", component: "Button", child: "t", action: { functionCall: { "@call": "eval", args: {} } } }, text("t")]), /only function a Button may call is openUrl/],
    [surface("a", [{ id: "root", component: "Button", child: "t" }, text("t")]), /needs an action/],
    [surface("a", [{ id: "root", component: "GridZeroChart", form: "scatter", data: { kind: "series", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] } }]), /cannot show series data/],
    [surface("a", [{ id: "root", component: "GridZeroChart", form: "bars", data: { kind: "rows" } }]), /not chart data/],
    [surface("a", [{ id: "root", component: "GridZeroChart", form: "slicer", data: { kind: "number", value: 1, unit: null, delta: null, label: null } }]), /form must be one of/],
    [surface("a", [text("root")], { catalogId: "https://evil.example/catalog.json" }), /catalogId must be/],
    [[...surface("a", [text("root")]), { version: "1.0", updateComponents: { surfaceId: "b", components: [text("x")] } }], /one surface/],
    [surface("a", [text("root", "x".repeat(70_000))]), /larger than/],
    [surface("a", Array.from({ length: 81 }, (_, i) => text(i === 0 ? "root" : `t${i}`))), /./],
    [surface("bad id!", [text("root")]), /letters, digits/],
  ];
  for (const [messages, why] of cases) {
    const { line, refused } = await show(messages);
    assert.equal(line, null, JSON.stringify(messages).slice(0, 120));
    assert.match(refused, why, JSON.stringify(messages).slice(0, 120));
  }
});
