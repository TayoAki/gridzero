// What the home screen shows for the kind of work a person does: figures against their targets,
// what is waiting on them, decisions lately recorded, and the health of the data they own.

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Hono } from "hono";

import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { connectedTable, dashboard, dashboardShare, dataCheck, widget, workItem, workbook } from "./db/schema.ts";

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/home", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    // Reports the person owns, or was given whole (not limited to rows or columns).
    const owned = await db.select({ id: dashboard.id, name: dashboard.name, minGroup: dashboard.minGroup }).from(dashboard).where(eq(dashboard.ownerId, user.id));
    const shared = await db.select({ id: dashboard.id, name: dashboard.name, minGroup: dashboard.minGroup, role: dashboardShare.role, limits: dashboardShare.limits, hide: dashboardShare.hide }).from(dashboardShare).innerJoin(dashboard, eq(dashboard.id, dashboardShare.dashboardId)).where(eq(dashboardShare.userId, user.id));
    const whole = [...owned, ...shared.filter((s) => !s.limits?.length && !s.hide?.length && (s.role !== "viewer" || s.minGroup <= 1))];
    const names = new Map(whole.map((r) => [r.id, r.name]));
    const cards = whole.length ? await db.select().from(widget).where(and(inArray(widget.dashboardId, [...names.keys()]), sql`${widget.options}->>'target' is not null`)) : [];
    const targets = cards.flatMap((w) => {
      const data = w.data as { kind: string; value?: number; unit?: string | null };
      const o = w.options as { target?: number; targetLow?: boolean };
      if (data.kind !== "number" || typeof data.value !== "number" || typeof o.target !== "number") return [];
      return [{ id: w.id, title: w.title, reportId: w.dashboardId, report: names.get(w.dashboardId) ?? "", value: data.value, unit: data.unit ?? null, target: o.target, met: o.targetLow ? data.value <= o.target : data.value >= o.target, refreshedAt: w.refreshedAt }];
    });
    const mine = await db.select().from(workItem).where(and(eq(workItem.assigneeId, user.id), isNull(workItem.closedAt))).orderBy(desc(workItem.createdAt)).limit(8);
    const today = new Date().toISOString().slice(0, 10);
    const decisions = await db.select().from(workItem).where(and(eq(workItem.kind, "decision"), or(eq(workItem.createdBy, user.id), eq(workItem.assigneeId, user.id)))).orderBy(desc(workItem.createdAt)).limit(5);
    const books = await db.select({ id: workbook.id, title: workbook.title }).from(workbook).where(and(eq(workbook.ownerId, user.id), isNull(workbook.deletedAt)));
    const ids = books.map((b) => b.id);
    const late = ids.length ? await db.select().from(connectedTable).where(and(inArray(connectedTable.workbookId, ids), isNotNull(connectedTable.lateSince))) : [];
    const failing = ids.length ? await db.select().from(dataCheck).where(and(inArray(dataCheck.workbookId, ids), inArray(dataCheck.lastStatus, ["failing", "error"]))) : [];
    const watched = ids.length ? await db.select({ id: connectedTable.id, lastRunAt: connectedTable.lastRunAt }).from(connectedTable).where(inArray(connectedTable.workbookId, ids)) : [];
    const arrived = watched.map((w) => w.lastRunAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    return c.json({
      targets,
      work: mine.map((w) => ({ id: w.id, kind: w.kind, title: w.title, status: w.status, due: w.due, overdue: !!w.due && w.due < today, label: w.label })),
      decisions: decisions.map((d) => ({ id: d.id, title: d.title, label: d.label, at: d.createdAt })),
      data: { late: late.map((t) => ({ name: t.name, workbookId: t.workbookId, note: t.lateNote })), failing: failing.map((k) => ({ name: k.name, workbookId: k.workbookId, rows: k.lastCount })), arrived: arrived ? arrived.toISOString() : null, workbooks: books.length },
    });
  });
}
