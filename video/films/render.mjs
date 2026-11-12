// Render a film: every frame is a pure function of its number; a browser draws it and ffmpeg encodes it.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
const require = createRequire("/home/user/gridzero/tests/e2e/");
const { chromium } = require("playwright");
const dir = new URL("./", import.meta.url).pathname;
const [name, mode = "master", ...rest] = process.argv.slice(2);
const TUT = { dana: "tut/v1.json", priya: "tut/v2.json", agency2: "tut/v3.json", trust2: "tut/v4.json", analyst: "tut/v5.json", tour: "tut/v6.json" };
const data = JSON.parse(readFileSync(dir + (TUT[name] ?? "snap/snaps.json"), "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => { console.log("pageerror", e.message); });
await page.goto("file://" + dir + (TUT[name] ? "tut.html" : "film.html"));
const frames = await page.evaluate(([d, n]) => window.init(d, n), [data, name]);
if (mode === "outline") { for (const c of rest) console.log(c, "\n  " + (await page.evaluate((x) => window.outline(x), c)).join("\n  ")); }
else if (mode === "stills") {
  mkdirSync(`${dir}out/${name}-stills`, { recursive: true });
  for (const s of rest) { const f = Math.round(Number(s) * 30); await page.evaluate((x) => window.renderFrame(x), f); await page.screenshot({ path: `${dir}out/${name}-stills/t${String(s).padStart(5, "0")}.png` }); }
  console.log("stills", rest.length, "of", frames, "frames");
} else {
  const out = `${dir}out/${name}-16x9-30fps.mp4`;
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "-", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.evaluate((x) => window.renderFrame(x), f);
    const buf = await page.screenshot({ type: "jpeg", quality: 96 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${frames} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote", out, frames, "frames");
}
await browser.close();
