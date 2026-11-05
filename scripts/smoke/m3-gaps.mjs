// M3 gaps smoke against a deployed environment: formula over pivot, icon sets, drill-down, chart data over HTTP with ETag.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
const require = createRequire(resolve(process.argv[3]) + "/");
const { unpack } = require("msgpackr");
const BASE = process.argv[2];
let cookie = "";
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.match(/(__Secure-)?better-auth\.session_token=[^;]+/)?.[0] ?? cookie;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}
async function open(id) {
  const grant = await (await api("POST", `/api/v1/workbooks/${id}/open`)).json();
  const ws = new WebSocket(`${grant.endpoint}?token=${grant.token}`); ws.binaryType = "arraybuffer";
  const replies = new Map(); let welcome; const welcomed = new Promise((r) => (welcome = r));
  ws.onmessage = (ev) => { const m = unpack(new Uint8Array(ev.data)); if (m.t === "Welcome") return welcome(m); if (m.t === "Changed") return; const p = replies.get(m.req_id); replies.delete(m.req_id); m.t === "Error" ? p?.reject(new Error(m.message)) : p?.resolve(m.body); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("socket error")); });
  let n = 0; ws.send(JSON.stringify({ reqId: ++n, action: { type: "Hello" } })); await welcomed;
  const send = (action) => new Promise((resolve, reject) => { const id = ++n; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ reqId: id, action })); });
  return { send, grant, http: grant.endpoint.replace(/^ws/, "http").replace(/\/ws$/, ""), close: () => ws.close() };
}
const range = (r0, c0, r1, c1) => ({ sheet: 0, r0, c0, r1, c1 });
await api("POST", "/api/auth/sign-up/email", { email: `smoke+${Date.now()}@example.test`, password: "smoke-" + Math.random().toString(36).slice(2) + "A1!", name: "Smoke" });
const { id } = await (await api("POST", "/api/v1/workbooks")).json();
const s = await open(id);
await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: ["region\tunits", "North\t1", "South\t2", "North\t3", "East\t4"].join("\n") });
await s.send({ type: "CreatePivot", spec: { id: "", sheet: 0, row: 0, col: 4, source: { type: "Range", range: range(0, 0, 4, 1) }, rows: [{ field: "region", group: null }], columns: [], values: [{ field: "units", agg: "Sum", percentile: null }], filters: [], totals: true }, new_sheet: false });
await s.send({ type: "UpdateCell", sheet: 0, row: 9, col: 0, raw: "=SUM(F2:F4)" });
await s.send({ type: "AddCondFormat", range: range(1, 1, 4, 1), rule: { type: "IconSet", set: "Arrows", reverse: false }, style: { fill: null, color: null, bold: false } });
const drill = await s.send({ type: "DrillDown", sheet: 0, row: 2, col: 5 });
const chart = await s.send({ type: "CreateChart", spec: { id: "", sheet: 0, row: 12, col: 1, w: 300, h: 200, kind: "Column", title: "", x: range(1, 0, 4, 0), series: [{ range: range(1, 1, 4, 1), name: null, kind: null, axis: "Left" }], bins: null, stacked: false } });
const tile = (await s.send({ type: "GetTiles", sheet: 0, tiles: [[0, 0]] })).tiles[0];
const text = (i) => tile.cells.find((c) => c[0] === i)?.[1];
const icon = (i) => tile.styles[tile.cells.find((c) => c[0] === i)[3]].icon?.[0];
const dt = (await s.send({ type: "GetTiles", sheet: drill.sheet, tiles: [[0, 0]] })).tiles[0];
const drows = dt.cells.filter((c) => c[0] % 16 === 0).length;
const url = `${s.http}/chart/${chart.id}?token=${s.grant.token}`;
const res = await fetch(url); const data = await res.json();
const second = await fetch(url, { headers: { "If-None-Match": res.headers.get("etag") } });
console.log("formula", text(9 * 16), "| icons", icon(17), icon(65), "| drill rows", drows, "| chart", JSON.stringify(data.series[0].values), res.status, second.status);
s.close();
const ok = text(9 * 16) === "10" && icon(17) === "down" && icon(65) === "up" && drows === 3 && data.series[0].values[3] === 4 && second.status === 304;
await api("DELETE", `/api/v1/workbooks/${id}`);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
