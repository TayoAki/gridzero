// M5 acceptance without the AI panel (BUILD-SPEC §11): custom functions, execute on
// wake, no network from Python, and the shared code editor's relay.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Stack, root, tileTexts, waitFor } from "./harness.mjs";

const sandboxDir = join(root, "services", "sandbox");
const stack = new Stack({
  controlPort: 19087,
  wbhostPort: 19090,
  wbhostEnv: {
    SANDBOX_DIR: sandboxDir,
    ...(process.env.SANDBOX_PYTHON ? { SANDBOX_PYTHON: process.env.SANDBOX_PYTHON } : {}),
    // Set only where bubblewrap cannot run; CI runs the real sandbox.
    ...(process.env.SANDBOX_ALLOW_UNISOLATED ? { SANDBOX_ALLOW_UNISOLATED: "1" } : {}),
  },
});

before(() => stack.start());
after(() => stack.stop());

const run = async (s, source) => s.send({ type: "RunCode", source });
const cell = async (s, row, col) => (await tileTexts(s, 0))[row * 16 + col];

test("=double(B1) works after Run and survives a restart", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 1, raw: "21" });
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 2, raw: "=double(B1)" });
  assert.equal(await cell(s, 0, 2), "#NAME?");

  const r = await run(s, 'def double(x):\n    return x * 2\n\ndef total(xs):\n    return sum(v for v in xs if v is not None)\n\nprint("loaded")\n');
  assert.equal(r.error, null);
  assert.equal(r.output.trim(), "loaded");
  assert.deepEqual(r.functions, ["double", "total"]);
  assert.equal(await cell(s, 0, 2), "42");

  // Formulas keep following their inputs, and ranges arrive as lists.
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 1, raw: "5" });
  assert.equal(await cell(s, 0, 2), "10");
  await s.send({ type: "UpdateCell", sheet: 0, row: 1, col: 1, raw: "7" });
  await s.send({ type: "UpdateCell", sheet: 0, row: 2, col: 2, raw: "=total(B1:B9)" });
  assert.equal(await cell(s, 2, 2), "12");

  await s.close();
  await stack.restartWbhost();
  const back = await stack.open(id);
  assert.equal(await cell(back, 0, 2), "10", "execute on wake restores the function");
  const code = await back.send({ type: "GetCode" });
  assert.ok(code.source.includes("def double"));
  assert.equal(code.execute_on_wake, true);

  // Turned off, the function is gone after the next load.
  await back.send({ type: "SetExecuteOnWake", on: false });
  await back.close();
  await stack.restartWbhost();
  const off = await stack.open(id);
  assert.equal(await cell(off, 0, 2), "#NAME?");
  await off.close();
});

test("Python cannot reach the network", async () => {
  const s = await stack.open(await stack.newWorkbook());
  const r = await run(
    s,
    [
      "import urllib.request",
      "try:",
      "    urllib.request.urlopen('http://example.com', timeout=5)",
      "    print('reached')",
      "except Exception as e:",
      "    print('blocked', type(e).__name__)",
    ].join("\n"),
  );
  assert.equal(r.error, null);
  assert.match(r.output, /^blocked/);
  await s.close();
});

test("errors and runaway functions are contained", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const bad = await run(s, "def broken(:\n");
  assert.match(bad.error, /SyntaxError/);
  await run(s, "import time\ndef boom(x):\n    raise ValueError('nope')\ndef slow(x):\n    time.sleep(30)\n");
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "=boom(1)" });
  assert.equal(await cell(s, 0, 0), "#VALUE!");
  const t0 = Date.now();
  await s.send({ type: "UpdateCell", sheet: 0, row: 1, col: 0, raw: "=slow(1)" });
  assert.equal(await cell(s, 1, 0), "#VALUE!");
  assert.ok(Date.now() - t0 < 15_000, "a stuck function is stopped");
  const again = await run(s, "def ok(x):\n    return x\n");
  assert.equal(again.error, null, "Run restarts Python afterwards");
  await s.close();
});

test("the SDK reads and writes the workbook; viewers cannot Run", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "3" });
  const r = await run(
    s,
    [
      "import gridzero as gz",
      "s = gz.sheet(0)",
      "print(gz.get_values(gz.sheet_range(s, 'A1:A1')))",
      "gz.update_cell(s, 'B2', '=A1*2')",
    ].join("\n"),
  );
  assert.equal(r.error, null);
  assert.match(r.output, /\[\['3'\]\]/);
  assert.equal(await cell(s, 1, 1), "6");

  // Saving code is not an edit you can undo by accident.
  const before = await s.send({ type: "GetCode" });
  await s.send({ type: "Undo" });
  assert.equal((await s.send({ type: "GetCode" })).source, before.source);

  await stack.api("PUT", `/api/v1/workbooks/${id}/link`, { linkAccess: "view", allowCopy: true });
  const owner = stack.cookie;
  stack.cookie = "";
  await stack.api("POST", "/api/auth/sign-up/email", { name: "V", email: `v-${Date.now()}@example.com`, password: "correct-horse-9" });
  const v = await stack.open(id);
  stack.cookie = owner;
  await assert.rejects(run(v, "print(1)"), /forbidden/);
  await v.close();
  await s.close();
});

test("the code socket stores updates, replays them, and ignores viewers", async () => {
  const id = await stack.newWorkbook();
  const g = await stack.grant(id);
  const url = `${g.endpoint.replace(/\/ws$/, "/code")}?token=${g.token}`;
  const connect = async () => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const got = [];
    ws.onmessage = (e) => got.push([...new Uint8Array(e.data)]);
    await new Promise((r) => (ws.onopen = r));
    return { ws, got };
  };
  const a = await connect();
  const b = await connect();
  a.ws.send(new Uint8Array([0, 9, 9]));
  await waitFor(() => b.got.length === 1, "relay to the other editor");
  assert.deepEqual(b.got[0], [0, 9, 9]);
  a.ws.close();
  b.ws.close();
  await stack.restartWbhost();
  const c = await connect();
  await waitFor(() => c.got.length === 1, "replay after a restart");
  assert.deepEqual(c.got[0], [0, 9, 9]);
  c.ws.close();
});
