// Priority, a form for people without an account, example rows, acknowledging a change, targets by
// period, sensitive coverage, finding a definition, two snapshots side by side, an evidence file, and
// four things a second walk through the roles found broken.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId, rev, sourceId;
const ADMIN = `admin-step8-${Date.now()}@example.com`, AUDITOR = `auditor-step8-${Date.now()}@example.com`;
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const say = async (script) => { fake.script.push(...script); await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "go" }).then((r) => r.text()); };
const anon = (method, path, body) => fetch(stack.base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function person(name, email = `${name.toLowerCase()}-${Date.now()}@example.com`) {
  const p = new Stack({ controlPort: 8941, wbhostPort: 8942 });
  p.base = stack.base;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}
const shareBoard = async (p, extra = {}) => { const r = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: p.email, role: "viewer", ...extra })); await p.api("POST", `/api/v1/report-invites/${r.share.inviteUrl.split("/").pop()}/accept`); };
const shareBook = async (p, role) => { const r = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: p.email, role })); await p.api("POST", `/api/v1/invites/${(r.share?.inviteUrl ?? r.inviteUrl).split("/").pop()}/accept`); };

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8941, wbhostPort: 8942, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", ADMIN_EMAILS: ADMIN, AUDITOR_EMAILS: AUDITOR } });
  await stack.start();
  await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await say([call("write_table", { workbook_id: workbookId, name: "orders", csv: "order_id,region,email,amount\n1,North,a@x.example,100\n2,North,b@x.example,200\n3,South,c@x.example,300\n" }), { text: "ok", stop: "end_turn" }]);
  await say([call("list_tables", { workbook_id: workbookId }), { text: "ok", stop: "end_turn" }]);
  const q = (sql, shape) => ({ kind: "table_query", workbookId, sql, shape });
  rev = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Revenue", form: "number", theme: "blue", source: q('SELECT SUM("amount") FROM "orders"', "number") }))).widget;
  await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "By region", form: "table", theme: "blue", source: q('SELECT "region", SUM("amount") AS "Revenue" FROM "orders" GROUP BY 1 ORDER BY 1', "table") });
  const spaces = (await json(await stack.api("GET", "/api/v1/workspaces"))).workspaces;
  sourceId = (await json(await stack.api("GET", `/api/v1/workspaces/${spaces[0].id}/sources`))).sources[0].id;
});
after(async () => { stack?.stop(); await fake?.close(); });

test("the queue is worked by priority, and example rows travel with a request", async () => {
  const pm = await person("Pam");
  const mk = async (title, priority) => (await json(await stack.api("POST", "/api/v1/work", { kind: "request", title, assignee: pm.email, ...(priority ? { priority } : {}) }))).item;
  await mk("Nice to have", "low");
  const second = await mk("Board pack is wrong", "urgent");
  await mk("Ordinary ask");
  assert.deepEqual((await json(await pm.api("GET", "/api/v1/work"))).items.map((i) => i.title), ["Board pack is wrong", "Ordinary ask", "Nice to have"]);
  // The person it was given to re-ranks it, and it moves.
  assert.equal((await pm.api("PATCH", `/api/v1/work/${second.id}`, { priority: "low" })).status, 200);
  assert.equal((await json(await pm.api("GET", "/api/v1/work"))).items[0].title, "Ordinary ask");
  assert.equal((await stack.api("POST", "/api/v1/work", { kind: "request", title: "Bad rank", assignee: pm.email, priority: "now" })).status, 400);

  const withRows = await json(await stack.api("POST", "/api/v1/work", { kind: "request", title: "Count these, not those", assignee: pm.email, examples: { columns: ["order_id", "status", "counts"], rows: [["12", "paid", "yes"], ["10", "cancelled", "no"]] } }));
  assert.deepEqual(withRows.item.examples.rows[1], ["10", "cancelled", "no"]);
  assert.equal((await stack.api("PATCH", `/api/v1/work/${withRows.item.id}`, { examples: { columns: ["a"], rows: Array.from({ length: 21 }, () => ["x"]) } })).status, 400);
});

test("someone without an account asks through a form, and the request reaches its owner", async () => {
  let res = await stack.api("POST", "/api/v1/intake-links", { title: "Ask the data team" });
  assert.equal(res.status, 201);
  const { token, url } = await res.json();
  assert.match(url, /\/ask\//);
  assert.equal((await json(await anon("GET", `/api/v1/public/intake/${token}`))).title, "Ask the data team");
  assert.equal((await anon("POST", `/api/v1/public/intake/${token}`, { email: "not-an-email", title: "x" })).status, 400);
  res = await anon("POST", `/api/v1/public/intake/${token}`, { email: "sam@partner.example", title: "Churn by plan for Q4", body: "For the review on the 3rd" });
  assert.equal(res.status, 201);
  const mine = (await json(await stack.api("GET", "/api/v1/work"))).items.find((i) => i.title === "Churn by plan for Q4");
  assert.equal(mine.requester, "sam@partner.example");
  assert.equal(mine.status, "new");
  assert.match(mine.events[0].text, /asked through the form/);
  assert.equal((await anon("POST", "/api/v1/public/intake/made-up-token-000000", { email: "a@b.example", title: "hello" })).status, 404);
  assert.equal((await stack.api("DELETE", `/api/v1/intake-links/${token}`)).status, 204);
  assert.equal((await anon("POST", `/api/v1/public/intake/${token}`, { email: "a@b.example", title: "hello" })).status, 404);
});

test("owners downstream say they have seen a change, and the announcer sees how many have", async () => {
  const bo = await person("Bo");
  await shareBook(bo, "editor");
  const boBoard = (await json(await bo.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await bo.api("POST", `/api/v1/dashboards/${boBoard}/widgets`, { title: "Orders", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT COUNT(*) FROM "orders"', shape: "number" } });
  const made = await json(await stack.api("POST", "/api/v1/announcements", { kind: "table", id: `${workbookId}:orders`, message: "orders gets a currency column" }));
  assert.equal(made.told, 1);
  const waiting = (await json(await bo.api("GET", "/api/v1/announcements/mine"))).announcements;
  assert.equal(waiting[0].message, "orders gets a currency column");
  assert.deepEqual(await json(await bo.api("POST", `/api/v1/announcements/${made.id}/ack`)), { acknowledged: 1, told: 1 });
  assert.equal((await json(await bo.api("GET", "/api/v1/announcements/mine"))).announcements.length, 0);
  const used = await json(await stack.api("GET", `/api/v1/used-by?kind=table&id=${workbookId}:orders`));
  assert.equal(used.announcements[0].acknowledged, 1);
  // Someone who was not told cannot acknowledge.
  const cy = await person("Cy");
  assert.equal((await cy.api("POST", `/api/v1/announcements/${made.id}/ack`)).status, 404);
});

test("a target can differ by month and by quarter, and Home shows the one for today", async () => {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const quarter = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  let res = await stack.api("PATCH", `/api/v1/widgets/${rev.id}`, { options: { target: 100, targets: { [quarter]: 500 } } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  let t = (await json(await stack.api("GET", "/api/v1/home"))).targets.find((x) => x.id === rev.id);
  assert.deepEqual([t.target, t.period, t.met], [500, quarter, true]);
  await stack.api("PATCH", `/api/v1/widgets/${rev.id}`, { options: { target: 100, targets: { [quarter]: 500, [month]: 900 } } });
  t = (await json(await stack.api("GET", "/api/v1/home"))).targets.find((x) => x.id === rev.id);
  assert.deepEqual([t.target, t.period, t.met], [900, month, false]);
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${rev.id}`, { options: { targets: { "next month": 5 } } })).status, 400);
});

test("coverage counts sensitive fields, and a definition is found by searching", async () => {
  let cov = await json(await stack.api("GET", "/api/v1/coverage"));
  assert.equal(cov.sensitive.marked, 0);
  assert.equal(cov.sensitive.unreviewed, 1);
  await stack.api("PUT", `/api/v1/workbooks/${workbookId}/sensitive`, { table: "orders", column: "email", on: true });
  cov = await json(await stack.api("GET", "/api/v1/coverage"));
  assert.deepEqual([cov.sensitive.marked, cov.sensitive.unreviewed], [1, 0]);

  const defs = (await json(await stack.api("GET", `/api/v1/sources/${sourceId}/review`))).definitions;
  const one = defs.find((d) => d.kind === "metric") ?? defs[0];
  const word = one.label.split(" ").find((w) => w.length > 3) ?? one.label;
  const hits = (await json(await stack.api("GET", `/api/v1/search/definitions?q=${encodeURIComponent(word.toLowerCase())}`))).definitions;
  assert.ok(hits.some((h) => h.id === one.id));
  const stranger = await person("Zed");
  assert.equal((await json(await stranger.api("GET", `/api/v1/search/definitions?q=${encodeURIComponent(word)}`))).definitions.length, 0);
});

test("two snapshots are set side by side, and the evidence for a report comes as one file", async () => {
  const a = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/snapshots`, { label: "Base case" }))).snapshot;
  await say([call("write_table", { workbook_id: workbookId, name: "orders2", csv: "order_id,region,email,amount\n1,North,a@x.example,1000\n" }), { text: "ok", stop: "end_turn" }]);
  const up = await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Upside", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT SUM("amount") FROM "orders2"', shape: "number" } }));
  const b = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/snapshots`, { label: "Upside case" }))).snapshot;
  const cmp = await json(await stack.api("GET", `/api/v1/snapshots/${a.id}/compare/${b.id}`));
  assert.deepEqual([cmp.a.label, cmp.b.label], ["Base case", "Upside case"]);
  assert.deepEqual(cmp.figures.find((f) => f.title === "Revenue"), { id: rev.id, title: "Revenue", a: 600, b: 600, change: 0 });
  assert.deepEqual(cmp.figures.find((f) => f.title === "Upside"), { id: up.widget.id, title: "Upside", a: null, b: 1000, change: null });

  const res = await stack.api("GET", `/api/v1/dashboards/${boardId}/evidence`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="evidence-my-dashboard-\d{4}-\d{2}-\d{2}\.json"/);
  const pack = await res.json();
  assert.equal(pack.snapshots.length, 2);
  assert.ok(pack.cards.some((k) => k.title === "Revenue" && /SUM/.test(k.source.sql)));
  assert.ok(pack.log.some((e) => e.what === "snapshot.taken"));
  const vi = await person("Vi");
  await shareBoard(vi, { acknowledge: true });
  assert.equal((await vi.api("GET", `/api/v1/dashboards/${boardId}/evidence`)).status, 404);
});

test("an auditor re-runs a figure, and View as shows the columns kept from a person", async () => {
  const aud = await person("Auditor", AUDITOR);
  let res = await aud.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql: 'SELECT SUM("amount") FROM "orders"' });
  assert.equal(res.status, 200);
  assert.equal(Number((await res.json()).rows[0][0]), 600);
  assert.equal((await aud.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql: 'DELETE FROM "orders"' })).status, 400);
  assert.equal((await aud.api("GET", `/api/v1/dashboards/${boardId}/evidence`)).status, 200);
  // Someone who is neither is still refused.
  const zed = await person("Zed");
  assert.equal((await zed.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql: "SELECT 1" })).status, 404);

  const lee = await person("Lee");
  await shareBoard(lee, { hide: ["email"], limits: [{ field: "region", values: ["North"] }] });
  const admin = await person("Admin", ADMIN);
  const seen = (await json(await admin.api("GET", `/api/v1/admin/access?email=${encodeURIComponent(lee.email)}`))).reports.find((r) => r.id === boardId);
  assert.equal(seen.rows, "region is North");
  assert.equal(seen.columns, "never email");
});

test("someone who sees part of a report updates a shared row they can see, and no other", async () => {
  const widgets = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets;
  const card = widgets.find((w) => w.title === "By region");
  const table = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/inputs`, { name: "Status", columns: [{ name: "Note", kind: "text" }], widgetId: card.id, keyColumn: "region" }))).table;
  await stack.api("POST", `/api/v1/inputs/${table.id}/approve`);
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "North", values: { Note: "from the owner" } });
  await stack.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "South", values: { Note: "south only" } });
  const tao = await person("Tao");
  await shareBoard(tao, { hide: ["email"], limits: [{ field: "region", values: ["North"] }] });
  // He sees the North entry, not the South one.
  const his = (await json(await tao.api("GET", `/api/v1/dashboards/${boardId}/inputs`))).tables.find((t) => t.id === table.id);
  assert.deepEqual(his.rows.map((r) => r.key), ["North"]);
  assert.equal((await tao.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "North", values: { Note: "done by Tao" } })).status, 200);
  assert.equal((await tao.api("PUT", `/api/v1/inputs/${table.id}/rows`, { key: "South", values: { Note: "should not work" } })).status, 403);
  const all = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/inputs`))).tables.find((t) => t.id === table.id);
  assert.equal(all.rows.find((r) => r.key === "North").values.Note, "done by Tao");
  assert.equal(all.rows.find((r) => r.key === "South").values.Note, "south only");
});

test("someone who can only open the workbook still reads its confirmed definitions from outside", async () => {
  const defs = (await json(await stack.api("GET", `/api/v1/sources/${sourceId}/review`))).definitions;
  const total = defs.find((d) => d.kind === "metric");
  const confirmed = await stack.api("POST", `/api/v1/definitions/${total.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
  const dru = await person("Dru");
  await shareBook(dru, "viewer");
  const token = (await json(await dru.api("POST", "/api/v1/tokens", { name: "nb" }))).token;
  const cat = await (await fetch(`${stack.base}/api/v1/catalog`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const src = cat.sources.find((s) => s.id === sourceId);
  assert.ok(src, "the workbook's source is not in the catalog");
  assert.ok(src.definitions.length >= 1);
  assert.ok(src.definitions.every((d) => d.status === "confirmed"));
  assert.ok(src.definitions.some((d) => d.id === total.id && typeof d.version === "number"));
});
