// Monitoring. A check is a query over a workbook's tables that returns the rows that are wrong: no rows
// means it passes. A connected table can say how often fresh data is expected. When a check starts
// failing, or a table is late or fails to refresh, the people who own what is built on it are told
// once, an issue is opened, and the reports affected carry a notice until it recovers.

import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { connectedTable, dashboard, dataCheck, user as userTable, widget, workbook } from "./db/schema.ts";
import { readOnlySqlProblem } from "./agents/workbook-tools.ts";
import { EngineError } from "./definitions/engine.ts";
import { TablesError, queryTables } from "./definitions/tables.ts";
import { captureError } from "./errors.ts";
import { access } from "./sharing.ts";
import { postWebhook, webhookProblem } from "./webhook.ts";
import { addEvent, namedOwner, openItem } from "./work.ts";

type Check = typeof dataCheck.$inferSelect;
const MAX_CHECKS = 40;
const engineMessage = (e: EngineError) => e.message.replace(/^\w+Exception: /, "").slice(0, 300);

/** The owners of every report with a card on this workbook, with how many reports there are. */
async function downstream(workbookId: string): Promise<{ owners: string[]; reports: { id: string; name: string }[] }> {
  const cards = await db.select({ dashboardId: widget.dashboardId }).from(widget).where(sql`${widget.source}->>'workbookId' = ${workbookId}`);
  const ids = [...new Set(cards.map((c) => c.dashboardId))];
  const reports = ids.length ? await db.select({ id: dashboard.id, name: dashboard.name, ownerId: dashboard.ownerId }).from(dashboard).where(inArray(dashboard.id, ids)) : [];
  return { owners: [...new Set(reports.map((r) => r.ownerId))], reports: reports.map((r) => ({ id: r.id, name: r.name })) };
}

const publicCheck = (c: Check) => ({ id: c.id, workbookId: c.workbookId, name: c.name, sql: c.sql, definitionId: c.definitionId, everyMinutes: c.everyMinutes, lastRunAt: c.lastRunAt, status: c.lastStatus ?? "not_run", count: c.lastCount, sample: c.lastSample, error: c.lastError, webhook: c.webhook, issueId: c.issueId });

/** Run one check and act on a change of state. */
export async function runCheck(row: Check): Promise<Check> {
  let status: "ok" | "failing" | "error" = "ok";
  let count = 0;
  let sample: Check["lastSample"] = null;
  let error: string | null = null;
  try {
    const out = await queryTables(row.workbookId, row.sql, 20);
    count = out.truncated ? 21 : out.rows.length;
    if (out.rows.length) {
      status = "failing";
      sample = { columns: out.columns, rows: out.rows.slice(0, 20) };
    }
  } catch (e) {
    status = "error";
    error = e instanceof EngineError ? engineMessage(e) : e instanceof TablesError ? e.message : "The check could not be run.";
    if (!(e instanceof EngineError) && !(e instanceof TablesError)) captureError(e, { job: "check", checkId: row.id });
  }
  const was = row.lastStatus;
  let issueId = row.issueId;
  const [book] = await db.select({ title: workbook.title, ownerId: workbook.ownerId }).from(workbook).where(eq(workbook.id, row.workbookId));
  if (status === "failing" && was !== "failing") {
    const down = await downstream(row.workbookId);
    const many = count > 20 ? "more than 20 rows" : `${count} row${count === 1 ? "" : "s"}`;
    const body = `${many} in ${book?.title ?? "the workbook"} break this check.${down.reports.length ? ` ${down.reports.length} report${down.reports.length === 1 ? " is" : "s are"} built on that workbook: ${down.reports.map((r) => r.name).slice(0, 5).join(", ")}.` : ""}`;
    const named = await namedOwner("workbook", row.workbookId);
    const issue = await openItem({ kind: "issue", title: `${row.name} is failing`, body, createdBy: row.ownerId, assigneeId: named ?? book?.ownerId ?? row.ownerId, objectKind: "workbook", objectId: row.workbookId, label: book?.title ?? "", links: row.definitionId ? [{ kind: "definition", id: row.definitionId, label: "the definition it protects" }] : [] });
    issueId = issue.id;
    for (const o of new Set([row.ownerId, named, book?.ownerId, ...down.owners].filter((x): x is string => !!x))) await notify(o, "check", `${row.name} is failing`, body, "/needs-you?tab=work");
    if (row.webhook) await postWebhook(row.webhook, { text: `${row.name} is failing: ${body}` });
    record({ userId: null, kind: "check.failed", objectKind: "workbook", objectId: row.workbookId, label: row.name, ownerId: book?.ownerId ?? row.ownerId, detail: { rows: count } });
  } else if (status === "ok" && was === "failing") {
    if (issueId) await addEvent(issueId, "GridZero", "ran the check again: it passes", { status: "fixed" });
    await notify(row.ownerId, "check", `${row.name} passes again`, "The issue it opened is marked fixed. Someone other than the fixer should verify it.", "/needs-you?tab=work");
    if (row.webhook) await postWebhook(row.webhook, { text: `${row.name} passes again.` });
  }
  const [done] = await db
    .update(dataCheck)
    .set({ lastRunAt: new Date(), lastStatus: status, lastCount: count, lastSample: sample, lastError: error, issueId, nextRunAt: row.everyMinutes ? new Date(Date.now() + row.everyMinutes * 60_000) : null })
    .where(eq(dataCheck.id, row.id))
    .returning();
  return done!;
}

/** Run every check that is due. */
export async function runDueChecks(now = new Date()): Promise<number> {
  const due = await db.transaction(async (tx) => {
    const rows = await tx.select().from(dataCheck).where(and(isNotNull(dataCheck.everyMinutes), lte(dataCheck.nextRunAt, now))).limit(10).for("update", { skipLocked: true });
    // Claimed: another process will not pick the same ones up.
    for (const r of rows) await tx.update(dataCheck).set({ nextRunAt: new Date(now.getTime() + (r.everyMinutes ?? 60) * 60_000) }).where(eq(dataCheck.id, r.id));
    return rows;
  });
  for (const r of due) await runCheck(r).catch((e: unknown) => captureError(e, { job: "check", checkId: r.id }));
  return due.length;
}

/** Tell people once when a watched table goes late or fails, and once when it recovers. */
export async function watchTables(now = new Date()): Promise<number> {
  const rows = await db.select().from(connectedTable).where(isNotNull(connectedTable.expectEveryHours));
  let told = 0;
  for (const t of rows) {
    const last = t.lastRunAt ?? t.createdAt;
    const overdue = now.getTime() - last.getTime() > t.expectEveryHours! * 3_600_000;
    const late = t.lastStatus === "error" || overdue;
    if (late && !t.lateSince) {
      const claimed = await db.update(connectedTable).set({ lateSince: now }).where(and(eq(connectedTable.id, t.id), sql`${connectedTable.lateSince} is null`)).returning({ id: connectedTable.id });
      if (!claimed.length) continue;
      const down = await downstream(t.workbookId);
      const why = t.lastStatus === "error" ? `its last refresh failed${t.lastError ? `: ${t.lastError.slice(0, 200)}` : ""}` : `no fresh data for more than ${t.expectEveryHours} hour${t.expectEveryHours === 1 ? "" : "s"}`;
      const body = `${t.name}: ${why}.${down.reports.length ? ` ${down.reports.length} report${down.reports.length === 1 ? "" : "s"} built on it: ${down.reports.map((r) => r.name).slice(0, 5).join(", ")}.` : ""}`;
      const named = await namedOwner("workbook", t.workbookId);
      for (const o of new Set([t.createdBy, named, ...down.owners].filter((x): x is string => !!x))) await notify(o, "late", `${t.name} is late`, body, `/workbook/${t.workbookId}`);
      record({ userId: null, kind: "table.late", objectKind: "workbook", objectId: t.workbookId, label: t.name, ownerId: t.createdBy, detail: { why } });
      told++;
    } else if (!late && t.lateSince) {
      await db.update(connectedTable).set({ lateSince: null, lateNote: null }).where(eq(connectedTable.id, t.id));
      const down = await downstream(t.workbookId);
      for (const o of new Set([t.createdBy, ...down.owners])) await notify(o, "late", `${t.name} has fresh data again`, "The notice on the reports built on it has been taken down.", `/workbook/${t.workbookId}`);
      record({ userId: null, kind: "table.recovered", objectKind: "workbook", objectId: t.workbookId, label: t.name, ownerId: t.createdBy });
      told++;
    }
  }
  return told;
}

/** What a report should say about the data under it: late tables, failing checks, and when data last arrived. */
export async function reportNotices(boardId: string): Promise<{ notices: { kind: "late" | "check"; text: string; note: string | null }[]; arrived: string | null }> {
  const cards = await db.select({ source: widget.source }).from(widget).where(eq(widget.dashboardId, boardId));
  const books = [...new Set(cards.map((c) => (c.source as { workbookId?: string }).workbookId).filter((x): x is string => !!x))];
  if (!books.length) return { notices: [], arrived: null };
  const tables = await db.select().from(connectedTable).where(inArray(connectedTable.workbookId, books));
  const checks = await db.select().from(dataCheck).where(and(inArray(dataCheck.workbookId, books), eq(dataCheck.lastStatus, "failing")));
  const arrived = tables.map((t) => t.lastRunAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    notices: [
      ...tables.filter((t) => t.lateSince).map((t) => ({ kind: "late" as const, text: t.lastStatus === "error" ? `${t.name} failed to refresh, so figures here may be out of date.` : `${t.name} is late, so figures here may be out of date.`, note: t.lateNote })),
      ...checks.map((c) => ({ kind: "check" as const, text: `A check on the data is failing: ${c.name}.`, note: null })),
    ],
    arrived: arrived ? arrived.toISOString() : null,
  };
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/workbooks/:id/checks", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await access(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(dataCheck).where(eq(dataCheck.workbookId, c.req.param("id"))).orderBy(dataCheck.createdAt);
    return c.json({ checks: rows.map(publicCheck) });
  });

  app.post("/api/v1/workbooks/:id/checks", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot add checks." }, 403);
    const parsed = z
      .object({ name: z.string().trim().min(2).max(120), sql: z.string().trim().min(1).max(5000), everyMinutes: z.number().int().min(5).max(10_080).nullable().optional(), definitionId: z.string().max(64).nullable().optional(), webhook: z.string().trim().max(500).nullable().optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A check needs a name and a query. It can run every 5 minutes at most." }, 400);
    const p = parsed.data;
    const problem = readOnlySqlProblem(p.sql);
    if (problem) return c.json({ error: problem }, 400);
    if (p.webhook) {
      const bad = await webhookProblem(p.webhook);
      if (bad) return c.json({ error: bad }, 400);
    }
    const existing = await db.select({ id: dataCheck.id }).from(dataCheck).where(eq(dataCheck.workbookId, found.row.id));
    if (existing.length >= MAX_CHECKS) return c.json({ error: `A workbook can have ${MAX_CHECKS} checks.` }, 400);
    const [row] = await db.insert(dataCheck).values({ id: newId(), ownerId: user.id, workbookId: found.row.id, name: p.name, sql: p.sql, everyMinutes: p.everyMinutes ?? null, definitionId: p.definitionId ?? null, webhook: p.webhook || null }).returning();
    // Run it once now, so a query that cannot run is known at once.
    const ran = await runCheck(row!);
    return c.json({ check: publicCheck(ran) }, 201);
  });

  const mine = async (userId: string, id: string) => {
    const [row] = await db.select().from(dataCheck).where(eq(dataCheck.id, id));
    if (!row) return null;
    const found = await access(userId, row.workbookId);
    return found && found.role !== "viewer" ? row : null;
  };

  app.post("/api/v1/checks/:id/run", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await mine(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ check: publicCheck(await runCheck(row)) });
  });

  app.delete("/api/v1/checks/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await mine(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    await db.delete(dataCheck).where(eq(dataCheck.id, row.id));
    return c.body(null, 204);
  });

  /** Say how often a connected table should bring fresh data, or what is being done while it is late. */
  app.put("/api/v1/connected-tables/:id/watch", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(connectedTable).where(eq(connectedTable.id, c.req.param("id")));
    const found = row ? await access(user.id, row.workbookId) : null;
    if (!row || !found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot change this." }, 403);
    const parsed = z.object({ expectEveryHours: z.number().int().min(1).max(720).nullable().optional(), note: z.string().trim().max(300).nullable().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Hours must be a whole number from 1 to 720." }, 400);
    const set: Partial<typeof connectedTable.$inferInsert> = {};
    if (parsed.data.expectEveryHours !== undefined) set.expectEveryHours = parsed.data.expectEveryHours;
    if (parsed.data.note !== undefined) {
      const [who] = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, user.id));
      set.lateNote = parsed.data.note ? `${who?.name || "Someone"}: ${parsed.data.note}` : null;
    }
    if (parsed.data.expectEveryHours === null) Object.assign(set, { lateSince: null, lateNote: null });
    const [done] = await db.update(connectedTable).set(set).where(eq(connectedTable.id, row.id)).returning();
    return c.json({ expectEveryHours: done!.expectEveryHours, late: !!done!.lateSince, note: done!.lateNote });
  });
}
