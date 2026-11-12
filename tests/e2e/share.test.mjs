// Sharing a report, emailing it on a schedule, and alerts.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { Stack } from "./harness.mjs";

let fake, stack, mail, agentId, workbookId, boardId, total, bySource;
const sent = [];

const call = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ tools: [{ id, name, input }], stop: "tool_use" });
const json = (res) => res.json();
const csvOf = (n) => ["order_id,source,amount", ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? "Email" : "Ads"},${i + 1}`)].join("\n") + "\n";
const query = (sql, shape) => ({ kind: "table_query", workbookId, sql, shape });

async function person(name) {
  const p = new Stack({ controlPort: 8975, wbhostPort: 8976 });
  p.base = stack.base;
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  assert.equal((await p.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" })).status, 200);
  return Object.assign(p, { email });
}

before(async () => {
  // A stand-in for the mail service: it records what it is asked to send.
  mail = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      sent.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"x"}');
    });
  });
  await new Promise((r) => mail.listen(8977, "127.0.0.1", r));
  fake = await startFakeAnthropic();
  stack = new Stack({ controlPort: 8975, wbhostPort: 8976, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", RESEND_API_KEY: "re_test", RESEND_BASE_URL: "http://127.0.0.1:8977", WEBHOOK_ALLOW_PRIVATE: "1" } });
  await stack.start();
  assert.equal((await stack.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" })).status, 200);
  agentId = (await json(await stack.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" }))).agent.id;
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
  // 20 orders: the total is 210.
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "orders", csv: csvOf(20) }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import my orders" }).then((r) => r.text());
  const add = async (title, form, source) => (await json(await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title, form, theme: "blue", source }))).widget;
  total = await add("Revenue", "number", query('SELECT SUM("amount") FROM "orders"', "number"));
  bySource = await add("Revenue by source", "bars", query('SELECT "source", SUM("amount") FROM "orders" GROUP BY 1 ORDER BY 1', "series"));
});

after(async () => {
  stack?.stop();
  await fake?.close();
  mail?.close();
});

test("a report is shared by invitation, and a viewer can read and filter but not change it", async () => {
  const ana = await person("Ana");
  // Before the invitation: nothing.
  assert.equal((await ana.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);

  let res = await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ana.email, role: "viewer" });
  assert.equal(res.status, 201);
  const { share, emailed } = await res.json();
  assert.equal(emailed, true);
  assert.match(sent.at(-1).subject, /shared the report "My dashboard" with you/);
  assert.equal(sent.at(-1).to, ana.email);
  assert.ok(sent.at(-1).html.includes(share.inviteUrl));
  // She has an account, so she is told in the app too.
  const notes = await json(await ana.api("GET", "/api/v1/notifications"));
  assert.equal(notes.unread, 1);
  assert.match(notes.notifications[0].title, /shared a report with you/);

  // Knowing the address is not enough: she joins by opening the link.
  assert.equal((await ana.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
  const tokenOf = (url) => url.split("/").pop();
  res = await ana.api("POST", `/api/v1/report-invites/${tokenOf(share.inviteUrl)}/accept`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dashboardId, boardId);

  const list = (await json(await ana.api("GET", "/api/v1/dashboards"))).dashboards;
  const shared = list.find((d) => d.id === boardId);
  assert.equal(shared.role, "viewer");
  assert.ok(shared.owner);
  const seen = await json(await ana.api("GET", `/api/v1/dashboards/${boardId}/widgets`));
  assert.equal(seen.role, "viewer");
  assert.equal(seen.widgets.length, 2);
  // Filtering runs with the owner's access: Ana cannot open the workbook, yet the card answers.
  assert.equal((await ana.api("GET", `/api/v1/workbooks/${workbookId}/tables`)).status, 404);
  const v = await json(await ana.api("POST", `/api/v1/widgets/${total.id}/view`, { filters: [{ field: "source", values: ["Ads"] }] }));
  assert.equal(v.data.value, 100);
  assert.equal((await ana.api("GET", `/api/v1/dashboards/${boardId}/fields`)).status, 200);

  // A viewer changes nothing.
  for (const [method, path, body] of [
    ["PATCH", `/api/v1/widgets/${total.id}`, { title: "Mine" }],
    ["DELETE", `/api/v1/widgets/${total.id}`],
    ["POST", `/api/v1/widgets/${total.id}/refresh`],
    ["PUT", `/api/v1/dashboards/${boardId}/layout`, { items: [{ id: total.id, x: 0, y: 0, w: 6, h: 1 }] }],
    ["POST", `/api/v1/dashboards/${boardId}/slicers`, { field: "source", style: "list" }],
    ["POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "x", form: "number", theme: "blue", source: query('SELECT 1', "number") }],
    ["PATCH", `/api/v1/dashboards/${boardId}`, { name: "Mine" }],
    ["DELETE", `/api/v1/dashboards/${boardId}`],
    ["GET", `/api/v1/dashboards/${boardId}/shares`],
    ["PUT", `/api/v1/dashboards/${boardId}/shares`, { email: "x@example.com", role: "editor" }],
    ["PUT", `/api/v1/dashboards/${boardId}/link`, { on: true }],
  ]) {
    assert.equal((await ana.api(method, path, body)).status, 404, `${method} ${path}`);
  }

  // Made an editor, she can arrange and restyle, but still cannot chart a workbook she cannot open.
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: ana.email, role: "editor" })).status, 200);
  assert.equal((await ana.api("PATCH", `/api/v1/widgets/${bySource.id}`, { form: "donut" })).status, 200);
  assert.equal((await ana.api("PUT", `/api/v1/dashboards/${boardId}/layout`, { items: [{ id: total.id, x: 0, y: 0, w: 6, h: 1 }] })).status, 200);
  assert.equal((await ana.api("POST", `/api/v1/widgets/${total.id}/refresh`)).status, 200);
  assert.equal((await ana.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "x", form: "number", theme: "blue", source: query('SELECT SUM("amount") FROM "orders"', "number") })).status, 404);
  assert.equal((await ana.api("DELETE", `/api/v1/dashboards/${boardId}`)).status, 404);

  // Removed, she is out at once.
  const { shares } = await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/shares`));
  assert.deepEqual(shares.map((s) => [s.email, s.role, s.accepted]), [[ana.email, "editor", true]]);
  assert.equal((await stack.api("DELETE", `/api/v1/dashboards/${boardId}/shares/${shares[0].id}`)).status, 204);
  assert.equal((await ana.api("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 404);
  assert.equal((await ana.api("POST", `/api/v1/report-invites/${tokenOf(share.inviteUrl)}/accept`)).status, 404);

  for (const body of [{ email: "nope", role: "viewer" }, { email: "a@example.com", role: "owner" }, {}]) assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/shares`, body)).status, 400);
});

test("a view link shows the report to anyone, lets them filter, and stops when turned off", async () => {
  const anyone = (method, path, body) => fetch(stack.base + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await anyone("GET", "/api/v1/public/reports/not-a-real-token-at-all-0000")).status, 404);

  const { link } = await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/link`, { on: true }));
  const token = link.split("/").pop();
  assert.match(link, /\/r\/[\w-]{20,}$/);
  const report = await json(await anyone("GET", `/api/v1/public/reports/${token}`));
  assert.equal(report.name, "My dashboard");
  assert.equal(report.widgets.length, 2);
  // The query behind a card stays with the owner.
  assert.deepEqual(report.widgets[0].source, { kind: "table_query" });
  assert.ok(!JSON.stringify(report).includes("SELECT"));
  assert.ok(!JSON.stringify(report).includes(workbookId));

  const fields = await json(await anyone("GET", `/api/v1/public/reports/${token}/fields`));
  assert.ok(fields.fields.some((f) => f.name === "source"));
  const v = await json(await anyone("POST", `/api/v1/public/reports/${token}/widgets/${total.id}/view`, { filters: [{ field: "source", values: ["Email"] }] }));
  assert.equal(v.data.value, 110);
  // The link reads; it does not reach the signed-in routes or anyone else's cards.
  assert.equal((await anyone("GET", `/api/v1/dashboards/${boardId}/widgets`)).status, 401);
  assert.equal((await anyone("POST", `/api/v1/widgets/${total.id}/rows`, { filters: [] })).status, 401);
  assert.equal((await anyone("POST", `/api/v1/public/reports/${token}/widgets/nope/view`, { filters: [] })).status, 404);

  // Turning it on again gives a new address; the old one stops.
  const again = (await json(await stack.api("PUT", `/api/v1/dashboards/${boardId}/link`, { on: true }))).link;
  assert.notEqual(again, link);
  assert.equal((await anyone("GET", `/api/v1/public/reports/${token}`)).status, 404);
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${boardId}/link`, { on: false })).status, 200);
  assert.equal((await anyone("GET", `/api/v1/public/reports/${again.split("/").pop()}`)).status, 404);
  assert.equal((await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/shares`))).link, null);
});

test("a report is emailed on a schedule, with fresh figures", async () => {
  let res = await stack.api("POST", "/api/v1/schedules", { kind: "report_email", dashboardId: boardId, recipients: ["client@example.com", "Boss@Example.com"], cron: "0 8 * * 1", label: "Monday report" });
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.equal(made.mail, true);
  assert.deepEqual(made.schedule.recipients, ["client@example.com", "boss@example.com"]);

  // The table grows before the send: the email carries the new total, not the stored one.
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "orders", csv: csvOf(30) }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import again" }).then((r) => r.text());
  const before = sent.length;
  res = await stack.api("POST", `/api/v1/schedules/${made.schedule.id}/run`);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(sent.length, before + 1);
  const message = sent.at(-1);
  assert.deepEqual(message.to, ["client@example.com", "boss@example.com"]);
  assert.match(message.subject, /^My dashboard: \d{4}-\d{2}-\d{2}$/);
  assert.ok(message.html.includes("Revenue by source"));
  assert.ok(message.html.includes("Open the report"));
  const stored = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.find((w) => w.id === total.id);
  // write_table adds a second table beside the first; whichever the card reads, the email shows what is stored now.
  assert.ok(message.html.includes(stored.data.value.toLocaleString("en-US")));
  const listed = (await json(await stack.api("GET", "/api/v1/schedules"))).schedules.find((s) => s.id === made.schedule.id);
  assert.equal(listed.lastStatus, "ok");

  for (const body of [
    { kind: "report_email", dashboardId: boardId, recipients: [], cron: "0 8 * * 1", label: "x" },
    { kind: "report_email", dashboardId: boardId, recipients: ["not an address"], cron: "0 8 * * 1", label: "x" },
    { kind: "report_email", dashboardId: boardId, recipients: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`), cron: "0 8 * * 1", label: "x" },
    { kind: "report_email", dashboardId: boardId, recipients: ["a@example.com"], cron: "* * * * *", label: "x" },
  ]) {
    assert.equal((await stack.api("POST", "/api/v1/schedules", body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  // Someone else's report cannot be sent, and their schedule cannot be run.
  const other = await person("Other");
  assert.equal((await other.api("POST", "/api/v1/schedules", { kind: "report_email", dashboardId: boardId, recipients: ["a@example.com"], cron: "0 8 * * 1", label: "x" })).status, 404);
  assert.equal((await other.api("POST", `/api/v1/schedules/${made.schedule.id}/run`)).status, 404);
});

test("an alert watches a figure card, and stays quiet until the figure crosses its line", async () => {
  const now = (await json(await stack.api("GET", `/api/v1/dashboards/${boardId}/widgets`))).widgets.find((w) => w.id === total.id).data.value;
  let res = await stack.api("POST", `/api/v1/widgets/${total.id}/alerts`, { op: "above", threshold: now + 100 });
  assert.equal(res.status, 201);
  const made = (await res.json()).alert;
  assert.equal(made.firing, false);
  // A figure already past the line starts as firing, so the first message is for the next crossing.
  res = await stack.api("POST", `/api/v1/widgets/${total.id}/alerts`, { op: "above", threshold: now - 1 });
  assert.equal((await res.json()).alert.firing, true);

  const unread = async () => (await json(await stack.api("GET", "/api/v1/notifications"))).unread;
  const startUnread = await unread();
  const mailBefore = sent.length;
  assert.equal((await stack.api("POST", `/api/v1/widgets/${total.id}/refresh`)).status, 200);
  assert.equal(await unread(), startUnread);
  assert.equal(sent.length, mailBefore);

  // Only a figure card can be watched, and only by someone who can see it.
  assert.equal((await stack.api("POST", `/api/v1/widgets/${bySource.id}/alerts`, { op: "above", threshold: 1 })).status, 400);
  for (const body of [{ op: "near", threshold: 1 }, { op: "above" }, { op: "above", threshold: "ten" }]) assert.equal((await stack.api("POST", `/api/v1/widgets/${total.id}/alerts`, body)).status, 400);
  const other = await person("Stranger");
  assert.equal((await other.api("POST", `/api/v1/widgets/${total.id}/alerts`, { op: "above", threshold: 1 })).status, 404);
  assert.equal((await other.api("DELETE", `/api/v1/alerts/${made.id}`)).status, 404);

  const mine = (await json(await stack.api("GET", "/api/v1/alerts"))).alerts;
  assert.equal(mine.length, 2);
  assert.ok(mine.every((a) => a.report === "My dashboard" && a.title === "Revenue"));
  for (const a of mine) assert.equal((await stack.api("DELETE", `/api/v1/alerts/${a.id}`)).status, 204);
  assert.equal((await json(await stack.api("GET", `/api/v1/widgets/${total.id}/alerts`))).alerts.length, 0);
});

test("a crossing is told once, in the app and by email", async () => {
  // A card whose figure is the clock, in seconds: it rises on its own, so a line just ahead of it is crossed by waiting.
  const res = await stack.api("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: "Clock", form: "number", theme: "blue", source: query("SELECT epoch(now())", "number") });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const w = (await res.json()).widget;
  const line = Math.ceil(w.data.value) + 2;
  assert.equal((await stack.api("POST", `/api/v1/widgets/${w.id}/alerts`, { op: "above", threshold: line })).status, 201);
  const notesBefore = (await json(await stack.api("GET", "/api/v1/notifications"))).notifications.length;
  const mailBefore = sent.length;

  await new Promise((r) => setTimeout(r, 3500));
  assert.equal((await stack.api("POST", `/api/v1/widgets/${w.id}/refresh`)).status, 200);
  let notes = (await json(await stack.api("GET", "/api/v1/notifications"))).notifications;
  assert.equal(notes.length, notesBefore + 1);
  assert.match(notes[0].title, /^Clock is above /);
  assert.equal(notes[0].link, `/dashboards/${boardId}`);
  assert.equal(notes[0].read, false);
  assert.equal(sent.length, mailBefore + 1);
  assert.match(sent.at(-1).subject, /^Clock is above /);

  // Still above on the next refresh: not told again.
  assert.equal((await stack.api("POST", `/api/v1/widgets/${w.id}/refresh`)).status, 200);
  assert.equal((await json(await stack.api("GET", "/api/v1/notifications"))).notifications.length, notesBefore + 1);
  assert.equal(sent.length, mailBefore + 1);
  const [mine] = (await json(await stack.api("GET", `/api/v1/widgets/${w.id}/alerts`))).alerts;
  assert.equal(mine.firing, true);

  assert.equal((await stack.api("POST", "/api/v1/notifications/read", {})).status, 204);
  assert.equal((await json(await stack.api("GET", "/api/v1/notifications"))).unread, 0);
});

test("a forgotten password is reset from an emailed link that works once", async () => {
  const anyone = (path, body) => fetch(stack.base + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: stack.base }, body: JSON.stringify(body) });
  const options = await (await fetch(stack.base + "/api/v1/auth/options")).json();
  assert.deepEqual(options, { passwordReset: true, google: false });

  const pat = await person("Pat");
  const before = sent.length;
  let res = await anyone("/api/auth/request-password-reset", { email: pat.email, redirectTo: `${stack.base}/reset-password` });
  assert.equal(res.status, 200);
  assert.equal(sent.length, before + 1);
  const mail = sent.at(-1);
  assert.equal(mail.to, pat.email);
  assert.equal(mail.subject, "Reset your GridZero password");
  const link = /href="([^"]+)"/.exec(mail.html)[1].replace(/&#38;/g, "&");
  // The link lands on the reset page with a token.
  const landed = await fetch(link, { redirect: "manual" });
  const token = new URL(landed.headers.get("location"), stack.base).searchParams.get("token");
  assert.ok(token, landed.headers.get("location"));

  res = await anyone("/api/auth/reset-password", { token, newPassword: "a-brand-new-pass-7" });
  assert.equal(res.status, 200);
  // The new password works, the old one does not, and the link cannot be used again.
  assert.equal((await anyone("/api/auth/sign-in/email", { email: pat.email, password: "a-brand-new-pass-7" })).status, 200);
  assert.notEqual((await anyone("/api/auth/sign-in/email", { email: pat.email, password: "correct-horse-9" })).status, 200);
  assert.notEqual((await anyone("/api/auth/reset-password", { token, newPassword: "another-pass-88" })).status, 200);
  // The devices that were signed in are signed out.
  assert.equal((await pat.api("GET", "/api/v1/dashboards")).status, 401);

  // An address with no account gets the same answer and no email.
  const quiet = sent.length;
  res = await anyone("/api/auth/request-password-reset", { email: "nobody-here@example.com", redirectTo: `${stack.base}/reset-password` });
  assert.equal(res.status, 200);
  assert.equal(sent.length, quiet);
});

test("a scheduled report is also posted to a webhook, in the shape Slack reads", async () => {
  let res = await stack.api("POST", "/api/v1/schedules", { kind: "report_email", dashboardId: boardId, recipients: [], webhook: "http://127.0.0.1:8977/hook", cron: "0 9 * * 1", label: "To the channel" });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const made = (await res.json()).schedule;
  assert.equal(made.webhook, "http://127.0.0.1:8977/hook");
  const before = sent.length;
  res = await stack.api("POST", `/api/v1/schedules/${made.id}/run`);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  // Only the webhook was told: there is nobody to email.
  assert.equal(sent.length, before + 1);
  const posted = sent.at(-1);
  assert.match(posted.text, /^\*My dashboard\* as of \d{4}-\d{2}-\d{2}\n• Revenue: /);
  assert.match(posted.text, /• Revenue by source: /);
  assert.equal(posted.report, "My dashboard");
  assert.ok(Array.isArray(posted.cards) && posted.cards.length >= 2);
  assert.ok(posted.url.startsWith("http"));

  for (const webhook of ["ftp://example.com/x", "not an address", "https://user:pw@example.com/hook"]) {
    assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "report_email", dashboardId: boardId, recipients: [], webhook, cron: "0 9 * * 1", label: "x" })).status, 400, webhook);
  }
  assert.equal((await stack.api("POST", "/api/v1/schedules", { kind: "report_email", dashboardId: boardId, recipients: [], cron: "0 9 * * 1", label: "x" })).status, 400);
});

test("someone held to certain rows sees every card worked out for those rows, and nothing else", async () => {
  // A fresh table, so the figures are known: 20 orders, odd ones Ads (sum 100), even ones Email (sum 110).
  fake.script.push(call("write_table", { workbook_id: workbookId, name: "sales", csv: csvOf(20) }), { text: "Imported.", stop: "end_turn" });
  await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "Import" }).then((r) => r.text());
  const board = (await json(await stack.api("POST", "/api/v1/dashboards", { name: "Client report" }))).dashboard.id;
  const add = async (title, form, source) => (await json(await stack.api("POST", `/api/v1/dashboards/${board}/widgets`, { title, form, theme: "blue", source }))).widget;
  const sum = await add("Revenue", "number", query('SELECT SUM("amount") FROM "sales"', "number"));
  const split = await add("Revenue by source", "bars", query('SELECT "source", SUM("amount") FROM "sales" GROUP BY 1 ORDER BY 1', "series"));
  // A card with no source column underneath cannot be limited: a constant.
  const constant = await add("Target", "number", query("SELECT 500", "number"));
  // An agent's snapshot holds figures that cannot be limited either; a note the owner wrote is for every reader.
  fake.script.push(call("propose_widget", { title: "All clients", designs: [{ form: "bars", theme: "blue" }], data: { kind: "series", points: [{ label: "Ads", value: 100 }, { label: "Email", value: 110 }] }, source: { kind: "snapshot", prompt: "x" } }), { text: "Here.", stop: "end_turn" });
  const lines = (await (await stack.api("POST", `/api/v1/agents/${agentId}/chat`, { text: "widget" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  const snap = (await json(await stack.api("POST", `/api/v1/widget-proposals/${lines.find((l) => l.type === "widget_proposal").proposalId}/accept`, { dashboardId: board, design: 0 }))).widget;
  const note = (await json(await stack.api("POST", `/api/v1/dashboards/${board}/notes`, { title: "Welcome", text: "Figures are in dollars." }))).widget;

  const cli = await person("Client");
  let res = await stack.api("PUT", `/api/v1/dashboards/${board}/shares`, { email: cli.email, role: "viewer", limits: [{ field: "source", values: ["Ads"] }] });
  assert.equal(res.status, 201);
  const share = (await res.json()).share;
  assert.deepEqual(share.limits, [{ field: "source", values: ["Ads"] }]);
  assert.equal((await cli.api("POST", `/api/v1/report-invites/${share.inviteUrl.split("/").pop()}/accept`)).status, 200);

  const seen = await json(await cli.api("GET", `/api/v1/dashboards/${board}/widgets`));
  assert.deepEqual(seen.limited, [{ field: "source", values: ["Ads"] }]);
  const card = (id) => seen.widgets.find((w) => w.id === id);
  // The total is the client's own, not the report's.
  assert.equal(card(sum.id).data.value, 100);
  assert.deepEqual(card(split.id).data.points, [{ label: "Ads", value: 100 }]);
  // What cannot be limited is not shown at all, and the query behind a card is not sent.
  assert.match(card(constant.id).data.text, /cannot be limited/);
  assert.match(card(snap.id).data.text, /cannot be limited/);
  assert.equal(card(note.id).data.text, "Figures are in dollars.");
  const wire = JSON.stringify(seen);
  assert.ok(!wire.includes("110") && !wire.includes("210") && !wire.includes("Email") && !wire.includes("SELECT") && !wire.includes(workbookId), wire.slice(0, 300));

  // Filtering cannot reach past the limit: asking for Email gives nothing, not Email's figure.
  let v = await json(await cli.api("POST", `/api/v1/widgets/${sum.id}/view`, { filters: [{ field: "source", values: ["Email"] }] }));
  assert.equal(v.data, null);
  v = await json(await cli.api("POST", `/api/v1/widgets/${sum.id}/view`, { filters: [{ field: "amount", range: [1, 5] }] }));
  assert.equal(v.data.value, 9); // 1 + 3 + 5
  v = await json(await cli.api("POST", `/api/v1/widgets/${snap.id}/view`, { filters: [] }));
  assert.equal(v.withheld, true);
  // The values offered to filter by are the client's own too.
  const fields = await json(await cli.api("GET", `/api/v1/dashboards/${board}/fields`));
  assert.deepEqual(fields.fields.find((f) => f.name === "source").values, ["Ads"]);
  assert.equal(fields.fields.find((f) => f.name === "amount").max, 19);
  // Rows behind a card are limited the same way; an alert, which reports the whole figure, is refused.
  const rows = await json(await cli.api("POST", `/api/v1/widgets/${split.id}/rows`, { filters: [] }));
  assert.equal(rows.count, 10);
  assert.ok(rows.rows.every((r) => r[1] === "Ads"));
  assert.equal(rows.totals.find((t) => t.column === "amount").total, 100);
  assert.equal((await cli.api("POST", `/api/v1/widgets/${sum.id}/alerts`, { op: "above", threshold: 1 })).status, 403);

  // The owner still sees everything, and an editor cannot be limited.
  assert.equal((await json(await stack.api("GET", `/api/v1/dashboards/${board}/widgets`))).widgets.find((w) => w.id === sum.id).data.value, 210);
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${board}/shares`, { email: cli.email, role: "editor", limits: [{ field: "source", values: ["Ads"] }] })).status, 400);
  // Lifting the limit shows the whole report again.
  assert.equal((await stack.api("PUT", `/api/v1/dashboards/${board}/shares`, { email: cli.email, role: "viewer", limits: [] })).status, 200);
  assert.equal((await json(await cli.api("GET", `/api/v1/dashboards/${board}/widgets`))).widgets.find((w) => w.id === sum.id).data.value, 210);
});
