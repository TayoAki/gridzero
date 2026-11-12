// Film 6 (the whole app, one sitting): sign in, upload a file, work in the spreadsheet, ask a question,
// build a report, filter it, check the rows, share it, and what the teammate then sees.
// The agent's wording comes from a scripted stand-in model; everything else is the real app. The data is made up.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { E2E, call, require, shot } from "./lib.mjs";
const { chromium } = require("playwright");
const { startFakeAnthropic } = await import(E2E + "fake-anthropic.mjs");
const { Stack } = await import(E2E + "harness.mjs");
const dir = new URL("./", import.meta.url).pathname;
mkdirSync(dir + "v6", { recursive: true });
const fake = await startFakeAnthropic();
const stack = new Stack({ controlPort: 8997, wbhostPort: 8998, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", WEB_DIST: "/home/user/gridzero/apps/web/dist" } });
await stack.start();
const snaps = {};
const fmt = (n) => n.toLocaleString("en-US");

// The same made-up orders as film 5: four regions, every twelfth refunded.
const regions = ["North", "South", "East", "West"], channels = ["Web", "Store", "Partner"];
const rows = ["order_id,region,channel,status,amount,ordered_at"];
const by = {}; let paid = 0;
for (let i = 0; i < 1200; i++) {
  const amount = 40 + ((i * 61) % 260) + (i % 4) * 12;
  const status = (i + 1) % 12 === 0 ? "refunded" : "paid";
  if (status === "paid") { paid += amount; by[regions[i % 4]] = (by[regions[i % 4]] ?? 0) + amount; }
  rows.push(`${i + 1},${regions[i % 4]},${channels[(i * 5) % 3]},${status},${amount},${new Date(Date.now() - (1199 - i) * 0.15 * 86400000).toISOString().slice(0, 10)}`);
}
writeFileSync(dir + "orders-export.csv", rows.join("\n") + "\n");
console.log("paid", fmt(paid), JSON.stringify(by));

try {
  const tag = Math.random().toString(36).slice(2, 7);
  const email = `ana.okafor-${tag}@example.com`, password = "correct-horse-9";
  const su = await fetch(stack.base + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: stack.base }, body: JSON.stringify({ name: "Ana Okafor", email, password }) });
  if (su.status !== 200) throw new Error("sign-up " + su.status);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 200)));
  // The sign-in page sits outside the app shell; wrap it so the film engine can treat it like any screen.
  const shotAuth = () => page.evaluate(() => {
    const src = document.querySelector(".auth-page"), clone = src.cloneNode(true);
    const a = src.querySelectorAll("input"), b = clone.querySelectorAll("input");
    a.forEach((el, i) => b[i].setAttribute("value", el.type === "password" ? "•".repeat(el.value.length) : el.value));
    b.forEach((el) => { if (el.type === "password") el.setAttribute("type", "text"); });
    return `<div class="gz-shell" style="display:block;width:1920px;height:1080px">${clone.outerHTML}</div>`;
  });
  const save = async (k, on = page, auth = false) => { await on.waitForTimeout(450); snaps[k] = auth ? await shotAuth() : await shot(on); await on.screenshot({ path: `${dir}v6/${k}.png` }); console.log("saved", k); };

  // 1. Sign in.
  await page.goto(stack.base + "/login");
  await page.locator(".auth-card").waitFor();
  await save("l0-login", page, true);
  await page.locator(".auth-card input[type=email]").fill(email);
  await page.locator(".auth-card input[type=password]").fill(password);
  await save("l1-typed", page, true);
  await page.locator(".auth-card button.primary").click();
  await page.getByRole("button", { name: /Upload a file/ }).waitFor({ timeout: 30000 });
  // The agent needs a key and a name before it can be asked anything.
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); }, [method, path, body]);
  await api("PUT", "/api/v1/ai-key", { key: "sk-ant-test-good" });
  await api("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" });
  await page.goto(stack.base + "/");
  await page.getByRole("button", { name: /Upload a file/ }).waitFor();
  await page.getByPlaceholder("Message Analyst").waitFor();
  await save("a0-home");

  // 2. Upload a file.
  await page.getByRole("button", { name: /Upload a file/ }).click();
  await page.waitForURL(/\/workbook\//);
  await page.locator(".dialog input[type=file]").waitFor({ timeout: 30000 });
  await save("a1-pick");
  await page.locator(".dialog input[type=file]").setInputFiles(dir + "orders-export.csv");
  await page.locator(".dialog button.primary-inline").waitFor({ timeout: 40000 });
  await page.getByLabel("Data table").check();
  await save("a2-preview");
  await page.locator(".dialog button.primary-inline").click();
  await page.locator(".dialog").waitFor({ state: "detached", timeout: 60000 });
  await page.waitForTimeout(1500);
  const wb = page.url().split("/workbook/")[1].split("?")[0];
  await page.locator(".wb-title").fill("Orders").catch(() => {});
  await page.locator(".wb-title").press("Enter").catch(() => {});
  await page.waitForTimeout(600);
  await save("a3-table");
  const t = (await api("GET", `/api/v1/workbooks/${wb}/tables`)).tables[0].table;
  console.log("table", t);

  // 3. Work in the spreadsheet: a label and a formula beside the data.
  const goto = async (ref) => { await page.getByLabel("Name box").fill(ref); await page.getByLabel("Name box").press("Enter"); await page.waitForTimeout(300); };
  await goto("H2"); await page.keyboard.type("Paid revenue"); await page.keyboard.press("Enter");
  await goto("H3");
  await save("s0-cell");
  await page.keyboard.type('=SUMIF(D:D,"paid",E:E)'); await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await goto("H3");
  await page.waitForTimeout(600);
  await save("s1-formula");
  console.log("formula bar:", await page.getByLabel("Formula bar").inputValue());

  // 4. Ask a question in plain words.
  fake.script.push(
    call("list_tables", { workbook_id: wb }),
    call("query_tables", { workbook_id: wb, sql: `select region, sum(amount) as revenue from ${t} where status = 'paid' group by 1 order by 2 desc`, max_rows: null }),
    { text: `Paid revenue is ${fmt(paid)} across 1,100 orders.\n\nBy region: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([r, v]) => `${r} ${fmt(v)}`).join(", ")}. Refunded orders are left out.`, stop: "end_turn" },
  );
  await page.getByLabel("Ask a question").fill("Which region brings in the most paid revenue?");
  await save("b0-ask");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText("Refunded orders are left out").first().waitFor({ timeout: 40000 });
  console.log("tool results:", fake.requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result").map((b) => (b.is_error ? "ERR " + b.content.slice(0, 200) : "ok " + String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 160))));
  await page.waitForTimeout(600);
  await save("b1-answer");

  // 5. Build a report.
  await page.locator('.gz-rail a[aria-label^="Reports"]').click();
  await page.locator(".report-empty").waitFor({ timeout: 15000 });
  await page.locator(".dashboard-name").fill("Regional revenue");
  await page.locator(".dashboard-name").press("Enter");
  await page.waitForTimeout(500);
  await save("c0-empty");
  const d = page.locator(".builder-dialog");
  const ctl = (label) => d.locator("label").filter({ hasText: new RegExp("^" + label) }).locator("select, input");
  const build = async (pick, key) => {
    await page.getByRole("button", { name: /^Add a card/ }).first().click();
    await ctl("Table").waitFor();
    if (key) await save("c1-open");
    for (const [label, value] of pick) await ctl(label).selectOption(value);
    await d.getByRole("button", { name: "+ Add a condition" }).click();
    await d.getByLabel("Column", { exact: true }).selectOption("status");
    await d.getByLabel("Value", { exact: true }).fill("paid");
    await d.locator(".builder-preview .widget-card").waitFor();
    await page.waitForTimeout(1100);
    if (key) await save(key);
    await d.getByRole("button", { name: "Add to report" }).click();
    await d.waitFor({ state: "detached" });
  };
  await build([["Show", "sum"], ["Column", "amount"], ["Split by", "region"]], "c2-builder");
  await build([["Show", "sum"], ["Column", "amount"]], null);
  await build([["Show", "sum"], ["Column", "amount"], ["Split by", "ordered_at"]], null);
  await page.locator(".widget-card").nth(2).waitFor();
  await page.waitForTimeout(1500);
  await save("c3-report");

  // 6. Filter it, and check the rows behind a chart.
  await page.getByLabel("Date range").selectOption("30d");
  await page.waitForTimeout(3000);
  await page.getByText(/Compare with the 30 days before/).click();
  await page.waitForTimeout(3000);
  await save("f0-filtered");
  console.log("filtered:", (await page.locator(".widget-value").first().innerText()).replace(/\s+/g, ""));
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
  await page.waitForTimeout(400);

  // 7. Share it with a teammate.
  const mate = `sam.rivera-${tag}@example.com`;
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.locator(".report-dialog");
  await share.getByLabel("Email address").waitFor();
  await save("g0-share");
  await share.getByLabel("Email address").fill(mate);
  await share.getByRole("button", { name: "Invite" }).click();
  await share.locator(".report-list li").waitFor();
  await save("g1-invited");
  const inviteUrl = await share.locator(".report-list input").first().inputValue();
  await page.keyboard.press("Escape");

  // What the teammate sees.
  const vctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const s2 = await vctx.request.post(stack.base + "/api/auth/sign-up/email", { data: { name: "Sam Rivera", email: mate, password } });
  console.log("teammate sign-up", s2.status());
  const sam = await vctx.newPage();
  await sam.goto(stack.base + "/");
  await sam.evaluate(() => { localStorage.setItem("gz_right", "false"); });
  await sam.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, stack.base));
  await sam.locator(".widget-card").nth(2).waitFor({ timeout: 30000 });
  await sam.waitForTimeout(2500);
  await save("h0-teammate", sam);
  console.log("teammate total:", (await sam.locator(".widget-value").first().innerText()).replace(/\s+/g, ""));
  await browser.close();
} catch (e) { console.log("FAILED", e.message.split("\n").slice(0, 5).join(" | ").slice(0, 700)); }
finally {
  const dd = "/home/user/gridzero/apps/web/dist/assets/";
  const css = readdirSync(dd).filter((f) => f.endsWith(".css")).map((f) => readFileSync(dd + f, "utf8")).join("\n");
  writeFileSync(dir + "v6.json", JSON.stringify({ css, snaps }));
  console.log("states", Object.keys(snaps).join(" "));
  stack.stop(); await fake.close(); process.exit(0);
}
