// Tutorial 1 (Dana, agency reporting lead): from an orders export to a confirmed number on a report.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { E2E, call, person, require, shot } from "./lib.mjs";
const { chromium } = require("playwright");
const { startFakeAnthropic } = await import(E2E + "fake-anthropic.mjs");
const { Stack } = await import(E2E + "harness.mjs");
const dir = new URL("./", import.meta.url).pathname;
mkdirSync(dir + "v1", { recursive: true });
const fake = await startFakeAnthropic();
const stack = new Stack({ controlPort: 8997, wbhostPort: 8998, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", WEB_DIST: "/home/user/gridzero/apps/web/dist" } });
await stack.start();
const snaps = {};
try {
  const dana = await person(stack.base, "Dana Reyes");
  await dana.api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const [n, v] = dana.cookie().split(/=(.*)/s);
  await ctx.addCookies([{ name: n, value: decodeURIComponent(v), url: stack.base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 200)));
  const save = async (k) => { await page.waitForTimeout(350); snaps[k] = await shot(page); await page.screenshot({ path: `${dir}v1/${k}.png` }); console.log("saved", k); };
  const ask = async (text, script, wait) => {
    fake.script.push(...script);
    await page.getByPlaceholder("Message Analyst").fill(text);
    await save(`ask-${Object.keys(snaps).length}`);
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText(wait).first().waitFor({ timeout: 40000 });
  };

  await page.goto(stack.base + "/");
  await page.getByRole("button", { name: "Create an agent" }).click();
  await page.getByPlaceholder("Message Analyst").waitFor();
  await save("a0-home");

  await page.getByRole("button", { name: /Upload a file/ }).click();
  await page.waitForURL(/\/workbook\//);
  await page.locator(".dialog input[type=file]").waitFor({ timeout: 30000 });
  await save("a1-pick");
  await page.locator(".dialog input[type=file]").setInputFiles(dir + "orders.csv");
  await page.locator(".dialog button.primary-inline").waitFor({ timeout: 40000 });
  await page.getByLabel("Data table").check();
  await save("a2-preview");
  await page.locator(".dialog button.primary-inline").click();
  await page.locator(".dialog").waitFor({ state: "detached", timeout: 60000 });
  await page.waitForTimeout(1500);
  const wb = page.url().split("/workbook/")[1].split("?")[0];
  await page.locator(".wb-title").fill("Larkspur · October").catch(() => {});
  await page.locator(".wb-title").press("Enter").catch(() => {});
  await page.waitForTimeout(600);
  await save("a3-table");

  await ask("What was revenue by source?", [
    call("list_tables", { workbook_id: wb }),
    call("query_tables", { workbook_id: wb, sql: "select source, sum(gross_sales) as revenue from orders_csv group by 1 order by 2 desc", max_rows: null }),
    { text: "Across all 6,000 orders, Google Ads leads with 123,148, then Email 112,977, TikTok Ads 112,818, Meta Ads 112,033 and Organic 103,475. That is 564,451 in total.\n\nOne thing decides this number: 590 orders are refunded, cancelled or test. Leaving them out gives 510,535. I counted every order for now. You can settle it under How we count.", stop: "end_turn" },
  ], "One thing decides this number");
  console.log("tool results:", fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " + b.content.slice(0, 160) : b.content.slice(0, 160))));
  await save("a5-answer");

  await page.locator('.gz-rail a[aria-label="How we count"]').click();
  await page.locator(".gz-side-item").first().click();
  await page.locator(".def-tabs").waitFor();
  const sourceId = page.url().split("/definitions/")[1];
  await save("a6-questions");
  await page.locator(".def-option", { hasText: "Leave out" }).first().click();
  await page.waitForTimeout(1500);
  await save("a7-answered");
  await page.locator(".def-tabs button", { hasText: "How we count" }).click();
  await save("a8-count");
  const review = await dana.json("GET", `/api/v1/sources/${sourceId}/review`);
  const metric = review.definitions.find((d) => d.kind === "metric" && d.name === "total_gross_sales");
  console.log("metric", metric.label, JSON.stringify(metric.body).slice(0, 200));
  const row = page.locator(`[data-testid="def-metric-total_gross_sales"]`);
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: "Confirm" }).click();
  await row.getByText("Confirmed").first().waitFor({ timeout: 20000 });
  await save("a9-confirmed");

  await page.locator(".gz-tab a", { hasText: "Larkspur" }).first().click().catch(async () => { await page.goto(`${stack.base}/workbook/${wb}`); });
  await page.getByPlaceholder("Message Analyst").waitFor();
  await page.waitForTimeout(1500);
  await page.locator(".wb-footer").getByText("orders", { exact: true }).click().catch((e) => console.log("no sheet tab", e.message.slice(0, 80)));
  await page.waitForTimeout(800);
  await ask("What was total gross sales?", [
    call("list_definitions", {}),
    call("query_definition", { definition_id: metric.id, group_by: [], limit: null }),
    { text: "Total gross sales is 510,535. It leaves out refunded, cancelled and test orders, as you decided. Confirmed by Dana Reyes today.", stop: "end_turn" },
  ], "Confirmed by Dana Reyes today");
  console.log("tool results:", fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " + b.content.slice(0, 160) : b.content.slice(0, 200))));
  await save("b1-confirmed-answer");
  await page.getByRole("button", { name: /Mark as correct/ }).last().click();
  await page.getByText("Marked as correct.").waitFor();
  await save("b2-marked");

  await ask("Put that on a report.", [
    call("propose_widget", { title: "Total gross sales", designs: [{ form: "number", theme: "blue" }], data: { kind: "number", value: 510535, unit: null, delta: null, label: "October, paid orders" }, source: { kind: "definition", definitionId: metric.id, groupBy: [], shape: "number" } }),
    { text: "Here is a design. Add it and it will follow the confirmed number.", stop: "end_turn" },
  ], "Here is a design");
  console.log("tool results:", fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " + b.content.slice(0, 200) : "ok")));
  await page.getByRole("button", { name: "Add to dashboard" }).first().waitFor({ timeout: 15000 });
  await save("b4-proposal");
  await page.getByRole("button", { name: "Add to dashboard" }).first().click();
  await page.getByText(/Added to/).first().waitFor();
  await save("b5-added");
  await page.locator('.gz-rail a[aria-label="Reports"]').click();
  await page.locator(".widget, .widget-card, [class*=widget]").first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await save("b6-report");
  await browser.close();
} catch (e) { console.log("FAILED", e.message.split("\n").slice(0, 5).join(" | ").slice(0, 600)); }
finally {
  const d = "/home/user/gridzero/apps/web/dist/assets/";
  const css = readdirSync(d).filter((f) => f.endsWith(".css")).map((f) => readFileSync(d + f, "utf8")).join("\n");
  writeFileSync(dir + "v1.json", JSON.stringify({ css, snaps }));
  console.log("states", Object.keys(snaps).join(" "));
  stack.stop(); await fake.close(); process.exit(0);
}
