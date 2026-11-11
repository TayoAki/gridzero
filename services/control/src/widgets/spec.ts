// Widget types (docs/AGENT-BUILD-SPEC.md §8.2). This file exists twice, byte for byte:
// services/control/src/widgets/spec.ts and apps/web/src/widgets/spec.ts. A control test
// checks they match, so edit both together. Import nothing here but zod.

import { z } from "zod";

// Chart forms are drawn by the Prism chart builder (apps/web/src/widgets/prism). FORM_DATA says which kind of
// data each reads, and fits() which columns a table needs for it.
export const FORMS = ["number", "gauge", "trend", "bars", "hbar", "pie", "donut", "funnel", "treemap", "waterfall", "radar", "histogram", "table", "stacked", "heatmap", "combo", "scatter", "bubble", "sunburst", "sankey", "boxplot", "list", "text"] as const;
export const THEMES = ["blue", "green", "purple", "orange", "slate", "rose"] as const;
export const SIZES = ["s", "m", "l"] as const;

export type WidgetForm = (typeof FORMS)[number];
export type WidgetTheme = (typeof THEMES)[number];
export type WidgetSize = (typeof SIZES)[number];

/** Card accent and chart colour for each theme. */
export const THEME_COLORS: Record<WidgetTheme, { accent: string; chart: string }> = {
  blue: { accent: "#1a73e8", chart: "#4285f4" },
  green: { accent: "#188038", chart: "#34a853" },
  purple: { accent: "#8430ce", chart: "#a142f4" },
  orange: { accent: "#e8710a", chart: "#fa903e" },
  slate: { accent: "#3c4043", chart: "#80868b" },
  rose: { accent: "#d01884", chart: "#ee5ea6" },
};

const label = z.string().max(200);
const num = z.number().finite();

export const widgetData = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("number"), value: num, unit: z.string().max(20).nullable(), delta: num.nullable(), label: label.nullable() }).strict(),
  z.object({ kind: z.literal("series"), points: z.array(z.object({ label, value: num }).strict()).min(2).max(60) }).strict(),
  z
    .object({
      kind: z.literal("table"),
      columns: z.array(label).min(1).max(6),
      rows: z.array(z.array(z.union([z.string().max(500), num, z.null()])).max(6)).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("list"),
      items: z
        .array(
          z
            .object({
              title: label,
              detail: z.string().max(500).nullable(),
              url: z.string().max(2000).regex(/^https:\/\//, "links must start with https://").nullable(),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  z.object({ kind: z.literal("text"), text: z.string().max(1000) }).strict(),
]);
export type WidgetData = z.infer<typeof widgetData>;

export const metricQuery = z
  .object({
    metric: z.string(),
    group_by: z.array(z.string()).max(3),
    filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.union([z.string(), num, z.array(z.union([z.string(), num]))]) }).strict()).max(5),
    order: z.enum(["asc", "desc"]),
    limit: z.number().int().min(1).max(500),
  })
  .strict();

const shape = z.enum(["number", "series", "table"]);

export const widgetSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), prompt: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("metric"), modelId: z.string(), query: metricQuery, shape }).strict(),
  z.object({ kind: z.literal("sheet"), workbookId: z.string(), sheet: z.number().int().min(0), range: z.string().max(20), shape }).strict(),
  // A read-only query over a workbook's Data Tables: the widget reruns it, so it follows the data.
  z.object({ kind: z.literal("table_query"), workbookId: z.string(), sql: z.string().min(1).max(5000), shape }).strict(),
  // A shared definition (a metric, optionally split by one dimension): the widget shows its status too.
  z.object({ kind: z.literal("definition"), definitionId: z.string(), groupBy: z.array(z.string()).max(1), shape }).strict(),
]);
export type WidgetSource = z.infer<typeof widgetSource>;

/** The data kind each form shows. */
export const FORM_DATA: Record<WidgetForm, WidgetData["kind"]> = {
  number: "number",
  gauge: "number",
  trend: "series",
  bars: "series",
  hbar: "series",
  pie: "series",
  donut: "series",
  funnel: "series",
  treemap: "series",
  waterfall: "series",
  radar: "series",
  histogram: "series",
  table: "table",
  stacked: "table",
  heatmap: "table",
  combo: "table",
  scatter: "table",
  bubble: "table",
  sunburst: "table",
  sankey: "table",
  boxplot: "table",
  list: "list",
  text: "text",
};

export const compatible = (form: WidgetForm, data: Pick<WidgetData, "kind">) => FORM_DATA[form] === data.kind;

/**
 * Why this form cannot draw this data, or null when it can. A chart needs the right columns, not only
 * the right kind of data: a scatter needs two number columns, a sankey two label columns and a number.
 */
export function fits(form: WidgetForm, data: WidgetData): string | null {
  if (FORM_DATA[form] !== data.kind) return `A ${form} widget cannot show ${data.kind} data.`;
  if (data.kind !== "table") return null;
  const numeric = data.columns.map((_, j) => data.rows.some((r) => typeof r[j] === "number") && data.rows.every((r) => r[j] === null || r[j] === undefined || typeof r[j] === "number"));
  const numbers = numeric.filter(Boolean).length;
  const labels = numeric.length - numbers;
  const need = (ok: boolean, what: string) => (ok ? null : `A ${form} widget needs ${what}.`);
  switch (form) {
    case "stacked":
    case "heatmap":
      return need(labels >= 2 ? numbers >= 1 : labels === 1 && numbers >= 2, "two label columns and a number column, or one label column and two or more number columns");
    case "combo":
      return need(labels >= 1 && numbers >= 2, "a label column and two number columns");
    case "scatter":
      return need(numbers >= 2, "two number columns, with an optional label column");
    case "bubble":
      return need(numbers >= 3, "three number columns: across, up and size");
    case "sunburst":
    case "sankey":
      return need(labels >= 2 && numbers >= 1, "two label columns and a number column");
    case "boxplot":
      return need(labels >= 1 && numbers >= 5, "a label column and five number columns: lowest, lower quarter, middle, upper quarter, highest");
    default:
      return null;
  }
}

/** Where a widget sits on its report's 12-column grid, and how big it is, in grid units. */
export const widgetLayout = z.object({ x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(2000), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(8) }).strict();
export type WidgetLayout = z.infer<typeof widgetLayout>;

/** The size a card is drawn at (compact or roomy), from its place on the grid. */
export const sizeOf = (l: WidgetLayout): WidgetSize => (l.w <= 3 ? "s" : l.h >= 2 ? "l" : "m");

export const design = z.object({ form: z.enum(FORMS), theme: z.enum(THEMES) }).strict();

export const proposal = z
  .object({
    title: z.string().min(1).max(60),
    designs: z.array(design).min(1).max(3),
    data: widgetData,
    source: widgetSource,
  })
  .strict()
  .superRefine((p, ctx) => {
    p.designs.forEach((d, i) => {
      const why = fits(d.form, p.data);
      if (why) ctx.addIssue({ code: "custom", path: ["designs", i, "form"], message: why });
    });
    if (p.source.kind !== "snapshot" && p.source.shape !== p.data.kind) {
      ctx.addIssue({ code: "custom", path: ["source", "shape"], message: `The source gives ${p.source.shape} data but the widget shows ${p.data.kind}.` });
    }
  });
export type Proposal = z.infer<typeof proposal>;

export interface Widget {
  id: string;
  agentId: string | null;
  title: string;
  form: WidgetForm;
  theme: WidgetTheme;
  size: WidgetSize;
  position: number;
  /** Null until someone has moved or resized a card on this report. */
  layout: WidgetLayout | null;
  data: WidgetData;
  source: WidgetSource;
  refreshedAt: string;
  createdAt: string;
}
