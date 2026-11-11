// Dashboards, widgets and widget proposals (agent spec §8.3, §8.4).

import { readOnlySqlProblem } from "../agents/workbook-tools.ts";
import { definitionFor } from "../definitions/store.ts";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import type { Vars } from "../app.ts";
import { newId } from "../agents/run.ts";
import { ToolError, registerTool } from "../agents/tools.ts";
import type { ClientTool } from "../agents/tools.ts";
import { db } from "../db/client.ts";
import { agent, dashboard, metricModel, widget, widgetProposal } from "../db/schema.ts";
import { TEMPLATES, isTemplate } from "../agents/templates.ts";
import { access } from "../sharing.ts";
import { RefreshError, refreshWidget, snapshotUpdated } from "./refresh.ts";
import { FORMS, SIZES, THEMES, fits, proposal, sizeOf, widgetData, widgetLayout } from "./spec.ts";
import type { Proposal, WidgetData, WidgetForm } from "./spec.ts";

type WidgetRow = typeof widget.$inferSelect;
const publicWidget = ({ dashboardId: _d, ...w }: WidgetRow) => w;

async function ownDashboard(userId: string, id: string) {
  const [row] = await db.select().from(dashboard).where(and(eq(dashboard.id, id), eq(dashboard.ownerId, userId)));
  return row ?? null;
}

async function ownWidget(userId: string, id: string): Promise<WidgetRow | null> {
  const [row] = await db
    .select({ w: widget })
    .from(widget)
    .innerJoin(dashboard, eq(dashboard.id, widget.dashboardId))
    .where(and(eq(widget.id, id), eq(dashboard.ownerId, userId)));
  return row?.w ?? null;
}

const issue = (e: z.ZodError) => {
  const i = e.issues[0]!;
  return `${i.path.join(".") || "(input)"}: ${i.message}`;
};

/** Checks a proposal's source belongs to the user. Returns an error message or null. */
async function sourceProblem(userId: string, p: Proposal): Promise<string | null> {
  if (p.source.kind === "metric") {
    const [m] = await db.select({ id: metricModel.id }).from(metricModel).where(and(eq(metricModel.id, p.source.modelId), eq(metricModel.ownerId, userId)));
    if (!m) return "Metric model not found.";
  }
  if (p.source.kind === "sheet" && !(await access(userId, p.source.workbookId))) return "Workbook not found.";
  if (p.source.kind === "table_query") {
    if (!(await access(userId, p.source.workbookId))) return "Workbook not found.";
    const problem = readOnlySqlProblem(p.source.sql);
    if (problem) return problem;
  }
  if (p.source.kind === "definition") {
    const found = await definitionFor(userId, p.source.definitionId);
    if (!found || found.def.kind !== "metric") return "There is no metric with that id. Use list_definitions.";
    if (p.source.groupBy.length ? p.source.shape !== "series" : p.source.shape !== "number") return "A definition widget is a number, or a series when it has one groupBy.";
  }
  return null;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  // --- dashboards --------------------------------------------------------
  app.get("/api/v1/dashboards", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    let rows = await db.select({ id: dashboard.id, name: dashboard.name }).from(dashboard).where(eq(dashboard.ownerId, user.id)).orderBy(asc(dashboard.createdAt));
    if (rows.length === 0) {
      await db.insert(dashboard).values({ id: newId(), ownerId: user.id, name: "My dashboard" });
      rows = await db.select({ id: dashboard.id, name: dashboard.name }).from(dashboard).where(eq(dashboard.ownerId, user.id));
    }
    return c.json({ dashboards: rows });
  });

  const nameOf = (body: { name?: unknown }) => (typeof body.name === "string" ? body.name.trim() : "");

  app.post("/api/v1/dashboards", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ name?: unknown; template?: unknown }>().catch(() => ({}) as { name?: unknown; template?: unknown });
    const template = body.template === undefined ? "blank" : body.template;
    if (!isTemplate(template)) return c.json({ error: 'template must be "blank", "sales" or "ops"' }, 400);
    const t = TEMPLATES[template];
    const name = nameOf(body) || t?.dashboard || "";
    if (!name || name.length > 60) return c.json({ error: "name must be 1-60 characters" }, 400);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.insert(dashboard).values({ id: newId(), ownerId: user.id, name }).returning({ id: dashboard.id, name: dashboard.name });
      if (!t) return { dashboard: row!, agent: null };
      const [made] = await tx.insert(agent).values({ id: newId(), ownerId: user.id, ...t.agent }).returning({ id: agent.id, name: agent.name });
      return { dashboard: row!, agent: made! };
    });
    return c.json(result, 201);
  });

  app.patch("/api/v1/dashboards/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownDashboard(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const name = nameOf(await c.req.json().catch(() => ({})));
    if (!name || name.length > 60) return c.json({ error: "name must be 1-60 characters" }, 400);
    await db.update(dashboard).set({ name }).where(eq(dashboard.id, c.req.param("id")));
    return c.json({ dashboard: { id: c.req.param("id"), name } });
  });

  app.delete("/api/v1/dashboards/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownDashboard(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    await db.delete(dashboard).where(eq(dashboard.id, c.req.param("id")));
    return c.body(null, 204);
  });

  app.get("/api/v1/dashboards/:id/widgets", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownDashboard(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(widget).where(eq(widget.dashboardId, c.req.param("id"))).orderBy(asc(widget.position));
    return c.json({ widgets: rows.map(publicWidget) });
  });

  /** Where each card sits and how big it is, after someone drags or resizes on the report. */
  app.put("/api/v1/dashboards/:id/layout", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownDashboard(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const parsed = z
      .object({ items: z.array(widgetLayout.extend({ id: z.string() }).strict()).min(1).max(200) })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    const items = parsed.data.items;
    const current = await db.select({ id: widget.id }).from(widget).where(eq(widget.dashboardId, c.req.param("id")));
    const have = new Set(current.map((w) => w.id));
    if (new Set(items.map((i) => i.id)).size !== items.length || !items.every((i) => have.has(i.id))) return c.json({ error: "Every item must be a different widget on this report." }, 400);
    if (items.some((i) => i.x + i.w > 12)) return c.json({ error: "A widget cannot reach past the twelfth column." }, 400);
    // Reading order (top to bottom, left to right) becomes the order used on a phone and in lists.
    const order = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    await db.transaction(async (tx) => {
      for (const [n, { id, ...layout }] of order.entries()) await tx.update(widget).set({ layout, size: sizeOf(layout), position: n }).where(eq(widget.id, id));
    });
    const rows = await db.select().from(widget).where(eq(widget.dashboardId, c.req.param("id"))).orderBy(asc(widget.position));
    return c.json({ widgets: rows.map(publicWidget) });
  });

  app.put("/api/v1/dashboards/:id/order", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownDashboard(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ widgetIds?: unknown }>().catch(() => ({}) as { widgetIds?: unknown });
    const ids = Array.isArray(body.widgetIds) ? body.widgetIds : null;
    const current = await db.select({ id: widget.id }).from(widget).where(eq(widget.dashboardId, c.req.param("id")));
    const have = new Set(current.map((w) => w.id));
    if (!ids || ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((x) => typeof x === "string" && have.has(x))) {
      return c.json({ error: "widgetIds must list every widget on the dashboard exactly once" }, 400);
    }
    await db.transaction(async (tx) => {
      for (const [i, id] of (ids as string[]).entries()) await tx.update(widget).set({ position: i }).where(eq(widget.id, id));
    });
    return c.body(null, 204);
  });

  // --- proposals ---------------------------------------------------------
  app.get("/api/v1/widget-proposals/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(widgetProposal).where(and(eq(widgetProposal.id, c.req.param("id")), eq(widgetProposal.ownerId, user.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ id: row.id, payload: row.payload, acceptedWidgetId: row.acceptedWidgetId });
  });

  app.post("/api/v1/widget-proposals/:id/accept", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(widgetProposal).where(and(eq(widgetProposal.id, c.req.param("id")), eq(widgetProposal.ownerId, user.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.acceptedWidgetId) return c.json({ error: "Already added." }, 409);
    const body = await c.req.json<{ dashboardId?: unknown; design?: unknown }>().catch(() => ({}) as { dashboardId?: unknown; design?: unknown });
    const board = typeof body.dashboardId === "string" ? await ownDashboard(user.id, body.dashboardId) : null;
    if (!board) return c.json({ error: "Choose one of your dashboards." }, 400);
    const p = row.payload as Proposal;
    const design = p.designs[Number(body.design)];
    if (!Number.isInteger(Number(body.design)) || !design) return c.json({ error: "design must be the number of one of the proposed designs" }, 400);
    const created = await db.transaction(async (tx) => {
      // Claim the proposal first so two clicks cannot add it twice.
      const claimed = await tx
        .update(widgetProposal)
        .set({ acceptedWidgetId: "pending" })
        .where(and(eq(widgetProposal.id, row.id), isNull(widgetProposal.acceptedWidgetId)))
        .returning({ id: widgetProposal.id });
      if (claimed.length === 0) return null;
      const [{ top } = { top: null }] = await tx.select({ top: max(widget.position) }).from(widget).where(eq(widget.dashboardId, board.id));
      const [w] = await tx
        .insert(widget)
        .values({ id: newId(), dashboardId: board.id, agentId: row.agentId, title: p.title, form: design.form, theme: design.theme, size: "m", position: (top ?? -1) + 1, data: p.data, source: p.source })
        .returning();
      await tx.update(widgetProposal).set({ acceptedWidgetId: w!.id }).where(eq(widgetProposal.id, row.id));
      return w!;
    });
    if (!created) return c.json({ error: "Already added." }, 409);
    return c.json({ widget: publicWidget(created) }, 201);
  });

  // --- widgets -----------------------------------------------------------
  app.patch("/api/v1/widgets/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await ownWidget(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const parsed = z
      .object({ title: z.string().trim().min(1).max(60), size: z.enum(SIZES), theme: z.enum(THEMES), form: z.enum(FORMS) })
      .partial()
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    const why = parsed.data.form ? fits(parsed.data.form, row.data as WidgetData) : null;
    if (why) return c.json({ error: why }, 400);
    const [w] = await db.update(widget).set(parsed.data).where(eq(widget.id, row.id)).returning();
    return c.json({ widget: publicWidget(w!) });
  });

  app.delete("/api/v1/widgets/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await ownWidget(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    await db.delete(widget).where(eq(widget.id, row.id));
    return c.body(null, 204);
  });

  app.post("/api/v1/widgets/:id/refresh", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await ownWidget(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    try {
      return c.json({ widget: publicWidget(await refreshWidget(user.id, row)) });
    } catch (e) {
      if (e instanceof RefreshError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
}

// --- agent tools -------------------------------------------------------------

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: "string" };
const nullable = (t: string) => ({ type: [t, "null"] });
const scalar = { anyOf: [{ type: "string" }, { type: "number" }] };

/** JSON Schema for WidgetData (mirrors spec.ts). */
const dataSchema = {
  anyOf: [
    obj({ kind: { type: "string", const: "number" }, value: { type: "number" }, unit: nullable("string"), delta: nullable("number"), label: nullable("string") }),
    obj({ kind: { type: "string", const: "series" }, points: { type: "array", items: obj({ label: str, value: { type: "number" } }) } }),
    obj({ kind: { type: "string", const: "table" }, columns: { type: "array", items: str }, rows: { type: "array", items: { type: "array", items: { anyOf: [str, { type: "number" }, { type: "null" }] } } } }),
    obj({ kind: { type: "string", const: "list" }, items: { type: "array", items: obj({ title: str, detail: nullable("string"), url: nullable("string") }) } }),
    obj({ kind: { type: "string", const: "text" }, text: str }),
  ],
};

const shapeSchema = { type: "string", enum: ["number", "series", "table"] };
const sourceSchema = {
  anyOf: [
    obj({ kind: { type: "string", const: "snapshot" }, prompt: str }),
    obj({
      kind: { type: "string", const: "metric" },
      modelId: str,
      query: obj({
        metric: str,
        group_by: { type: "array", items: str },
        filters: { type: "array", items: obj({ field: str, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in"] }, value: { anyOf: [str, { type: "number" }, { type: "array", items: scalar }] } }) },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer" },
      }),
      shape: shapeSchema,
    }),
    obj({ kind: { type: "string", const: "sheet" }, workbookId: str, sheet: { type: "integer" }, range: str, shape: shapeSchema }),
    obj({ kind: { type: "string", const: "table_query" }, workbookId: str, sql: str, shape: shapeSchema }),
    obj({ kind: { type: "string", const: "definition" }, definitionId: str, groupBy: { type: "array", items: str }, shape: shapeSchema }),
  ],
};

const proposeWidget: ClientTool<Proposal> = {
  name: "propose_widget",
  description: [
    "Show the user up to 3 designs for a dashboard widget; they pick one and choose the dashboard.",
    "Forms by the data they read.",
    "A number: number (one figure, with its change), gauge (one figure against a scale, such as a rate or progress).",
    "A series (2-60 points of label and value): trend (a line over time), bars (compare a few things), hbar (a ranking, or long labels), pie and donut (shares of a whole, at most about 8 slices), funnel (steps that shrink, such as visit to purchase), treemap (many parts of a whole), waterfall (pluses and minuses that add up to a total), radar (one thing scored on several measures), histogram (how often values fall in each range: the labels are the ranges, in order).",
    "A table (up to 6 columns and 50 rows): table (exact figures to read), stacked (parts within each bar: one label column and two or more number columns, or two label columns and a number), heatmap (a number for every pair of two label columns, such as day by hour), combo (bars and a line together, for two measures on different scales: a label column and two number columns), scatter (whether two measures move together: two number columns, optional label column), bubble (scatter with a third number column as size), sunburst (parts within parts: two label columns and a number), sankey (flow from one set of things to another: from, to, amount), boxplot (the spread of values per group: a label column, then lowest, lower quarter, middle, upper quarter, highest).",
    "list (up to 20 items; links must be https), text (up to 1000 characters).",
    "Choose the form from the question, not from habit. Over time: trend. Ranking: hbar. Share of a whole: donut, or treemap past 8 parts. Steps: funnel. What made up a change: waterfall. Two measures together: combo or scatter. Where something goes: sankey. Spread: boxplot or histogram. One rate or goal: gauge. Offer different forms across the designs when more than one fits, and shape the data for the form: a form is refused when the data lacks the columns it needs.",
    "Themes: blue, green, purple, orange, slate, rose.",
    "Source says how the widget refreshes; shape is the data kind it returns.",
    "definition: a metric from list_definitions, with groupBy empty for a number or one dimension name for a series. Prefer this when a definition fits.",
    "table_query: the query_tables SQL that produced the data, rerun on each refresh. For a number the SQL returns one row whose last column is the value; for a series, rows of label then value; for a table, up to 6 columns.",
    "metric: a query_metric query. sheet: a workbook range in A1 notation, including its header row. snapshot: a prompt you will be given again to produce new data; use it only when nothing else fits.",
    "Only call this after the user agreed to have a widget.",
  ].join(" "),
  inputSchema: obj({ title: str, designs: { type: "array", items: obj({ form: { type: "string", enum: [...FORMS] }, theme: { type: "string", enum: [...THEMES] } }) }, data: dataSchema, source: sourceSchema }),
  schema: proposal as unknown as z.ZodType<Proposal>,
  readOnly: false,
  privateData: false,
  kinds: ["chat"],
  async run(input, ctx) {
    const problem = await sourceProblem(ctx.userId, input);
    if (problem) throw new ToolError(problem);
    const id = newId();
    await db.insert(widgetProposal).values({ id, ownerId: ctx.userId, agentId: ctx.agentId, payload: input });
    ctx.emit({ type: "widget_proposal", proposalId: id });
    return { proposal_id: id, status: "shown to the user" };
  },
  summary: () => "Proposed a widget",
};

interface UpdateInput {
  widget_id: string;
  data: WidgetData;
}

const updateWidgetData: ClientTool<UpdateInput> = {
  name: "update_widget_data",
  description: "Give the widget you are refreshing its new data. The data kind must match the widget's form.",
  inputSchema: obj({ widget_id: str, data: dataSchema }),
  schema: z.object({ widget_id: z.string(), data: widgetData }).strict(),
  readOnly: true,
  privateData: false,
  kinds: ["widget_refresh"],
  async run(input, ctx) {
    if (input.widget_id !== ctx.widgetId) throw new ToolError("You can only update the widget you were asked to refresh.");
    const [row] = await db.select().from(widget).where(eq(widget.id, input.widget_id));
    if (!row) throw new ToolError("Widget not found.");
    const why = fits(row.form as WidgetForm, input.data);
    if (why) throw new ToolError(input.data.kind === (row.data as WidgetData).kind ? why : `This widget shows ${(row.data as WidgetData).kind} data, not ${input.data.kind}.`);
    const old = row.data as WidgetData;
    // A number keeps its delta and label when the agent leaves them out.
    const data =
      input.data.kind === "number" && old.kind === "number"
        ? { ...input.data, delta: input.data.delta ?? old.delta, label: input.data.label ?? old.label, unit: input.data.unit ?? old.unit }
        : input.data;
    await db.update(widget).set({ data, refreshedAt: new Date() }).where(eq(widget.id, row.id));
    snapshotUpdated.add(ctx.runId);
    return { ok: true };
  },
  summary: () => "Updated the widget",
};

registerTool(proposeWidget as ClientTool<any>);
registerTool(updateWidgetData as ClientTool<any>);
