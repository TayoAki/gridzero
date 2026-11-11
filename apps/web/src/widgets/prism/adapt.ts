// Turns a widget's stored data into the result shape Prism's chart builder draws.

import { fits } from "../spec";
import type { WidgetData, WidgetForm } from "../spec";
import type { ChartType, QueryResult, ResultRow } from "./types";

/** The Prism chart each widget form is drawn as. Forms not listed here are not charts. */
export const FORM_CHART: Partial<Record<WidgetForm, Exclude<ChartType, "auto">>> = {
  gauge: "gauge",
  trend: "area",
  bars: "bar",
  hbar: "hbar",
  pie: "pie",
  donut: "donut",
  funnel: "funnel",
  treemap: "treemap",
  waterfall: "waterfall",
  radar: "radar",
  histogram: "histogram",
  stacked: "stacked",
  heatmap: "heatmap",
  combo: "combo",
  scatter: "scatter",
  bubble: "bubble",
  sunburst: "sunburst",
  sankey: "sankey",
  boxplot: "boxplot",
};

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A number is one measure with no dimension. A series is one dimension and one measure. A table becomes
 * dimensions (its text columns, at most two) and measures (its number columns). Returns null when the
 * data cannot be drawn as that chart, so the caller can fall back to the plain number or table.
 */
export function toResult(data: WidgetData, form: WidgetForm, title: string): QueryResult | null {
  const chart = FORM_CHART[form];
  if (!chart || fits(form, data) !== null) return null;
  const measure = title || "Value";
  if (data.kind === "number") {
    const name = data.label || measure;
    return { dimKeys: [], measureKeys: [name], rows: [{ [name]: data.value }], rowCount: 1, chart };
  }
  if (data.kind === "series") {
    return { dimKeys: ["label"], measureKeys: [measure], rows: data.points.map((p) => ({ label: p.label, [measure]: p.value })), rowCount: data.points.length, chart };
  }
  if (data.kind !== "table" || data.rows.length === 0) return null;
  const numeric = data.columns.map((_, j) => data.rows.every((r) => r[j] === null || r[j] === undefined || isNumber(r[j])) && data.rows.some((r) => isNumber(r[j])));
  const labels = data.columns.filter((_, j) => !numeric[j]);
  const measures = data.columns.filter((_, j) => numeric[j]);
  const rows: ResultRow[] = data.rows.map((r) => Object.fromEntries(data.columns.map((c, j) => [c, r[j] === undefined ? null : (r[j] as string | number | null)])));
  const done = (dimKeys: string[], measureKeys: string[], out: ResultRow[] = rows): QueryResult => ({ dimKeys, measureKeys, rows: out, rowCount: out.length, chart });

  switch (form) {
    case "boxplot": {
      // Five number columns in order: lowest, lower quarter, middle, upper quarter, highest.
      const five = measures.slice(0, 5);
      return done([labels[0]!], [measure], rows.map((r) => ({ [labels[0]!]: r[labels[0]!] ?? null, [measure]: five.map((m) => (isNumber(r[m]) ? (r[m] as number) : 0)) })));
    }
    case "scatter":
      return done(labels.slice(0, 1), measures.slice(0, 2));
    case "bubble":
      return done(labels.slice(0, 1), measures.slice(0, 3));
    case "combo":
      return done(labels.slice(0, 1), measures.slice(0, 3));
    case "sunburst":
    case "sankey":
      return done(labels.slice(0, 2), measures.slice(0, 1));
    case "stacked":
    case "heatmap": {
      if (labels.length >= 2) return done(labels.slice(0, 2), measures.slice(0, 1));
      if (form === "stacked") return done(labels.slice(0, 1), measures);
      // One text column and several number columns: lay the number columns out as the second dimension.
      const long = rows.flatMap((r) => measures.map((m) => ({ [labels[0]!]: r[labels[0]!] ?? null, measure: m, value: r[m] ?? null })));
      return done([labels[0]!, "measure"], ["value"], long);
    }
    default:
      return null;
  }
}
