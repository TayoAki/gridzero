// M3 smoke against a deployed environment: pivot, chart, slicer, cond format, validation, filter, insert rows -> reconnect.
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
const require = createRequire(process.argv[3] + "/");
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
let s = await open(id);
await s.send({ type: "PasteText", sheet: 0, row: 0, col: 0, text: ["region\tunits", "North\t1", "South\t2", "North\t3", "East\t4"].join("\n") });
const src = range(0, 0, 4, 1);
await s.send({ type: "SetFilter", target: { type: "Range", range: src }, col: 0, filter: null });
await s.send({ type: "CreatePivot", spec: { id: "", sheet: 0, row: 0, col: 4, source: { type: "Range", range: src }, rows: [{ field: "region", group: null }], columns: [], values: [{ field: "units", agg: "Sum", percentile: null }], filters: [], totals: true }, new_sheet: false });
const chart = await s.send({ type: "CreateChart", spec: { id: "", sheet: 0, row: 8, col: 4, w: 400, h: 300, kind: "Column", title: "", x: range(1, 4, 3, 4), series: [{ range: range(1, 5, 3, 5), name: null, kind: null, axis: "Left" }], bins: null, stacked: false } });
await s.send({ type: "CreateSlicer", spec: { id: "", sheet: 0, row: 20, col: 0, target: { type: "Range", range: src }, column: 0, title: "" } });
await s.send({ type: "AddCondFormat", range: range(1, 1, 4, 1), rule: { type: "DataBar", color: "#638EC6" }, style: { fill: null, color: null, bold: false } });
await s.send({ type: "SetValidation", spec: { id: "", range: range(1, 2, 9, 2), values: ["Yes", "No"], source: null, strict: true } });
await s.send({ type: "UpdateCell", sheet: 0, row: 1, col: 1, raw: "10" });
await s.send({ type: "SetFilter", target: { type: "Range", range: src }, col: 0, filter: { type: "Values", values: ["North"] } });
await s.send({ type: "InsertRows", sheet: 0, row: 0, count: 2 });
s.close();
s = await open(id);
const data = (await s.send({ type: "GetChart", id: chart.id })).data;
const meta = (await s.send({ type: "GetSheetMeta", sheet: 0 })).meta;
let rejected = false;
try { await s.send({ type: "UpdateCell", sheet: 0, row: 3, col: 2, raw: "Maybe" }); } catch { rejected = true; }
console.log("after reconnect: chart", JSON.stringify(data.x), JSON.stringify(data.series[0].values), data.refs[1], "| pivot at row", meta.pivots[0].spec.row, "| slicer filter", JSON.stringify(meta.slicers[0].filter), "| dropdown rejects:", rejected);
s.close();
const ok = data.series[0].values[0] === 13 && data.refs[1] === "='Sheet1'!F4:F6" && meta.pivots[0].spec.row === 2 && rejected;
await api("DELETE", `/api/v1/workbooks/${id}`);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
