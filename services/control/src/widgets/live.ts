// Live cards: a card's query run again with a report's filters applied to the rows underneath it, so
// totals follow a filter instead of only hiding rows already on the card. Also what a report can be
// filtered by, the rows behind a card, and making a card from a table without an agent.

import { isAuditor, record } from "../activity.ts";
import { and, eq, isNull, max } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { newId } from "../agents/run.ts";
import { readOnlySqlProblem } from "../agents/workbook-tools.ts";
import type { Vars } from "../app.ts";
import { db } from "../db/client.ts";
import { metricModel, widget, workbook } from "../db/schema.ts";
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
import { guarded } from "./access.ts";
import type { Guard } from "./access.ts";
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

const same2 = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What a card says to someone it cannot be limited for. */
export const WITHHELD: WidgetData = { kind: "text", text: "Not shown: this card cannot be limited to the rows you may see." };

/**
 * A card for someone held to certain rows: worked out for those rows only, with their own filters on top.
 * If any limit cannot reach the card's data (a snapshot, or a table without that column), nothing of it is shown.
 */
export async function limitedView(ownerId: string, row: WidgetRow, limits: { field: string; values: string[] }[], filters: ReportFilter[], compare: boolean): Promise<CardView & { withheld: boolean }> {
  const stored = row.data as WidgetData;
  // A slicer holds no figures, and a note is words the owner wrote for whoever reads the report.
  if (stored.kind === "slicer" || (stored.kind === "text" && row.agentId === null)) return { live: false, data: stored, applied: [], previous: null, withheld: false };
  const view = await viewWidget(ownerId, row, [...limits, ...filters], compare).catch((e: unknown) => {
    if (e instanceof RefreshError) return null;
    throw e;
  });
  if (!view || !view.live || !limits.every((l) => view.applied.some((a) => same2(a, l.field)))) return { live: true, data: WITHHELD, applied: [], previous: null, withheld: true };
  return { ...view, applied: view.applied.filter((a) => !limits.some((l) => same2(l.field, a)) || filters.some((f) => same2(f.field, a))), withheld: false };
}

const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i");
const hidden = (text: string): WidgetData => ({ kind: "text", text });

/**
 * A card's query rewritten so no group smaller than `n` rows comes back, or null when that cannot be
 * guaranteed. A total gets the same rule: fewer than `n` rows in all and it returns nothing.
 * Only a single SELECT is understood; anything else is refused rather than guessed at.
 */
export function protectSmallGroups(sql: string, n: number): string | null {
  const s = sql.trim().replace(/;+\s*$/, "");
  if ((s.match(/\bselect\b/gi) ?? []).length !== 1 || /\b(union|intersect|except|having|qualify)\b|\bover\s*\(/i.test(s)) return null;
  const grouped = /\bgroup\s+by\b/i.test(s);
  // Without grouping it must be one total; plain rows are individual records.
  if (!grouped && !/\b(sum|count|avg|min|max|median)\s*\(/i.test(s)) return null;
  const tail = /\b(order\s+by|limit)\b/i.exec(grouped ? s.slice(s.search(/\bgroup\s+by\b/i)) : s);
  const at = tail ? (grouped ? s.search(/\bgroup\s+by\b/i) : 0) + tail.index : s.length;
  return `${s.slice(0, at).trimEnd()} HAVING COUNT(*) >= ${Math.floor(n)} ${s.slice(at)}`.trim();
}

/**
 * A card for a reader who is guarded in any way: held to certain rows, kept from certain columns, or
 * never shown a small group. Where a rule cannot be applied to a card, the card is not shown at all.
 */
export async function guardedView(ownerId: string, row: WidgetRow, g: Guard, filters: ReportFilter[], compare: boolean): Promise<CardView & { withheld: boolean }> {
  const stored = row.data as WidgetData;
  const source = row.source as WidgetSource;
  const no = (text: string) => ({ live: true, data: hidden(text), applied: [], previous: null, withheld: true });
  if (stored.kind === "text" && row.agentId === null) return { live: false, data: stored, applied: [], previous: null, withheld: false };
  if (stored.kind === "slicer") return g.hide.some((h) => same2(h, stored.field)) ? no("Not shown.") : { live: false, data: stored, applied: [], previous: null, withheld: false };
  // A reader cannot filter by a column they may not see: the counts would give it away.
  const asked = filters.filter((f) => ![...g.hide, ...g.mask].some((h) => same2(h, f.field)));
  let use = row;
  // A masked column may only reach the reader as a column of a table, where each value is shown in part.
  const reads = source.kind === "table_query" ? g.mask.filter((m) => word(m).test(source.sql) || source.sql.replace(/count\s*\(\s*\*\s*\)/gi, "").includes("*")) : g.mask;
  if (reads.length && (source.kind !== "table_query" || source.shape !== "table")) return no("Not shown: this card reads a column you see only in part.");
  if (g.hide.length || g.minGroup > 1) {
    if (source.kind === "table_query") {
      const bare = source.sql.replace(/count\s*\(\s*\*\s*\)/gi, "");
      if (g.hide.length && (bare.includes("*") || g.hide.some((h) => word(h).test(source.sql)))) return no("Not shown: this card reads a column you may not see.");
      if (g.minGroup > 1) {
        const safe = protectSmallGroups(source.sql, g.minGroup);
        if (!safe) return no("Not shown: this card cannot be held to the smallest group size set for this report.");
        use = { ...row, source: { ...source, sql: safe } };
      }
    } else return no(g.hide.length ? "Not shown: this card cannot be checked for the columns you may not see." : "Not shown: this card cannot be held to the smallest group size set for this report.");
  }
  const part = (v: string | number | null) => (v === null || v === "" ? v : `${String(v).slice(0, 1)}•••`);
  const masked = <T extends CardView & { withheld: boolean }>(v: T): T => {
    if (!reads.length || v.withheld) return v;
    const d = v.data as { kind: string; columns?: string[]; rows?: (string | number | null)[][] } | null;
    if (d?.kind !== "table") return { ...v, data: hidden("Not shown: this card reads a column you see only in part."), withheld: true };
    const at = (d.columns ?? []).map((c, i) => (g.mask.some((m) => same2(m, c)) ? i : -1)).filter((i) => i >= 0);
    // The column is read but is not one of the columns shown (it is grouped or filtered on): nothing can be shown safely.
    if (!at.length) return { ...v, data: hidden("Not shown: this card reads a column you see only in part."), withheld: true };
    return { ...v, data: { ...d, rows: (d.rows ?? []).map((r) => r.map((x, i) => (at.includes(i) ? part(x) : x))) } as WidgetData, previous: null };
  };
  if (g.limits.length) return masked(await limitedView(ownerId, use, g.limits, asked, compare));
  const view = await viewWidget(ownerId, use, asked, compare).catch((e: unknown) => {
    if (e instanceof RefreshError) return null;
    throw e;
  });
  if (!view || !view.live) return no("Not shown.");
  return masked({ ...view, withheld: false });
}

/** Every card on a report, as a guarded reader gets them: worked out for them, never the stored figures. */
export async function guardedWidgets(ownerId: string, rows: WidgetRow[], g: Guard, publicWidget: (w: WidgetRow) => Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out = [];
  for (const w of rows) {
    const v = await guardedView(ownerId, w, g, [], false);
    const base = publicWidget(w);
    out.push(v.withheld ? { ...base, form: "text", data: v.data, source: { kind: "snapshot", prompt: "" }, options: null } : { ...base, data: v.data ?? { kind: "text", text: "Nothing here for the rows you may see." }, ...(v.data ? {} : { form: "text" }), source: { kind: (w.source as { kind: string }).kind === "snapshot" ? "snapshot" : "table_query", workbookId: "", sql: "", shape: "table" } });
  }
  return out;
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
export async function reportFields(boardId: string, ownerId: string, limits: ReportFilter[] = []): Promise<{ fields: ReportField[]; cards: Record<string, { live: boolean; columns: string[] | null; fields: string[] }> }> {
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
      const info = await tableFields(book, list.flatMap((l) => (l.sql ? [{ id: l.id, sql: l.sql }] : [])), limits);
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
  readDashboard: (userId: string, id: string) => Promise<({ id: string; ownerId: string } & Guard) | null>;
  /** The dashboard, when the user may change it. */
  editDashboard: (userId: string, id: string) => Promise<{ id: string; ownerId: string } | null>;
  /** The widget and the user whose data access it runs with, when the user may see it. */
  readWidget: (userId: string, id: string) => Promise<({ row: WidgetRow; runAs: string } & Guard) | null>;
  publicWidget: (w: WidgetRow) => unknown;
}

async function auditorBook(id: string) {
  const [row] = await db.select().from(workbook).where(and(eq(workbook.id, id), isNull(workbook.deletedAt)));
  return row ? { row, role: "viewer" as const } : null;
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
      if (guarded(found)) return c.json(await guardedView(found.runAs, found.row, found, parsed.data.filters, parsed.data.compare));
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
    // Rows are individual records: not for someone kept from certain columns or from small groups.
    if (found.hide.length || found.minGroup > 1 || found.mask.length) return c.json({ error: "The rows behind this card are not available to you." }, 403);
    const workbookId = await workbookOf(found.runAs, source);
    if (!workbookId) return c.json({ error: "The workbook for this widget is gone or no longer shared with you." }, 404);
    try {
      const info = await tableFields(workbookId, [{ id: "card", sql: source.sql }]);
      const table = info.described.card?.tables[0];
      if (!table) return c.json({ error: "This card's query does not name a table." }, 400);
      const all = [...found.limits, ...parsed.data.filters];
      const out = await queryTables(workbookId, `SELECT * FROM "${table}"`, 200, all);
      // Someone held to certain rows sees the rows only when every limit reached this table.
      if (!found.limits.every((l) => out.applied.some((a) => same2(a, l.field)))) return c.json({ error: "These rows cannot be limited to what you may see." }, 403);
      // How many rows there are in all, and the total of each number column: what a drill-through is checked against.
      const numbers = (info.tables.find((t) => t.table === table)?.columns ?? []).filter((col) => col.kind === "number").slice(0, 4);
      const sums = await queryTables(workbookId, `SELECT COUNT(*)${numbers.map((col) => `, SUM("${col.name.replace(/"/g, '""')}")`).join("")} FROM "${table}"`, 1, all);
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
    const fields = await reportFields(board.id, board.ownerId, board.limits);
    const kept = [...board.hide, ...board.mask];
    return c.json(kept.length ? { ...fields, fields: fields.fields.filter((f) => !kept.some((h) => same2(h, f.name))) } : fields);
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

  /** Run one read-only statement a person wrote over a workbook's tables. Nothing is saved. */
  app.post("/api/v1/workbooks/:id/query", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    // An auditor may re-run a figure: read-only, like everyone, and logged as theirs.
    const book = (await access(user.id, c.req.param("id"))) ?? (isAuditor(user.email) ? await auditorBook(c.req.param("id")) : null);
    if (!book) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ sql?: unknown }>().catch(() => ({}) as { sql?: unknown });
    if (typeof body.sql !== "string" || !body.sql.trim()) return c.json({ error: "Write a query first." }, 400);
    if (body.sql.length > 20_000) return c.json({ error: "The query is longer than 20,000 characters." }, 400);
    const problem = readOnlySqlProblem(body.sql);
    if (problem) return c.json({ error: problem }, 400);
    const started = Date.now();
    try {
      const out = await queryTables(c.req.param("id"), body.sql, 1000);
      record({ userId: user.id, kind: "query.run", objectKind: "workbook", objectId: book.row.id, label: book.row.title, ownerId: book.row.ownerId, detail: { rows: out.rows.length }, ms: Date.now() - started });
      return c.json({ columns: out.columns, rows: out.rows, truncated: out.truncated, ms: Date.now() - started });
    } catch (e) {
      if (e instanceof TablesError) return c.json({ error: e.message }, 400);
      if (e instanceof EngineError) {
        // DuckDB says where: "LINE 3: ...". The editor marks that line.
        const line = /LINE (\d+):/.exec(e.message)?.[1];
        return c.json({ error: engineMessage(e), line: line ? Number(line) : null }, 400);
      }
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
