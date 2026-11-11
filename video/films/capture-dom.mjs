import { createRequire } from "node:module";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const E2E = "/home/user/gridzero/tests/e2e/";
const { Stack } = await import(E2E + "harness.mjs");
const out = new URL("./snap/", import.meta.url).pathname;
const stack = new Stack({ controlPort: 8995, wbhostPort: 8996, controlEnv: { CONNECTION_SECRET_KEY: "e2e-connection-key", WEB_DIST: "/home/user/gridzero/apps/web/dist" } });
await stack.start();
try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const [name, value] = stack.cookie.split(/=(.*)/s);
  await ctx.addCookies([{ name, value: decodeURIComponent(value), url: stack.base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 300)));
  await page.goto(stack.base + "/?preview=1");
  await page.locator(".gz-shell").waitFor();
  await page.evaluate(() => { localStorage.setItem("gz_right", "false"); localStorage.setItem("gz_tabs", "[]"); });
  const snaps = {};
  for (const code of ["L1", "L2", "L5", "L3", "M3", "J2", "J5", "J6", "M1"]) {
    await page.evaluate(() => localStorage.setItem("gz_tabs", "[]"));
    await page.goto(`${stack.base}/preview/${code}`);
    await page.locator(".pv-screen").waitFor({ timeout: 8000 }).catch(async (e) => { await page.screenshot({ path: out + "fail.png" }); console.log("url", page.url(), (await page.locator("body").innerText()).slice(0, 300)); throw e; });
    await page.waitForTimeout(400);
    snaps[code] = await page.evaluate(() => document.querySelector(".gz-shell").outerHTML);
    await page.screenshot({ path: `${out}${code}.png` });
    console.log(code, snaps[code].length);
  }
  const dir = "/home/user/gridzero/apps/web/dist/assets/";
  const css = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(dir + f, "utf8")).join("\n");
  writeFileSync(out + "snaps.json", JSON.stringify({ css, snaps }));
  await browser.close();
} catch (e) { console.log("FAILED", e.message.slice(0, 500)); } finally { stack.stop(); process.exit(0); }
