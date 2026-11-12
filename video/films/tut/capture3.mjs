// Film 3 (Dana, agency reporting lead): one report for every client, each seeing only their own rows.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { E2E, person, require, shot } from "./lib.mjs";
const { chromium } = require("playwright");
const { startFakeAnthropic } = await import(E2E + "fake-anthropic.mjs");
const { Stack } = await import(E2E + "harness.mjs");
const dir = new URL("./", import.meta.url).pathname;
mkdirSync(dir + "v3", { recursive: true });
const fake = await startFakeAnthropic();
const stack = new Stack({ controlPort: 8997, wbhostPort: 8998, controlEnv: { ANTHROPIC_BASE_URL: fake.url, CONNECTION_SECRET_KEY: "e2e-connection-key", WEB_DIST: "/home/user/gridzero/apps/web/dist" } });
await stack.start();
const snaps = {};

// Made-up orders for three made-up clients, ending today so "Last 30 days" has rows. Nothing here is real.
const clients = ["Birchwood Coffee", "Acme Outdoors", "Cedar & Co"];
const sources = ["Google Ads", "Meta Ads", "Email", "Organic"];
const today = Date.now();
const rows = ["order_id,client,source,amount,ordered_at"];
for (let i = 0; i < 900; i++) {
  const c = i % 3;
  const amount = 20 + ((i * 37) % 180) + c * 15;
  rows.push(`${i + 1},${clients[c]},${sources[(i * 7 + c) % 4]},${amount},${new Date(today - (899 - i) * 0.3 * 86400000).toISOString().slice(0, 10)}`);
}
writeFileSync(dir + "clients.csv", rows.join("\n") + "\n");

try {
  const dana = await person(stack.base, "Dana Reyes");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const [n, v] = dana.cookie().split(/=(.*)/s);
  await ctx.addCookies([{ name: n, value: decodeURIComponent(v), url: stack.base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 200)));
  const saveOn = async (p, k) => { await p.waitForTimeout(450); snaps[k] = await shot(p); await p.screenshot({ path: `${dir}v3/${k}.png` }); console.log("saved", k); };
  const save = (k) => saveOn(page, k);

  await page.goto(stack.base + "/");
  await page.evaluate(() => { localStorage.setItem("gz_right", "false"); });
  await page.goto(stack.base + "/");
  await page.getByRole("button", { name: /Upload a file/ }).waitFor();
  await save("a0-home");

  await page.getByRole("button", { name: /Upload a file/ }).click();
  await page.waitForURL(/\/workbook\//);
  await page.locator(".dialog input[type=file]").waitFor({ timeout: 30000 });
  await page.locator(".dialog input[type=file]").setInputFiles(dir + "clients.csv");
  await page.locator(".dialog button.primary-inline").waitFor({ timeout: 40000 });
  await page.getByLabel("Data table").check();
  await save("a2-preview");
  await page.locator(".dialog button.primary-inline").click();
  await page.locator(".dialog").waitFor({ state: "detached", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.locator(".wb-title").fill("Client orders").catch(() => {});
  await page.locator(".wb-title").press("Enter").catch(() => {});
  await page.waitForTimeout(600);
  await save("a3-table");

  // The report, built by hand: no agent, no analyst.
  await page.locator('.gz-rail a[aria-label^="Reports"]').click();
  await page.locator(".report-empty").waitFor({ timeout: 15000 });
  await page.locator(".dashboard-name").fill("Monthly client report");
  await page.locator(".dashboard-name").press("Enter");
  await page.waitForTimeout(500);
  await save("b0-empty");
  const d = page.locator(".builder-dialog");
  const ctl = (label) => d.locator("label").filter({ hasText: new RegExp("^" + label) }).locator("select, input");
  const build = async (pick, key) => {
    await page.getByRole("button", { name: /^Add a card/ }).first().click();
    await ctl("Table").waitFor();
    if (key === "b1-builder") await save("b1-open");
    for (const [label, value] of pick) await ctl(label).selectOption(value);
    await d.locator(".builder-preview .widget-card").waitFor();
    await page.waitForTimeout(900);
    if (key) await save(key);
    await d.getByRole("button", { name: "Add to report" }).click();
    await d.waitFor({ state: "detached" });
  };
  await build([["Show", "sum"], ["Column", "amount"]], "b1-builder");
  await build([["Show", "sum"], ["Column", "amount"], ["Split by", "client"]], "b2-split");
  await build([["Show", "sum"], ["Column", "amount"], ["Split by", "ordered_at"]], null);
  await page.locator(".widget-card").nth(2).waitFor();
  await page.waitForTimeout(1500);
  await save("c0-report");

  // A date range: the cards say they were worked out again.
  await page.getByLabel("Date range").selectOption("30d");
  await page.waitForTimeout(3000);
  await page.getByText(/Compare with the 30 days before/).click();
  await page.waitForTimeout(3000);
  await save("c1-filtered");
  await page.getByRole("button", { name: "Clear all" }).click();
  await page.waitForTimeout(1500);

  // Share it with one client, limited to their rows.
  const email = "bea@birchwood.example";
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.locator(".report-dialog");
  await share.getByLabel("Email address").waitFor();
  await save("d0-share");
  await share.getByLabel("Email address").fill(email);
  await save("d1-typed");
  await share.getByRole("button", { name: "Invite" }).click();
  await share.locator(".report-list li").waitFor();
  await save("d2-invited");
  await share.getByRole("button", { name: "Limit what they see…" }).click();
  await share.getByLabel("Field").selectOption("client");
  await share.getByLabel("Value", { exact: true }).selectOption("Birchwood Coffee");
  await save("d3-limit");
  await share.getByRole("button", { name: "Apply" }).click();
  await share.locator(".report-limit").waitFor();
  await save("d4-limited");
  const inviteUrl = await share.locator(".report-list input").first().inputValue();
  await page.keyboard.press("Escape");

  // What the client sees.
  const vctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const signup = await vctx.request.post(stack.base + "/api/auth/sign-up/email", { data: { name: "Bea Lindqvist", email, password: "correct-horse-9" } });
  // The made-up client may exist from an earlier capture: sign in instead.
  if (signup.status() !== 200) console.log("client signed in", (await vctx.request.post(stack.base + "/api/auth/sign-in/email", { data: { email, password: "correct-horse-9" } })).status());
  const bea = await vctx.newPage();
  await bea.goto(stack.base + "/");
  await bea.evaluate(() => { localStorage.setItem("gz_right", "false"); });
  await bea.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, stack.base));
  await bea.locator(".widget-card").nth(2).waitFor({ timeout: 30000 });
  await bea.waitForTimeout(2500);
  await saveOn(bea, "e0-client");
  console.log("client view:", (await bea.locator(".slice-bar").first().innerText()).replace(/\s+/g, " "), "| total", (await bea.locator(".widget-value").first().innerText()).replace(/\s+/g, ""), "| mentions Acme:", (await bea.locator("body").innerText()).includes("Acme"));
  console.log("owner total:", (await page.locator(".widget-value").first().innerText()).replace(/\s+/g, ""));
  await browser.close();
} catch (e) { console.log("FAILED", e.message.split("\n").slice(0, 5).join(" | ").slice(0, 600)); }
finally {
  const dd = "/home/user/gridzero/apps/web/dist/assets/";
  const css = readdirSync(dd).filter((f) => f.endsWith(".css")).map((f) => readFileSync(dd + f, "utf8")).join("\n");
  writeFileSync(dir + "v3.json", JSON.stringify({ css, snaps }));
  console.log("states", Object.keys(snaps).join(" "));
  stack.stop(); await fake.close(); process.exit(0);
}
