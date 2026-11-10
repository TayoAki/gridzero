// Workbook and warehouse tools for agents (agent spec §6.2).

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { csvRow, decryptSecret, runQuery } from "../connectors.ts";
import type { Config, Kind } from "../connectors.ts";
import { db } from "../db/client.ts";
import { connection, workbook, workbookShare } from "../db/schema.ts";
import { access } from "../sharing.ts";
import { TILE_COLS, TILE_ROWS, cellGrid, hostAgentCall, hostBase, hostToken, parseA1Range } from "./host.ts";
import type { Tile } from "./host.ts";
import { ToolError, registerTool } from "./tools.ts";
import type { ClientTool } from "./tools.ts";

const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const nullableInt = { type: ["integer", "null"] };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

async function readable(userId: string, id: string) {
  const found = await access(userId, id);
  if (!found) throw new ToolError("Workbook not found.");
  return found;
}

async function writable(userId: string, id: string) {
  const found = await readable(userId, id);
  if (found.role === "viewer") throw new ToolError("You can only read that workbook.");
  return found;
}

async function tiles(workbookId: string, sheet: number, tileRows: number, tileCols: number) {
  const want: [number, number][] = [];
  for (let r = 0; r < tileRows; r++) for (let c = 0; c < tileCols; c++) want.push([r, c]);
  return hostAgentCall<{ tiles: Tile[] }>(workbookId, { type: "GetTiles", sheet, tiles: want });
}

function sheetName(sheets: { id: number; name: string }[], sheet: number): string {
  if (sheet < 0 || sheet >= sheets.length) throw new ToolError(`That workbook has no sheet ${sheet}. It has ${sheets.length}.`);
  return sheets[sheet]!.name;
}

// --- list_workbooks ----------------------------------------------------------

const listWorkbooks: ClientTool<Record<string, never>> = {
  name: "list_workbooks",
  description: "List the spreadsheets (workbooks) the user can open: id, title and the user's role. Use the id with read_sheet, write_table and create_chart.",
  inputSchema: obj({}),
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  readOnly: true,
  privateData: false,
  async run(_input, ctx) {
    const rows = await db
      .selectDistinct({ id: workbook.id, title: workbook.title, ownerId: workbook.ownerId, shareRole: workbookShare.role, lastAccessedAt: workbook.lastAccessedAt })
      .from(workbook)
      .leftJoin(workbookShare, and(eq(workbookShare.workbookId, workbook.id), eq(workbookShare.userId, ctx.userId)))
      .where(and(isNull(workbook.deletedAt), or(eq(workbook.ownerId, ctx.userId), eq(workbookShare.userId, ctx.userId))));
    rows.sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    return { workbooks: rows.slice(0, 50).map((r) => ({ id: r.id, title: r.title, role: r.ownerId === ctx.userId ? "owner" : r.shareRole })) };
  },
  summary: (_i, r) => `Listed ${(r as { workbooks: unknown[] }).workbooks.length} workbooks`,
};

// --- read_sheet --------------------------------------------------------------

interface ReadSheetInput {
  workbook_id: string;
  sheet: number | null;
  max_rows: number | null;
}

/** Displayed values of rows 0..maxRows-1 as CSV, trimmed of empty trailing rows and columns. */
export function gridToCsv(grid: Map<string, string>, maxRows: number, maxCols: number): { csv: string; truncated: boolean } {
  let lastRow = -1;
  let lastCol = -1;
  let truncated = false;
  for (const key of grid.keys()) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    if (r >= maxRows) {
      truncated = true;
      continue;
    }
    if (c >= maxCols) continue;
    lastRow = Math.max(lastRow, r);
    lastCol = Math.max(lastCol, c);
  }
  let csv = "";
  for (let r = 0; r <= lastRow; r++) {
    const values: string[] = [];
    for (let c = 0; c <= lastCol; c++) values.push(grid.get(`${r},${c}`) ?? "");
    csv += csvRow(values);
  }
  return { csv, truncated };
}

const readSheet: ClientTool<ReadSheetInput> = {
  name: "read_sheet",
  description: "Read the displayed values of one sheet of a workbook as CSV (up to 200 rows and 32 columns). sheet is the sheet's index (0 is the first); null means 0. max_rows defaults to 50.",
  inputSchema: obj({ workbook_id: { type: "string" }, sheet: nullableInt, max_rows: nullableInt }),
  schema: z.object({ workbook_id: z.string(), sheet: z.number().int().nullable(), max_rows: z.number().int().nullable() }).strict(),
  readOnly: true,
  privateData: true,
  async run(input, ctx) {
    const found = await readable(ctx.userId, input.workbook_id);
    const sheet = input.sheet ?? 0;
    const maxRows = Math.min(200, Math.max(1, input.max_rows ?? 50));
    // One tile row past the limit tells us whether there is more.
    const res = await tiles(found.row.id, sheet, Math.ceil(maxRows / TILE_ROWS) + 1, 2);
    const name = sheetName(res.sheets, sheet);
    const { csv, truncated } = gridToCsv(cellGrid(res.reply.tiles), maxRows, 2 * TILE_COLS);
    return { sheet_name: name, csv, truncated, _title: found.row.title };
  },
  summary: (_i, r) => {
    const out = r as { _title: string; sheet_name: string };
    return `Read ${out._title} / ${out.sheet_name}`;
  },
};

// --- run_sql -----------------------------------------------------------------

interface RunSqlInput {
  connection_id: string;
  sql: string;
  max_rows: number | null;
}

const runSql: ClientTool<RunSqlInput> = {
  name: "run_sql",
  description: "Run a read-only SQL query on one of the user's database connections and return the result as CSV. max_rows defaults to 50 (at most 500). Use list_connections first if you do not know the connection id.",
  inputSchema: obj({ connection_id: { type: "string" }, sql: { type: "string" }, max_rows: nullableInt }),
  schema: z.object({ connection_id: z.string(), sql: z.string(), max_rows: z.number().int().nullable() }).strict(),
  readOnly: true,
  privateData: true,
  async run(input, ctx) {
    if (input.sql.length > 20_000) throw new ToolError("The query is longer than 20,000 characters.");
    const [conn] = await db.select().from(connection).where(and(eq(connection.id, input.connection_id), eq(connection.ownerId, ctx.userId)));
    if (!conn) throw new ToolError("Connection not found.");
    const maxRows = Math.min(500, Math.max(1, input.max_rows ?? 50));
    const lines: string[] = [];
    let truncated = false;
    let pending = "";
    const decoder = new TextDecoder();
    try {
      await runQuery(conn.kind as Kind, conn.config as Config, decryptSecret(conn.secret), input.sql, async (csv) => {
        for await (const chunk of csv) {
          pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = pending.indexOf("\n")) >= 0 && !truncated) {
            lines.push(pending.slice(0, nl + 1));
            pending = pending.slice(nl + 1);
            if (lines.length > maxRows + 1) truncated = true;
          }
          if (truncated) break;
        }
        if (!truncated && pending) lines.push(pending);
      });
    } catch (e) {
      throw new ToolError(`The query failed: ${(e as Error).message.slice(0, 500)}`);
    }
    return { csv: lines.slice(0, maxRows + 1).join(""), truncated, _name: conn.name };
  },
  summary: (_i, r) => `Queried ${(r as { _name: string })._name}`,
};

const listConnections: ClientTool<Record<string, never>> = {
  name: "list_connections",
  description: "List the user's saved database connections (id, name, kind) for run_sql.",
  inputSchema: obj({}),
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  readOnly: true,
  privateData: false,
  async run(_input, ctx) {
    const rows = await db.select({ id: connection.id, name: connection.name, kind: connection.kind }).from(connection).where(eq(connection.ownerId, ctx.userId));
    return { connections: rows };
  },
  summary: (_i, r) => `Listed ${(r as { connections: unknown[] }).connections.length} connections`,
};

// --- write_table -------------------------------------------------------------

interface WriteTableInput {
  workbook_id: string;
  name: string;
  csv: string;
}

const writeTable: ClientTool<WriteTableInput> = {
  name: "write_table",
  description: "Write CSV data (first line is the header) to a new sheet of a workbook as a Data Table. name is the table and sheet name (1-60 characters).",
  inputSchema: obj({ workbook_id: { type: "string" }, name: { type: "string" }, csv: { type: "string" } }),
  schema: z.object({ workbook_id: z.string(), name: z.string(), csv: z.string() }).strict(),
  readOnly: false,
  privateData: false,
  async run(input, ctx) {
    const found = await writable(ctx.userId, input.workbook_id);
    const name = input.name.trim();
    if (!name || name.length > 60) throw new ToolError("The table name must be 1-60 characters.");
    if (Buffer.byteLength(input.csv) > MAX_WRITE_BYTES) throw new ToolError("The CSV is larger than 2 MB.");
    if (!input.csv.trim()) throw new ToolError("The CSV is empty.");
    const base = hostBase(found.row.id);
    const token = encodeURIComponent(await hostToken(found.row.id));
    const importId = `ag${randomBytes(8).toString("hex")}`;
    const up = await fetch(`${base}/import?token=${token}&import_id=${importId}&name=agent.csv`, {
      method: "POST",
      body: Readable.toWeb(Readable.from([input.csv])) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit);
    if (!up.ok) throw new ToolError(`The upload failed: ${(await up.text()).slice(0, 300)}`);
    const res = await fetch(`${base}/apply?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "FinalizeImport", import_id: importId, options: { header: true, separator: ",", quote: null, skip_rows: 0 }, dest: { type: "NewSheet" }, mode: "Table", name }),
    });
    if (!res.ok) throw new ToolError(`The import failed: ${(await res.text()).slice(0, 300)}`);
    const done = (await res.json()) as { rows: number; table: string | null };
    const meta = await hostAgentCall<{ meta: { tables: { id: string; sheet: number }[] } }>(found.row.id, { type: "GetSheetMeta", sheet: 0 });
    const sheet = meta.sheets.length - 1;
    return { sheet, table: done.table, rows: Math.max(0, done.rows - 1), _title: found.row.title };
  },
  summary: (_i, r) => {
    const out = r as { rows: number; _title: string };
    return `Wrote ${out.rows} rows to ${out._title}`;
  },
};

// --- create_chart ------------------------------------------------------------

interface CreateChartInput {
  workbook_id: string;
  sheet: number;
  range: string;
  kind: "Column" | "Bar" | "Line" | "Pie";
  title: string;
}

const createChart: ClientTool<CreateChartInput> = {
  name: "create_chart",
  description:
    "Make a chart in a workbook from a range in A1 notation (like A1:C20). The first row is the header, the first column the categories, and every other column one series.",
  inputSchema: obj({
    workbook_id: { type: "string" },
    sheet: { type: "integer" },
    range: { type: "string" },
    kind: { type: "string", enum: ["Column", "Bar", "Line", "Pie"] },
    title: { type: "string" },
  }),
  schema: z.object({ workbook_id: z.string(), sheet: z.number().int(), range: z.string(), kind: z.enum(["Column", "Bar", "Line", "Pie"]), title: z.string() }).strict(),
  readOnly: false,
  privateData: false,
  async run(input, ctx) {
    const found = await writable(ctx.userId, input.workbook_id);
    let r;
    try {
      r = parseA1Range(input.range);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    if (r.r1 <= r.r0 || r.c1 <= r.c0) throw new ToolError("The range needs a header row and at least two columns.");
    const view = await tiles(found.row.id, input.sheet, 2, 4);
    sheetName(view.sheets, input.sheet);
    const grid = cellGrid(view.reply.tiles);
    let lastCol = r.c1;
    for (const key of grid.keys()) lastCol = Math.max(lastCol, Number(key.split(",")[1]));
    const series = [];
    for (let c = r.c0 + 1; c <= r.c1 && series.length < 12; c++) {
      series.push({ range: { sheet: input.sheet, r0: r.r0 + 1, c0: c, r1: r.r1, c1: c }, name: grid.get(`${r.r0},${c}`) ?? null, kind: null, axis: "Left" });
    }
    const spec = {
      id: "",
      sheet: input.sheet,
      row: 0,
      col: lastCol + 2,
      w: 480,
      h: 300,
      kind: input.kind,
      title: input.title.slice(0, 200),
      x: { sheet: input.sheet, r0: r.r0 + 1, c0: r.c0, r1: r.r1, c1: r.c0 },
      series,
      bins: null,
      stacked: false,
    };
    let res;
    try {
      res = await hostAgentCall<{ id: string }>(found.row.id, { type: "CreateChart", spec });
    } catch (e) {
      throw new ToolError(`The chart could not be made: ${(e as Error).message.slice(0, 300)}`);
    }
    return { chart_id: res.reply.id, _title: found.row.title };
  },
  summary: (_i, r) => `Made a chart in ${(r as { _title: string })._title}`,
};

for (const tool of [listWorkbooks, readSheet, runSql, listConnections, writeTable, createChart]) registerTool(tool as ClientTool<any>);
