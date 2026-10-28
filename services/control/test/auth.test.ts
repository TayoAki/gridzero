// Control-plane API: auth (M0 acceptance) and workbook lifecycle (M1).
// Needs DATABASE_URL, BETTER_AUTH_SECRET and WB_TOKEN_SECRET (CI provides a Postgres service).

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

test("workbook create, rename, open and delete are owner-only", async () => {
  const owner = sessionCookie(await post("/api/auth/sign-up/email", { name: "Owner", email: `owner-${Date.now()}@example.com`, password }));
  const other = sessionCookie(await post("/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password }));

  const created = await post("/api/v1/workbooks", {}, owner);
  assert.equal(created.status, 201);
  const { id, title } = await created.json();
  assert.match(id, /^[0-9A-F]{24}$/);
  assert.equal(title, "Untitled Workbook");

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, { method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });

  assert.equal((await call("PATCH", `/api/v1/workbooks/${id}`, owner, { title: "Q4 model" })).status, 200);
  assert.equal((await call("PATCH", `/api/v1/workbooks/${id}`, owner, { title: "" })).status, 400);
  assert.equal((await call("PATCH", `/api/v1/workbooks/${id}`, other, { title: "mine" })).status, 404);

  const open = await call("POST", `/api/v1/workbooks/${id}/open`, owner);
  assert.equal(open.status, 200);
  const grant = await open.json();
  assert.equal(grant.title, "Q4 model");
  assert.ok(grant.endpoint.endsWith(`/wb/${id}/ws`));
  const claims = JSON.parse(Buffer.from(grant.token.split(".")[1], "base64url").toString());
  assert.equal(claims.wb, id);
  assert.equal(claims.role, "owner");
  assert.ok(claims.exp > Date.now() / 1000);
  assert.equal((await call("POST", `/api/v1/workbooks/${id}/open`, other)).status, 404);

  assert.equal((await call("DELETE", `/api/v1/workbooks/${id}`, other)).status, 404);
  assert.equal((await call("DELETE", `/api/v1/workbooks/${id}`, owner)).status, 204);
  const list = await (await call("GET", "/api/v1/workbooks", owner)).json();
  assert.deepEqual(list.workbooks, []);
  assert.equal((await call("POST", `/api/v1/workbooks/${id}/open`, owner)).status, 404);
});
