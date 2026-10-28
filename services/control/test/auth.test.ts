// M0 acceptance: sign up -> authenticated /me -> empty workbook list.
// Needs DATABASE_URL and BETTER_AUTH_SECRET (CI provides a Postgres service).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { app } from "../src/app.ts";
import { runMigrations, sql } from "../src/db/client.ts";
import { env } from "../src/env.ts";

const origin = env.publicUrl;
const email = `ci-${Date.now()}@example.com`;
const password = "correct-horse-9";

before(runMigrations);
after(() => sql.end());

function post(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(/better-auth\.session_token=[^;]+/);
  assert.ok(match, "sign-up/in sets a session cookie");
  return match[0];
}

test("health check reaches the database", async () => {
  const res = await app.request("/api/v1/health");
  assert.equal(res.status, 200);
});

test("unauthenticated /me is rejected", async () => {
  assert.equal((await app.request("/api/v1/me")).status, 401);
});

test("sign up, read /me and an empty workbook list, then sign in again", async () => {
  const signUp = await post("/api/auth/sign-up/email", { name: "CI User", email, password });
  assert.equal(signUp.status, 200);
  const cookie = sessionCookie(signUp);

  const me = await app.request("/api/v1/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, email);

  const list = await app.request("/api/v1/workbooks", { headers: { Cookie: cookie } });
  assert.deepEqual(await list.json(), { workbooks: [] });

  assert.equal((await post("/api/auth/sign-up/email", { name: "Dup", email, password })).status, 422);
  assert.equal((await post("/api/auth/sign-in/email", { email, password: "wrong-password" })).status, 401);
  assert.equal((await post("/api/auth/sign-in/email", { email, password })).status, 200);
});
