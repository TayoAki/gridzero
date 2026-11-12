// Film 4 (Priya, data lead): the data models itself, one question is asked, and an AI answer becomes a test.
// The agent's wording here comes from a scripted stand-in model; the screens, numbers and checks are the real app's.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { E2E, call, person, require, shot } from "./lib.mjs";
const { chromium } = require("playwright");
const { startFakeAnthropic } = await import(E2E + "fake-anthropic.mjs");
const { Stack } = await import(E2E + "harness.mjs");
const dir = new URL("./", import.meta.url).pathname;
mkdirSync(dir + "v4", { recursive: true });
const fake = await startFakeAnthropic();
const stack = new Stack({ controlPort: 8997, wbhostPort: 8998, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", WEB_DIST: "/home/user/gridzero/apps/web/dist" } });
await stack.start();
const snaps = {};

// Made-up orders: every tenth is cancelled, so "revenue" has two honest answers.
const sources = ["Google Ads", "Meta Ads", "Email", "Organic"];
const rows = ["order_id,status,source,amount"];
let all = 0, paid = 0;
for (let i = 0; i < 1200; i++) {
  const amount = 30 + ((i * 53) % 240);
  const status = (i + 1) % 10 === 0 ? "cancelled" : "paid";
  all += amount;
  if (status === "paid") paid += amount;
  rows.push(`${i + 1},${status},${sources[(i * 5) % 4]},${amount}`);
}
writeFileSync(dir + "orders.csv", rows.join("\n") + "\n");
const fmt = (n) => n.toLocaleString("en-US");
console.log("all", fmt(all), "paid", fmt(paid));

try {
  const priya = await person(stack.base, "Priya Nair");
  await priya.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  await priya.api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const [n, v] = priya.cookie().split(/=(.*)/s);
  await ctx.addCookies([{ name: n, value: decodeURIComponent(v), url: stack.base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 200)));
  const save = async (k) => { await page.waitForTimeout(450); snaps[k] = await shot(page); await page.screenshot({ path: `${dir}v4/${k}.png` }); console.log("saved", k); };
  const results = () => console.log("tool results:", fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " + b.content.slice(0, 200) : "ok")));
  /** Type in the Ask bar, save the typed state, send, and wait for the reply. */
  const ask = async (text, script, wait, key) => {
    fake.script.push(...script);
    await page.getByLabel("Ask a question").fill(text);
    await save(`${key}-ask`);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByText(wait).first().waitFor({ timeout: 40000 });
    results();
    await page.waitForTimeout(600);
    await save(`${key}-answer`);
  };

  await page.goto(stack.base + "/");
  await page.getByRole("button", { name: /Upload a file/ }).waitFor();
  await page.getByPlaceholder("Message Analyst").waitFor();
  await save("a0-home");
  await page.getByRole("button", { name: /Upload a file/ }).click();
  await page.waitForURL(/\/workbook\//);
  await page.locator(".dialog input[type=file]").waitFor({ timeout: 30000 });
  await page.locator(".dialog input[type=file]").setInputFiles(dir + "orders.csv");
  await page.locator(".dialog button.primary-inline").waitFor({ timeout: 40000 });
  await page.getByLabel("Data table").check();
  await page.locator(".dialog button.primary-inline").click();
  await page.locator(".dialog").waitFor({ state: "detached", timeout: 60000 });
  await page.waitForTimeout(1500);
  const wb = page.url().split("/workbook/")[1].split("?")[0];
  await page.locator(".wb-title").fill("Orders").catch(() => {});
  await page.locator(".wb-title").press("Enter").catch(() => {});
  await page.waitForTimeout(600);
  await save("a1-table");

  // The first question makes the agent look at the tables, which models them.
  const tables = (await priya.json("GET", `/api/v1/workbooks/${wb}/tables`)).tables;
  const t = tables[0].table;
  console.log("table", t);
  await ask("What was revenue?", [
    call("list_tables", { workbook_id: wb }),
    call("query_tables", { workbook_id: wb, sql: `select sum(amount) as revenue from ${t}`, max_rows: null }),
    { text: `Across all 1,200 orders, revenue is ${fmt(all)}.\n\nOne thing decides this number: 120 orders are cancelled. Leaving them out gives ${fmt(paid)}. I have put that question under Needs you.`, stop: "end_turn" },
  ], "One thing decides this number", "b0");

  // Needs you: what was settled, and the one question that changes the number.
  await page.locator('.gz-rail a[aria-label^="Needs you"]').click();
  await page.locator("[data-testid=need-question]").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  await save("c0-needs");
  const q = page.locator("[data-testid=need-question]", { hasText: /cancelled/ }).first();
  await q.locator(".need-option").first().click();
  await save("c1-picked");
  await q.getByRole("button", { name: "Confirm" }).click();
  await page.locator(".ok-note").waitFor();
  await save("c2-answered");

  // Ask again: the answer now leaves cancelled orders out. Mark it as correct.
  await ask("What was revenue, leaving out cancelled orders?", [
    call("query_tables", { workbook_id: wb, sql: `select sum(amount) as revenue from ${t} where status = 'paid'`, max_rows: null }),
    { text: `Revenue is ${fmt(paid)}, from 1,080 paid orders. The 120 cancelled orders are left out, as you decided.`, stop: "end_turn" },
  ], "as you decided", "d0");
  const mark = page.locator(".gz-right").getByRole("button", { name: /Mark as correct/ }).last();
  await mark.waitFor({ timeout: 15000 });
  await mark.click();
  await page.locator(".gz-right").getByText(/Marked as correct/).last().waitFor();
  await save("d1-marked");

  // Checked answers: the agent is put to the same question again and graded.
  await page.locator('.gz-rail a[aria-label="Metrics"]').click();
  await page.locator(".gz-side-item").first().waitFor();
  await page.locator(".gz-side-item").first().click();
  await page.getByRole("tab", { name: /Checked answers/ }).or(page.getByRole("button", { name: /Checked answers/ })).first().click();
  await page.getByRole("button", { name: /Test the agent/ }).waitFor({ timeout: 15000 });
  await save("e0-checked");
  fake.script.push(call("query_tables", { workbook_id: wb, sql: `select sum(amount) as revenue from ${t} where status = 'paid'`, max_rows: null }), { text: `Revenue is ${fmt(paid)}.`, stop: "end_turn" });
  await page.getByRole("button", { name: /Test the agent/ }).click();
  await page.waitForTimeout(4000);
  await save("e1-passed");
  console.log("checked answers:", (await page.locator(".main").innerText()).replace(/\s+/g, " ").slice(0, 500));
  await browser.close();
} catch (e) { console.log("FAILED", e.message.split("\n").slice(0, 5).join(" | ").slice(0, 600)); }
finally {
  const dd = "/home/user/gridzero/apps/web/dist/assets/";
  const css = readdirSync(dd).filter((f) => f.endsWith(".css")).map((f) => readFileSync(dd + f, "utf8")).join("\n");
  writeFileSync(dir + "v4.json", JSON.stringify({ css, snaps }));
  console.log("states", Object.keys(snaps).join(" "));
  stack.stop(); await fake.close(); process.exit(0);
}
