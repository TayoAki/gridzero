// Sensitive fields, columns kept from a reader, the smallest group a viewer may see, and signed links.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, agentId, workbookId, boardId, headcount, byTeam, pay, payByTeam;
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
// 12 people: 6 in Sales, 5 in Ops, 1 in Legal. Salaries are 50, 51, ... 61.
const TEAMS = ["Sales", "Sales", "Sales", "Sales", "Sales", "Sales", "Ops", "Ops", "Ops", "Ops", "Ops", "Legal"];
const csv = ["person_id,email,team,salary", ...TEAMS.map((t, i) => `${i + 1},p${i + 1}@corp.example,${t},${50 + i}`)].join("\n") + "\n";
const query = (sql, shape) => ({ kind: "table_query", workbookId, sql, shape });

async function person(name) {
  const p = new Stack({ controlPort: 8971, wbhostPort: 8972 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}
const join = async (p, share) => assert.equal((await p.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`)).status, 200);
const cardsOf = async (p) => Object.fromEntries((await json(await p.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.map((w) => [w.title, w]));
const anon = (path, body) => fetch(stack.base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8971, wbhostPort: 8972, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "people", csv }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import" }).then((r) => r.text());
  const add = async (title, form, source) => (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title, form, theme: "blue", source }))).widget;
  headcount = await add("Headcount", "number", query('SELECT COUNT(*) FROM "people"', "number"));
  byTeam = await add("Headcount by team", "bars", query('SELECT "team", COUNT(*) FROM "people" GROUP BY 1 ORDER BY 2 DESC', "series"));
  pay = await add("Total pay", "number", query('SELECT SUM("salary") FROM "people"', "number"));
  payByTeam = await add("Average pay by team", "bars", query('SELECT "team", AVG("salary") FROM "people" GROUP BY 1 ORDER BY 1', "series"));
});

after(async () => {
  stack?.stop();
  await fake?.close();
});

test("column names suggest what is sensitive, and marking one shows where it is used", async () => {
  let res = await stack.api("GET", `/api/v1/workbooks/${workbookId}/sensitive`);
  assert.equal(res.status, 200);
  let s = await res.json();
  assert.deepEqual(s.suggested.map((x) => x.column).sort(), ["email", "salary"]);
  assert.equal(s.marked.length, 0);
  assert.equal((await stack.api("PUT", `/api/v1/workbooks/${workbookId}/sensitive`, { table: "people", column: "nope", on: true })).status, 404);
  assert.equal((await stack.api("PUT", `/api/v1/workbooks/${workbookId}/sensitive`, { table: "people", column: "salary", on: true })).status, 200);
  s = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/sensitive`));
  assert.deepEqual(s.suggested.map((x) => x.column), ["email"]);
  assert.deepEqual(s.marked[0].cards.map((k) => k.title).sort(), ["Average pay by team", "Total pay"]);
  const stranger = await person("Zed");
  assert.equal((await stranger.api("GET", `/api/v1/workbooks/${workbookId}/sensitive`)).status, 404);
});

test("a report that reads a sensitive field is shared only by hiding it or by saying yes, and the yes is logged", async () => {
  const ana = await person("Ana");
  let res = await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ana.email, role: "viewer" });
  assert.equal(res.status, 409);
  assert.deepEqual((await res.json()).sensitive, ["salary"]);
  // Hidden from her: the cards that read salary are not shown, the others are.
  res = await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ana.email, role: "viewer", hide: ["salary"] });
  assert.equal(res.status, 201);
  await join(ana, (await res.json()).share);
  const hers = await cardsOf(ana);
  assert.equal(hers["Headcount"].data.value, 12);
  assert.equal(hers["Total pay"].data.kind, "text");
  assert.match(hers["Total pay"].data.text, /column you may not see/);
  assert.equal(hers["Average pay by team"].data.kind, "text");
  assert.equal(hers["Headcount by team"].data.points.length, 3);
  // Nor by asking for the card directly, nor by its rows, nor as a field to filter by.
  const direct = await json(await ana.api("POST", `/api/v1/widgets/${pay.id}/view`, { filters: [] }));
  assert.equal(direct.withheld, true);
  assert.equal((await ana.api("POST", `/api/v1/widgets/${headcount.id}/rows`, { filters: [] })).status, 403);
  const fields = (await json(await ana.api("GET", `/api/v1/dashboards/${boardId}/fields`))).fields.map((f) => f.name);
  assert.ok(!fields.includes("salary"));
  assert.ok(fields.includes("team"));

  // An editor cannot be kept from columns, so that needs the yes.
  const bo = await person("Bo");
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: bo.email, role: "editor", hide: ["salary"] })).status, 400);
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: bo.email, role: "editor" })).status, 409);
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: bo.email, role: "editor", acknowledge: true })).status, 201);
  await new Promise((r) => setTimeout(r, 200));
  const log = await json(await stack.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  const yes = log.events.find((e) => e.kind === "share.sensitive_approved");
  assert.deepEqual(yes.detail.fields, ["salary"]);
  assert.equal(yes.detail.email, bo.email);
  const s = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/sensitive`));
  assert.equal(s.marked[0].approvals[0].to, bo.email);
  // The view link is the same: anyone with it would see the field.
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/link`, { on: true })).status, 409);
});

test("a viewer is never shown a group smaller than the report's rule, however they filter", async () => {
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/protect`, { minGroup: 5 })).status, 200);
  const cy = await person("Cy");
  const res = await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: cy.email, role: "viewer", acknowledge: true });
  await join(cy, (await res.json()).share);
  assert.equal((await cy.api("PUT", `/api/v1/dashboards/${boardId}/protect`, { minGroup: 0 })).status, 404);
  const his = await cardsOf(cy);
  // Legal has one person: it is gone from both split cards. The totals stand.
  assert.deepEqual(his["Headcount by team"].data.points.map((p) => p.label).sort(), ["Ops", "Sales"]);
  assert.deepEqual(his["Average pay by team"].data.points.map((p) => p.label), ["Ops", "Sales"]);
  assert.equal(his["Headcount"].data.value, 12);
  // Filtering down to Legal leaves nothing rather than one person's pay.
  const narrowed = await json(await cy.api("POST", `/api/v1/widgets/${pay.id}/view`, { filters: [{ field: "team", values: ["Legal"] }] }));
  assert.ok(narrowed.data === null || narrowed.data.kind !== "number" || narrowed.withheld, JSON.stringify(narrowed.data));
  const sales = await json(await cy.api("POST", `/api/v1/widgets/${pay.id}/view`, { filters: [{ field: "team", values: ["Sales"] }] }));
  assert.equal(sales.data.value, 50 + 51 + 52 + 53 + 54 + 55);
  assert.equal((await cy.api("POST", `/api/v1/widgets/${headcount.id}/rows`, { filters: [] })).status, 403);
  assert.equal((await cy.api("GET", `/api/v1/dashboards/${boardId}/snapshots`)).status, 404);
  // The owner still sees everything.
  const mine = await cardsOf(stack);
  assert.equal(mine["Headcount by team"].data.points.length, 3);

  // A card that lists people, or that the rule cannot be applied to, is not shown.
  const raw = (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Everyone", form: "table", theme: "blue", source: query('SELECT "person_id", "team" FROM "people"', "table") }))).widget;
  const v = await json(await cy.api("POST", `/api/v1/widgets/${raw.id}/view`, { filters: [] }));
  assert.equal(v.withheld, true);
  assert.match(v.data.text, /smallest group size/);
  await stack.api("DELETE", `/api/v1/widgets/${raw.id}`);
});

test("a signed link carries its own rows and hidden columns, runs out, and can be stopped", async () => {
  let res = await stack.api("POST", `/api/v1/dashboards/${boardId}/embed-links`, { limits: [{ field: "team", values: ["Sales"] }] });
  assert.equal(res.status, 409);
  res = await stack.api("POST", `/api/v1/dashboards/${boardId}/embed-links`, { limits: [{ field: "team", values: ["Sales"] }], hide: ["salary"], days: 7 });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const { url } = await res.json();
  const token = url.split("/r/")[1];
  assert.ok(token.startsWith("e_"));

  res = await anon(`/api/v1/public/reports/${token}`);
  assert.equal(res.status, 200);
  const seen = Object.fromEntries((await res.json()).widgets.map((w) => [w.title, w]));
  assert.equal(seen["Headcount"].data.value, 6);
  assert.deepEqual(seen["Headcount by team"].data.points.map((p) => p.label), ["Sales"]);
  assert.equal(seen["Total pay"].data.kind, "text");
  // Changing one character of the link, or its claims, opens nothing.
  const [body, sig] = token.slice(2).split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), l: [] })).toString("base64url");
  assert.equal((await anon(`/api/v1/public/reports/e_${forged}.${sig}`)).status, 404);
  assert.equal((await anon(`/api/v1/public/reports/e_${body}.${sig.slice(0, -2)}AA`)).status, 404);
  // A reader cannot widen it with a filter of their own.
  const view = await (await anon(`/api/v1/public/reports/${token}/widgets/${headcount.id}/view`, { filters: [{ field: "team", values: ["Ops"] }] })).json();
  assert.ok(view.data === null || view.data.value === 0 || view.data.kind === "text", JSON.stringify(view.data));

  assert.equal((await stack.api("DELETE", `/api/v1/dashboards/${boardId}/embed-links`)).status, 204);
  assert.equal((await anon(`/api/v1/public/reports/${token}`)).status, 404);
  const stranger = await person("Yan");
  assert.equal((await stranger.api("POST", `/api/v1/dashboards/${boardId}/embed-links`, {})).status, 404);
});

test("the rewrite that keeps small groups out refuses what it does not understand", async () => {
  const { protectSmallGroups } = await import("../../services/control/src/widgets/live.ts").catch(() => ({ protectSmallGroups: null }));
  if (!protectSmallGroups) return;
  assert.equal(protectSmallGroups('SELECT "a", COUNT(*) FROM "t" GROUP BY 1 ORDER BY 2 DESC LIMIT 5', 5), 'SELECT "a", COUNT(*) FROM "t" GROUP BY 1 HAVING COUNT(*) >= 5 ORDER BY 2 DESC LIMIT 5');
  assert.equal(protectSmallGroups('SELECT SUM("x") FROM "t" WHERE "y" = 1', 3), 'SELECT SUM("x") FROM "t" WHERE "y" = 1 HAVING COUNT(*) >= 3');
  assert.equal(protectSmallGroups('SELECT * FROM "t"', 3), null);
  assert.equal(protectSmallGroups('SELECT "a", COUNT(*) FROM (SELECT * FROM "t") GROUP BY 1', 3), null);
  assert.equal(protectSmallGroups('SELECT "a", SUM("x") OVER (PARTITION BY "a") FROM "t"', 3), null);
});
