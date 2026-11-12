// For people who analyse and model: named events with every earlier wording kept, notebooks of SQL and
// words over a workbook, experiment runs tied to the version of the data they used, a model's score
// against where it started with a way back to the version before, and one map of a workbook from its
// sources to the reports built on it.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { readOnlySqlProblem } from "./agents/workbook-tools.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { connectedTable, connection, dashboard, definition, experimentRun, modelAsset, notebook, source, term, trackedTable, widget } from "./db/schema.ts";
import { EngineError } from "./definitions/engine.ts";
import { TablesError, queryTables, tableFields } from "./definitions/tables.ts";
import { access } from "./sharing.ts";
import { downstreamOwners } from "./usedby.ts";

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i");
const queryError = (e: unknown) => (e instanceof TablesError ? e.message : e instanceof EngineError ? e.message.replace(/^\w+Exception: /, "").slice(0, 300) : null);

/** How many rows a wording of an event picks out, or why it cannot be run. */
async function countOf(workbookId: string, table: string, condition: string): Promise<{ rows?: number; problem?: string }> {
  const statement = `SELECT COUNT(*) FROM ${q(table)} WHERE ${condition}`;
  const bad = readOnlySqlProblem(statement);
  if (bad || /;|--|\/\*/.test(condition)) return { problem: bad ?? "Write only the condition: what goes after WHERE." };
  try {
    return { rows: Number((await queryTables(workbookId, statement, 1)).rows[0]?.[0] ?? 0) };
  } catch (e) {
    const why = queryError(e);
    if (why) return { problem: why };
    throw e;
  }
}

type Model = typeof modelAsset.$inferSelect;
/** Score a model's predictions against what happened: the share that match, or the average error when both are numbers. */
async function score(m: Model): Promise<{ kind: "accuracy" | "error"; score: number; rows: number } | { problem: string }> {
  if (!m.monitor) return { problem: "Say which columns hold the prediction and what happened." };
  const p = q(m.monitor.predicted), a = q(m.monitor.actual), t = q(m.tableName);
  try {
    const kinds = (await tableFields(m.workbookId)).tables.find((x) => x.table === m.tableName)?.columns ?? [];
    const numeric = [m.monitor.predicted, m.monitor.actual].every((c) => kinds.find((k) => k.name === c)?.kind === "number");
    const out = await queryTables(m.workbookId, numeric ? `SELECT COUNT(*), AVG(ABS(${p} - ${a})) FROM ${t} WHERE ${p} IS NOT NULL AND ${a} IS NOT NULL` : `SELECT COUNT(*), AVG(CASE WHEN CAST(${p} AS VARCHAR) = CAST(${a} AS VARCHAR) THEN 1.0 ELSE 0.0 END) FROM ${t} WHERE ${p} IS NOT NULL AND ${a} IS NOT NULL`, 1);
    const rows = Number(out.rows[0]?.[0] ?? 0);
    if (!rows) return { problem: "No row has both a prediction and what happened yet." };
    return { kind: numeric ? "error" : "accuracy", score: Math.round(Number(out.rows[0]![1]) * 10_000) / 10_000, rows };
  } catch (e) {
    const why = queryError(e);
    if (why) return { problem: why };
    throw e;
  }
}

export function routes(app: Hono<{ Variables: Vars }>) {
  const book = async (c: { get: (k: "user") => Vars["user"]; req: { param: (k: string) => string } }, write = false) => {
    const user = c.get("user");
    if (!user) return null;
    const found = await access(user.id, c.req.param("id"));
    return found && (!write || found.role !== "viewer") ? { user, found } : null;
  };

  // --- events and other named things, with their versions -----------------------

  app.get("/api/v1/workbooks/:id/terms", async (c) => {
    const hit = await book(c);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const rows = await db.select().from(term).where(eq(term.workbookId, hit.found.row.id)).orderBy(term.name);
    return c.json({ terms: rows.map((t) => ({ id: t.id, kind: t.kind, name: t.name, meaning: t.meaning, table: t.tableName, condition: t.condition, version: t.version, history: t.history, updatedAt: t.updatedAt })) });
  });

  /** Define a new one, or reword an existing one. A rewording is a new version; the old wording is kept. */
  app.put("/api/v1/workbooks/:id/terms", async (c) => {
    const hit = await book(c, true);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const parsed = z.object({ name: z.string().trim().min(2).max(80), meaning: z.string().trim().max(500).optional(), table: z.string().min(1).max(200), condition: z.string().trim().min(1).max(1000), kind: z.enum(["event", "segment", "status"]).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Give a name, the table, and the condition that picks out its rows." }, 400);
    const p = parsed.data;
    const counted = await countOf(hit.found.row.id, p.table, p.condition);
    if (counted.problem) return c.json({ error: counted.problem }, 400);
    const [old] = await db.select().from(term).where(and(eq(term.workbookId, hit.found.row.id), eq(term.name, p.name)));
    const who = hit.user.name || hit.user.email;
    if (!old) {
      const [row] = await db.insert(term).values({ id: newId(), workbookId: hit.found.row.id, kind: p.kind ?? "event", name: p.name, meaning: p.meaning ?? "", tableName: p.table, condition: p.condition, updatedBy: who }).returning();
      return c.json({ term: { id: row!.id, name: row!.name, version: 1, rows: counted.rows } }, 201);
    }
    if (old.condition === p.condition && old.tableName === p.table && old.meaning === (p.meaning ?? old.meaning)) return c.json({ term: { id: old.id, name: old.name, version: old.version, rows: counted.rows } });
    const before = await countOf(hit.found.row.id, old.tableName, old.condition);
    const [row] = await db.update(term).set({ meaning: p.meaning ?? old.meaning, tableName: p.table, condition: p.condition, version: old.version + 1, history: [...old.history, { version: old.version, meaning: old.meaning, condition: old.condition, at: old.updatedAt.toISOString(), by: old.updatedBy }].slice(-50), updatedBy: who, updatedAt: new Date() }).where(eq(term.id, old.id)).returning();
    record({ userId: hit.user.id, kind: "term.reworded", objectKind: "workbook", objectId: hit.found.row.id, label: p.name, ownerId: hit.found.row.ownerId, detail: { version: row!.version, rowsBefore: before.rows ?? null, rowsAfter: counted.rows } });
    return c.json({ term: { id: row!.id, name: row!.name, version: row!.version, rows: counted.rows, rowsBefore: before.rows ?? null } });
  });

  // --- notebooks ----------------------------------------------------------------

  const cells = z.array(z.object({ id: z.string().min(1).max(40), kind: z.enum(["sql", "note"]), text: z.string().max(20_000) }).strict()).max(100);

  app.get("/api/v1/workbooks/:id/notebooks", async (c) => {
    const hit = await book(c);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const rows = await db.select().from(notebook).where(eq(notebook.workbookId, hit.found.row.id)).orderBy(desc(notebook.updatedAt));
    return c.json({ notebooks: rows.map((n) => ({ id: n.id, title: n.title, cells: n.cells, mine: n.ownerId === hit.user.id, updatedAt: n.updatedAt })) });
  });

  app.post("/api/v1/workbooks/:id/notebooks", async (c) => {
    const hit = await book(c);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const parsed = z.object({ title: z.string().trim().min(1).max(120), cells: cells.optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A notebook needs a title." }, 400);
    const have = await db.select({ id: notebook.id }).from(notebook).where(and(eq(notebook.workbookId, hit.found.row.id), eq(notebook.ownerId, hit.user.id)));
    if (have.length >= 50) return c.json({ error: "You can keep 50 notebooks on a workbook." }, 400);
    const [row] = await db.insert(notebook).values({ id: newId(), ownerId: hit.user.id, workbookId: hit.found.row.id, title: parsed.data.title, cells: parsed.data.cells ?? [] }).returning();
    return c.json({ notebook: { id: row!.id, title: row!.title, cells: row!.cells, mine: true } }, 201);
  });

  /** Save a notebook. Only whoever made it changes it; anyone who can open the workbook can read and run it. */
  app.put("/api/v1/notebooks/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ title: z.string().trim().min(1).max(120).optional(), cells: cells.optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A notebook holds up to 100 cells." }, 400);
    const [row] = await db.update(notebook).set({ ...(parsed.data.title ? { title: parsed.data.title } : {}), ...(parsed.data.cells ? { cells: parsed.data.cells } : {}), updatedAt: new Date() }).where(and(eq(notebook.id, c.req.param("id")), eq(notebook.ownerId, user.id))).returning();
    return row ? c.json({ notebook: { id: row.id, title: row.title, cells: row.cells, mine: true } }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/api/v1/notebooks/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const gone = await db.delete(notebook).where(and(eq(notebook.id, c.req.param("id")), eq(notebook.ownerId, user.id))).returning({ id: notebook.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  // --- experiment runs ----------------------------------------------------------

  app.get("/api/v1/workbooks/:id/experiments", async (c) => {
    const hit = await book(c);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const rows = await db.select().from(experimentRun).where(eq(experimentRun.workbookId, hit.found.row.id)).orderBy(desc(experimentRun.createdAt)).limit(200);
    const tracked = await db.select({ id: trackedTable.id, table: trackedTable.tableName }).from(trackedTable).where(eq(trackedTable.workbookId, hit.found.row.id));
    const tableOf = new Map(tracked.map((t) => [t.id, t.table]));
    return c.json({ runs: rows.map((r) => ({ id: r.id, name: r.name, data: r.trackedId ? { table: tableOf.get(r.trackedId) ?? "a table no longer tracked", version: r.dataVersion } : null, params: r.params, metrics: r.metrics, notes: r.notes, at: r.createdAt })) });
  });

  /** Record a run. A personal token may do this, so a notebook or a script elsewhere can log its own results. */
  app.post("/api/v1/workbooks/:id/experiments", async (c) => {
    const hit = await book(c);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
    const parsed = z.object({ name: z.string().trim().min(1).max(120), table: z.string().max(200).optional(), dataVersion: z.number().int().min(0).optional(), params: z.record(z.string().max(60), scalar).optional(), metrics: z.record(z.string().max(60), z.number().finite()).optional(), notes: z.string().trim().max(2000).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A run needs a name; metrics are numbers by name." }, 400);
    const p = parsed.data;
    let trackedId: string | null = null, dataVersion: number | null = null;
    if (p.table) {
      const [t] = await db.select().from(trackedTable).where(and(eq(trackedTable.workbookId, hit.found.row.id), eq(trackedTable.tableName, p.table)));
      if (!t || t.lastVersion === null) return c.json({ error: `${p.table} is not tracked, so there is no version of it to tie the run to. Track it first.` }, 400);
      if (p.dataVersion !== undefined && p.dataVersion > t.lastVersion) return c.json({ error: `${p.table} has no capture ${p.dataVersion}; the latest is ${t.lastVersion}.` }, 400);
      trackedId = t.id;
      dataVersion = p.dataVersion ?? t.lastVersion;
    }
    const [row] = await db.insert(experimentRun).values({ id: newId(), ownerId: hit.user.id, workbookId: hit.found.row.id, name: p.name, trackedId, dataVersion, params: p.params ?? {}, metrics: p.metrics ?? {}, notes: p.notes ?? "" }).returning();
    return c.json({ run: { id: row!.id, name: row!.name, data: p.table ? { table: p.table, version: dataVersion } : null, metrics: row!.metrics } }, 201);
  });

  // --- a model's score, and the way back ----------------------------------------

  const ownModel = async (userId: string, id: string) => (await db.select().from(modelAsset).where(and(eq(modelAsset.id, id), eq(modelAsset.ownerId, userId))))[0] ?? null;
  const judge = (m: Model, now: { kind: "accuracy" | "error"; score: number; rows: number }) => {
    const base = m.baseline;
    if (!base || base.kind !== now.kind) return false;
    const tol = m.monitor?.tolerance ?? 0.05;
    // Accuracy falls by more than the tolerance; or the average error grows by more than that share of where it started.
    return now.kind === "accuracy" ? base.score - now.score > tol : now.score - base.score > Math.abs(base.score) * tol;
  };

  /** Say how the model is scored. The score now becomes the one later scores are held against. */
  app.put("/api/v1/models/:id/monitor", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const m = await ownModel(user.id, c.req.param("id"));
    if (!m) return c.json({ error: "not found" }, 404);
    const parsed = z.object({ predicted: z.string().min(1).max(200), actual: z.string().min(1).max(200), tolerance: z.number().min(0.001).max(1).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Name the column with the prediction and the column with what happened." }, 400);
    const next = { ...m, monitor: { predicted: parsed.data.predicted, actual: parsed.data.actual, tolerance: parsed.data.tolerance ?? 0.05 } };
    const now = await score(next);
    if ("problem" in now) return c.json({ error: now.problem }, 400);
    const stamp = { ...now, at: new Date().toISOString() };
    await db.update(modelAsset).set({ monitor: next.monitor, baseline: stamp, health: { ...stamp, degraded: false } }).where(eq(modelAsset.id, m.id));
    return c.json({ baseline: stamp });
  });

  /** Score it again against where it started. If it has fallen too far, the owner and the owners downstream are told once. */
  app.post("/api/v1/models/:id/health", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const m = await ownModel(user.id, c.req.param("id"));
    if (!m) return c.json({ error: "not found" }, 404);
    const now = await score(m);
    if ("problem" in now) return c.json({ error: now.problem }, 400);
    const degraded = judge(m, now);
    const health = { ...now, at: new Date().toISOString(), degraded };
    // The first score of a version is what later scores are held against.
    await db.update(modelAsset).set({ health, ...(m.baseline ? {} : { baseline: { ...now, at: health.at } }) }).where(eq(modelAsset.id, m.id));
    if (degraded && !m.health?.degraded) {
      const down = await downstreamOwners(user.id, "table", `${m.workbookId}:${m.tableName}`);
      const what = now.kind === "accuracy" ? `It is right ${Math.round(now.score * 1000) / 10}% of the time, down from ${Math.round(m.baseline!.score * 1000) / 10}%.` : `Its average error is ${now.score}, up from ${m.baseline!.score}.`;
      for (const o of new Set([m.ownerId, ...(down?.owners ?? [])])) await notify(o, "model", `${m.name} version ${m.version} has got worse`, `${what} ${down?.found.cards.length ?? 0} cards read its predictions.`, null);
      record({ userId: user.id, kind: "model.degraded", objectKind: "workbook", objectId: m.workbookId, label: `${m.name} ${m.version}`, ownerId: m.ownerId, detail: { score: now.score, baseline: m.baseline!.score } });
    }
    return c.json({ health, baseline: m.baseline, drift: m.baseline ? Math.round((now.score - m.baseline.score) * 10_000) / 10_000 : null });
  });

  /** Go back to the version before. The owners of the reports that read it are told. */
  app.post("/api/v1/models/:id/rollback", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const m = await ownModel(user.id, c.req.param("id"));
    if (!m) return c.json({ error: "not found" }, 404);
    const last = m.history.at(-1);
    if (!last) return c.json({ error: "There is no earlier version to go back to." }, 400);
    await db.update(modelAsset).set({ version: last.version, notes: last.notes, history: [...m.history.slice(0, -1)], updatedAt: new Date(), health: null }).where(eq(modelAsset.id, m.id));
    const down = await downstreamOwners(user.id, "table", `${m.workbookId}:${m.tableName}`);
    const others = (down?.owners ?? []).filter((o) => o !== user.id);
    for (const o of others) await notify(o, "model", `${m.name} is back on version ${last.version}`, `Version ${m.version} was withdrawn. The predictions in ${m.tableName} are whatever the model's owner loads next; this app does not run the model.`, null);
    record({ userId: user.id, kind: "model.rolled_back", objectKind: "workbook", objectId: m.workbookId, label: `${m.name} ${last.version}`, ownerId: m.ownerId, detail: { from: m.version, told: others.length } });
    return c.json({ version: last.version, withdrawn: m.version, told: others.length });
  });

  // --- the map ------------------------------------------------------------------

  /** One workbook from end to end: where its tables come from, the definitions and cards built on each, and the reports those are on. */
  app.get("/api/v1/workbooks/:id/map", async (c) => {
    const hit = await book(c);
    if (!hit) return c.json({ error: c.get("user") ? "not found" : "unauthenticated" }, c.get("user") ? 404 : 401);
    const id = hit.found.row.id;
    const { tables } = await tableFields(id);
    const connected = await db.select({ name: connectedTable.name, conn: connection.name, kind: connection.kind }).from(connectedTable).innerJoin(connection, eq(connection.id, connectedTable.connectionId)).where(eq(connectedTable.workbookId, id));
    const sources = await db.select().from(source).where(and(eq(source.kind, "workbook"), sql`${source.config}->>'workbookId' = ${id}`));
    const defs = sources.length ? await db.select().from(definition).where(inArray(definition.sourceId, sources.map((s) => s.id))) : [];
    const cards = await db.select().from(widget).where(sql`${widget.source}->>'workbookId' = ${id}`);
    const byDef = defs.length ? await db.select().from(widget).where(inArray(sql`${widget.source}->>'definitionId'`, defs.map((d) => d.id))) : [];
    const allCards = [...new Map([...cards, ...byDef].map((w) => [w.id, w])).values()];
    const reports = allCards.length ? await db.select({ id: dashboard.id, name: dashboard.name }).from(dashboard).where(inArray(dashboard.id, [...new Set(allCards.map((w) => w.dashboardId))])) : [];
    const models = await db.select().from(modelAsset).where(eq(modelAsset.workbookId, id));
    const nodes: { id: string; kind: string; label: string; note?: string }[] = [];
    const edges: { from: string; to: string }[] = [];
    const origin = new Map<string, string>();
    for (const t of connected) origin.set(t.name.toLowerCase(), `${t.conn} (${t.kind})`);
    for (const o of new Set(origin.values())) nodes.push({ id: `o:${o}`, kind: "origin", label: o });
    if (tables.some((t) => !origin.has(t.table.toLowerCase()))) nodes.push({ id: "o:upload", kind: "origin", label: "Uploaded or typed in" });
    for (const t of tables) {
      nodes.push({ id: `t:${t.table}`, kind: "table", label: t.table, note: `${t.columns.length} columns` });
      edges.push({ from: origin.has(t.table.toLowerCase()) ? `o:${origin.get(t.table.toLowerCase())}` : "o:upload", to: `t:${t.table}` });
    }
    for (const m of models) {
      nodes.push({ id: `m:${m.id}`, kind: "model", label: `${m.name} v${m.version}` });
      edges.push({ from: `m:${m.id}`, to: `t:${m.tableName}` });
    }
    for (const d of defs) {
      const text = JSON.stringify(d.body);
      const uses = tables.filter((t) => word(t.table).test(text));
      if (!uses.length) continue;
      nodes.push({ id: `d:${d.id}`, kind: "definition", label: d.label, note: d.status.replace("_", " ") });
      for (const t of uses) edges.push({ from: `t:${t.table}`, to: `d:${d.id}` });
    }
    for (const w of allCards) {
      const s = w.source as { sql?: string; definitionId?: string };
      nodes.push({ id: `c:${w.id}`, kind: "card", label: w.title });
      for (const t of tables) if (s.sql && word(t.table).test(s.sql)) edges.push({ from: `t:${t.table}`, to: `c:${w.id}` });
      if (s.definitionId && nodes.some((n) => n.id === `d:${s.definitionId}`)) edges.push({ from: `d:${s.definitionId}`, to: `c:${w.id}` });
      edges.push({ from: `c:${w.id}`, to: `r:${w.dashboardId}` });
    }
    for (const r of reports) nodes.push({ id: `r:${r.id}`, kind: "report", label: r.name });
    return c.json({ workbook: hit.found.row.title, generatedAt: new Date().toISOString(), nodes, edges, counts: { tables: tables.length, definitions: nodes.filter((n) => n.kind === "definition").length, cards: allCards.length, reports: reports.length } });
  });
}
