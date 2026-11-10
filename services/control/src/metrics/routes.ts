// Metric models: upload, export, query, and the agent tools over them (agent spec §7.4, §7.5).

import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import type { Vars } from "../app.ts";
import type { Kind } from "../connectors.ts";
import { db } from "../db/client.ts";
import { connection, metricModel } from "../db/schema.ts";
import { ToolError, registerTool } from "../agents/tools.ts";
import type { ClientTool } from "../agents/tools.ts";
import { newId } from "../agents/run.ts";
import { queryToCsv } from "../agents/workbook-tools.ts";
import { DIALECT, MetricError, compileQuery, parseModel, summarize } from "./compile.ts";
import type { MetricQuery, OssieModel } from "./compile.ts";

const MAX_YAML = 1024 * 1024;

const querySchema = z
  .object({
    metric: z.string(),
    group_by: z.array(z.string()).max(3).default([]),
    filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown() })).max(5).default([]),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

type ModelRow = typeof metricModel.$inferSelect;
const publicModel = (m: ModelRow) => ({ id: m.id, name: m.name, connectionId: m.connectionId, ...summarize(m.parsed as OssieModel), createdAt: m.createdAt });

async function ownModel(userId: string, id: string): Promise<ModelRow | null> {
  const [row] = await db.select().from(metricModel).where(and(eq(metricModel.id, id), eq(metricModel.ownerId, userId)));
  return row ?? null;
}

export async function listModels(userId: string) {
  const rows = await db.select().from(metricModel).where(eq(metricModel.ownerId, userId)).orderBy(desc(metricModel.createdAt));
  return rows.map(publicModel);
}

/** Compile and run one metric query. Throws MetricError for model problems, Error for query failures. */
export async function runMetric(userId: string, modelId: string, q: MetricQuery, maxRows = 500): Promise<{ sql: string; csv: string; truncated: boolean }> {
  const model = await ownModel(userId, modelId);
  if (!model) throw new MetricError("Metric model not found.");
  const [conn] = await db.select().from(connection).where(eq(connection.id, model.connectionId));
  if (!conn) throw new MetricError("The model's connection no longer exists.");
  const sql = compileQuery(model.parsed as OssieModel, DIALECT[conn.kind as Kind], q);
  return { sql, ...(await queryToCsv(conn, sql, Math.min(maxRows, q.limit))) };
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/metrics", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ models: await listModels(user.id) });
  });

  app.post("/api/v1/metrics", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ connectionId?: unknown; yaml?: unknown }>().catch(() => ({}) as { connectionId?: unknown; yaml?: unknown });
    if (typeof body.yaml !== "string" || !body.yaml.trim()) return c.json({ error: "yaml is required" }, 400);
    if (Buffer.byteLength(body.yaml) > MAX_YAML) return c.json({ error: "The file is larger than 1 MB." }, 400);
    const [conn] = typeof body.connectionId === "string" ? await db.select().from(connection).where(and(eq(connection.id, body.connectionId), eq(connection.ownerId, user.id))) : [];
    if (!conn) return c.json({ error: "Choose one of your connections." }, 400);
    let parsed: OssieModel;
    try {
      parsed = parseModel(body.yaml);
    } catch (e) {
      if (e instanceof MetricError) return c.json({ error: e.message }, 400);
      throw e;
    }
    const [existing] = await db.select({ id: metricModel.id }).from(metricModel).where(and(eq(metricModel.ownerId, user.id), eq(metricModel.name, parsed.name)));
    if (existing) return c.json({ error: `You already have a model named ${parsed.name}. Delete it first.` }, 409);
    const [row] = await db.insert(metricModel).values({ id: newId(), ownerId: user.id, connectionId: conn.id, name: parsed.name, source: body.yaml, parsed }).returning();
    return c.json({ model: publicModel(row!) }, 201);
  });

  app.get("/api/v1/metrics/:id/export", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await ownModel(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.body(row.source, 200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${row.name}.ossie.yaml"`,
    });
  });

  app.delete("/api/v1/metrics/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await ownModel(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    await db.delete(metricModel).where(eq(metricModel.id, row.id));
    return c.body(null, 204);
  });

  app.post("/api/v1/metrics/:id/query", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownModel(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const q = querySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!q.success) return c.json({ error: `${q.error.issues[0]!.path.join(".")}: ${q.error.issues[0]!.message}` }, 400);
    try {
      return c.json(await runMetric(user.id, c.req.param("id"), q.data as MetricQuery));
    } catch (e) {
      if (e instanceof MetricError) return c.json({ error: e.message }, 400);
      return c.json({ error: `The query failed: ${(e as Error).message.slice(0, 500)}` }, 502);
    }
  });
}

// --- agent tools -------------------------------------------------------------

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const listMetrics: ClientTool<Record<string, never>> = {
  name: "list_metrics",
  description: "List the user's metric models: each model's id, its metrics (name and description) and the fields you can group or filter by.",
  inputSchema: obj({}),
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  readOnly: true,
  privateData: false,
  async run(_input, ctx) {
    return { models: (await listModels(ctx.userId)).map((m) => ({ id: m.id, name: m.name, metrics: m.metrics, fields: m.fields })) };
  },
  summary: () => "Listed metrics",
};

interface QueryMetricInput {
  model_id: string;
  metric: string;
  group_by: string[];
  filters: { field: string; op: string; value: string | number | (string | number)[] }[];
  order: "asc" | "desc";
  limit: number;
}

const scalar = { anyOf: [{ type: "string" }, { type: "number" }] };

const queryMetric: ClientTool<QueryMetricInput> = {
  name: "query_metric",
  description:
    "Measure a metric from a metric model, optionally grouped by up to 3 fields and filtered (op is one of =, !=, >, >=, <, <=, in; for in, value is a list). Returns the SQL that ran and the result as CSV.",
  inputSchema: obj({
    model_id: { type: "string" },
    metric: { type: "string" },
    group_by: { type: "array", items: { type: "string" } },
    filters: {
      type: "array",
      items: obj({ field: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "in"] }, value: { anyOf: [scalar.anyOf[0], scalar.anyOf[1], { type: "array", items: scalar }] } }),
    },
    order: { type: "string", enum: ["asc", "desc"] },
    limit: { type: "integer" },
  }),
  schema: z
    .object({
      model_id: z.string(),
      metric: z.string(),
      group_by: z.array(z.string()),
      filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]) }).strict()),
      order: z.enum(["asc", "desc"]),
      limit: z.number().int(),
    })
    .strict(),
  readOnly: true,
  privateData: true,
  async run(input, ctx) {
    try {
      return await runMetric(ctx.userId, input.model_id, { ...input, limit: Math.min(500, Math.max(1, input.limit)) });
    } catch (e) {
      if (e instanceof MetricError) throw new ToolError(e.message);
      throw new ToolError(`The query failed: ${(e as Error).message.slice(0, 500)}`);
    }
  },
  summary: (i) => `Measured ${i.metric}`,
};

registerTool(listMetrics as ClientTool<any>);
registerTool(queryMetric as ClientTool<any>);
