// A quality record that survives a removed check, lists downloaded as files, contracts with renewal
// reminders, closing a period, and Python in notebooks: cells, scheduled runs that write a table,
// and a model whose earlier predictions come back on a rollback.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, files, admin, agentId, workbookId, boardId, feed, rev;
const dir = mkdtempSync(join(tmpdir(), "gz-delta-"));
const ADMIN = `admin-step11-${Date.now()}@example.com`;
let feedRows = 3;
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
const load = async (name, csv) => { fake.script.push(call("write_table", { workbook_id: workbookId, name, csv }), { text: "ok", stop: "end_turn" }); await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "go" }).then((r) => r.text()); };
const py = async (p, source) => { const res = await p.api("POST", `/api/v1/workbooks/${workbookId}/python`, { source }); return { status: res.status, ...(await res.json()) }; };
const notes = async (p) => (await json(await p.api("GET", "/api/v1/notifications"))).notifications;
async function person(name, email = `${name.toLowerCase()}-${Date.now()}@example.com`) {
  const p = new Stack({ controlPort: 8937, wbhostPort: 8938 });
  p.base = stack.base;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

before(async () => {
  files = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/csv" }).end("id,v\n" + Array.from({ length: feedRows }, (_, i) => `${i + 1},${i}`).join("\n") + "\n"));
  await new Promise((r) => files.listen(8939, "127.0.0.1", r));
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8937, wbhostPort: 8938, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" }, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", ADMIN_EMAILS: ADMIN, DELTA_DIR: dir, SCHEDULE_TICK_MS: "400" } });
  await stack.start();
  await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await load("orders", "order_id,client,amount\n1,Acme,100\n2,Acme,250\n3,Cedar,300\n4,Cedar,50\n");
  rev = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Revenue", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: 'SELECT SUM("amount") FROM "orders"', shape: "number" } }))).widget;
  const conn = (await json(await stack.api("POST", "/api/v1/connections", { kind: "web", name: "Feed" }))).id;
  feed = await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId: conn, name: "feed", sql: "http://127.0.0.1:8939/feed.csv" }));
  admin = await person("Admin", ADMIN);
});
after(async () => { stack?.stop(); await fake?.close(); files?.close(); rmSync(dir, { recursive: true, force: true }); });

test("removing a failing check does not tidy up the quality score", async () => {
  const bad = (await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "No order over 200", sql: 'SELECT * FROM "orders" WHERE "amount" > 200' }))).check;
  assert.equal(bad.status, "failing");
  await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "Amounts are positive", sql: 'SELECT * FROM "orders" WHERE "amount" <= 0' });
  let q = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/quality`));
  assert.deepEqual([q.runs, q.score], [2, 50]);
  assert.equal((await stack.api("DELETE", `/api/v1/checks/${bad.id}`)).status, 204);
  q = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/quality`));
  // Still two runs, still half failed; the removed check is listed as removed.
  assert.deepEqual([q.runs, q.score], [2, 50]);
  const gone = q.checks.find((k) => k.name === "No order over 200");
  assert.deepEqual([gone.removed, gone.runs, gone.passRate], [true, 1, 0]);
});

test("usage, people, spend and contracts download as files; only an administrator gets the last three", async () => {
  await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`);
  await wait(200);
  let res = await stack.api("GET", "/api/v1/activity/export?what=reports");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="gridzero-reports-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], "Report,Owner,Opens in 30 days,People,Last opened");
  assert.match(lines[1], /^My dashboard,E2E,\d+,1,/);
  for (const what of ["people", "spend", "contracts"]) assert.equal((await stack.api("GET", `/api/v1/activity/export?what=${what}`)).status, 403);
  res = await admin.api("GET", "/api/v1/activity/export?what=people&days=90");
  const people = await res.text();
  assert.match(people.split("\r\n")[0], /^Name,Email,Joined,Active in 90 days/);
  assert.ok(people.includes(ADMIN));
  assert.equal((await admin.api("GET", "/api/v1/activity/export?what=nonsense")).status, 400);
  // A name that starts like a formula is written as text, so a spreadsheet does not run it.
  const sly = await person("=HYPERLINK(1)", `sly-${Date.now()}@example.com`);
  assert.ok((await (await admin.api("GET", "/api/v1/activity/export?what=people")).text()).includes(`"'=HYPERLINK(1)"`));
  void sly;
});

test("contracts set seats bought against people active here, and administrators are told before a renewal", async () => {
  assert.equal((await stack.api("POST", "/api/v1/admin/contracts", { vendor: "GridZero" })).status, 403);
  const soon = day(-20), later = day(-200);
  let res = await admin.api("POST", "/api/v1/admin/contracts", { vendor: "GridZero", product: "Team plan", seats: 5000, countsHere: true, yearlyCost: 24000, renewsOn: soon, owner: "Dana" });
  assert.equal(res.status, 201);
  const id = (await res.json()).id;
  await admin.api("POST", "/api/v1/admin/contracts", { vendor: "Snowflake", yearlyCost: 90000, renewsOn: later });
  const list = (await json(await admin.api("GET", "/api/v1/admin/contracts"))).contracts;
  const mine = list.find((k) => k.id === id);
  assert.equal(mine.daysLeft, 20);
  assert.ok(mine.active90 >= 1 && mine.unused === 5000 - mine.active90 && mine.signedUp >= mine.active90);
  assert.equal(list.find((k) => k.vendor === "Snowflake").active90, undefined);
  // Within 30 days: told once.
  await wait(1200);
  const told = async () => (await notes(admin)).filter((n) => /GridZero Team plan renews in 20 days/.test(n.title)).length;
  assert.equal(await told(), 1);
  await wait(1000);
  assert.equal(await told(), 1);
  // The date moves to within a week: told again, for the nearer date.
  assert.equal((await admin.api("PATCH", `/api/v1/admin/contracts/${id}`, { renewsOn: day(-5) })).status, 200);
  await wait(1200);
  assert.ok((await notes(admin)).some((n) => /GridZero Team plan renews in 5 days/.test(n.title)));
  const csv = await (await admin.api("GET", "/api/v1/activity/export?what=contracts")).text();
  assert.match(csv, /GridZero,Team plan,5000,\d+,\d+,24000,/);
});

test("a period is closed: reports are snapshotted and show it, and whoever closed it hears of later changes", async () => {
  const last = new Date(); last.setUTCMonth(last.getUTCMonth() - 1);
  const period = last.toISOString().slice(0, 7);
  const now = new Date().toISOString().slice(0, 7);
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/periods`, { period: "October" })).status, 400);
  let res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/periods`, { period: now });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /has not ended/);
  // An editor of the workbook closes it; the owner of the report built on it is told.
  const ctl = await person("Connie");
  const inv = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: ctl.email, role: "editor" }));
  await ctl.api("POST", `/api/v1/invites/${(inv.share?.inviteUrl ?? inv.inviteUrl).split("/").pop()}/accept`);
  res = await ctl.api("POST", `/api/v1/workbooks/${workbookId}/periods`, { period, note: "Reconciled to the ledger" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).snapshots, 1);
  assert.equal((await ctl.api("POST", `/api/v1/workbooks/${workbookId}/periods`, { period })).status, 409);
  assert.match((await notes(stack))[0].title, new RegExp(`${period} is closed for`));
  // The report says so, with who and the days it covers; and a snapshot was taken at the close.
  const board = await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  assert.deepEqual([board.closed[0].period, board.closed[0].by, board.closed[0].note, board.closed[0].from.slice(8)], [period, "Connie", "Reconciled to the ledger", "01"]);
  const snaps = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/snapshots`))).snapshots;
  assert.equal(snaps[0].label, `Closed ${period}`);
  // The data changes afterwards: she is told.
  feedRows = 5;
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${feed.id}/refresh`)).status, 200);
  const warned = (await notes(ctl)).find((n) => /Something changed after you closed/.test(n.title));
  assert.match(warned.body, /feed was refreshed and now has 5 rows, not 3/);
  // Only the workbook's owner reopens it.
  assert.equal((await ctl.api("DELETE", `/api/v1/workbooks/${workbookId}/periods/${period}`)).status, 404);
  assert.equal((await stack.api("DELETE", `/api/v1/workbooks/${workbookId}/periods/${period}`)).status, 204);
  assert.equal((await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).closed.length, 0);
  assert.match((await notes(ctl))[0].title, /was reopened/);
});

test("a Python cell reads the workbook's tables, saves a result, and is confined", async () => {
  let r = await py(stack, 'print(tables())\nprint(sql(\'select client, sum(amount) from orders group by 1 order by 1\').fetchall())');
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.error, null);
  assert.match(r.output, /'orders'/);
  assert.match(r.output, /\('Acme', 350\), \('Cedar', 350\)/);
  // pandas is there, and a saved frame comes back as a table.
  r = await py(stack, 'df = table("orders").df()\ndf["share"] = (df["amount"] / df["amount"].sum()).round(3)\nsave("shares", df[["order_id", "share"]])');
  assert.equal(r.error, null, r.error);
  assert.deepEqual([r.saved[0].name, r.saved[0].count, r.saved[0].columns], ["shares", 4, ["order_id", "share"]]);
  assert.deepEqual(r.saved[0].rows[0], ["1", "0.143"]);
  // A mistake is reported with the line the person wrote.
  r = await py(stack, "x = 1\ny = x / 0\n");
  assert.match(r.error, /line 2/);
  assert.match(r.error, /ZeroDivisionError/);
  // No network, no files outside its own folder, no other programs.
  r = await py(stack, [
    "import socket, os, subprocess",
    "def attempt(label, fn):",
    "    try:",
    "        fn(); print(label, 'ALLOWED')",
    "    except BaseException as e:",
    "        print(label, 'refused')",
    "attempt('network', lambda: socket.create_connection(('1.1.1.1', 80), 2))",
    "attempt('read', lambda: open('/etc/passwd').read())",
    "attempt('write', lambda: open('/tmp/escape-' + str(os.getpid()), 'w').write('x'))",
    "attempt('program', lambda: subprocess.run(['ls']))",
    "attempt('environment', lambda: os.environ['DATABASE_URL'])",
  ].join("\n"));
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.output.trim().split("\n"), ["network refused", "read refused", "write refused", "program refused", "environment refused"]);
  // Someone who cannot open the workbook cannot run anything on it, and a token cannot run Python at all.
  const zed = await person("Zed");
  assert.equal((await py(zed, "print(1)")).status, 404);
  const token = (await json(await stack.api("POST", "/api/v1/tokens", { name: "nb" }))).token;
  assert.equal((await fetch(`${stack.base}/api/v1/workbooks/${workbookId}/python`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ source: "print(1)" }) })).status, 401);
});

test("a notebook run writes its table into the workbook, and each run of a model's notebook is a version whose predictions come back on a rollback", async () => {
  // Bo has a card on the predictions, once they exist.
  const cells = (factor) => [{ id: "a", kind: "note", text: "Score each client." }, { id: "b", kind: "python", text: `scores = sql('select client, sum(amount) * ${factor} as score from orders group by 1 order by 1')` }, { id: "c", kind: "python", text: 'save("scores", scores)' }];
  const nb = (await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/notebooks`, { title: "Scoring", cells: cells(1) }))).notebook;
  // The two Python cells run as one, top to bottom, so the second sees what the first made.
  let run = await json(await stack.api("POST", `/api/v1/notebooks/${nb.id}/run`));
  assert.equal(run.status, "ok", run.output);
  assert.deepEqual(run.landed, [{ name: "scores", rows: 2 }]);
  const read = async () => (await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql: 'SELECT "client", "score" FROM "scores" ORDER BY 1' }))).rows.map((r) => [r[0], Number(r[1])]);
  assert.deepEqual(await read(), [["Acme", 350], ["Cedar", 350]]);

  // Tie it to a model: the next run is a new version, kept.
  const model = (await json(await stack.api("POST", "/api/v1/models", { name: "Client score", version: "by hand", workbookId, table: "scores" }))).model;
  assert.equal((await stack.api("PUT", `/api/v1/notebooks/${nb.id}/schedule`, { modelId: "nope" })).status, 400);
  assert.equal((await stack.api("PUT", `/api/v1/notebooks/${nb.id}/schedule`, { modelId: model.id })).status, 200);
  run = await json(await stack.api("POST", `/api/v1/notebooks/${nb.id}/run`));
  assert.match(run.version, /^run \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const first = run.version;
  // The notebook changes (scores doubled) and runs again: a second version, and the table is the same table.
  await stack.api("PUT", `/api/v1/notebooks/${nb.id}`, { cells: cells(2) });
  await wait(1100);
  run = await json(await stack.api("POST", `/api/v1/notebooks/${nb.id}/run`));
  assert.equal(run.status, "ok", run.output);
  assert.deepEqual(await read(), [["Acme", 700], ["Cedar", 700]]);
  assert.equal((await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/tables`))).tables.filter((t) => t.table === "scores").length, 1);
  let m = (await json(await stack.api("GET", "/api/v1/models"))).models[0];
  assert.equal(m.history.at(-1).version, first);
  // Rolling back puts the earlier predictions back in the workbook.
  const back = await json(await stack.api("POST", `/api/v1/models/${model.id}/rollback`));
  assert.deepEqual([back.version, back.restored], [first, 2]);
  assert.deepEqual(await read(), [["Acme", 350], ["Cedar", 350]]);

  // On a schedule: it runs by itself, and a failure is reported to its owner.
  assert.equal((await stack.api("PUT", `/api/v1/notebooks/${nb.id}/schedule`, { everyHours: 1 })).status, 200);
  const listed = (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/notebooks`))).notebooks[0];
  assert.deepEqual([listed.everyHours, listed.lastStatus, listed.writes], [1, "ok", ["scores"]]);
  assert.equal(typeof (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/notebooks`))).python, "boolean");
  await stack.api("PUT", `/api/v1/notebooks/${nb.id}`, { cells: [{ id: "x", kind: "python", text: "raise ValueError('the feed is empty')" }] });
  run = await json(await stack.api("POST", `/api/v1/notebooks/${nb.id}/run`));
  assert.equal(run.status, "error");
  assert.match(run.output, /the feed is empty/);
  // Someone else cannot run or schedule it.
  const zed = await person("Zed");
  assert.equal((await zed.api("POST", `/api/v1/notebooks/${nb.id}/run`)).status, 404);
  assert.equal((await zed.api("PUT", `/api/v1/notebooks/${nb.id}/schedule`, { everyHours: 1 })).status, 404);
});
