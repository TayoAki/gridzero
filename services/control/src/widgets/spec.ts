// Widget types (docs/AGENT-BUILD-SPEC.md §8.2). This file exists twice, byte for byte:
// services/control/src/widgets/spec.ts and apps/web/src/widgets/spec.ts. A control test
// checks they match, so edit both together. Import nothing here but zod.

import { z } from "zod";

export const FORMS = ["number", "trend", "bars", "table", "list", "text"] as const;
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
  trend: "series",
  bars: "series",
  table: "table",
  list: "list",
  text: "text",
};

export const compatible = (form: WidgetForm, data: Pick<WidgetData, "kind">) => FORM_DATA[form] === data.kind;

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
      if (!compatible(d.form, p.data)) ctx.addIssue({ code: "custom", path: ["designs", i, "form"], message: `A ${d.form} widget cannot show ${p.data.kind} data.` });
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
  data: WidgetData;
  source: WidgetSource;
  refreshedAt: string;
  createdAt: string;
}
