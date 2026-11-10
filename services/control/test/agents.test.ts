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
