// Delta Lake and Unity Catalog, both open source.
//
// A workbook table can be tracked: its rows are written to a Delta table each time it is captured, so
// two captures can be set side by side record by record. Entries typed into a table on a report can be
// written out as a Delta table that a warehouse can read. When a Unity Catalog server is configured,
// a written-out table is registered there, and its catalogs, schemas and tables can be listed.

import { join } from "node:path";

import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { isAdmin, record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { inputRow, inputTable, trackedTable } from "./db/schema.ts";
import { EngineError, engineJob } from "./definitions/engine.ts";
import { TablesError, queryTables, tableFields } from "./definitions/tables.ts";
import { env } from "./env.ts";
import { captureError } from "./errors.ts";
import { access } from "./sharing.ts";
import { dashboardAccess } from "./widgets/access.ts";

const MAX_ROWS = 50_000;
const pathOf = (kind: "history" | "entries", id: string) => join(env.deltaDir, kind, id.replace(/[^A-Za-z0-9_-]/g, ""));
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

export const unityOn = () => !!env.unityUrl;
async function unity<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(`${env.unityUrl!.replace(/\/$/, "")}/api/2.1/unity-catalog${path}`, { method, headers: { "Content-Type": "application/json", ...(env.unityToken ? { Authorization: `Bearer ${env.unityToken}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, data: res.ok ? ((await res.json().catch(() => null)) as T | null) : null };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** Register a Delta table in Unity Catalog as an external table. Returns its full name, or why it could not be done. */
export async function registerInUnity(name: string, location: string, columns: string[]): Promise<{ name?: string; problem?: string }> {
  if (!unityOn()) return {};
  const table = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "table";
  const full = `${env.unityCatalog}.${env.unitySchema}.${table}`;
  const made = await unity("POST", "/tables", { name: table, catalog_name: env.unityCatalog, schema_name: env.unitySchema, table_type: "EXTERNAL", data_source_format: "DELTA", storage_location: location, columns: columns.map((c, i) => ({ name: c, type_text: "string", type_name: "STRING", type_json: '{"type":"string"}', position: i, nullable: true })) });
  // Already there from an earlier write: the location is the same, so there is nothing to change.
  if (made.ok || made.status === 409) return { name: full };
  return { problem: made.status ? `Unity Catalog answered ${made.status}.` : "Unity Catalog could not be reached." };
}

type Tracked = typeof trackedTable.$inferSelect;
export async function capture(t: Tracked): Promise<{ version: number; rows: number }> {
  const out = await queryTables(t.workbookId, `SELECT * FROM ${q(t.tableName)}`, MAX_ROWS);
  if (out.truncated) throw new TablesError(`Only tables of up to ${MAX_ROWS.toLocaleString()} rows can be tracked.`);
  const done = await engineJob<{ version: number; rows: number }>({ job: "delta_write", path: pathOf("history", t.id), columns: out.columns, rows: out.rows });
  await db.update(trackedTable).set({ lastVersion: done.version, lastAt: new Date(), nextRunAt: t.everyHours ? new Date(Date.now() + t.everyHours * 3_600_000) : null }).where(eq(trackedTable.id, t.id));
  return done;
}

export async function captureDue(now = new Date()): Promise<number> {
  const due = await db.select().from(trackedTable).where(and(isNotNull(trackedTable.everyHours), lte(trackedTable.nextRunAt, now))).limit(5);
  for (const t of due) {
    await db.update(trackedTable).set({ nextRunAt: new Date(now.getTime() + (t.everyHours ?? 24) * 3_600_000) }).where(eq(trackedTable.id, t.id));
    await capture(t).catch((e: unknown) => captureError(e, { job: "capture", id: t.id }));
  }
  return due.length;
}

const fail = (c: { json: (b: unknown, s: 400) => Response }, e: unknown) => {
  if (e instanceof TablesError) return c.json({ error: e.message }, 400);
  if (e instanceof EngineError) return c.json({ error: "The table's history could not be read or written." }, 400);
  throw e;
};

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/workbooks/:id/history", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await access(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(trackedTable).where(eq(trackedTable.workbookId, c.req.param("id")));
    return c.json({ tracked: rows.map((t) => ({ id: t.id, table: t.tableName, key: t.keyColumn, everyHours: t.everyHours, lastVersion: t.lastVersion, lastAt: t.lastAt })) });
  });

  /** Start keeping a table's rows. The first capture is taken at once. */
  app.post("/api/v1/workbooks/:id/history", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot track a table." }, 403);
    const parsed = z.object({ table: z.string().min(1).max(200), key: z.string().min(1).max(200), everyHours: z.number().int().min(1).max(720).nullable().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Name the table and the column that tells its rows apart." }, 400);
    const p = parsed.data;
    const { tables } = await tableFields(found.row.id);
    if (!tables.find((t) => t.table === p.table)?.columns.some((col) => col.name === p.key)) return c.json({ error: "That table or column is not in this workbook." }, 404);
    const [row] = await db.insert(trackedTable).values({ id: newId(), ownerId: user.id, workbookId: found.row.id, tableName: p.table, keyColumn: p.key, everyHours: p.everyHours ?? null }).onConflictDoUpdate({ target: [trackedTable.workbookId, trackedTable.tableName], set: { keyColumn: p.key, everyHours: p.everyHours ?? null } }).returning();
    try {
      const done = await capture(row!);
      return c.json({ id: row!.id, table: p.table, key: p.key, version: done.version, rows: done.rows }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  const tracked = async (userId: string, id: string, write = false) => {
    const [t] = await db.select().from(trackedTable).where(eq(trackedTable.id, id));
    const found = t ? await access(userId, t.workbookId) : null;
    return t && found && (!write || found.role !== "viewer") ? t : null;
  };

  app.post("/api/v1/history/:id/capture", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const t = await tracked(user.id, c.req.param("id"), true);
    if (!t) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await capture(t));
    } catch (e) {
      return fail(c, e);
    }
  });

  /** The captures taken, and with ?a=&b= what changed between two of them, record by record. */
  app.get("/api/v1/history/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const t = await tracked(user.id, c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    try {
      const { versions } = await engineJob<{ versions: { version: number; at: number }[] }>({ job: "delta_history", path: pathOf("history", t.id) });
      const a = c.req.query("a"), b = c.req.query("b");
      const has = (v: string | undefined) => v !== undefined && versions.some((x) => String(x.version) === v);
      if (a === undefined && b === undefined) return c.json({ table: t.tableName, key: t.keyColumn, versions });
      if (!has(a) || !has(b)) return c.json({ error: "Choose two captures that exist." }, 400);
      return c.json({ table: t.tableName, versions, diff: await engineJob({ job: "delta_diff", path: pathOf("history", t.id), key: t.keyColumn, a: Number(a), b: Number(b) }) });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Write a fill-in table's entries out as a Delta table, and register it in Unity Catalog when one is set up. */
  app.post("/api/v1/inputs/:id/export", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [t] = await db.select().from(inputTable).where(eq(inputTable.id, c.req.param("id")));
    const found = t ? await dashboardAccess(user.id, t.dashboardId) : null;
    if (!t || !found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(inputRow).where(eq(inputRow.tableId, t.id));
    const columns = [...(t.keyColumn ? [t.keyColumn] : []), ...t.columns.map((x) => x.name), "entered_by", "entered_at"];
    const data = rows.map((r) => [...(t.keyColumn ? [r.key] : []), ...t.columns.map((x) => r.values[x.name] ?? null), r.updatedBy, r.updatedAt.toISOString()]);
    try {
      const path = pathOf("entries", t.id);
      const done = await engineJob<{ version: number; rows: number }>({ job: "delta_write", path, columns, rows: data });
      await db.update(inputTable).set({ exportedVersion: done.version }).where(eq(inputTable.id, t.id));
      const reg = await registerInUnity(`${found.row.name}_${t.name}`, path, columns);
      record({ userId: user.id, kind: "input.written_out", objectKind: "report", objectId: found.row.id, label: t.name, ownerId: found.row.ownerId, detail: { version: done.version, rows: done.rows, unity: reg.name ?? null } });
      return c.json({ format: "delta", location: path, version: done.version, rows: done.rows, unityTable: reg.name ?? null, unityProblem: reg.problem ?? null });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** What the Unity Catalog server holds: catalogs, schemas and tables. For administrators. */
  app.get("/api/v1/admin/unity", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!isAdmin(user.email)) return c.json({ error: "Only an administrator can see this." }, 403);
    if (!unityOn()) return c.json({ on: false, catalogs: [] });
    const cats = await unity<{ catalogs?: { name: string }[] }>("GET", "/catalogs");
    if (!cats.ok) return c.json({ on: true, error: cats.status ? `Unity Catalog answered ${cats.status}.` : "Unity Catalog could not be reached.", catalogs: [] });
    const out = [];
    for (const cat of (cats.data?.catalogs ?? []).slice(0, 20)) {
      const schemas = await unity<{ schemas?: { name: string }[] }>("GET", `/schemas?catalog_name=${encodeURIComponent(cat.name)}`);
      const list = [];
      for (const s of (schemas.data?.schemas ?? []).slice(0, 30)) {
        const tables = await unity<{ tables?: { name: string; table_type?: string; data_source_format?: string; storage_location?: string }[] }>("GET", `/tables?catalog_name=${encodeURIComponent(cat.name)}&schema_name=${encodeURIComponent(s.name)}`);
        list.push({ name: s.name, tables: (tables.data?.tables ?? []).slice(0, 200).map((t) => ({ name: t.name, type: t.table_type ?? "", format: t.data_source_format ?? "", location: t.storage_location ?? "" })) });
      }
      out.push({ name: cat.name, schemas: list });
    }
    return c.json({ on: true, url: env.unityUrl, catalogs: out });
  });
}
