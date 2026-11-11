// Workbook tables as a data source. Each Data Table is staged as a CSV file and queried with
// DuckDB inside the semantic engine's worker, which is locked so it can read those files only.
// This is what lets an agent total a whole uploaded table instead of reading its first rows.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostAgentCall, hostBase, hostToken } from "../agents/host.ts";
import { engineJob } from "./engine.ts";

export interface WorkbookTable {
  /** The name SQL uses: the table's name with anything but letters, digits and underscores replaced. */
  name: string;
  title: string;
  sheet: number;
  /** Rows in the table, and rows showing if someone has filtered it. */
  totalRows: number;
  shownRows: number;
}

interface TableInfo {
  id: string;
  name: string;
  sheet: number;
  row: number;
  col: number;
  rows: number;
  total_rows: number;
}

/** Above this a table is left out: the workbook host hands a sheet over in one piece. */
export const MAX_TABLE_ROWS = 2_000_000;
const CACHE_MS = 5 * 60_000;

export class TablesError extends Error {}

const sqlName = (name: string) => {
  const clean = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "table";
  return /^[A-Za-z]/.test(clean) ? clean : `t_${clean}`;
};

/** The Data Tables of a workbook that can be queried: on their own sheet, starting at A1. */
export async function workbookTables(workbookId: string): Promise<{ tables: WorkbookTable[]; skipped: string[] }> {
  const first = await hostAgentCall<{ meta: { tables: TableInfo[] } }>(workbookId, { type: "GetSheetMeta", sheet: 0 });
  const infos: TableInfo[] = [...first.reply.meta.tables];
  for (let s = 1; s < first.sheets.length; s++) infos.push(...(await hostAgentCall<{ meta: { tables: TableInfo[] } }>(workbookId, { type: "GetSheetMeta", sheet: s })).reply.meta.tables);
  const tables: WorkbookTable[] = [];
  const skipped: string[] = [];
  const perSheet = new Map<number, number>();
  for (const t of infos) perSheet.set(t.sheet, (perSheet.get(t.sheet) ?? 0) + 1);
  for (const t of infos) {
    if (t.row !== 0 || t.col !== 0 || perSheet.get(t.sheet) !== 1) skipped.push(`${t.name} (not alone at the top of its sheet)`);
    else if (t.total_rows > MAX_TABLE_ROWS) skipped.push(`${t.name} (more than ${MAX_TABLE_ROWS.toLocaleString("en-US")} rows)`);
    else if (tables.some((x) => x.name === sqlName(t.name))) skipped.push(`${t.name} (another table has the same name)`);
    else tables.push({ name: sqlName(t.name), title: t.name, sheet: t.sheet, totalRows: t.total_rows, shownRows: t.rows });
  }
  return { tables, skipped };
}

interface Staged {
  dir: string;
  files: { name: string; path: string }[];
  tables: WorkbookTable[];
  skipped: string[];
  signature: string;
  at: number;
}
const staged = new Map<string, Staged>();

/** The workbook's tables as files on disk, reused while the tables have not changed. */
export async function stage(workbookId: string): Promise<Staged> {
  const { tables, skipped } = await workbookTables(workbookId);
  const signature = JSON.stringify(tables);
  const old = staged.get(workbookId);
  // Row counts catch imports and filters; the time limit catches edits that keep the same counts.
  if (old && old.signature === signature && Date.now() - old.at < CACHE_MS) return old;
  const dir = await mkdtemp(join(tmpdir(), "gz-tables-"));
  const token = encodeURIComponent(await hostToken(workbookId));
  const files: Staged["files"] = [];
  for (const t of tables) {
    const res = await fetch(`${hostBase(workbookId)}/export.csv?token=${token}&sheet=${t.sheet}`);
    if (!res.ok) throw new TablesError(`The table ${t.title} could not be read (${res.status}).`);
    const path = join(dir, `${t.name}.csv`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    files.push({ name: t.name, path });
  }
  const next: Staged = { dir, files, tables, skipped, signature, at: Date.now() };
  staged.set(workbookId, next);
  if (old) void rm(old.dir, { recursive: true, force: true });
  return next;
}

/** Run one read-only statement over a workbook's tables (DuckDB SQL). */
export async function queryTables(workbookId: string, sql: string, maxRows = 500): Promise<{ columns: string[]; rows: (string | null)[][]; truncated: boolean; tables: WorkbookTable[] }> {
  const s = await stage(workbookId);
  if (!s.files.length) throw new TablesError("That workbook has no Data Tables to query. Import a file as a Data table first.");
  const out = await engineJob<{ columns: string[]; rows: unknown[][]; truncated: boolean }>({ job: "files_query", files: s.files, sql, max_rows: maxRows });
  return { columns: out.columns, rows: out.rows.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v)))), truncated: out.truncated, tables: s.tables };
}
