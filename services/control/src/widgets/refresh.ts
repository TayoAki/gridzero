// Refreshing a widget from its source (agent spec §8.5).

import { checkAlerts } from "../alerts.ts";
import { captureError } from "../errors.ts";
import { readOnlySqlProblem } from "../agents/workbook-tools.ts";
import { EngineError } from "../definitions/engine.ts";
import { MetricSqlError, NoCredential, SourceError, memberAccess } from "../definitions/sql.ts";
import { TooCostly, definitionFor, runMetric as runDefinition, sourceDefinitions } from "../definitions/store.ts";
import { TablesError, queryTables } from "../definitions/tables.ts";
import { eq } from "drizzle-orm";

import { ERRORS } from "../agents/catalog.ts";
import { cellGrid, hostAgentCall, parseA1Range, TILE_COLS, TILE_ROWS } from "../agents/host.ts";
import type { Tile } from "../agents/host.ts";
import { loadKey, overCap } from "../agents/keys.ts";
import { runAgent } from "../agents/run.ts";
import { db } from "../db/client.ts";
import { agent, widget } from "../db/schema.ts";
import { MetricError } from "../metrics/compile.ts";
import { runMetric } from "../metrics/routes.ts";
import { access } from "../sharing.ts";
import type { WidgetData, WidgetSource } from "./spec.ts";

type WidgetRow = typeof widget.$inferSelect;

export class RefreshError extends Error {
  status: 400 | 404 | 409 | 429 | 502;
  constructor(status: RefreshError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

/** RFC 4180 CSV to rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const numeric = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim().replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Header row plus data rows to widget data (spec §8.5):
 * number = first data row, last column (or the only row, when the range has no header); series = first column labels and last column
 * values (60 rows at most, non-numeric rows skipped); table = 6 columns and 50 rows.
 */
export function rowsToData(rows: string[][], shape: "number" | "series" | "table", previous?: WidgetData): WidgetData {
  const [header = [], ...body] = rows;
  if (shape === "number") {
    // A range of one row has no header: the number is in that row (an agent pointing at the single cell A2).
    const first = body[0] ?? (rows.length === 1 ? header : undefined);
    const value = first ? numeric(first[first.length - 1]) : null;
    if (value === null) throw new RefreshError(400, "The source did not return a number.");
    const old = previous?.kind === "number" ? previous : null;
    return { kind: "number", value, unit: old?.unit ?? null, delta: old ? value - old.value : null, label: old?.label ?? null };
  }
  if (shape === "series") {
    const points: { label: string; value: number }[] = [];
    for (const r of body.slice(0, 60)) {
      const value = numeric(r[r.length - 1]);
      if (value !== null) points.push({ label: (r[0] ?? "").slice(0, 200), value });
    }
    if (points.length < 2) throw new RefreshError(400, "The source returned fewer than 2 numeric rows.");
    return { kind: "series", points };
  }
  const columns = header.slice(0, 6).map((c) => c.slice(0, 200));
  if (columns.length === 0) throw new RefreshError(400, "The source returned no columns.");
  return {
    kind: "table",
    columns,
    rows: body.slice(0, 50).map((r) => columns.map((_, i) => {
      const cell = r[i] ?? "";
      if (cell === "") return null;
      return numeric(cell) ?? cell.slice(0, 500);
    })),
  };
}

async function sheetRows(userId: string, source: Extract<WidgetSource, { kind: "sheet" }>): Promise<string[][]> {
  if (!(await access(userId, source.workbookId))) throw new RefreshError(404, "The workbook for this widget is gone or no longer shared with you.");
  let r;
  try {
    r = parseA1Range(source.range);
  } catch (e) {
    throw new RefreshError(400, (e as Error).message);
  }
  if (r.r1 - r.r0 > 200 || r.c1 - r.c0 > 31) throw new RefreshError(400, "The range is larger than 200 rows by 32 columns.");
  const want: [number, number][] = [];
  for (let tr = Math.floor(r.r0 / TILE_ROWS); tr <= Math.floor(r.r1 / TILE_ROWS); tr++)
    for (let tc = Math.floor(r.c0 / TILE_COLS); tc <= Math.floor(r.c1 / TILE_COLS); tc++) want.push([tr, tc]);
  const res = await hostAgentCall<{ tiles: Tile[] }>(source.workbookId, { type: "GetTiles", sheet: source.sheet, tiles: want });
  const grid = cellGrid(res.reply.tiles);
  const rows: string[][] = [];
  for (let row = r.r0; row <= r.r1; row++) {
    const cells: string[] = [];
    for (let col = r.c0; col <= r.c1; col++) cells.push(grid.get(`${row},${col}`) ?? "");
    rows.push(cells);
  }
  return rows;
}

async function tableQueryRows(userId: string, source: Extract<WidgetSource, { kind: "table_query" }>): Promise<string[][]> {
  if (!(await access(userId, source.workbookId))) throw new RefreshError(404, "The workbook for this widget is gone or no longer shared with you.");
  const problem = readOnlySqlProblem(source.sql);
  if (problem) throw new RefreshError(400, problem);
  try {
    const out = await queryTables(source.workbookId, source.sql, 60);
    return [out.columns, ...out.rows.map((r) => r.map((v) => v ?? ""))];
  } catch (e) {
    if (e instanceof TablesError) throw new RefreshError(400, e.message);
    if (e instanceof EngineError) throw new RefreshError(400, `The query no longer runs: ${e.message.replace(/^\w+Exception: /, "").slice(0, 300)}`);
    throw e;
  }
}

async function definitionRows(userId: string, source: Extract<WidgetSource, { kind: "definition" }>): Promise<string[][]> {
  const found = await definitionFor(userId, source.definitionId);
  if (!found || found.def.kind !== "metric") throw new RefreshError(404, "The definition for this widget is gone or no longer shared with you.");
  const all = (await sourceDefinitions(found.src.id)).map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, status: d.status, body: d.body as Record<string, any> }));
  const groupBy = source.groupBy.map((n) => {
    const dim = all.find((d) => d.kind === "dimension" && d.name === n);
    if (!dim) throw new RefreshError(400, `The dimension ${n} no longer exists.`);
    return dim;
  });
  try {
    const v = await runDefinition(await memberAccess(found.src, userId), all.find((d) => d.id === found.def.id)!, all, { groupBy, limit: 60 });
    return [v.columns, ...v.rows.map((r) => r.map((x) => x ?? ""))];
  } catch (e) {
    if (e instanceof NoCredential || e instanceof MetricSqlError || e instanceof SourceError || e instanceof TooCostly) throw new RefreshError(400, e.message);
    throw e;
  }
}

/** Which refresh runs called update_widget_data. */
export const snapshotUpdated = new Set<string>();

async function snapshot(userId: string, row: WidgetRow, source: Extract<WidgetSource, { kind: "snapshot" }>): Promise<void> {
  if (!row.agentId) throw new RefreshError(409, "The agent that made this widget was deleted, so it cannot refresh.");
  const [owner] = await db.select().from(agent).where(eq(agent.id, row.agentId));
  if (!owner || owner.ownerId !== userId) throw new RefreshError(409, "The agent that made this widget was deleted, so it cannot refresh.");
  const key = await loadKey(userId);
  if (!key) throw new RefreshError(409, ERRORS.E_NO_KEY);
  const over = await overCap(userId, key);
  if (over) throw new RefreshError(429, ERRORS[over]);
  const result = await runAgent({
    agent: owner,
    userId,
    apiKey: key.key,
    provider: key.provider,
    keySource: key.source,
    kind: "widget_refresh",
    userText: `${source.prompt}\n\nUpdate the widget "${row.title}" by calling update_widget_data.`,
    store: false,
    widgetId: row.id,
    emit: () => {},
  });
  const updated = snapshotUpdated.delete(result.runId);
  if (!updated) throw new RefreshError(409, result.ok ? "The agent did not return new data." : ERRORS[result.errorCode!]);
}

/** Refresh one widget; returns the updated row. */
export async function refreshWidget(userId: string, row: WidgetRow): Promise<WidgetRow> {
  const source = row.source as WidgetSource;
  if (source.kind === "snapshot") {
    await snapshot(userId, row, source);
  } else {
    let rows: string[][];
    if (source.kind === "metric") {
      try {
        rows = parseCsv((await runMetric(userId, source.modelId, source.query)).csv);
      } catch (e) {
        if (e instanceof RefreshError) throw e;
        if (e instanceof MetricError) throw new RefreshError(400, e.message);
        throw new RefreshError(502, `The metric query failed: ${(e as Error).message.slice(0, 300)}`);
      }
    } else if (source.kind === "table_query") {
      rows = await tableQueryRows(userId, source);
    } else if (source.kind === "definition") {
      rows = await definitionRows(userId, source);
    } else {
      rows = await sheetRows(userId, source);
    }
    const data = rowsToData(rows, source.shape, row.data as WidgetData);
    await db.update(widget).set({ data, refreshedAt: new Date() }).where(eq(widget.id, row.id));
  }
  const [fresh] = await db.select().from(widget).where(eq(widget.id, row.id));
  // Tell anyone who asked to hear when this figure crosses a line.
  await checkAlerts(fresh!).catch((e: unknown) => captureError(e, { job: "alerts", widgetId: row.id }));
  return fresh!;
}
