// Dashboards, widgets and widget proposals (agent spec §8.3, §8.4).

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
import { FORMS, SIZES, THEMES, compatible, proposal, widgetData } from "./spec.ts";
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
    if (parsed.data.form && !compatible(parsed.data.form, row.data as WidgetData)) {
      return c.json({ error: `A ${parsed.data.form} widget cannot show ${(row.data as WidgetData).kind} data.` }, 400);
    }
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
  ],
};

const proposeWidget: ClientTool<Proposal> = {
  name: "propose_widget",
  description: [
    "Show the user up to 3 designs for a dashboard widget; they pick one and choose the dashboard.",
    "Forms: number (data kind number), trend and bars (series, 2-60 points), table (up to 6 columns and 50 rows), list (up to 20 items; links must be https), text (up to 1000 characters).",
    "Themes: blue, green, purple, orange, slate, rose.",
    "Source says how the widget refreshes: metric (a query_metric query; shape is the data kind), sheet (a workbook range in A1 notation; shape is the data kind) or snapshot (a prompt you will be given again to produce new data).",
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
    if (!compatible(row.form as WidgetForm, input.data)) throw new ToolError(`This widget shows ${(row.data as WidgetData).kind} data, not ${input.data.kind}.`);
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
