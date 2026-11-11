// Live cards: a card's query run again with a report's filters applied to the rows underneath it, so
// totals follow a filter instead of only hiding rows already on the card. Also what a report can be
// filtered by, the rows behind a card, and making a card from a table without an agent.

import { and, eq, max } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { newId } from "../agents/run.ts";
import { readOnlySqlProblem } from "../agents/workbook-tools.ts";
import type { Vars } from "../app.ts";
import { db } from "../db/client.ts";
import { metricModel, widget } from "../db/schema.ts";
import { EngineError } from "../definitions/engine.ts";
import { MetricSqlError, NoCredential, SourceError, memberAccess } from "../definitions/sql.ts";
import type { SourceConfig } from "../definitions/sql.ts";
import { TooCostly, definitionFor, runMetric as runDefinition, sourceDefinitions } from "../definitions/store.ts";
import { TablesError, queryTables, tableFields } from "../definitions/tables.ts";
import type { TableField } from "../definitions/tables.ts";
import { MetricError } from "../metrics/compile.ts";
import type { OssieModel } from "../metrics/compile.ts";
import { runMetric } from "../metrics/routes.ts";
import { access } from "../sharing.ts";
import { RefreshError, parseCsv, rowsToData } from "./refresh.ts";
import { DESIGN_FORMS, THEMES, fits, reportFilter, widgetSource } from "./spec.ts";
import type { ReportFilter, WidgetData, WidgetSource } from "./spec.ts";

type WidgetRow = typeof widget.$inferSelect;
type Shape = "number" | "series" | "table";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const engineMessage = (e: EngineError) => e.message.replace(/^\w+Exception: /, "").slice(0, 300);

/**
 * A source's rows with the filters applied underneath, and which filters reached it. Null when this kind
 * of source cannot be filtered: a snapshot an agent wrote, a sheet range, a definition on a database.
 */
async function filteredRows(userId: string, source: WidgetSource, filters: ReportFilter[]): Promise<{ rows: string[][]; applied: string[] } | null> {
  if (source.kind === "table_query") {
    if (!(await access(userId, source.workbookId))) throw new RefreshError(404, "The workbook for this widget is gone or no longer shared with you.");
    const problem = readOnlySqlProblem(source.sql);
    if (problem) throw new RefreshError(400, problem);
    try {
      const out = await queryTables(source.workbookId, source.sql, 60, filters);
      return { rows: [out.columns, ...out.rows.map((r) => r.map((v) => v ?? ""))], applied: out.applied };
    } catch (e) {
      if (e instanceof TablesError) throw new RefreshError(400, e.message);
      if (e instanceof EngineError) throw new RefreshError(400, `The query no longer runs: ${engineMessage(e)}`);
      throw e;
    }
  }
  if (source.kind === "definition") {
    const found = await definitionFor(userId, source.definitionId);
    if (!found || found.def.kind !== "metric") throw new RefreshError(404, "The definition for this widget is gone or no longer shared with you.");
    if (found.src.kind !== "workbook") return null;
    const all = (await sourceDefinitions(found.src.id)).map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, status: d.status, body: d.body as Record<string, any> }));
    const groupBy = source.groupBy.map((n) => {
      const dim = all.find((d) => d.kind === "dimension" && d.name === n);
      if (!dim) throw new RefreshError(400, `The dimension ${n} no longer exists.`);
      return dim;
    });
    try {
      const v = await runDefinition(await memberAccess(found.src, userId), all.find((d) => d.id === found.def.id)!, all, { groupBy, limit: 60 }, false, filters);
      return { rows: [v.columns, ...v.rows.map((r) => r.map((x) => x ?? ""))], applied: v.applied ?? [] };
    } catch (e) {
      if (e instanceof NoCredential || e instanceof MetricSqlError || e instanceof SourceError || e instanceof TooCostly) throw new RefreshError(400, e.message);
      throw e;
    }
  }
  if (source.kind === "metric") {
    const [model] = await db.select().from(metricModel).where(and(eq(metricModel.id, source.modelId), eq(metricModel.ownerId, userId)));
    if (!model) throw new RefreshError(404, "The metric model for this widget is gone.");
    const names = ((model.parsed as OssieModel).datasets[0]?.fields ?? []).map((f) => f.name);
    const extra: { field: string; op: string; value: string | number | (string | number)[] }[] = [];
    const applied: string[] = [];
    for (const f of filters) {
      const field = names.find((n) => same(n, f.field));
      if (!field) continue;
      const before = extra.length;
      if (f.values && f.values.length <= 50) extra.push({ field, op: "in", value: f.values });
      else if (f.range) extra.push({ field, op: ">=", value: f.range[0] }, { field, op: "<=", value: f.range[1] });
      else {
        if (f.from) extra.push({ field, op: ">=", value: f.from });
        if (f.to) extra.push({ field, op: "<", value: f.to });
      }
      if (extra.length > before) applied.push(f.field);
    }
    // A metric query takes five filters; a report that asks for more leaves this card as it was.
    if (source.query.filters.length + extra.length > 5) return null;
    try {
      return { rows: parseCsv((await runMetric(userId, source.modelId, { ...source.query, filters: [...source.query.filters, ...extra] })).csv), applied };
    } catch (e) {
      if (e instanceof MetricError) throw new RefreshError(400, (e as Error).message);
      throw new RefreshError(502, `The metric query failed: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return null;
}

/** Rows to card data, allowing what a filter can leave: one point, or nothing at all (null). */
function shaped(rows: string[][], shape: Shape, stored: WidgetData): WidgetData | null {
  try {
    const data = rowsToData(rows, shape, undefined);
    // Keep the card's own unit and label; the change from last refresh means nothing under a filter.
    return data.kind === "number" && stored.kind === "number" ? { ...data, unit: stored.unit, label: stored.label, delta: null } : data;
  } catch (e) {
    if (!(e instanceof RefreshError)) throw e;
    if (shape !== "series") return null;
    const points = rows.slice(1, 61).flatMap((r) => {
      const value = Number((r[r.length - 1] ?? "").trim().replace(/,/g, ""));
      return (r[r.length - 1] ?? "").trim() !== "" && Number.isFinite(value) ? [{ label: (r[0] ?? "").slice(0, 200), value }] : [];
    });
    return points.length ? { kind: "series", points } : null;
  }
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The same filters, with each closed date range moved back by its own length. */
function previousPeriod(filters: ReportFilter[]): ReportFilter[] | null {
  let moved = false;
  const out = filters.map((f) => {
    if (!f.from || !f.to) return f;
    const from = Date.parse(f.from);
    const to = Date.parse(f.to);
    if (!(to > from)) return f;
    moved = true;
    return { ...f, from: iso(from - (to - from)), to: f.from };
  });
  return moved ? out : null;
}

export interface CardView {
  /** False when this card's source cannot be filtered underneath; the page then filters what is on the card. */
  live: boolean;
  data: WidgetData | null;
  /** The filters that reached this card's data. */
  applied: string[];
  /** The same card over the period just before, when asked for and the filters hold a date range. */
  previous: WidgetData | null;
}

export async function viewWidget(userId: string, row: WidgetRow, filters: ReportFilter[], compare: boolean): Promise<CardView> {
  const source = row.source as WidgetSource;
  const stored = row.data as WidgetData;
  const now = await filteredRows(userId, source, filters);
  if (!now || source.kind === "snapshot") return { live: false, data: stored, applied: [], previous: null };
  const view: CardView = { live: true, data: shaped(now.rows, source.shape, stored), applied: now.applied, previous: null };
  const earlier = compare ? previousPeriod(filters.filter((f) => now.applied.some((a) => same(a, f.field)))) : null;
  if (earlier) {
    const before = await filteredRows(userId, source, earlier);
    if (before) view.previous = shaped(before.rows, source.shape, stored);
  }
  return view;
}

/** The workbook behind a card whose rows can be filtered, when there is one. */
async function workbookOf(userId: string, source: WidgetSource): Promise<string | null> {
  if (source.kind === "table_query") return (await access(userId, source.workbookId)) ? source.workbookId : null;
  if (source.kind === "definition") {
    const found = await definitionFor(userId, source.definitionId);
    const id = found?.src.kind === "workbook" ? ((found.src.config as SourceConfig).workbookId ?? null) : null;
    return id && (await access(userId, id)) ? id : null;
  }
  return null;
}

export interface ReportField {
  name: string;
  kind: "text" | "number" | "date";
  /** Every value, for a text field with 200 or fewer. Null when there are more. */
  values: string[] | null;
  min: string | number | null;
  max: string | number | null;
}

/** Fields with the same name in several tables become one: its values are joined, its range widened. */
function merge(into: Map<string, ReportField>, f: TableField) {
  const key = f.name.trim().toLowerCase();
  const old = into.get(key);
  const next: ReportField = { name: f.name, kind: f.kind, values: f.kind === "text" ? (f.values ?? null) : null, min: f.min ?? null, max: f.max ?? null };
  if (!old) return void into.set(key, next);
  if (old.kind !== next.kind) return void (old.kind = "text", (old.values = null));
  if (old.kind === "text") old.values = old.values && next.values ? [...new Set([...old.values, ...next.values])].sort().slice(0, 200) : null;
  else {
    if (next.min !== null && (old.min === null || next.min < old.min)) old.min = next.min;
    if (next.max !== null && (old.max === null || next.max > old.max)) old.max = next.max;
  }
}

/** What a report can be filtered by, and for each card whether it follows and what its columns are. Read with the owner's access. */
export async function reportFields(boardId: string, ownerId: string): Promise<{ fields: ReportField[]; cards: Record<string, { live: boolean; columns: string[] | null; fields: string[] }> }> {
  const rows = await db.select().from(widget).where(eq(widget.dashboardId, boardId));
  const byBook = new Map<string, { id: string; sql: string | null }[]>();
  const cards: Record<string, { live: boolean; columns: string[] | null; fields: string[] }> = {};
  for (const w of rows) {
    const source = w.source as WidgetSource;
    cards[w.id] = { live: false, columns: null, fields: [] };
    const book = await workbookOf(ownerId, source).catch(() => null);
    if (!book) {
      if (source.kind === "metric") cards[w.id]!.live = true;
      continue;
    }
    cards[w.id]!.live = true;
    byBook.set(book, [...(byBook.get(book) ?? []), { id: w.id, sql: source.kind === "table_query" ? source.sql : null }]);
  }
  const fields = new Map<string, ReportField>();
  for (const [book, list] of byBook) {
    try {
      const info = await tableFields(book, list.flatMap((l) => (l.sql ? [{ id: l.id, sql: l.sql }] : [])));
      for (const l of list) {
        const d = info.described[l.id];
        // A definition card names no SQL here: it may read any of the workbook's tables.
        const tables = l.sql ? info.tables.filter((t) => d?.tables.includes(t.table)) : info.tables;
        cards[l.id]!.columns = d?.columns ?? null;
        cards[l.id]!.fields = [...new Set(tables.flatMap((t) => t.columns.map((col) => col.name)))];
        for (const t of tables) for (const col of t.columns) merge(fields, col);
      }
    } catch (e) {
      if (!(e instanceof TablesError) && !(e instanceof EngineError)) throw e;
    }
  }
  return { fields: [...fields.values()], cards };
}

const filtersBody = z.object({ filters: z.array(reportFilter).max(12).default([]), compare: z.boolean().default(false) }).strict();

const issue = (e: z.ZodError) => {
  const i = e.issues[0]!;
  return `${i.path.join(".") || "(input)"}: ${i.message}`;
};

/** The SQL a builder card may hold: one read-only statement over one workbook's tables. */
const builderSource = widgetSource.refine((s) => s.kind === "table_query", "A card made by hand reads a workbook table.");

interface Guards {
  /** The dashboard, when the user may see it. */
  readDashboard: (userId: string, id: string) => Promise<{ id: string; ownerId: string } | null>;
  /** The dashboard, when the user may change it. */
  editDashboard: (userId: string, id: string) => Promise<{ id: string; ownerId: string } | null>;
  /** The widget and the user whose data access it runs with, when the user may see it. */
  readWidget: (userId: string, id: string) => Promise<{ row: WidgetRow; runAs: string } | null>;
  publicWidget: (w: WidgetRow) => unknown;
}

export function liveRoutes(app: Hono<{ Variables: Vars }>, g: Guards) {
  /** One card with the report's filters applied. Nothing is saved. */
  app.post("/api/v1/widgets/:id/view", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await g.readWidget(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const parsed = filtersBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    try {
      return c.json(await viewWidget(found.runAs, found.row, parsed.data.filters, parsed.data.compare));
    } catch (e) {
      if (e instanceof RefreshError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  /** The rows behind a card: its first table, with the report's filters applied. */
  app.post("/api/v1/widgets/:id/rows", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await g.readWidget(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const parsed = filtersBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    const source = found.row.source as WidgetSource;
    if (source.kind !== "table_query") return c.json({ error: "Only a card that reads a workbook table can show its rows." }, 400);
    const workbookId = await workbookOf(found.runAs, source);
    if (!workbookId) return c.json({ error: "The workbook for this widget is gone or no longer shared with you." }, 404);
    try {
      const info = await tableFields(workbookId, [{ id: "card", sql: source.sql }]);
      const table = info.described.card?.tables[0];
      if (!table) return c.json({ error: "This card's query does not name a table." }, 400);
      const out = await queryTables(workbookId, `SELECT * FROM "${table}"`, 200, parsed.data.filters);
      // How many rows there are in all, and the total of each number column: what a drill-through is checked against.
      const numbers = (info.tables.find((t) => t.table === table)?.columns ?? []).filter((col) => col.kind === "number").slice(0, 4);
      const sums = await queryTables(workbookId, `SELECT COUNT(*)${numbers.map((col) => `, SUM("${col.name.replace(/"/g, '""')}")`).join("")} FROM "${table}"`, 1, parsed.data.filters);
      const first = sums.rows[0] ?? [];
      return c.json({ table: info.tables.find((t) => t.table === table)?.title ?? table, columns: out.columns, rows: out.rows, truncated: out.truncated, count: Number(first[0] ?? out.rows.length), totals: numbers.map((col, i) => ({ column: col.name, total: first[i + 1] === null || first[i + 1] === undefined ? null : Number(first[i + 1]) })) });
    } catch (e) {
      if (e instanceof TablesError) return c.json({ error: e.message }, 400);
      if (e instanceof EngineError) return c.json({ error: engineMessage(e) }, 400);
      throw e;
    }
  });

  app.get("/api/v1/dashboards/:id/fields", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const board = await g.readDashboard(user.id, c.req.param("id"));
    if (!board) return c.json({ error: "not found" }, 404);
    return c.json(await reportFields(board.id, board.ownerId));
  });

  /** A workbook's tables and their columns, for making a card by hand. */
  app.get("/api/v1/workbooks/:id/tables", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await access(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    try {
      const info = await tableFields(c.req.param("id"));
      return c.json({ tables: info.tables, skipped: info.skipped });
    } catch (e) {
      if (e instanceof TablesError) return c.json({ tables: [], skipped: [], error: e.message });
      if (e instanceof EngineError) return c.json({ error: engineMessage(e) }, 400);
      throw e;
    }
  });

  const built = z.object({ title: z.string().trim().min(1).max(60), form: z.enum(DESIGN_FORMS), theme: z.enum(THEMES), source: builderSource }).strict();

  /** Run a hand-made card's query and give back what it would show. Throws RefreshError with the reason. */
  async function build(userId: string, input: z.infer<typeof built>): Promise<WidgetData> {
    const out = await filteredRows(userId, input.source, []);
    if (!out) throw new RefreshError(400, "A card made by hand reads a workbook table.");
    const shape = (input.source as Extract<WidgetSource, { kind: "table_query" }>).shape;
    const data = rowsToData(out.rows, shape, undefined);
    const why = fits(input.form, data);
    if (why) throw new RefreshError(400, why);
    return data;
  }

  /** What a hand-made card would show, before it is added. */
  app.post("/api/v1/widgets/preview", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = built.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    try {
      return c.json({ data: await build(user.id, parsed.data) });
    } catch (e) {
      if (e instanceof RefreshError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  /** Add a card made by hand: pick a table, what to total and what to split it by. No agent needed. */
  app.post("/api/v1/dashboards/:id/widgets", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const board = await g.editDashboard(user.id, c.req.param("id"));
    if (!board) return c.json({ error: "not found" }, 404);
    const parsed = built.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: issue(parsed.error) }, 400);
    // An editor may chart only a workbook they can open themselves; the card then runs as the owner.
    const src = parsed.data.source;
    if (src.kind === "table_query" && !(await access(user.id, src.workbookId))) return c.json({ error: "The workbook for this widget is gone or no longer shared with you." }, 404);
    let data: WidgetData;
    try {
      // The card runs with the report owner's access from now on, so it is built with it too.
      data = await build(board.ownerId, parsed.data);
    } catch (e) {
      if (e instanceof RefreshError) return c.json({ error: e.message }, e.status);
      throw e;
    }
    const [{ top } = { top: null }] = await db.select({ top: max(widget.position) }).from(widget).where(eq(widget.dashboardId, board.id));
    const [w] = await db
      .insert(widget)
      .values({ id: newId(), dashboardId: board.id, agentId: null, title: parsed.data.title, form: parsed.data.form, theme: parsed.data.theme, size: "m", position: (top ?? -1) + 1, data, source: parsed.data.source })
      .returning();
    return c.json({ widget: g.publicWidget(w!) }, 201);
  });
}
