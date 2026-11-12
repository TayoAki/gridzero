// Owners, targets, actions and decisions; requests and issues; checks, late data and report notices.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { Stack } from "./harness.mjs";

let stack, files, hook, workbookId, boardId, connectionId, tableId, card;
let broken = false;
let rows = 4;
const hooked = [];
const csv = () => ["sku,units,target", ...Array.from({ length: rows }, (_, i) => `S${i + 1},${(i + 1) * 10},25`)].join("\n") + "\n";
const json = (res) => res.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function person(name) {
  const p = new Stack({ controlPort: 8963, wbhostPort: 8964 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}
const shareWith = async (p, role = "viewer") => {
  const { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: p.email, role }));
  assert.equal((await p.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`)).status, 200);
};
const notes = async (p) => (await json(await p.api("GET", "/api/v1/notifications"))).notifications;

before(async () => {
  files = createServer((req, res) => {
    if (req.url === "/stock.csv" && !broken) res.writeHead(200, { "Content-Type": "text/csv" }).end(csv());
    else res.writeHead(404).end("no such file");
  });
  await new Promise((r) => files.listen(8966, "127.0.0.1", r));
  hook = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hooked.push(JSON.parse(body));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => hook.listen(8967, "127.0.0.1", r));
  stack = new Stack({ controlPort: 8963, wbhostPort: 8964, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" }, controlEnv: { CONNECTION_SECRET_KEY: "e2e-connection-key", WEBHOOK_ALLOW_PRIVATE: "1", SCHEDULE_TICK_MS: "400" } });
  await stack.start();
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  connectionId = (await json(await stack.api("POST", "/api/v1/connections", { kind: "web", name: "Web files" }))).id;
  const made = await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId, name: "stock", sql: "http://127.0.0.1:8966/stock.csv" }));
  tableId = made.id;
  card = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Units", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT SUM("units") FROM "stock"', shape: "number" } }))).widget;
});

after(async () => {
  stack?.stop();
  files?.close();
  hook?.close();
});

test("a card takes a target, and a thing takes a named owner who can open it", async () => {
  let res = await stack.api("PATCH", `/api/v1/widgets/${card.id}`, { options: { target: 120, targetLow: false } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).widget.options.target, 120);
  assert.equal((await stack.api("PATCH", `/api/v1/widgets/${card.id}`, { options: { target: "lots" } })).status, 400);

  const ana = await person("Ana");
  // She cannot open the report yet, so she cannot answer for it.
  assert.equal((await stack.api("PUT", "/api/v1/owners", { kind: "report", id: boardId, email: ana.email })).status, 400);
  await shareWith(ana);
  res = await stack.api("PUT", "/api/v1/owners", { kind: "report", id: boardId, email: ana.email });
  assert.equal(res.status, 200);
  assert.match((await notes(ana))[0].title, /You now answer for/);
  // A viewer cannot name owners.
  assert.equal((await ana.api("PUT", "/api/v1/owners", { kind: "report", id: boardId, email: ana.email })).status, 403);
  assert.equal((await stack.api("PUT", "/api/v1/owners", { kind: "report", id: boardId, email: "nobody@example.com" })).status, 400);
});

test("an action goes to a person with a due date, and is done or escalated", async () => {
  const bo = await person("Bo");
  // Someone who cannot open the report cannot be given an action on it.
  assert.equal((await stack.api("POST", "/api/v1/work", { kind: "action", title: "Reorder S1", assignee: bo.email, object: { kind: "report", id: boardId } })).status, 400);
  await shareWith(bo);
  let res = await stack.api("POST", "/api/v1/work", { kind: "action", title: "Reorder S1", due: "2020-01-01", assignee: bo.email, object: { kind: "card", id: card.id } });
  assert.equal(res.status, 201);
  const item = (await res.json()).item;
  assert.equal(item.status, "open");
  assert.equal(item.overdue, true);
  assert.equal(item.object.label, "Units");
  assert.match((await notes(bo))[0].title, /gave you an action: Reorder S1/);
  const mine = (await json(await bo.api("GET", "/api/v1/work"))).items;
  assert.deepEqual(mine.map((i) => i.title), ["Reorder S1"]);
  assert.deepEqual(mine[0].moves.sort(), ["done", "escalated"]);
  assert.equal((await json(await bo.api("GET", "/api/v1/needs-you"))).work, 1);

  // Bo escalates with a note: whoever raised it is told.
  res = await bo.api("PATCH", `/api/v1/work/${item.id}`, { status: "escalated", note: "Supplier is out of stock" });
  assert.equal(res.status, 200);
  assert.match((await notes(stack))[0].title, /Bo escalated it: Reorder S1/);
  // Then it is done, and leaves Bo's list.
  assert.equal((await bo.api("PATCH", `/api/v1/work/${item.id}`, { status: "done" })).status, 200);
  assert.equal((await json(await bo.api("GET", "/api/v1/work"))).items.length, 0);
  const on = (await json(await stack.api("GET", `/api/v1/work?scope=object&kind=card&id=${card.id}`))).items[0];
  assert.equal(on.closed, true);
  assert.deepEqual(on.events.map((e) => e.text), ["opened it", "said: Supplier is out of stock", "escalated it", "marked it done"]);

  // A decision is recorded as made.
  const dec = (await json(await stack.api("POST", "/api/v1/work", { kind: "decision", title: "Hold S1 price until March", object: { kind: "report", id: boardId } }))).item;
  assert.equal(dec.status, "recorded");
  assert.equal(dec.closed, true);
  // A stranger sees none of it.
  const cy = await person("Cy");
  assert.equal((await cy.api("GET", `/api/v1/work?scope=object&kind=report&id=${boardId}`)).status, 404);
  assert.equal((await cy.api("PATCH", `/api/v1/work/${item.id}`, { note: "hello" })).status, 404);
});

test("a request runs from asked to signed off, and only the asker signs it off", async () => {
  const dee = await person("Dee");
  let res = await dee.api("POST", "/api/v1/work", { kind: "request", title: "Units by warehouse", body: "For the Monday review", assignee: stack.email ?? (await json(await stack.api("GET", "/api/v1/me"))).email, acceptance: ["Splits by warehouse", "Matches the stock sheet"] });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const item = (await res.json()).item;
  assert.equal(item.status, "new");
  assert.equal((await dee.api("POST", "/api/v1/work", { kind: "request", title: "No one to send to" })).status, 400);

  const id = item.id;
  // The asker cannot accept their own request; the builder can.
  assert.equal((await dee.api("PATCH", `/api/v1/work/${id}`, { status: "accepted" })).status, 400);
  assert.equal((await stack.api("PATCH", `/api/v1/work/${id}`, { status: "accepted" })).status, 200);
  assert.equal((await stack.api("PATCH", `/api/v1/work/${id}`, { status: "built", link: { kind: "report", id: boardId } })).status, 200);
  // The builder cannot sign it off, and the asker cannot until every check is ticked.
  assert.equal((await stack.api("PATCH", `/api/v1/work/${id}`, { status: "signed_off" })).status, 400);
  res = await dee.api("PATCH", `/api/v1/work/${id}`, { status: "signed_off" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Tick every acceptance check/);
  res = await dee.api("PATCH", `/api/v1/work/${id}`, { status: "signed_off", acceptance: item.acceptance.map((a) => ({ ...a, done: true })) });
  assert.equal(res.status, 200);
  const done = (await res.json()).item;
  assert.equal(done.closed, true);
  assert.equal(done.links[0].label, "My dashboard");
});

test("a check that finds rows opens an issue, tells the owners, posts to a webhook, and closes the loop when it passes", async () => {
  const eve = await person("Eve");
  // A stranger cannot add or see checks.
  assert.equal((await eve.api("GET", `/api/v1/workbooks/${workbookId}/checks`)).status, 404);
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "No writing", sql: 'DELETE FROM "stock"' })).status, 400);

  // Passing to begin with: nothing is below 5.
  let res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "Nothing below its target", sql: 'SELECT "sku", "units" FROM "stock" WHERE "units" < 5', everyMinutes: 5, webhook: "http://127.0.0.1:8967/hook" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  let check = (await res.json()).check;
  assert.equal(check.status, "ok");

  // A check written to fail: two items are under 25.
  res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "Stock under target", sql: 'SELECT "sku", "units", "target" FROM "stock" WHERE "units" < "target"', webhook: "http://127.0.0.1:8967/hook" });
  check = (await res.json()).check;
  assert.equal(check.status, "failing");
  assert.equal(check.count, 2);
  assert.deepEqual(check.sample.rows, [["S1", "10", "25"], ["S2", "20", "25"]]);
  assert.match((await notes(stack))[0].title, /Stock under target is failing/);
  assert.match(hooked.at(-1).text, /Stock under target is failing: 2 rows/);
  const issue = (await json(await stack.api("GET", `/api/v1/work?scope=object&kind=workbook&id=${workbookId}`))).items.find((i) => i.kind === "issue");
  assert.equal(issue.status, "open");
  assert.match(issue.body, /1 report is built on that workbook: My dashboard/);
  // The report built on it says so.
  let board = await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  assert.ok(board.notices.some((n) => n.kind === "check" && /Stock under target/.test(n.text)));
  assert.ok(board.arrived);

  // Running it again while still failing tells nobody twice.
  const before = hooked.length;
  await stack.api("POST", `/api/v1/checks/${check.id}/run`);
  assert.equal(hooked.length, before);

  // The data is fixed: every item now has at least 30. The check passes, the issue is marked fixed.
  rows = 0;
  const fixed = createServer((req, res2) => res2.writeHead(200, { "Content-Type": "text/csv" }).end("sku,units,target\nS1,30,25\nS2,40,25\n"));
  files.close();
  await new Promise((r) => fixed.listen(8966, "127.0.0.1", r));
  files = fixed;
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${tableId}/refresh`)).status, 200);
  check = (await json(await stack.api("POST", `/api/v1/checks/${check.id}/run`))).check;
  assert.equal(check.status, "ok");
  assert.match(hooked.at(-1).text, /passes again/);
  const after = (await json(await stack.api("GET", `/api/v1/work?scope=object&kind=workbook&id=${workbookId}`))).items.find((i) => i.id === issue.id);
  assert.equal(after.status, "fixed");
  board = await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  assert.equal(board.notices.length, 0);
});

test("a table that fails to refresh tells the owners downstream once, puts a notice on the report, and clears when it recovers", async () => {
  const flo = await person("Flo");
  await shareWith(flo);
  assert.equal((await stack.api("PUT", `/api/v1/connected-tables/${tableId}/watch`, { expectEveryHours: 24 })).status, 200);
  assert.equal((await flo.api("PUT", `/api/v1/connected-tables/${tableId}/watch`, { expectEveryHours: 1 })).status, 404);
  files.close();
  files = createServer((req, res) => res.writeHead(404).end("gone"));
  await new Promise((r) => files.listen(8966, "127.0.0.1", r));
  const res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${tableId}/refresh`);
  assert.notEqual(res.status, 200);
  await wait(1500);
  const mine = (await notes(stack)).filter((n) => n.title === "stock is late");
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /its last refresh failed/);
  assert.match(mine[0].body, /1 report built on it: My dashboard/);
  await wait(1200);
  assert.equal((await notes(stack)).filter((n) => n.title === "stock is late").length, 1);

  // Whoever is on it says so, and the viewer of the report sees both lines.
  assert.equal((await stack.api("PUT", `/api/v1/connected-tables/${tableId}/watch`, { note: "The export moved; fixing the address" })).status, 200);
  let board = await json(await flo.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  const notice = board.notices.find((n) => n.kind === "late");
  assert.match(notice.text, /stock failed to refresh/);
  assert.match(notice.note, /E2E: The export moved/);

  files.close();
  files = createServer((req, res2) => res2.writeHead(200, { "Content-Type": "text/csv" }).end("sku,units,target\nS1,30,25\n"));
  await new Promise((r) => files.listen(8966, "127.0.0.1", r));
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${tableId}/refresh`)).status, 200);
  await wait(1500);
  assert.ok((await notes(stack)).some((n) => n.title === "stock has fresh data again"));
  board = await json(await flo.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  assert.equal(board.notices.length, 0);
});

test("an alert can also post to a webhook, and coverage counts what has an owner", async () => {
  const before = hooked.length;
  let res = await stack.api("POST", `/api/v1/widgets/${card.id}/alerts`, { op: "above", threshold: 1000, webhook: "ftp://nope" });
  assert.equal(res.status, 400);
  res = await stack.api("POST", `/api/v1/widgets/${card.id}/alerts`, { op: "below", threshold: 1000, webhook: "http://127.0.0.1:8967/hook" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).alert.webhook, "http://127.0.0.1:8967/hook");
  // Already below the line when set, so nothing is sent until the next crossing.
  assert.equal(hooked.length, before);
  const cov = await json(await stack.api("GET", "/api/v1/coverage"));
  assert.equal(cov.totals.reports >= 1, true);
  assert.equal(typeof cov.issues.open, "number");
});
