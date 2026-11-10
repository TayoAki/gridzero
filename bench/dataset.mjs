// The benchmark dataset: the same seeded sales table for every product, so each one
// imports byte-identical files.
//
//   node bench/dataset.mjs <rows> <out.csv>      e.g. node bench/dataset.mjs 1000000 /tmp/sales-1m.csv
//
// Columns: order_id, order_date, region, product, channel, units, unit_price, revenue, discount
// (discount is empty for about 1 row in 10).

import { createWriteStream } from "node:fs";
import { once } from "node:events";

export const REGIONS = ["North", "South", "East", "West", "Central", "Online"];
export const CHANNELS = ["Retail", "Wholesale", "Web", "Partner"];
export const PRODUCTS = Array.from({ length: 50 }, (_, i) => `SKU-${String(i + 1).padStart(3, "0")}`);
export const HEADER = ["order_id", "order_date", "region", "product", "channel", "units", "unit_price", "revenue", "discount"];

/** mulberry32: small, fast and the same everywhere. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const START = Date.UTC(2024, 0, 1);

/** Row i (1-based) as CSV text, without the newline. */
export function row(i, next) {
  const units = 1 + Math.floor(next() * 20);
  const price = Math.round((2 + next() * 98) * 100) / 100;
  const discount = next() < 0.1 ? "" : (Math.floor(next() * 31) / 100).toFixed(2);
  return [
    i,
    new Date(START + Math.floor(next() * 730) * DAY).toISOString().slice(0, 10),
    REGIONS[Math.floor(next() * REGIONS.length)],
    PRODUCTS[Math.floor(next() * PRODUCTS.length)],
    CHANNELS[Math.floor(next() * CHANNELS.length)],
    units,
    price.toFixed(2),
    (Math.round(units * price * 100) / 100).toFixed(2),
    discount,
  ].join(",");
}

export async function writeDataset(rows, path) {
  const out = createWriteStream(path);
  const next = rng(20261109);
  let chunk = HEADER.join(",") + "\n";
  for (let i = 1; i <= rows; i++) {
    chunk += row(i, next) + "\n";
    if (chunk.length > 1 << 20) {
      if (!out.write(chunk)) await once(out, "drain");
      chunk = "";
    }
  }
  out.end(chunk);
  await once(out, "finish");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("bench/dataset.mjs")) {
  const [rows, path] = [Number(process.argv[2]), process.argv[3]];
  if (!rows || !path) {
    console.error("usage: node bench/dataset.mjs <rows> <out.csv>");
    process.exit(1);
  }
  await writeDataset(rows, path);
  console.log(`wrote ${rows.toLocaleString()} rows to ${path}`);
}
