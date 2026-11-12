// Attribution across several touches, an experiment read with its uncertainty, events whose wording is
// versioned, notebooks, experiment runs tied to a version of the data, a model's score and the way
// back, the map of a workbook, and a signed link dressed for its host.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { attributionSql, experimentSql } from "../../apps/web/src/widgets/builderSql.ts";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, files, scoresTable, agentId, workbookId, boardId;
const GOOD = ["yes,yes", "no,no", "yes,yes", "no,no", "yes,yes", "no,no", "yes,yes", "no,no", "yes,no", "no,no"];
const BAD = ["yes,no", "no,yes", "yes,no", "no,yes", "yes,no", "no,no", "yes,yes", "no,no", "yes,yes", "no,no"];
let preds = GOOD;
const dir = mkdtempSync(join(tmpdir(), "gz-delta-"));
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const load = async (name, csv) => { fake.script.push(call("write_table", { workbook_id: workbookId, name, csv }), { text: "ok", stop: "end_turn" }); await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "go" }).then((r) => r.text()); };
const run = async (sql) => { const res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/query`, { sql }); const body = await res.json(); assert.equal(res.status, 200, `${body.error}\n${sql}`); return body; };
async function person(name) {
  const p = new Stack({ controlPort: 8947, wbhostPort: 8948 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8947, wbhostPort: 8948, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" }, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", DELTA_DIR: dir } });
  await stack.start();
  await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  // c1 was touched by Ads then Email; c2 by Email only; c3 bought with no touch at all.
  await load("touches", "customer,channel,touched_at\nc1,Ads,2026-01-01\nc1,Email,2026-01-05\nc2,Email,2026-01-03\n");
  await load("sales", "customer,amount\nc1,100\nc2,60\nc3,40\n");
  // An experiment: 40 people in each group. B's order value is 10 higher, with the same spread.
  await load("trial", "user_id,variant,order_value,converted\n" + Array.from({ length: 80 }, (_, i) => `${i},${i % 2 ? "B" : "A"},${(i % 2 ? 60 : 50) + ((i >> 1) % 5) - 2},${i % 4 === 0 ? "no" : "yes"}`).join("\n") + "\n");
  // The model's predictions arrive from outside, so they can change under it.
  files = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/csv" }).end("account,predicted,actual\n" + preds.map((r, i) => `a${i},${r}`).join("\n") + "\n"));
  await new Promise((r) => files.listen(8949, "127.0.0.1", r));
  const conn = (await json(await stack.api("POST", "/api/v1/connections", { kind: "web", name: "Scoring job" }))).id;
  scoresTable = await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId: conn, name: "scores", sql: "http://127.0.0.1:8949/scores.csv" }));
});
after(async () => { stack?.stop(); await fake?.close(); files?.close(); rmSync(dir, { recursive: true, force: true }); });

test("a sale is credited to its first touch, its last, or shared among all, and the channels add up to the sales", async () => {
  const t = { table: "touches", key: "customer", channel: "channel", time: "touched_at" }, s = { table: "sales", key: "customer", amount: "amount" };
  const by = async (model) => Object.fromEntries((await run(attributionSql(t, s, model).sql)).rows.map((r) => [r[0], Number(r[1])]));
  assert.deepEqual(await by("first"), { Ads: 100, Email: 60, "(no touch)": 40 });
  assert.deepEqual(await by("last"), { Email: 160, "(no touch)": 40 });
  assert.deepEqual(await by("linear"), { Email: 110, Ads: 50, "(no touch)": 40 });
  // Whatever the rule, nothing is created or lost.
  for (const m of ["first", "last", "linear"]) assert.equal(Object.values(await by(m)).reduce((a, b) => a + b, 0), 200);
  const built = attributionSql(t, s, "linear");
  const res = await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: built.title, form: "bars", theme: "blue", source: { kind: "table_query", workbookId, sql: built.sql, shape: "series" } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
});

test("an experiment is read as a difference with the range it is likely to lie in, and says when it cannot tell", async () => {
  const out = await run(experimentSql("trial", "variant", "A", "B", "order_value").sql);
  const row = Object.fromEntries(out.columns.map((c, i) => [c, out.rows[0][i]]));
  assert.equal(Number(row["A rows"]), 40);
  assert.equal(Number(row["Difference"]), 10);
  assert.ok(Number(row["At least"]) > 9 && Number(row["At most"]) < 11, `${row["At least"]} to ${row["At most"]}`);
  assert.equal(row["Reading"], "B is higher");
  // The same column with the groups the other way round reads the other way.
  const back = await run(experimentSql("trial", "variant", "B", "A", "order_value").sql);
  assert.equal(back.rows[0][back.columns.indexOf("Reading")], "B is lower");
  // Too few rows: it says so, and does not call a winner.
  await load("tiny", "variant,v\nA,1\nA,2\nB,9\nB,10\n");
  const tiny = await run(experimentSql("tiny", "variant", "A", "B", "v").sql);
  assert.equal(tiny.rows[0][tiny.columns.indexOf("Reading")], "Too few rows to say");
});

test("an event's wording is versioned: rewording keeps the old one, with how many rows each picked out", async () => {
  let res = await stack.api("PUT", `/api/v1/workbooks/${workbookId}/terms`, { name: "Converted", meaning: "Finished checkout", table: "trial", condition: "\"converted\" = 'yes'" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  assert.deepEqual((await res.json()).term.rows, 60);
  // A condition that cannot run, or that is more than a condition, is refused.
  assert.equal((await stack.api("PUT", `/api/v1/workbooks/${workbookId}/terms`, { name: "Bad", table: "trial", condition: "\"nope\" = 1" })).status, 400);
  assert.equal((await stack.api("PUT", `/api/v1/workbooks/${workbookId}/terms`, { name: "Sneaky", table: "trial", condition: "1 = 1; DROP TABLE trial" })).status, 400);
  res = await stack.api("PUT", `/api/v1/workbooks/${workbookId}/terms`, { name: "Converted", meaning: "Finished checkout with an order over 55", table: "trial", condition: "\"converted\" = 'yes' AND \"order_value\" > 55" });
  const v2 = (await res.json()).term;
  assert.equal(v2.version, 2);
  assert.equal(v2.rowsBefore, 60);
  assert.ok(v2.rows < 60);
  const kept = (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/terms`))).terms.find((t) => t.name === "Converted");
  assert.equal(kept.history.length, 1);
  assert.equal(kept.history[0].condition, "\"converted\" = 'yes'");
  const stranger = await person("Zed");
  assert.equal((await stranger.api("GET", `/api/v1/workbooks/${workbookId}/terms`)).status, 404);
});

test("a notebook keeps cells of SQL and words; others who can open the workbook read it but do not change it", async () => {
  const cells = [{ id: "a", kind: "note", text: "Does variant B lift order value?" }, { id: "b", kind: "sql", text: 'SELECT "variant", AVG("order_value") FROM "trial" GROUP BY 1 ORDER BY 1' }];
  const nb = (await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/notebooks`, { title: "Variant B readout", cells }))).notebook;
  assert.equal(nb.cells.length, 2);
  // Running a cell is the ordinary read-only query.
  assert.deepEqual((await run(nb.cells[1].text)).rows.map((r) => [r[0], Number(r[1])]), [["A", 50], ["B", 60]]);
  const saved = await json(await stack.api("PUT", `/api/v1/notebooks/${nb.id}`, { cells: [...cells, { id: "c", kind: "note", text: "Yes: about 10 higher." }] }));
  assert.equal(saved.notebook.cells.length, 3);
  const mate = await person("Mate");
  const inv = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: mate.email, role: "viewer" }));
  await mate.api("POST", `/api/v1/invites/${(inv.share?.inviteUrl ?? inv.inviteUrl).split("/").pop()}/accept`);
  const theirs = (await json(await mate.api("GET", `/api/v1/workbooks/${workbookId}/notebooks`))).notebooks;
  assert.deepEqual([theirs[0].title, theirs[0].mine, theirs[0].cells.length], ["Variant B readout", false, 3]);
  assert.equal((await mate.api("PUT", `/api/v1/notebooks/${nb.id}`, { title: "Mine now" })).status, 404);
  assert.equal((await mate.api("DELETE", `/api/v1/notebooks/${nb.id}`)).status, 404);
});

test("an experiment run is tied to the capture of the data it used, and a token can record one", async () => {
  // Not tracked yet: there is no version to tie to.
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/experiments`, { name: "fit 1", table: "trial" })).status, 400);
  await stack.api("POST", `/api/v1/workbooks/${workbookId}/history`, { table: "trial", key: "user_id" });
  let res = await stack.api("POST", `/api/v1/workbooks/${workbookId}/experiments`, { name: "fit 1", table: "trial", params: { depth: 4, method: "tree" }, metrics: { auc: 0.81 } });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  assert.deepEqual((await res.json()).run.data, { table: "trial", version: 0 });
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/experiments`, { name: "fit 2", table: "trial", dataVersion: 9 })).status, 400);
  // From a notebook elsewhere, with a token.
  const token = (await json(await stack.api("POST", "/api/v1/tokens", { name: "nb" }))).token;
  res = await fetch(`${stack.base}/api/v1/workbooks/${workbookId}/experiments`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "fit 2", table: "trial", metrics: { auc: 0.84 } }) });
  assert.equal(res.status, 201);
  const runs = (await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/experiments`))).runs;
  assert.deepEqual(runs.map((r) => [r.name, r.metrics.auc, r.data.version]), [["fit 2", 0.84, 0], ["fit 1", 0.81, 0]]);
  // The token still cannot change anything else.
  assert.equal((await fetch(`${stack.base}/api/v1/workbooks/${workbookId}/notebooks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "x" }) })).status, 401);
});

test("a model is scored against where it started, its owners are told once when it gets worse, and it can go back a version", async () => {
  // Bo has a card on the predictions.
  const bo = await person("Bo");
  const inv = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: bo.email, role: "editor" }));
  await bo.api("POST", `/api/v1/invites/${(inv.share?.inviteUrl ?? inv.inviteUrl).split("/").pop()}/accept`);
  const boBoard = (await json(await bo.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await bo.api("POST", `/api/v1/dashboards/${boBoard}/widgets`, { title: "At risk", form: "number", theme: "blue", source: { kind: "table_query", workbookId, sql: `SELECT COUNT(*) FROM "scores" WHERE "predicted" = 'yes'`, shape: "number" } });

  const model = (await json(await stack.api("POST", "/api/v1/models", { name: "Churn", version: "1", workbookId, table: "scores" }))).model;
  await stack.api("PATCH", `/api/v1/models/${model.id}`, { version: "2", notes: "Retrained" });
  assert.equal((await stack.api("PUT", `/api/v1/models/${model.id}/monitor`, { predicted: "nope", actual: "actual" })).status, 400);
  let res = await stack.api("PUT", `/api/v1/models/${model.id}/monitor`, { predicted: "predicted", actual: "actual", tolerance: 0.1 });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual([(await res.clone().json()).baseline.kind, (await res.json()).baseline.score], ["accuracy", 0.9]);
  // Still as good: nobody is told.
  let h = await json(await stack.api("POST", `/api/v1/models/${model.id}/health`));
  assert.deepEqual([h.health.degraded, h.drift], [false, 0]);
  // The predictions get worse: 5 of 10 right. The owners are told, once.
  preds = BAD;
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${scoresTable.id}/refresh`)).status, 200);
  h = await json(await stack.api("POST", `/api/v1/models/${model.id}/health`));
  assert.deepEqual([h.health.score, h.health.degraded, h.drift], [0.5, true, -0.4]);
  const worse = async () => (await json(await bo.api("GET", "/api/v1/notifications"))).notifications.filter((n) => /Churn version 2 has got worse/.test(n.title));
  assert.equal((await worse()).length, 1);
  assert.match((await worse())[0].body, /right 50% of the time, down from 90%/);
  await stack.api("POST", `/api/v1/models/${model.id}/health`);
  assert.equal((await worse()).length, 1);
  // Back to version 1.
  res = await stack.api("POST", `/api/v1/models/${model.id}/rollback`);
  assert.deepEqual(await res.json(), { version: "1", withdrawn: "2", told: 1, restored: null });
  assert.match((await json(await bo.api("GET", "/api/v1/notifications"))).notifications[0].title, /Churn is back on version 1/);
  assert.equal((await stack.api("POST", `/api/v1/models/${model.id}/rollback`)).status, 400);
  assert.equal((await bo.api("POST", `/api/v1/models/${model.id}/rollback`)).status, 404);
});

test("the map shows a workbook from its tables to the cards and reports built on them", async () => {
  const map = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/map`));
  const kinds = (k) => map.nodes.filter((n) => n.kind === k).map((n) => n.label);
  assert.ok(kinds("table").includes("sales") && kinds("table").includes("touches"));
  assert.ok(kinds("origin").includes("Uploaded or typed in"));
  assert.ok(kinds("report").length >= 2);
  assert.ok(kinds("model").some((l) => l.startsWith("Churn")));
  // The attribution card hangs off both tables it reads, and leads to its report.
  const card = map.nodes.find((n) => n.kind === "card" && /credit|shared equally/i.test(n.label));
  const into = map.edges.filter((e) => e.to === card.id).map((e) => e.from).sort();
  assert.deepEqual(into, ["t:sales", "t:touches"]);
  assert.ok(map.edges.some((e) => e.from === card.id && e.to === `r:${boardId}`));
  const stranger = await person("Zed");
  assert.equal((await stranger.api("GET", `/api/v1/workbooks/${workbookId}/map`)).status, 404);
});

test("a signed link carries the host's colours, and only colours", async () => {
  let res = await stack.api("POST", `/api/v1/dashboards/${boardId}/embed-links`, { theme: { accent: "red" } });
  assert.equal(res.status, 400);
  res = await stack.api("POST", `/api/v1/dashboards/${boardId}/embed-links`, { theme: { accent: "#7c3aed", background: "#0b1020", text: "#f8fafc", font: "serif", hideTitle: true }, days: 3 });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const token = (await res.json()).url.split("/r/")[1];
  const seen = await (await fetch(`${stack.base}/api/v1/public/reports/${token}`)).json();
  assert.deepEqual(seen.theme, { accent: "#7c3aed", background: "#0b1020", text: "#f8fafc", font: "serif", hideTitle: true });
  // The ordinary view link has no theme.
  const link = (await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/link`, { on: true }))).link.split("/r/")[1];
  assert.equal((await (await fetch(`${stack.base}/api/v1/public/reports/${link}`)).json()).theme, null);
});
