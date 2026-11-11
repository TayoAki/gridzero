// Who may see or change a report: its owner, or someone it was shared with who accepted.
// A card's query always runs with the owner's access to the data, never the viewer's, so sharing a
// report shares what is on it and nothing else.

import { and, eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { dashboard, dashboardShare, widget } from "../db/schema.ts";

export type ReportRole = "owner" | "editor" | "viewer";
export type DashboardRow = typeof dashboard.$inferSelect;
export type WidgetRow = typeof widget.$inferSelect;

export async function dashboardAccess(userId: string, id: string): Promise<{ row: DashboardRow; role: ReportRole } | null> {
  const [row] = await db.select().from(dashboard).where(eq(dashboard.id, id));
  if (!row) return null;
  if (row.ownerId === userId) return { row, role: "owner" };
  const [share] = await db
    .select({ role: dashboardShare.role })
    .from(dashboardShare)
    .where(and(eq(dashboardShare.dashboardId, id), eq(dashboardShare.userId, userId)));
  return share ? { row, role: share.role } : null;
}

export const canEdit = (role: ReportRole) => role !== "viewer";

export async function widgetAccess(userId: string, id: string): Promise<{ row: WidgetRow; board: DashboardRow; role: ReportRole } | null> {
  const [row] = await db.select().from(widget).where(eq(widget.id, id));
  if (!row) return null;
  const found = await dashboardAccess(userId, row.dashboardId);
  return found ? { row, board: found.row, role: found.role } : null;
}
