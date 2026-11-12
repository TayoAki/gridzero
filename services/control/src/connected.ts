// Connections and connected tables (BUILD-SPEC §11 M6).

import { forgetStaged } from "./definitions/tables.ts";
import { record } from "./activity.ts";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq, isNotNull, isNull, lte, desc } from "drizzle-orm";
import type { Hono } from "hono";
import { sign } from "hono/jwt";

import type { Vars } from "./app.ts";
import { decryptSecret, encryptSecret, KINDS, NEEDS_USER, runQuery, secretsConfigured, testConnection } from "./connectors.ts";
import type { Config, Kind } from "./connectors.ts";
import { db } from "./db/client.ts";
import { auditEvent, connectedTable, connection, workbook } from "./db/schema.ts";
import { env } from "./env.ts";
import { access, audit } from "./sharing.ts";

const newId = () => randomBytes(12).toString("hex");
const MAX_SQL = 100_000;
const MAX_NAME = 100;

// --- cron --------------------------------------------------------------------

function field(text: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let [a, b] = [min, max];
    if (m[1] !== "*") {
      const [x, y] = m[1]!.split("-").map(Number);
      a = x!;
      b = y ?? (m[2] ? max : x!);
    }
    if (a < min || b > max || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** The first minute after `from` matching a 5-field cron expression (UTC), or null. */
export function nextRun(cron: string, from: Date): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = [field(parts[0]!, 0, 59), field(parts[1]!, 0, 23), field(parts[2]!, 1, 31), field(parts[3]!, 1, 12), field(parts[4]!, 0, 7)];
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0);
  // Standard cron: when both day fields are restricted, either one matching is enough.
  const anyDom = parts[2] === "*";
  const anyDow = parts[4] === "*";
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    const dayOk = anyDom || anyDow ? dom.has(t.getUTCDate()) && dow.has(t.getUTCDay()) : dom.has(t.getUTCDate()) || dow.has(t.getUTCDay());
    if (minute.has(t.getUTCMinutes()) && hour.has(t.getUTCHours()) && month.has(t.getUTCMonth() + 1) && dayOk) return new Date(t);
  }
  return null;
}

// --- refresh -----------------------------------------------------------------

/** Why a web connected table's address cannot be used, or null. The workbook host checks where it leads. */
export function webAddressProblem(address: string): string | null {
  if (address.length > 2000) return "The address is longer than 2,000 characters.";
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "Enter the full web address of a file, starting with https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Enter the full web address of a file, starting with https://";
  if (url.username || url.password) return "Leave the user name and password out of the address.";
  return null;
}

type Row = typeof connectedTable.$inferSelect;

async function hostToken(id: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 1800;
  return sign({ wb: id, sub: "control", role: "owner", admin: true, exp }, env.wbTokenSecret, "HS256");
}

const running = new Set<string>();

/** Run a connected table's query and put the result in its Data Table. */
export async function refresh(row: Row): Promise<{ rows: number; table: string | null }> {
  if (running.has(row.id)) throw new Error("This table is already refreshing");
  running.add(row.id);
  const started = new Date();
  try {
    const [conn] = await db.select().from(connection).where(eq(connection.id, row.connectionId));
    if (!conn) throw new Error("The connection no longer exists");
    const base = env.wbhostUrl.replace(/^ws/, "http") + `/wb/${row.workbookId}`;
    const token = encodeURIComponent(await hostToken(row.workbookId));
    const importId = `ct${randomBytes(8).toString("hex")}`;
    if (conn.kind === "web") {
      // The workbook host downloads the file itself: it refuses addresses inside our own network.
      const problem = webAddressProblem(row.sql);
      if (problem) throw new Error(problem);
      const res = await fetch(`${base}/import_url?token=${token}&import_id=${importId}&url=${encodeURIComponent(row.sql)}`, { method: "POST" });
      if (!res.ok) throw new Error((await res.text()) || `The file could not be downloaded (${res.status})`);
    } else {
      await runQuery(conn.kind as Kind, conn.config as Config, decryptSecret(conn.secret), row.sql, async (csv) => {
        const res = await fetch(`${base}/import?token=${token}&import_id=${importId}&name=query.csv`, {
          method: "POST",
          body: Readable.toWeb(Readable.from(csv)) as unknown as BodyInit,
          duplex: "half",
        } as RequestInit);
        if (!res.ok) throw new Error((await res.text()) || `The upload failed (${res.status})`);
      });
    }
    const finish = (dest: unknown) =>
      fetch(`${base}/apply?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "FinalizeImport", import_id: importId, options: { header: true, separator: ",", quote: null, skip_rows: 0 }, dest, mode: "Table", name: row.name }),
      });
    let res = await finish(row.tableId ? { type: "Table", table: row.tableId } : { type: "NewSheet" });
    // The table was deleted from the sheet: bring it back on a new one.
    if (res.status === 404) res = await finish({ type: "NewSheet" });
    if (!res.ok) throw new Error((await res.text()) || `The import failed (${res.status})`);
    const done = (await res.json()) as { rows: number; table: string | null };
    await db
      .update(connectedTable)
      .set({ tableId: done.table, lastRunAt: started, lastStatus: "ok", lastError: null, rowCount: Math.max(0, done.rows - 1) })
      .where(eq(connectedTable.id, row.id));
    // The same number of rows can hold different values: queries must not reuse the copy from before.
    forgetStaged(row.workbookId);
    await audit(row.workbookId, row.createdBy, "connected_table.refresh", { id: row.id, rows: done.rows - 1 });
    record({ userId: row.createdBy, kind: "connection.used", objectKind: "connection", objectId: row.connectionId, label: row.name, ownerId: conn.ownerId, detail: { table: row.id, rows: done.rows - 1 }, ms: Date.now() - started.getTime() });
    return { rows: done.rows - 1, table: done.table };
  } catch (e) {
    const message = (e as Error).message.slice(0, 2000);
    await db.update(connectedTable).set({ lastRunAt: started, lastStatus: "error", lastError: message }).where(eq(connectedTable.id, row.id));
    await audit(row.workbookId, row.createdBy, "connected_table.refresh_failed", { id: row.id, error: message });
    record({ userId: row.createdBy, kind: "connection.failed", objectKind: "connection", objectId: row.connectionId, label: row.name, ownerId: row.createdBy, detail: { table: row.id, error: message.slice(0, 300) } });
    throw e;
  } finally {
    running.delete(row.id);
  }
}

/** Start every scheduled refresh that is due. */
export async function runDue(now = new Date()): Promise<number> {
  const due = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ row: connectedTable })
      .from(connectedTable)
      .innerJoin(workbook, eq(workbook.id, connectedTable.workbookId))
      .where(and(isNotNull(connectedTable.schedule), lte(connectedTable.nextRunAt, now), isNull(workbook.deletedAt)))
      .for("update", { of: connectedTable, skipLocked: true });
    for (const { row } of rows) {
      await tx.update(connectedTable).set({ nextRunAt: nextRun(row.schedule!, now) }).where(eq(connectedTable.id, row.id));
    }
    return rows.map((r) => r.row);
  });
  // Errors are recorded on the row by refresh().
  for (const row of due) void refresh(row).catch(() => {});
  return due.length;
}

// --- routes ------------------------------------------------------------------

const publicConnection = (c: typeof connection.$inferSelect) => ({ id: c.id, kind: c.kind, name: c.name, config: c.config, createdAt: c.createdAt });

function parseConnection(body: Record<string, unknown>): { kind: Kind; name: string; config: Config; secret: string } | string {
  const kind = body.kind as Kind;
  if (!KINDS.includes(kind)) return `kind must be one of ${KINDS.join(", ")}`;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME) return `the name must be 1-${MAX_NAME} characters`;
  const raw = (body.config ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string).trim() : undefined);
  // A web connection holds nothing: no host, no user, no password. Each table carries its own address.
  if (kind === "web") return { kind, name, secret: "none", config: {} };
  const user = text("user");
  if (!user && NEEDS_USER.includes(kind)) return "a user is required";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!secret) return kind === "databricks" ? "an access token is required" : kind === "bigquery" ? "a service account key is required" : "a password or key is required";
  const ssl = text("ssl");
  if (ssl && !["verify", "require", "disable"].includes(ssl)) return "ssl must be verify, require or disable";
  const auth = text("auth");
  if (auth && !["password", "key_pair"].includes(auth)) return "auth must be password or key_pair";
  const port = raw.port === undefined || raw.port === "" ? undefined : Number(raw.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return "the port is not valid";
  return {
    kind,
    name,
    secret,
    config: { user, host: text("host"), port, database: text("database"), ssl: ssl as Config["ssl"], account: text("account"), warehouse: text("warehouse"), schema: text("schema"), role: text("role"), auth: auth as Config["auth"], project: text("project"), location: text("location") },
  };
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/connections", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select().from(connection).where(eq(connection.ownerId, user.id));
    return c.json({ connections: rows.map(publicConnection) });
  });

  app.post("/api/v1/connections/test", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = parseConnection(await c.req.json().catch(() => ({})));
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);
    try {
      await testConnection(parsed.kind, parsed.config, parsed.secret);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/v1/connections", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!secretsConfigured()) return c.json({ error: "Connections are not set up on this server" }, 503);
    const parsed = parseConnection(await c.req.json().catch(() => ({})));
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);
    const [row] = await db.insert(connection).values({ id: newId(), ownerId: user.id, kind: parsed.kind, name: parsed.name, config: parsed.config, secret: encryptSecret(parsed.secret) }).returning();
    await audit("", user.id, "connection.create", { id: row!.id, kind: parsed.kind, name: parsed.name });
    return c.json(publicConnection(row!), 201);
  });

  app.delete("/api/v1/connections/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [gone] = await db
      .delete(connection)
      .where(and(eq(connection.id, c.req.param("id")), eq(connection.ownerId, user.id)))
      .returning();
    if (!gone) return c.json({ error: "not found" }, 404);
    await audit("", user.id, "connection.delete", { id: gone.id, name: gone.name });
    return c.body(null, 204);
  });

  /** A saved connection's own test: uses the stored secret. */
  app.post("/api/v1/connections/:id/test", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db
      .select()
      .from(connection)
      .where(and(eq(connection.id, c.req.param("id")), eq(connection.ownerId, user.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    await audit("", user.id, "connection.test", { id: row.id });
    try {
      await testConnection(row.kind as Kind, row.config as Config, decryptSecret(row.secret));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message });
    }
  });

  const editable = async (userId: string, id: string) => {
    const found = await access(userId, id);
    return found && found.role !== "viewer" ? found : null;
  };

  app.get("/api/v1/workbooks/:id/connected-tables", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(connectedTable).where(eq(connectedTable.workbookId, found.row.id));
    return c.json({ tables: rows });
  });

  app.post("/api/v1/workbooks/:id/connected-tables", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await editable(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    const schedule = typeof body.schedule === "string" && body.schedule.trim() ? body.schedule.trim() : null;
    if (!name || name.length > MAX_NAME) return c.json({ error: `the name must be 1-${MAX_NAME} characters` }, 400);
    if (!sql || sql.length > MAX_SQL) return c.json({ error: "enter a query" }, 400);
    const nextRunAt = schedule ? nextRun(schedule, new Date()) : null;
    if (schedule && !nextRunAt) return c.json({ error: "the schedule is not a valid cron expression" }, 400);
    // Only the connection's owner can point a workbook at it.
    const [conn] = await db
      .select({ id: connection.id, kind: connection.kind })
      .from(connection)
      .where(and(eq(connection.id, String(body.connectionId)), eq(connection.ownerId, user.id)));
    if (!conn) return c.json({ error: "no such connection" }, 400);
    // For a web connection the "query" is the file's address.
    const bad = conn.kind === "web" ? webAddressProblem(sql) : null;
    if (bad) return c.json({ error: bad }, 400);
    const [row] = await db.insert(connectedTable).values({ id: newId(), workbookId: found.row.id, connectionId: conn.id, name, sql, schedule, nextRunAt, createdBy: user.id }).returning();
    await audit(found.row.id, user.id, "connected_table.create", { id: row!.id, connection: conn.id });
    try {
      const result = await refresh(row!);
      return c.json({ id: row!.id, ...result }, 201);
    } catch (e) {
      return c.json({ id: row!.id, error: (e as Error).message }, 201);
    }
  });

  const owned = async (workbookId: string, id: string) => {
    const [row] = await db
      .select()
      .from(connectedTable)
      .where(and(eq(connectedTable.id, id), eq(connectedTable.workbookId, workbookId)));
    return row ?? null;
  };

  app.post("/api/v1/workbooks/:id/connected-tables/:ct/refresh", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await editable(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const row = await owned(found.row.id, c.req.param("ct"));
    if (!row) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await refresh(row));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.patch("/api/v1/workbooks/:id/connected-tables/:ct", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await editable(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const row = await owned(found.row.id, c.req.param("ct"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const set: Partial<typeof connectedTable.$inferInsert> = {};
    if (typeof body.sql === "string" && body.sql.trim() && body.sql.length <= MAX_SQL) set.sql = body.sql.trim();
    if ("schedule" in body) {
      const schedule = typeof body.schedule === "string" && body.schedule.trim() ? body.schedule.trim() : null;
      const next = schedule ? nextRun(schedule, new Date()) : null;
      if (schedule && !next) return c.json({ error: "the schedule is not a valid cron expression" }, 400);
      set.schedule = schedule;
      set.nextRunAt = next;
    }
    if (Object.keys(set).length > 0) await db.update(connectedTable).set(set).where(eq(connectedTable.id, row.id));
    await audit(found.row.id, user.id, "connected_table.update", { id: row.id });
    return c.json({ id: row.id });
  });

  app.delete("/api/v1/workbooks/:id/connected-tables/:ct", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await editable(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const row = await owned(found.row.id, c.req.param("ct"));
    if (!row) return c.json({ error: "not found" }, 404);
    await db.delete(connectedTable).where(eq(connectedTable.id, row.id));
    await audit(found.row.id, user.id, "connected_table.delete", { id: row.id });
    return c.body(null, 204);
  });

  app.get("/api/v1/workbooks/:id/audit", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role !== "owner") return c.json({ error: "only the owner can see the audit log" }, 403);
    const rows = await db.select().from(auditEvent).where(eq(auditEvent.workbookId, found.row.id)).orderBy(desc(auditEvent.at)).limit(500);
    return c.json({ events: rows });
  });
}
