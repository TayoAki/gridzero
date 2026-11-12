// Who may see or change a report: its owner, or someone it was shared with who accepted.
// A card's query always runs with the owner's access to the data, never the viewer's, so sharing a
// report shares what is on it and nothing else.

import { and, eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { dashboard, dashboardGroupShare, dashboardShare, groupMember, user, widget } from "../db/schema.ts";
import { env } from "../env.ts";

export type ReportRole = "owner" | "editor" | "viewer";
export type DashboardRow = typeof dashboard.$inferSelect;
export type WidgetRow = typeof widget.$inferSelect;

export interface Limit {
  field: string;
  values: string[];
}

/** What stands between a reader and the full figures: rows they are held to, columns they never see, and the smallest group they may be shown. */
export interface Guard {
  limits: Limit[];
  hide: string[];
  minGroup: number;
  /** Columns shown only in part. */
  mask: string[];
}
export const OPEN: Guard = { limits: [], hide: [], minGroup: 0, mask: [] };
export const guarded = (g: Guard) => g.limits.length > 0 || g.hide.length > 0 || g.minGroup > 1 || g.mask.length > 0;

/** `limits` are the rows a person is held to on this report; empty for the owner and for anyone not limited. */
export async function dashboardAccess(userId: string, id: string): Promise<({ row: DashboardRow; role: ReportRole } & Guard) | null> {
  const [row] = await db.select().from(dashboard).where(eq(dashboard.id, id));
  if (!row) return null;
  if (row.ownerId === userId) return { row, role: "owner", ...OPEN };
  const [share] = await db
    .select({ role: dashboardShare.role, limits: dashboardShare.limits, hide: dashboardShare.hide, mask: dashboardShare.mask })
    .from(dashboardShare)
    .where(and(eq(dashboardShare.dashboardId, id), eq(dashboardShare.userId, userId)));
  // The smallest-group rule is for people who only read; editors arrange the report and see it whole.
  if (share) return { row, role: share.role, limits: share.limits ?? [], hide: share.role === "viewer" ? (share.hide ?? []) : [], mask: share.role === "viewer" ? (share.mask ?? []) : [], minGroup: share.role === "viewer" ? row.minGroup : 0 };
  // Through a group the person belongs to: a viewer, with that group's guards.
  const [viaGroup] = await db
    .select({ limits: dashboardGroupShare.limits, hide: dashboardGroupShare.hide, mask: dashboardGroupShare.mask })
    .from(dashboardGroupShare)
    .innerJoin(groupMember, eq(groupMember.groupId, dashboardGroupShare.groupId))
    .where(and(eq(dashboardGroupShare.dashboardId, id), eq(groupMember.userId, userId)));
  if (viaGroup) return { row, role: "viewer", limits: viaGroup.limits ?? [], hide: viaGroup.hide ?? [], mask: viaGroup.mask ?? [], minGroup: row.minGroup };
  // An auditor reads every report and changes none.
  if (!env.auditorEmails.length) return null;
  const [who] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return who && env.auditorEmails.includes(who.email.toLowerCase()) ? { row, role: "viewer", ...OPEN } : null;
}

export const canEdit = (role: ReportRole) => role !== "viewer";

export async function widgetAccess(userId: string, id: string): Promise<({ row: WidgetRow; board: DashboardRow; role: ReportRole } & Guard) | null> {
  const [row] = await db.select().from(widget).where(eq(widget.id, id));
  if (!row) return null;
  const found = await dashboardAccess(userId, row.dashboardId);
  return found ? { row, board: found.row, role: found.role, limits: found.limits, hide: found.hide, minGroup: found.minGroup, mask: found.mask } : null;
}
