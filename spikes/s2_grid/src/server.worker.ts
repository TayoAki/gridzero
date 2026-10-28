// Simulated workbook server. Stands in for the Rust workbook actor: answers tile
// requests with MessagePack patches after a configurable network latency, so the
// client pays real decode costs and sees realistic arrival timing.

import { pack } from "msgpackr";
import type { ViewportRequest } from "./tiles";
import { TILE_COLS, TILE_ROWS } from "./tiles";

interface ConfigMessage {
  type: "config";
  rows: number;
  cols: number;
  latencyMs: number;
  jitterMs: number;
}

const REGIONS = ["North", "South", "East", "West"];
const PRODUCTS = ["Widget", "Gadget", "Gizmo", "Doohickey", "Thingamajig with a long name"];

let rows = 1_000_000;
let cols = 50;
let latencyMs = 30;
let jitterMs = 10;

self.onmessage = (ev: MessageEvent<ConfigMessage | ViewportRequest>) => {
  const msg = ev.data;
  if (msg.type === "config") {
    ({ rows, cols, latencyMs, jitterMs } = msg);
    return;
  }
  const t0 = performance.now();
  const payload = msg.tiles.map(([tr, tc]) => [tr, tc, buildTile(tr, tc)]);
  const bytes = pack(payload);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const serverMs = performance.now() - t0;
  const delay = latencyMs + Math.random() * jitterMs;
  setTimeout(() => (self as unknown as Worker).postMessage({ buf, serverMs }, [buf]), delay);
};

function buildTile(tr: number, tc: number): [number, string, number][] {
  const cells: [number, string, number][] = [];
  for (let dr = 0; dr < TILE_ROWS; dr++) {
    const r = tr * TILE_ROWS + dr;
    if (r >= rows) break;
    for (let dc = 0; dc < TILE_COLS; dc++) {
      const c = tc * TILE_COLS + dc;
      if (c >= cols) break;
      const [display, flags] = cellValue(r, c);
      cells.push([dr * TILE_COLS + dc, display, flags]);
    }
  }
  return cells;
}

function cellValue(r: number, c: number): [string, number] {
  if (r === 0) return [`col_${c}`, 2];
  const h = hash(r, c);
  switch (c % 5) {
    case 0:
      return [String(r), 1];
    case 1:
      return [REGIONS[h % REGIONS.length], 0];
    case 2:
      return [PRODUCTS[h % PRODUCTS.length], 0];
    case 3:
      return [money(h % 1_000_000), 1];
    default:
      return [`2025-${String((h % 12) + 1).padStart(2, "0")}-${String((h % 28) + 1).padStart(2, "0")}`, 1];
  }
}

/** Cents to "1,234.56". Hand-rolled: Intl formatting would dominate tile build time,
 *  whereas the production server formats in Rust. */
function money(cents: number): string {
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${String(cents % 100).padStart(2, "0")}`;
}

function hash(r: number, c: number): number {
  let x = (r * 73856093) ^ (c * 19349663);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
