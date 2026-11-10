// Before beta: account deletion and browser error reports.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { after, before, test } from "node:test";

import { Stack } from "./harness.mjs";

const stack = new Stack({ controlPort: 19387, wbhostPort: 19390 });
before(() => stack.start());
after(() => stack.stop());

/** Paths on the host that belong to workbook `id`. */
const filesOf = (id) => (existsSync(stack.dataDir) ? readdirSync(stack.dataDir, { recursive: true }).filter((p) => String(p).includes(id)) : []);

test("deleting an account removes its workbooks, files and sign-in", async () => {
  stack.cookie = "";
  const email = `leaver-${Date.now()}@example.com`;
  assert.equal((await stack.api("POST", "/api/auth/sign-up/email", { name: "Leaver", email, password: "correct-horse-9" })).status, 200);
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "mine" });
  await s.close();
  assert.ok(filesOf(id).length > 0, "the workbook has files on the host");

  assert.equal((await stack.api("DELETE", "/api/v1/account", { password: "correct-horse-9" })).status, 400, "needs the word DELETE");
  assert.equal((await stack.api("DELETE", "/api/v1/account", { password: "wrong-password", confirm: "DELETE" })).status, 403);
  assert.equal((await stack.api("DELETE", "/api/v1/account", { password: "correct-horse-9", confirm: "DELETE" })).status, 204);

  assert.equal((await stack.api("GET", "/api/v1/me")).status, 401, "signed out");
  assert.deepEqual(filesOf(id), [], "the workbook's files are gone");
  const login = await stack.api("POST", "/api/auth/sign-in/email", { email, password: "correct-horse-9" });
  assert.notEqual(login.status, 200, "the account no longer signs in");
});

test("browser error reports are accepted, bounded and rate-limited", async () => {
  assert.equal((await stack.api("POST", "/api/v1/client-errors", { message: "boom", stack: "x".repeat(20_000), url: "http://x/" })).status, 204);
  assert.equal((await stack.api("POST", "/api/v1/client-errors", { nope: true })).status, 400);
  let limited = false;
  for (let i = 0; i < 30 && !limited; i++) limited = (await stack.api("POST", "/api/v1/client-errors", { message: `e${i}` })).status === 429;
  assert.ok(limited, "a flood is cut off");
});
