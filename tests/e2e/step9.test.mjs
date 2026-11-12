// What administrators can do and see: change someone's access, keep groups, have the identity provider
// add and switch off people, set a starter list, see the questions asked most, and read reliability,
// quality and warehouse spend over time. And masking: a column shown only in part.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, files, admin, agentId, workbookId, boardId, feed;
let feedOk = true;
const ADMIN = `admin-step9-${Date.now()}@example.com`;
const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (p, id, script, text = "go") => { fake.script.push(...script); await p.api("POST", `/api/v1/agents/${id}/chat`, { text }).then((r) => r.text()); };
const scim = (method, path, body, token = "scim-secret") => fetch(stack.base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" }, body: body ? JSON.stringify(body) : undefined });
async function person(name, email = `${name.toLowerCase()}-${Date.now()}@example.com`) {
  const p = new Stack({ controlPort: 8943, wbhostPort: 8944 });
  p.base = stack.base;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}
const cardsOf = async (p) => Object.fromEntries((await json(await p.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.map((w) => [w.title, w]));

before(async () => {
  files = createServer((req, res) => (feedOk ? res.writeHead(200, { "Content-Type": "text/csv" }).end("day,cost,team\n" + [0, 1, 2].map((i) => `${new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)},${10 + i},${i ? "Sales" : "Ops"}`).join("\n") + "\n") : res.writeHead(404).end("gone")));
  await new Promise((r) => files.listen(8946, "127.0.0.1", r));
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8943, wbhostPort: 8944, wbhostEnv: { IMPORT_ALLOW_PRIVATE_URLS: "1" }, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", ADMIN_EMAILS: ADMIN, SCIM_TOKEN: "scim-secret", SCHEDULE_TICK_MS: "400" } });
  await stack.start();
  await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  await say(stack, agentId, [call("write_table", { workbook_id: workbookId, name: "people", csv: "person_id,name,team,salary\n1,Ada Lovelace,Sales,50\n2,Bo Diddley,Sales,60\n3,Cy Young,Ops,70\n" }), { text: "ok", stop: "end_turn" }]);
  const q = (sql, shape) => ({ kind: "table_query", workbookId, sql, shape });
  const add = (title, form, sql, shape) => stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title, form, theme: "blue", source: q(sql, shape) });
  await add("Headcount", "number", 'SELECT COUNT(*) FROM "people"', "number");
  await add("Roster", "table", 'SELECT "name", "team" FROM "people" ORDER BY 1', "table");
  await add("People by name", "bars", 'SELECT "name", COUNT(*) FROM "people" GROUP BY 1 ORDER BY 1', "series");
  const conn = (await json(await stack.api("POST", "/api/v1/connections", { kind: "web", name: "Billing export" }))).id;
  feed = await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables`, { connectionId: conn, name: "bill", sql: "http://127.0.0.1:8946/bill.csv" }));
  admin = await person("Admin", ADMIN);
});
after(async () => { stack?.stop(); await fake?.close(); files?.close(); });

test("a column can be shown only in part: masked in a table, and any other card that reads it is not shown", async () => {
  const mo = await person("Mo");
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: mo.email, role: "editor", mask: ["name"] })).status, 400);
  const { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: mo.email, role: "viewer", mask: ["name"] }));
  await mo.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);
  const his = await cardsOf(mo);
  assert.deepEqual(his["Roster"].data.rows, [["A•••", "Sales"], ["B•••", "Sales"], ["C•••", "Ops"]]);
  assert.equal(his["Headcount"].data.value, 3);
  assert.equal(his["People by name"].data.kind, "text");
  assert.match(his["People by name"].data.text, /only in part/);
  // Not by filtering on it, nor by the rows behind a card.
  const roster = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.find((w) => w.title === "Roster");
  const v = await json(await mo.api("POST", `/api/v1/widgets/${roster.id}/view`, { filters: [{ field: "name", values: ["Ada Lovelace"] }], compare: false }));
  assert.equal(v.data.rows.length, 3);
  assert.equal((await mo.api("POST", `/api/v1/widgets/${roster.id}/rows`, { filters: [] })).status, 403);
  assert.ok(!(await json(await mo.api("GET", `/api/v1/dashboards/${boardId}/fields`))).fields.some((f) => f.name === "name"));
  // The owner sees the names whole.
  assert.equal((await cardsOf(stack))["Roster"].data.rows[0][0], "Ada Lovelace");
});

test("an administrator changes or removes someone's access, and the owner is told", async () => {
  const vi = await person("Vi");
  const { share } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: vi.email, role: "viewer" }));
  await vi.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`);
  const seen = (await json(await admin.api("GET", `/api/v1/admin/access?email=${encodeURIComponent(vi.email)}`))).reports.find((r) => r.id === boardId);
  assert.ok(seen.shareId);
  // Someone who is not an administrator cannot.
  assert.equal((await vi.api("PATCH", `/api/v1/admin/shares/${seen.shareId}`, { remove: true })).status, 403);
  assert.equal((await admin.api("PATCH", `/api/v1/admin/shares/${seen.shareId}`, { role: "editor" })).status, 200);
  assert.equal((await json(await vi.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).role, "editor");
  assert.equal((await admin.api("PATCH", `/api/v1/admin/shares/${seen.shareId}`, { remove: true })).status, 200);
  assert.equal((await vi.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
  const note = (await json(await stack.api("GET", "/api/v1/notifications"))).notifications[0];
  assert.match(note.title, /An administrator removed .* access to My dashboard/);
  await wait(200);
  const log = await json(await stack.api("GET", `/api/v1/activity?kind=report&id=${boardId}`));
  assert.ok(log.events.some((e) => e.kind === "share.removed" && e.detail.byAdministrator));
});

test("a report shared with a group reaches its members, with the group's guards, as they come and go", async () => {
  const al = await person("Al"), bea = await person("Bea");
  assert.equal((await stack.api("POST", "/api/v1/admin/groups", { name: `Sales leads ${Date.now()}` })).status, 403);
  const g = (await json(await admin.api("POST", "/api/v1/admin/groups", { name: `Sales leads ${Date.now()}` }))).group;
  assert.equal((await admin.api("PUT", `/api/v1/admin/groups/${g.id}/members`, { email: al.email, on: true })).status, 200);
  assert.equal((await al.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
  // The owner sees the group's name and size, not who is in it.
  const listed = (await json(await stack.api("GET", "/api/v1/groups"))).groups.find((x) => x.id === g.id);
  assert.equal(listed.members, 1);
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/group-shares`, { groupId: g.id, limits: [{ field: "team", values: ["Sales"] }] })).status, 200);
  const his = await json(await al.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  assert.equal(his.role, "viewer");
  assert.equal(his.widgets.find((w) => w.title === "Headcount").data.value, 2);
  // Bea joins the group later and gets the same; Al leaves and loses it.
  await admin.api("PUT", `/api/v1/admin/groups/${g.id}/members`, { email: bea.email, on: true });
  assert.equal((await json(await bea.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.find((w) => w.title === "Headcount").data.value, 2);
  await admin.api("PUT", `/api/v1/admin/groups/${g.id}/members`, { email: al.email, on: false });
  assert.equal((await al.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
  assert.equal((await stack.api("DELETE", `/api/v1/dashboards/${boardId}/group-shares/${g.id}`)).status, 204);
  assert.equal((await bea.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
});

test("the identity provider adds a person and switches them off, and that takes hold at once", async () => {
  assert.equal((await scim("GET", "/scim/v2/Users", undefined, "wrong")).status, 401);
  const email = `joiner-${Date.now()}@corp.example`;
  let res = await scim("POST", "/scim/v2/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, name: { givenName: "Jo", familyName: "Iner" }, active: true });
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.equal(made.displayName, "Jo Iner");
  assert.equal((await scim("POST", "/scim/v2/Users", { userName: email })).status, 409);
  const found = await json(await scim("GET", `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`));
  assert.equal(found.totalResults, 1);
  assert.ok((await json(await admin.api("GET", "/api/v1/admin/overview"))).people.some((p) => p.email === email));

  // Someone already signed in is switched off: their next request is refused, and their token too.
  const leaver = await person("Leaver");
  const token = (await json(await leaver.api("POST", "/api/v1/tokens", { name: "nb" }))).token;
  assert.equal((await leaver.api("GET", "/api/v1/me")).status, 200);
  const id = (await json(await scim("GET", `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${leaver.email}"`)}`))).Resources[0].id;
  res = await scim("PATCH", `/scim/v2/Users/${id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] });
  assert.equal((await res.json()).active, false);
  assert.equal((await leaver.api("GET", "/api/v1/me")).status, 401);
  assert.equal((await fetch(`${stack.base}/api/v1/catalog`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  // Switched on again, they sign in as before.
  res = await scim("PATCH", `/scim/v2/Users/${id}`, { Operations: [{ op: "replace", path: "active", value: true }] });
  assert.equal((await res.json()).active, true);
  assert.equal((await leaver.api("POST", "/api/auth/sign-in/email", { email: leaver.email, password: "correct-horse-9" })).status, 200);
  assert.equal((await leaver.api("GET", "/api/v1/me")).status, 200);
});

test("an administrator sets the starter list for a kind of work, and sees how far people have got", async () => {
  const items = [{ text: "Open the report your manager shared", link: "/dashboards" }, { text: "Set a target on your main figure" }];
  assert.equal((await stack.api("PUT", "/api/v1/admin/checklists/decide", { items })).status, 403);
  assert.equal((await admin.api("PUT", "/api/v1/admin/checklists/nonsense", { items })).status, 400);
  assert.equal((await admin.api("PUT", "/api/v1/admin/checklists/decide", { items })).status, 200);
  // Earlier runs left their own ticks in the shared database: count from where it stands.
  const before = (await json(await admin.api("GET", "/api/v1/admin/checklists"))).lists.find((l) => l.lens === "decide").items.map((i) => i.people);
  let mine = (await json(await stack.api("GET", "/api/v1/checklists/decide"))).items;
  assert.deepEqual(mine.map((i) => i.done), [false, false]);
  await stack.api("POST", "/api/v1/checklists/decide/done", { text: items[0].text, on: true });
  mine = (await json(await stack.api("GET", "/api/v1/checklists/decide"))).items;
  assert.deepEqual(mine.map((i) => i.done), [true, false]);
  const progress = (await json(await admin.api("GET", "/api/v1/admin/checklists"))).lists.find((l) => l.lens === "decide");
  assert.deepEqual(progress.items.map((i) => i.people), [before[0] + 1, before[1]]);
});

test("the questions asked most are counted across people, without names", async () => {
  const al = await person("Al2"), bo = await person("Bo2");
  // Wording unique to this run: the database holds chats from other runs too.
  const tag = `tag${Date.now()}`;
  for (const p of [al, bo]) {
    await p.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
    const id = (await json(await p.api("POST", "/api/v1/agents", { name: "A", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
    await say(p, id, [{ text: "It was 3.", stop: "end_turn" }], p === al ? `What was revenue for ${tag}?` : `what was revenue for ${tag}`);
    await say(p, id, [{ text: "No.", stop: "end_turn" }], p === al ? `Is the ${tag} deal closed?` : `Only Bo asked about ${tag} once`);
  }
  assert.equal((await stack.api("GET", "/api/v1/admin/questions")).status, 403);
  const top = await json(await admin.api("GET", `/api/v1/admin/questions?about=${tag}`));
  const ours = top.questions.filter((x) => x.text.includes(tag));
  // The question both asked, in different capitals and punctuation, is one line; what one person asked once is not listed.
  assert.deepEqual(ours.map((x) => [x.times, x.people]), [[2, 2]]);
  assert.match(ours[0].text, /revenue for/i);
  assert.ok(!JSON.stringify(top).includes(al.email));
});

test("reliability and quality are kept over time, and warehouse spend is read from a table", async () => {
  // Reliability: one good refresh at set-up, then a failure, then a recovery.
  await stack.api("PUT", `/api/v1/connected-tables/${feed.id}/watch`, { expectEveryHours: 24 });
  feedOk = false;
  await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${feed.id}/refresh`);
  await wait(1400);
  feedOk = true;
  await stack.api("POST", `/api/v1/workbooks/${workbookId}/connected-tables/${feed.id}/refresh`);
  await wait(1400);
  const rel = await json(await stack.api("GET", "/api/v1/activity/reliability"));
  const t = rel.tables.find((x) => x.name === "bill");
  assert.deepEqual([t.refreshes, t.failed, t.incidents, t.lateNow], [3, 1, 1, false]);
  assert.equal(t.onTime, 66.7);
  assert.equal(rel.score, 66.7);
  assert.equal(rel.weeks.reduce((a, w) => a + w.incidents, 0), 1);

  // Quality: a check that passes twice and one that fails once.
  const ok = (await json(await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "Pay is positive", sql: 'SELECT * FROM "people" WHERE "salary" <= 0' }))).check;
  await stack.api("POST", `/api/v1/checks/${ok.id}/run`);
  await stack.api("POST", `/api/v1/workbooks/${workbookId}/checks`, { name: "Nobody over 65", sql: 'SELECT * FROM "people" WHERE "salary" > 65' });
  const qual = await json(await stack.api("GET", `/api/v1/workbooks/${workbookId}/quality`));
  assert.equal(qual.runs, 3);
  assert.equal(qual.score, 66.7);
  assert.equal(qual.checks.find((k) => k.name === "Pay is positive").passRate, 100);
  assert.equal(qual.checks.find((k) => k.name === "Nobody over 65").passRate, 0);
  assert.equal(qual.byDay.length, 1);

  // Spend: the administrator points at the bill.
  assert.equal((await stack.api("PUT", "/api/v1/admin/billing", { workbookId, table: "bill", date: "day", cost: "cost", owner: "team" })).status, 403);
  assert.equal((await admin.api("PUT", "/api/v1/admin/billing", { workbookId, table: "bill", date: "day", cost: "cost" })).status, 404);
  // The administrator needs to be able to open the workbook that holds the bill.
  const inv = await json(await stack.api("PUT", `/api/v1/workbooks/${workbookId}/shares`, { email: ADMIN, role: "viewer" }));
  await admin.api("POST", `/api/v1/invites/${(inv.share?.inviteUrl ?? inv.inviteUrl).split("/").pop()}/accept`);
  assert.equal((await admin.api("PUT", "/api/v1/admin/billing", { workbookId, table: "bill", date: "day", cost: "nope" })).status, 400);
  assert.equal((await admin.api("PUT", "/api/v1/admin/billing", { workbookId, table: "bill", date: "day", cost: "cost", owner: "team" })).status, 200);
  const spend = (await json(await admin.api("GET", "/api/v1/admin/spend"))).warehouse;
  assert.equal(spend.total, 33);
  assert.equal(spend.byDay.length, 3);
  assert.deepEqual(spend.byOwner, [{ owner: "Sales", cost: 23 }, { owner: "Ops", cost: 10 }]);
});
