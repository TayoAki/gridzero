// Builds bench/report.html from the newest GridZero result in bench/results and the
// hand-timed columns in bench/scoresheet.csv.
//
//   node bench/report.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FORMULAS } from "./formulas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(join(here, "results")).filter((f) => f.startsWith("gridzero-") && f.endsWith(".json"));
if (!files.length) throw new Error("No GridZero results yet: run bench/gridzero.mjs first");
const runs = files.map((f) => JSON.parse(readFileSync(join(here, "results", f), "utf8")));
const run = runs.sort((a, b) => b.ranAt.localeCompare(a.ranAt))[0];

/** Minimal CSV: quoted fields, doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((x) => x !== ""));
}

const [head, ...sheet] = parseCsv(readFileSync(join(here, "scoresheet.csv"), "utf8"));
const products = head.slice(5);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 1 : 0 });

// What GridZero has today (C rows), kept beside the code that would change it.
const GRIDZERO_CAPS = {
  C1: "1M rows tested in a Data Table; 10M cells readable by formulas",
  C2: "Yes: a Python panel, and functions callable from cells",
  C3: "Postgres, Redshift, Snowflake, Databricks, BigQuery",
  C4: "Yes: hourly, daily or weekly",
  C5: "Yes",
  C6: "Yes",
  C7: "Yes",
  C8: "Not yet",
  C9: "Not set",
  C10: "Not set",
};

const ROW_ZERO_DATE = "2026-11-09";

const result = (id, size) => run.results.find((r) => r.id === id && (!size || String(r.size) === String(size)));
const baseline = result("T0")?.value ?? 0;

function gridzeroCell(id, size, unit) {
  const r = result(id, size);
  if (!r) return `<span class="none">Not run</span>`;
  if (id === "T9") return `<span class="val">${r.value}</span> <span class="unit">of ${size}</span>`;
  if (id === "T0") return `<span class="val">${num(r.value)}</span> <span class="unit">ms</span>`;
  if (unit === "s") return `<span class="val">${num(r.value)}</span> <span class="unit">s</span>`;
  const server = Math.max(0, r.value - baseline);
  const net = Math.min(r.value, baseline);
  const pctNet = (100 * net) / r.value;
  return `<span class="val">${num(r.value)}</span> <span class="unit">ms</span>
    <span class="split" role="img" aria-label="${num(net)} ms network, ${num(server)} ms server"><i class="net" style="width:${pctNet.toFixed(1)}%"></i><i class="srv" style="width:${(100 - pctNet).toFixed(1)}%"></i></span>
    <span class="note">${num(server)} ms server</span>`;
}

const otherCell = (v) => (v ? `<span class="val">${esc(v)}</span>` : `<span class="none">Not measured</span>`);

const speedRows = sheet
  .filter((r) => r[0].startsWith("T"))
  .map(([id, size, task, unit, how, ...others]) => `
      <tr>
        <th scope="row"><span class="id">${id}</span> ${esc(task)}<span class="how">${esc(how)}</span></th>
        <td class="num">${size ? Number(size).toLocaleString("en-US") : ""}</td>
        <td class="gz">${gridzeroCell(id, size, unit)}</td>
        ${others.map((v) => `<td>${otherCell(v)}</td>`).join("")}
      </tr>`)
  .join("");

const capRows = sheet
  .filter((r) => r[0].startsWith("C"))
  .map(([id, , task, , how, ...others]) => `
      <tr>
        <th scope="row">${esc(task)}${how ? `<span class="how">${esc(how)}</span>` : ""}</th>
        <td class="gz">${esc(GRIDZERO_CAPS[id] ?? "")}</td>
        ${others.map((v) => `<td>${otherCell(v)}</td>`).join("")}
      </tr>`)
  .join("");

const missed = new Set((run.formulaMisses ?? []).map((m) => m.formula));
const areas = [...new Set(FORMULAS.map((f) => f[0]))].map((area) => {
  const all = FORMULAS.filter((f) => f[0] === area);
  return { area, total: all.length, pass: all.filter((f) => !missed.has(f[1])).length };
});
const t9 = result("T9");

const html = `<title>GridZero Benchmark</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600&display=swap">
<style>
/* Layout: one reading column; wide tables scroll inside their own frame. */
:root {
  --paper: #f6f7f9; --sheet: #ffffff; --ink: #18202b; --muted: #5d6877; --line: #dde2e8;
  --accent: #0f6e8c; --net: #b9c3cf; --miss: #b4442d; --ok: #2f7a4f;
  --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
  --display: "IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #11161c; --sheet: #171e26; --ink: #e5eaf0; --muted: #98a4b3; --line: #2a3440;
  --accent: #4fb3d4; --net: #3d4957; --miss: #e07a63; --ok: #6cc292; color-scheme: dark } }
:root[data-theme="dark"] {
  --paper: #11161c; --sheet: #171e26; --ink: #e5eaf0; --muted: #98a4b3; --line: #2a3440;
  --accent: #4fb3d4; --net: #3d4957; --miss: #e07a63; --ok: #6cc292; color-scheme: dark }
body { background: var(--paper); color: var(--ink); font: 15px/1.55 var(--sans);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 40px 64px; }
main { max-width: 1120px; margin: 0 auto; display: grid; gap: 40px; }
header { display: grid; gap: 10px; max-width: 70ch; }
h1 { font: 600 2.2rem/1.1 var(--display); margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
h2 { font: 600 1.35rem/1.2 var(--display); margin: 0; text-wrap: balance; }
p { margin: 0; }
.lede { color: var(--muted); }
.meta { display: flex; flex-wrap: wrap; gap: 8px 20px; font: 13px var(--mono); color: var(--muted); }
section { display: grid; gap: 14px; min-width: 0; }
section > p { max-width: 70ch; }
.frame { overflow-x: auto; background: var(--sheet); border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; min-width: 860px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--line); }
tr:last-child > * { border-bottom: 0; }
thead th { font: 500 12px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); background: var(--paper); position: sticky; top: 0; }
thead th.gz { color: var(--accent); }
tbody th { font-weight: 500; width: 30%; }
.id { font: 500 12px var(--mono); color: var(--muted); margin-right: 4px; }
.how { display: block; font-weight: 400; font-size: 12.5px; color: var(--muted); margin-top: 2px; }
td.num { font-family: var(--mono); font-size: 13px; color: var(--muted); white-space: nowrap; }
td.gz { background: color-mix(in srgb, var(--accent) 6%, transparent); min-width: 180px; }
.val { font: 500 15px var(--mono); }
.unit, .note { font: 12px var(--mono); color: var(--muted); }
.note { display: block; }
.none { font-size: 12.5px; color: var(--muted); font-style: italic; }
.split { display: flex; height: 6px; margin: 6px 0 3px; border-radius: 3px; overflow: hidden; background: var(--net); max-width: 160px; }
.split i { display: block; height: 100%; }
.split .net { background: var(--net); }
.split .srv { background: var(--accent); }
.legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; background: var(--c); }
.areas { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.area { background: var(--sheet); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; display: grid; gap: 2px; }
.area b { font: 500 18px var(--mono); }
.area b.short { color: var(--miss); }
.area span { font-size: 12.5px; color: var(--muted); text-transform: capitalize; }
.misses { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.misses code { font: 13px var(--mono); }
ul.method { margin: 0; padding-left: 18px; display: grid; gap: 6px; max-width: 75ch; }
code { font-family: var(--mono); font-size: 0.92em; }
@media (max-width: 520px) { h1 { font-size: 1.8rem; } body { padding-block: 24px 48px; } }
</style>
<main>
  <header>
    <h1>GridZero Benchmark</h1>
    <p class="lede">The same tasks on the same seeded sales data in each spreadsheet. GridZero's column is measured by script; the other columns are filled in by hand from <code>bench/scoresheet.csv</code>.</p>
    <div class="meta">
      <span>GridZero: ${esc(new URL(run.target).hostname)}</span>
      <span>Run ${esc(run.ranAt.slice(0, 16).replace("T", " "))} UTC</span>
      <span>Network round trip ${num(baseline)} ms</span>
    </div>
  </header>

  <section aria-labelledby="speed">
    <h2 id="speed">Speed</h2>
    <p>Each time is from the request to the result, as a click would feel, so it includes the trip to the server. The bar under a GridZero time splits it into that round trip and the server's own work.</p>
    <div class="legend"><span style="--c: var(--net)">Network round trip</span><span style="--c: var(--accent)">Server work</span></div>
    <div class="frame"><table>
      <thead><tr><th>Task</th><th>Rows</th><th class="gz">GridZero</th>${products.map((p) => `<th>${esc(p)}</th>`).join("")}</tr></thead>
      <tbody>${speedRows}</tbody>
    </table></div>
  </section>

  <section aria-labelledby="formulas">
    <h2 id="formulas">Formula coverage</h2>
    <p>${t9 ? `${t9.value} of ${t9.size} common Excel formulas give Excel's answer in GridZero.` : "Not run."} The list is in <code>bench/formulas.mjs</code>.</p>
    <div class="areas">${areas.map((a) => `<div class="area"><b class="${a.pass < a.total ? "short" : ""}">${a.pass}/${a.total}</b><span>${esc(a.area)}</span></div>`).join("")}</div>
    ${(run.formulaMisses ?? []).length ? `<ul class="misses">${run.formulaMisses.map((m) => `<li><code>${esc(m.formula)}</code> gave <code>${esc(m.got)}</code>; Excel gives <code>${esc(m.expected)}</code></li>`).join("")}</ul>` : ""}
  </section>

  <section aria-labelledby="caps">
    <h2 id="caps">What each one has</h2>
    <div class="frame"><table>
      <thead><tr><th>Feature</th><th class="gz">GridZero</th>${products.map((p) => `<th>${esc(p)}</th>`).join("")}</tr></thead>
      <tbody>${capRows}</tbody>
    </table></div>
  </section>

  <section aria-labelledby="method">
    <h2 id="method">How it was measured</h2>
    <ul class="method">
      <li>Data: <code>node bench/dataset.mjs &lt;rows&gt; &lt;file&gt;</code>, seeded, so every product imports byte-identical files (the 1M-row file is about 70 MB).</li>
      <li>GridZero: <code>node bench/gridzero.mjs &lt;control URL&gt;</code> runs every task through the same API and socket the browser uses. Drawing in the browser is not timed.</li>
      <li>Row Zero (free plan, ${esc(ROW_ZERO_DATE)}): driven in a browser on the same machine. Imports were timed from choosing the file until the table showed; sort, filter and pivot from the click until Row Zero's last reply over its socket, the same request-to-reply span the GridZero runner measures. Row Zero's servers were about 70 ms closer to this machine than GridZero's staging server, so compare the server's share rather than the totals for the fast tasks. Its formula coverage, reopen, jump, formula column and recalculation were not measured: its grid could not be read back reliably from a script.</li>
      <li>Other products: timed by hand with a stopwatch, middle of three tries, on the same machine and network. Hand timing cannot resolve much under 300 ms.</li>
      <li>Imports include uploading the file from this machine, so they depend on its upload speed.</li>
    </ul>
  </section>
</main>
`;

writeFileSync(join(here, "report.html"), html);
console.log(`wrote ${join(here, "report.html")} from ${run.target} (${run.ranAt})`);
