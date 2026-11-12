// Reading from outside with a personal token, the catalog, a tracked model, a release posted to a
// webhook, and company sign-in through an identity provider that speaks OpenID Connect.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, idp, hook, agentId, workbookId, boardId, sourceId;
const hooked = [];
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const say = async (script) => {
  fake.script.push(...script);
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "go" }).then((r) => r.text());
};
const withToken = (token, method, path, body) => fetch(stack.base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function person(name) {
  const p = new Stack({ controlPort: 8981, wbhostPort: 8982 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

before(async () => {
  // A stand-in identity provider: discovery, a token endpoint and who the person is.
  idp = createServer((req, res) => {
    const send = (body) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url.startsWith("/.well-known/openid-configuration")) return send({ issuer: "http://127.0.0.1:8983", authorization_endpoint: "http://127.0.0.1:8983/authorize", token_endpoint: "http://127.0.0.1:8983/token", userinfo_endpoint: "http://127.0.0.1:8983/userinfo" });
    if (req.url.startsWith("/token")) return send({ access_token: "access-1", token_type: "Bearer", expires_in: 3600 });
    if (req.url.startsWith("/userinfo")) return send({ sub: "emp-42", email: "sam.okoro@corp.example", name: "Sam Okoro", email_verified: true });
    res.writeHead(404).end();
  });
  await new Promise((r) => idp.listen(8983, "127.0.0.1", r));
  hook = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hooked.push(JSON.parse(body));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => hook.listen(8984, "127.0.0.1", r));
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8981, wbhostPort: 8982, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", WEBHOOK_ALLOW_PRIVATE: "1", OIDC_DISCOVERY_URL: "http://127.0.0.1:8983/.well-known/openid-configuration", OIDC_CLIENT_ID: "gridzero", OIDC_CLIENT_SECRET: "idp-secret", OIDC_NAME: "Corp" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await say([call("write_table", { workbook_id: workbookId, name: "scores", csv: "account,churn_risk\nA,0.8\nB,0.2\nC,0.5\n" }), { text: "Imported.", stop: "end_turn" }]);
  await say([call("list_tables", { workbook_id: workbookId }), { text: "Looked.", stop: "end_turn" }]);
  const spaces = (await json(await stack.api("GET", "/api/v1/workspaces"))).workspaces;
  sourceId = (await json(await stack.api("GET", `/api/v1/workspaces/${spaces[0].id}/sources`))).sources[0].id;
});

after(async () => {
  stack?.stop();
  await fake?.close();
  idp?.close();
  hook?.close();
});

test("a personal token reads what its owner can see, and nothing else", async () => {
  let res = await stack.api("POST", "/api/v1/tokens", { name: "Churn notebook" });
  assert.equal(res.status, 201);
  const { token, id } = await res.json();
  assert.match(token, /^gz_/);
  // The token is shown once: the list holds its name, never the token.
  const list = await json(await stack.api("GET", "/api/v1/tokens"));
  assert.deepEqual(list.tokens.map((t) => t.name), ["Churn notebook"]);
  assert.ok(!JSON.stringify(list).includes(token));

  // The catalog: sources, definitions with versions, and the latest release.
  await stack.api("POST", `/api/v1/sources/${sourceId}/releases`, { label: "2026.11", webhook: "http://127.0.0.1:8984/ci" });
  res = await withToken(token, "GET", "/api/v1/catalog");
  assert.equal(res.status, 200);
  const cat = await res.json();
  const src = cat.sources.find((s) => s.id === sourceId);
  assert.equal(src.release.label, "2026.11");
  assert.ok(src.definitions.length > 0);
  assert.ok(src.definitions.every((d) => typeof d.version === "number"));
  // The release was posted, whole, to the pipeline's address.
  assert.equal(hooked.at(-1).release.label, "2026.11");
  assert.ok(hooked.at(-1).release.definitions.length > 0);

  // It can run the read-only query, and nothing that changes anything.
  res = await withToken(token, "POST", `/api/v1/workbooks/${workbookId}/query`, { sql: 'SELECT COUNT(*) FROM "scores"' });
  assert.equal(res.status, 200);
  assert.equal(Number((await res.json()).rows[0][0]), 3);
  assert.equal((await withToken(token, "POST", `/api/v1/workbooks/${workbookId}/query`, { sql: 'DELETE FROM "scores"' })).status, 400);
  assert.equal((await withToken(token, "POST", "/api/v1/workbooks")).status, 401);
  assert.equal((await withToken(token, "DELETE", `/api/v1/dashboards/${boardId}`)).status, 401);
  assert.equal((await withToken(token, "PUT", `/api/v1/dashboards/${boardId}/shares`, { email: "x@example.com", role: "viewer" })).status, 401);
  // A token cannot make or list tokens, and a made-up one is nobody.
  assert.equal((await withToken(token, "POST", "/api/v1/tokens", { name: "more" })).status, 401);
  assert.equal((await withToken(token, "GET", "/api/v1/tokens")).status, 401);
  assert.equal((await withToken("gz_made-up-token-value-000000000000", "GET", "/api/v1/catalog")).status, 401);
  // Someone else's workbook is still theirs.
  const other = await person("Oz");
  const theirs = (await json(await other.api("POST", "/api/v1/workbooks"))).id;
  assert.equal((await withToken(token, "POST", `/api/v1/workbooks/${theirs}/query`, { sql: "SELECT 1" })).status, 404);

  assert.equal((await stack.api("DELETE", `/api/v1/tokens/${id}`)).status, 204);
  assert.equal((await withToken(token, "GET", "/api/v1/catalog")).status, 401);
});

test("a model's new version reaches the owners of the reports that read its predictions", async () => {
  // Bo can edit the workbook and has a card on the scores table.
  const bo = await person("Bo");
  const invite = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: bo.email, role: "editor" }));
  assert.equal((await bo.api("POST", `/api/v1/invites/${(invite.share?.inviteUrl ?? invite.inviteUrl).split("/").pop()}/accept`)).status, 200);
  const boBoard = (await json(await bo.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  assert.equal((await bo.api("POST", `/api/v1/dashboards/${boBoard}/widgets`, { title: "Accounts at risk", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT COUNT(*) FROM "scores" WHERE "churn_risk" > 0.4', shape: "number" } })).status, 201);

  let res = await stack.api("POST", "/api/v1/models", { name: "Churn model", version: "3", workbookId, table: "scores" });
  assert.equal(res.status, 201);
  const model = (await res.json()).model;
  // His report says which model it rests on.
  let board = await json(await bo.api("GET", `/api/v1/dashboards/${boBoard}/widgets`));
  assert.deepEqual(board.models, [{ name: "Churn model", version: "3" }]);

  res = await stack.api("PATCH", `/api/v1/models/${model.id}`, { version: "4", notes: "Retrained on October data" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).told, 1);
  const note = (await json(await bo.api("GET", "/api/v1/notifications"))).notifications[0];
  assert.equal(note.title, "Churn model is now version 4");
  assert.match(note.body, /It was 3\. 1 card reads? its predictions\. Retrained on October data/);
  board = await json(await bo.api("GET", `/api/v1/dashboards/${boBoard}/widgets`));
  assert.equal(board.models[0].version, "4");
  const mine = (await json(await stack.api("GET", "/api/v1/models"))).models[0];
  assert.deepEqual(mine.history.map((h) => h.version), ["3"]);
  assert.equal((await stack.api("PATCH", `/api/v1/models/${model.id}`, { version: "4" })).status, 400);
  assert.equal((await bo.api("PATCH", `/api/v1/models/${model.id}`, { version: "5" })).status, 404);
});

test("someone signs in through the company's identity provider and lands in their own account", async () => {
  const options = await (await fetch(`${stack.base}/api/v1/auth/options`)).json();
  assert.equal(options.company, "Corp");
  const jar = new Map();
  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  // The app hands back the provider's address, with a state it will check on the way back.
  let res = keep(await fetch(`${stack.base}/api/auth/sign-in/social`, { method: "POST", headers: { "Content-Type": "application/json", Origin: stack.base }, body: JSON.stringify({ provider: "company", callbackURL: "/" }) }));
  assert.equal(res.status, 200, await res.clone().text());
  const { url } = await res.json();
  const going = new URL(url);
  assert.equal(going.origin, "http://127.0.0.1:8983");
  assert.equal(going.searchParams.get("client_id"), "gridzero");
  assert.match(going.searchParams.get("redirect_uri"), /\/api\/auth\/callback\/company$/);
  // The provider sends the person back with a code.
  res = keep(await fetch(`${stack.base}/api/auth/callback/company?code=code-1&state=${encodeURIComponent(going.searchParams.get("state"))}`, { headers: { Cookie: cookie() }, redirect: "manual" }));
  assert.ok([302, 303].includes(res.status), `callback gave ${res.status}: ${await res.clone().text()}`);
  const me = await (await fetch(`${stack.base}/api/v1/me`, { headers: { Cookie: cookie() } })).json();
  assert.equal(me.email, "sam.okoro@corp.example");
  assert.equal(me.name, "Sam Okoro");
  // A made-up state is refused.
  res = await fetch(`${stack.base}/api/auth/callback/company?code=code-1&state=made-up`, { redirect: "manual" });
  const where = res.headers.get("location") ?? "";
  assert.ok(res.status >= 400 || /error/.test(where), `a made-up state gave ${res.status} ${where}`);
});
