// Turns a widget's stored data into the result shape Prism's chart builder draws.

import type { WidgetData, WidgetForm } from "../spec";
import type { ChartType, QueryResult } from "./types";

/** The Prism chart each widget form is drawn as. Forms not listed here are not charts. */
export const FORM_CHART: Partial<Record<WidgetForm, Exclude<ChartType, "auto">>> = {
  trend: "area",
  bars: "bar",
  hbar: "hbar",
  pie: "pie",
  donut: "donut",
  funnel: "funnel",
  treemap: "treemap",
  waterfall: "waterfall",
  stacked: "stacked",
  heatmap: "heatmap",
};

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A series is one dimension and one measure. A table becomes dimensions (its text columns, at most two)
 * and measures (its number columns). Returns null when the data cannot be drawn as that chart, so the
 * caller can fall back to a plain table.
 */
export function toResult(data: WidgetData, form: WidgetForm, title: string): QueryResult | null {
  const chart = FORM_CHART[form];
  if (!chart) return null;
  if (data.kind === "series") {
    const measure = title || "Value";
    return { dimKeys: ["label"], measureKeys: [measure], rows: data.points.map((p) => ({ label: p.label, [measure]: p.value })), rowCount: data.points.length, chart };
  }
  if (data.kind !== "table" || data.rows.length === 0) return null;
  const numeric = data.columns.map((_, j) => data.rows.every((r) => r[j] === null || r[j] === undefined || isNumber(r[j])) && data.rows.some((r) => isNumber(r[j])));
  const dims = data.columns.filter((_, j) => !numeric[j]).slice(0, 2);
  const measures = data.columns.filter((_, j) => numeric[j]);
  if (dims.length === 0 || measures.length === 0) return null;
  // A stacked chart or a heatmap needs a second thing to split by: a second text column, or several number columns.
  if ((form === "stacked" || form === "heatmap") && dims.length < 2 && measures.length < 2) return null;
  const rows = data.rows.map((r) => Object.fromEntries(data.columns.map((c, j) => [c, r[j] === undefined ? null : (r[j] as string | number | null)])));
  if (form === "heatmap" && dims.length < 2) {
    // One text column and several number columns: lay the number columns out as the second dimension.
    const long = rows.flatMap((r) => measures.map((m) => ({ [dims[0]!]: r[dims[0]!] ?? null, measure: m, value: r[m] ?? null })));
    return { dimKeys: [dims[0]!, "measure"], measureKeys: ["value"], rows: long, rowCount: long.length, chart };
  }
  return { dimKeys: dims, measureKeys: measures, rows, rowCount: rows.length, chart };
}
