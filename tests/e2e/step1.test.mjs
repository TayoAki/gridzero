// Used by, the activity log, usage, and what an administrator and an auditor can see.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId, total, bySource;
const ADMIN = "admin-step1@example.com";
const AUDITOR = "auditor-step1@example.com";

const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const csvOf = (n) => ["order_id,source,amount", ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? "Email" : "Ads"},${i + 1}`)].join("\n") + "\n";
const query = (sql, shape) => ({ kind: "table_query", workbookId, sql, shape });

async function person(name, email = `${name.toLowerCase()}-${Date.now()}@example.com`) {
  const p = new Stack({ controlPort: 8961, wbhostPort: 8962 });
  p.base = stack.base;
  const up = await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" });
  // A fixed address may exist from an earlier run.
  if (up.status !== 200) assert.equal((await p.api("POST", "/api/auth/sign-in/email", { email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}
const join = async (p, share) => assert.equal((await p.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`)).status, 200);

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8961, wbhostPort: 8962, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", ADMIN_EMAILS: ADMIN, AUDITOR_EMAILS: AUDITOR } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "orders", csv: csvOf(20) }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import my orders" }).then((r) => r.text());
  const add = async (title, form, source) => (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title, form, theme: "blue", source }))).widget;
  total = await add("Revenue", "number", query('SELECT SUM("amount") FROM "orders"', "number"));
  bySource = await add("Revenue by source", "bars", query('SELECT "source", SUM("amount") FROM "orders" GROUP BY 1 ORDER BY 1', "series"));
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("a table and a field say which cards, reports and people are built on them", async () => {
  const ana = await person("Ana");
  const { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ana.email, role: "viewer", limits: [{ field: "source", values: ["Ads"] }] }));
  await join(ana, share);

  let res = await stack.api("GET", `/api/v1/used-by?kind=table&id=${workbookId}:orders`);
  assert.equal(res.status, 200);
  let used = await res.json();
  assert.equal(used.item.label, "orders");
  assert.deepEqual(used.cards.map((c) => c.title).sort(), ["Revenue", "Revenue by source"]);
  assert.equal(used.reports.length, 1);
  assert.equal(used.people.total, 2);
  assert.ok(used.people.list.some((p) => p.email === ana.email && p.limited));

  // Only one card reads the source column.
  used = await json(await stack.api("GET", `/api/v1/used-by?kind=field&id=${workbookId}:orders:source`));
  assert.deepEqual(used.cards.map((c) => c.title), ["Revenue by source"]);
  // A column nothing reads.
  used = await json(await stack.api("GET", `/api/v1/used-by?kind=field&id=${workbookId}:orders:order_id`));
  assert.equal(used.cards.length, 0);
  assert.equal(used.people.total, 0);

  // A report says who sees it; a viewer and a stranger are told nothing.
  used = await json(await stack.api("GET", `/api/v1/used-by?kind=report&id=${boardId}`));
  assert.equal(used.people.total, 2);
  assert.equal((await ana.api("GET", `/api/v1/used-by?kind=report&id=${boardId}`)).status, 404);
  assert.equal((await ana.api("GET", `/api/v1/used-by?kind=table&id=${workbookId}:orders`)).status, 404);
  assert.equal((await stack.api("GET", "/api/v1/used-by?kind=nothing&id=x")).status, 400);
});

test("announcing a change tells the owners of what is built on it, once each", async () => {
  // Bo can edit the workbook and builds his own report on it.
  const bo = await person("Bo");
  const invite = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: bo.email, role: "editor" }));
  const token = (invite.share?.inviteUrl ?? invite.inviteUrl ?? "").split("/").pop();
  assert.equal((await bo.api("POST", `/api/v1/invites/${token}/accept`)).status, 200);
  const boBoard = (await json(await bo.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  assert.equal((await bo.api("POST", `/api/v1/dashboards/${boBoard}/widgets`, { title: "Orders", form: "number", theme: "blue", source: query('SELECT COUNT(*) FROM "orders"', "number") })).status, 201);

  const used = await json(await stack.api("GET", `/api/v1/used-by?kind=table&id=${workbookId}:orders`));
  assert.equal(used.reports.length, 2);

  const res = await stack.api("POST", "/api/v1/announcements", { kind: "field", id: `${workbookId}:orders:amount`, message: "amount will be in cents", effectiveOn: "2026-12-01" });
  assert.equal(res.status, 201);
  // The amount column is read by the owner's two cards only, so nobody else is told.
  assert.equal((await res.json()).told, 0);
  const told = await json(await stack.api("POST", "/api/v1/announcements", { kind: "table", id: `${workbookId}:orders`, message: "orders moves to a new export" }));
  assert.equal(told.told, 1);
  const notes = await json(await bo.api("GET", "/api/v1/notifications"));
  assert.match(notes.notifications[0].title, /orders is changing/);
  assert.match(notes.notifications[0].body, /orders moves to a new export/);
  // It stays on the thing.
  const again = await json(await stack.api("GET", `/api/v1/used-by?kind=table&id=${workbookId}:orders`));
  assert.equal(again.announcements[0].message, "orders moves to a new export");
  assert.equal((await stack.api("POST", "/api/v1/announcements", { kind: "table", id: `${workbookId}:orders`, message: "x" })).status, 400);
});

test("opening, querying and sharing are logged, and the owner reads the log and the usage", async () => {
  const cy = await person("Cy");
  const { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: cy.email, role: "viewer" }));
  await join(cy, share);
  await cy.api("GET", `/api/v1/dashboards/${boardId}/widgets`);
  await cy.api("GET", `/api/v1/dashboards/${boardId}/widgets`);
  await stack.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql: 'SELECT COUNT(*) FROM "orders"' });
  await new Promise((r) => setTimeout(r, 300));

  const log = await json(await stack.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  const kinds = log.events.map((e) => e.kind);
  assert.ok(kinds.includes("share.added"));
  assert.ok(log.events.some((e) => e.kind === "report.opened" && e.who === "Cy"));
  assert.ok(log.events.find((e) => e.kind === "share.added" && e.detail.email === cy.email));
  // A viewer reads only what they did themselves.
  const theirs = await json(await cy.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  assert.ok(theirs.events.length >= 2);
  assert.ok(theirs.events.every((e) => e.who === "Cy"));

  const usage = await json(await stack.api("GET", "/api/v1/activity/usage"));
  const row = usage.reports.find((r) => r.id === boardId);
  assert.ok(row.opens >= 2);
  assert.ok(row.people >= 1);
  const q = usage.cost.queries.find((x) => x.kind === "workbook" && x.id === workbookId);
  assert.ok(q && q.runs >= 1);
});

test("an administrator lists everyone and views as one person; nobody else can", async () => {
  const dee = await person("Dee");
  const { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: dee.email, role: "viewer", limits: [{ field: "source", values: ["Email"] }] }));
  await join(dee, share);
  assert.equal((await stack.api("GET", "/api/v1/admin/overview")).status, 403);
  assert.equal((await stack.api("GET", `/api/v1/admin/access?email=${dee.email}`)).status, 403);

  const admin = await person("Admin", ADMIN);
  assert.equal((await json(await admin.api("GET", "/api/v1/me"))).admin, true);
  const over = await json(await admin.api("GET", "/api/v1/admin/overview"));
  assert.ok(over.people.some((p) => p.email === dee.email));
  assert.ok(over.active >= 1);
  const seen = await json(await admin.api("GET", `/api/v1/admin/access?email=${encodeURIComponent(dee.email)}`));
  const r = seen.reports.find((x) => x.id === boardId);
  assert.equal(r.role, "viewer");
  assert.equal(r.rows, "source is Email");
  assert.match(r.tables, /no tables/);
  assert.ok(seen.changes.some((x) => x.kind === "share.added"));
  // Seeing the list is not access: the administrator still cannot open the report.
  assert.equal((await admin.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
  const all = await json(await admin.api("GET", "/api/v1/activity/usage?everyone=1"));
  assert.ok(all.reports.some((x) => x.id === boardId));
});

test("an auditor can read any report and its log, and change nothing", async () => {
  const aud = await person("Auditor", AUDITOR);
  assert.equal((await json(await aud.api("GET", "/api/v1/me"))).auditor, true);
  const res = await aud.api("GET", `/api/v1/dashboards/${boardId}/widgets`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, "viewer");
  const log = await json(await aud.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  assert.ok(log.events.some((e) => e.kind === "share.added"));
  assert.ok([403, 404].includes((await aud.api("PATCH", `/api/v1/widgets/${total.id}`, { title: "Changed" })).status));
  assert.ok([403, 404].includes((await aud.api("DELETE", `/api/v1/widgets/${bySource.id}`)).status));
  assert.equal((await aud.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: "x@example.com", role: "viewer" })).status, 404);
});
