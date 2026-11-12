// Film 5 (Ana, data analyst): from an orders export to an answer with its whole trail: her own
// query, a card she built, the rows behind it, a notebook with Python, and a link that keeps her filters.
// No agent is used, so nothing in this film is staged wording. The data is made up.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { E2E, person, require, shot } from "./lib.mjs";
const { chromium } = require("playwright");
const { startFakeAnthropic } = await import(E2E + "fake-anthropic.mjs");
const { Stack } = await import(E2E + "harness.mjs");
const dir = new URL("./", import.meta.url).pathname;
mkdirSync(dir + "v5", { recursive: true });
const fake = await startFakeAnthropic();
const stack = new Stack({ controlPort: 8997, wbhostPort: 8998, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", WEB_DIST: "/home/user/gridzero/apps/web/dist" } });
await stack.start();
const snaps = {};

// Made-up orders: four regions, three channels, every twelfth refunded, ending today.
const regions = ["North", "South", "East", "West"], channels = ["Web", "Store", "Partner"];
const rows = ["order_id,region,channel,status,amount,ordered_at"];
let paid = 0;
for (let i = 0; i < 1200; i++) {
  const amount = 40 + ((i * 61) % 260) + (i % 4) * 12;
  const status = (i + 1) % 12 === 0 ? "refunded" : "paid";
  if (status === "paid") paid += amount;
  rows.push(`${i + 1},${regions[i % 4]},${channels[(i * 5) % 3]},${status},${amount},${new Date(Date.now() - (1199 - i) * 0.15 * 86400000).toISOString().slice(0, 10)}`);
}
writeFileSync(dir + "analyst-orders.csv", rows.join("\n") + "\n");
console.log("paid total", paid.toLocaleString("en-US"));

try {
  const ana = await person(stack.base, "Ana Okafor");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const [n, v] = ana.cookie().split(/=(.*)/s);
  await ctx.addCookies([{ name: n, value: decodeURIComponent(v), url: stack.base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 200)));
  const save = async (k) => { await page.waitForTimeout(450); snaps[k] = await shot(page); await page.screenshot({ path: `${dir}v5/${k}.png` }); console.log("saved", k); };

  await page.goto(stack.base + "/");
  await page.evaluate(() => { localStorage.setItem("gz_right", "false"); localStorage.setItem("gz_lens", "analyse"); });
  await page.goto(stack.base + "/");
  await page.getByRole("button", { name: /Upload a file/ }).waitFor();
  await save("a0-home");
  await page.getByRole("button", { name: /Upload a file/ }).click();
  await page.waitForURL(/\/workbook\//);
  await page.locator(".dialog input[type=file]").waitFor({ timeout: 30000 });
  await page.locator(".dialog input[type=file]").setInputFiles(dir + "analyst-orders.csv");
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
  const table = (await ana.json("GET", `/api/v1/workbooks/${wb}/tables`)).tables[0].table;
  console.log("table", table);

  // Her own query.
  const sql = `SELECT region, SUM(amount) AS revenue\nFROM ${table}\nWHERE status = 'paid'\nGROUP BY region\nORDER BY revenue DESC`;
  await page.goto(`${stack.base}/sql?wb=${wb}&q=${encodeURIComponent(sql)}`);
  await page.locator(".code-editor .cm-content").waitFor();
  await page.locator(".sql-tree").waitFor();
  await page.waitForTimeout(800);
  await save("b0-sql");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator(".sql-result table, .sql-grid table, table").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  await save("b1-result");

  // A card built by hand, on a report.
  await page.locator('.gz-rail a[aria-label^="Reports"]').click();
  await page.locator(".report-empty").waitFor({ timeout: 15000 });
  await page.locator(".dashboard-name").fill("Regional revenue");
  await page.locator(".dashboard-name").press("Enter");
  await page.waitForTimeout(500);
  await save("c0-empty");
  const d = page.locator(".builder-dialog");
  const ctl = (label) => d.locator("label").filter({ hasText: new RegExp("^" + label) }).locator("select, input");
  const build = async (pick, keep, key) => {
    await page.getByRole("button", { name: /^Add a card/ }).first().click();
    await ctl("Table").waitFor();
    if (key) await save("c1-open");
    for (const [label, value] of pick) await ctl(label).selectOption(value);
    if (keep) {
      await d.getByRole("button", { name: "+ Add a condition" }).click();
      await d.getByLabel("Column", { exact: true }).selectOption("status");
      await d.getByLabel("Value", { exact: true }).fill("paid");
    }
    await d.locator(".builder-preview .widget-card").waitFor();
    await page.waitForTimeout(1100);
    if (key) await save(key);
    await d.getByRole("button", { name: "Add to report" }).click();
    await d.waitFor({ state: "detached" });
  };
  await build([["Show", "sum"], ["Column", "amount"], ["Split by", "region"]], true, "c2-builder");
  await build([["Show", "sum"], ["Column", "amount"]], true, null);
  await build([["Show", "sum"], ["Column", "amount"], ["Split by", "ordered_at"]], true, null);
  await page.locator(".widget-card").nth(2).waitFor();
  await page.waitForTimeout(1500);
  await save("c3-report");

  // The rows behind the card.
  await page.getByRole("button", { name: /^Options for Total amount by region/ }).click();
  await save("d0-menu");
  await page.getByRole("button", { name: "Open large" }).click();
  await page.getByRole("button", { name: "Rows behind it" }).waitFor();
  await save("d1-large");
  await page.getByRole("button", { name: "Rows behind it" }).click();
  await page.getByText(/rows/i).first().waitFor();
  await page.waitForTimeout(1500);
  await save("d2-rows");
  await page.keyboard.press("Escape");

  // A notebook: a note, a Python cell, the result.
  const nb = (await ana.json("POST", `/api/v1/workbooks/${wb}/notebooks`, { title: "Which region is slipping?", cells: [
    { id: "a", kind: "note", text: "Compare each region's last 30 days with the 30 before." },
    { id: "b", kind: "python", text: `df = sql("""\n  select region,\n         sum(amount) filter (where ordered_at >= current_date - 30) as last_30,\n         sum(amount) filter (where ordered_at <  current_date - 30 and ordered_at >= current_date - 60) as before\n  from ${table} where status = 'paid' group by 1\n""").df()\ndf["change_pct"] = ((df["last_30"] / df["before"] - 1) * 100).round(1)\nsave("region_change", df.sort_values("change_pct"))` },
  ] })).notebook;
  await page.goto(`${stack.base}/lab?wb=${wb}`);
  await page.getByRole("button", { name: "Which region is slipping?" }).click();
  await page.locator("[data-testid=cell]").nth(1).waitFor();
  await page.waitForTimeout(600);
  await save("e0-notebook");
  await page.locator("[data-testid=cell]").nth(1).getByRole("button", { name: "Run" }).click();
  await page.locator(".cell-result table").waitFor({ timeout: 60000 });
  await page.waitForTimeout(700);
  await save("e1-ran");
  console.log("notebook result:", (await page.locator(".cell-result").innerText()).replace(/\s+/g, " ").slice(0, 300), nb.id);

  // Back on the report: filter it, and copy a link that keeps the filter.
  await page.locator('.gz-rail a[aria-label^="Reports"]').click();
  await page.locator(".widget-card").nth(2).waitFor();
  await page.waitForTimeout(1200);
  await page.getByLabel("Date range").selectOption("30d");
  await page.waitForTimeout(3000);
  await page.getByText(/Compare with the 30 days before/).click();
  await page.waitForTimeout(3000);
  await save("f0-filtered");
  console.log("filtered:", (await page.locator(".widget-value").first().innerText()).replace(/\s+/g, ""), "|", (await page.locator(".slice-bar, .filter-bar").first().innerText()).replace(/\s+/g, " ").slice(0, 160));
  await browser.close();
} catch (e) { console.log("FAILED", e.message.split("\n").slice(0, 5).join(" | ").slice(0, 700)); }
finally {
  const dd = "/home/user/gridzero/apps/web/dist/assets/";
  const css = readdirSync(dd).filter((f) => f.endsWith(".css")).map((f) => readFileSync(dd + f, "utf8")).join("\n");
  writeFileSync(dir + "v5.json", JSON.stringify({ css, snaps }));
  console.log("states", Object.keys(snaps).join(" "));
  stack.stop(); await fake.close(); process.exit(0);
}
