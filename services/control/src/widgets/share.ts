// Sharing a report: invite people by email as viewers or editors, or turn on a link anyone can open
// without signing in. A shared report shows its cards and lets the reader filter them. It never gives
// the reader the tables underneath.

import { randomBytes } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { newId } from "../agents/run.ts";
import type { Vars } from "../app.ts";
import { db } from "../db/client.ts";
import { dashboard, dashboardShare, user as userTable, widget } from "../db/schema.ts";
import { env } from "../env.ts";
import { mailEnabled, sendMail } from "../mail.ts";
import { record } from "../activity.ts";
import { notify } from "../alerts.ts";
import { dashboardAccess } from "./access.ts";
import { reportFields, viewWidget } from "./live.ts";
import { RefreshError } from "./refresh.ts";
import { reportFilter } from "./spec.ts";

const MAX_SHARES = 50;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const token = () => randomBytes(24).toString("base64url");
const inviteUrl = (t: string) => `${env.publicUrl}/report-invite/${t}`;
export const publicUrl = (t: string) => `${env.publicUrl}/r/${t}`;

const publicWidget = ({ dashboardId: _d, agentId: _a, source, ...w }: typeof widget.$inferSelect) => ({
  ...w,
  // A reader without an account sees that a card is live or a snapshot, not the query behind it.
  source: { kind: (source as { kind: string }).kind },
});

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/dashboards/:id/shares", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const shares = await db.select().from(dashboardShare).where(eq(dashboardShare.dashboardId, found.row.id)).orderBy(asc(dashboardShare.createdAt));
    return c.json({
      shares: shares.map((s) => ({ id: s.id, email: s.email, role: s.role, limits: s.limits ?? [], accepted: !!s.userId, inviteUrl: s.userId ? null : inviteUrl(s.inviteToken) })),
      link: found.row.linkToken ? publicUrl(found.row.linkToken) : null,
      mail: mailEnabled(),
    });
  });

  /** Invite someone, or change the role of someone already invited. */
  app.put("/api/v1/dashboards/:id/shares", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(["viewer", "editor"]), limits: z.array(z.object({ field: z.string().trim().min(1).max(200), values: z.array(z.string().max(500)).min(1).max(200) }).strict()).max(5).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Enter an email address and choose viewer or editor." }, 400);
    const { email, role } = parsed.data;
    const limits = parsed.data.limits?.length ? parsed.data.limits : null;
    // An editor arranges the whole report, so only a viewer can be held to certain rows.
    if (limits && role !== "viewer") return c.json({ error: "Only someone who can view, not edit, can be limited to certain rows." }, 400);
    if (email === user.email.toLowerCase()) return c.json({ error: "This is your own report." }, 400);
    const existing = await db.select().from(dashboardShare).where(eq(dashboardShare.dashboardId, found.row.id));
    const old = existing.find((s) => s.email === email);
    if (old) {
      await db.update(dashboardShare).set({ role, ...(parsed.data.limits !== undefined || role !== "viewer" ? { limits } : {}) }).where(eq(dashboardShare.id, old.id));
      record({ userId: user.id, kind: "share.changed", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { email, role, limits: parsed.data.limits !== undefined || role !== "viewer" ? limits : old.limits } });
      return c.json({ share: { id: old.id, email, role, limits: parsed.data.limits !== undefined || role !== "viewer" ? (limits ?? []) : (old.limits ?? []), accepted: !!old.userId, inviteUrl: old.userId ? null : inviteUrl(old.inviteToken) }, emailed: false });
    }
    if (existing.length >= MAX_SHARES) return c.json({ error: `A report can be shared with ${MAX_SHARES} people.` }, 400);
    const [row] = await db.insert(dashboardShare).values({ id: newId(), dashboardId: found.row.id, email, role, limits, inviteToken: token(), invitedBy: user.id }).returning();
    const url = inviteUrl(row!.inviteToken);
    record({ userId: user.id, kind: "share.added", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { email, role, limits } });
    const verb = role === "editor" ? "edit" : "view";
    const emailed = await sendMail({
      to: email,
      subject: `${user.name} shared the report "${found.row.name}" with you`,
      html: `<p>${escape(user.name)} invited you to ${verb} the report <strong>${escape(found.row.name)}</strong> on GridZero.</p><p><a href="${escape(url)}">Open the report</a></p>`,
    });
    // Someone who already has an account also sees it in the app.
    const [invitee] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email));
    if (invitee) await notify(invitee.id, "share", `${user.name} shared a report with you`, `"${found.row.name}", to ${verb}.`, `/report-invite/${row!.inviteToken}`);
    return c.json({ share: { id: row!.id, email, role, limits: limits ?? [], accepted: false, inviteUrl: url }, emailed }, 201);
  });

  app.delete("/api/v1/dashboards/:id/shares/:share", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const gone = await db.delete(dashboardShare).where(and(eq(dashboardShare.id, c.req.param("share")), eq(dashboardShare.dashboardId, found.row.id))).returning({ email: dashboardShare.email });
    if (gone[0]) record({ userId: user.id, kind: "share.removed", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { email: gone[0].email } });
    return c.body(null, 204);
  });

  /** Turn the view-only link on (a new address each time) or off. */
  app.put("/api/v1/dashboards/:id/link", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ on?: unknown }>().catch(() => ({}) as { on?: unknown });
    if (typeof body.on !== "boolean") return c.json({ error: "on must be true or false" }, 400);
    const linkToken = body.on ? token() : null;
    await db.update(dashboard).set({ linkToken }).where(eq(dashboard.id, found.row.id));
    record({ userId: user.id, kind: "link.changed", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { on: body.on } });
    return c.json({ link: linkToken ? publicUrl(linkToken) : null });
  });

  /** Accept an invitation: the signed-in person joins the report. The address it was sent to does not have to match. */
  app.post("/api/v1/report-invites/:token/accept", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [share] = await db.select().from(dashboardShare).where(eq(dashboardShare.inviteToken, c.req.param("token")));
    if (!share) return c.json({ error: "This invitation is no longer valid. Ask for a new one." }, 404);
    if (share.userId && share.userId !== user.id) return c.json({ error: "This invitation has already been used." }, 409);
    const [board] = await db.select({ ownerId: dashboard.ownerId }).from(dashboard).where(eq(dashboard.id, share.dashboardId));
    if (board && board.ownerId !== user.id && !share.userId) {
      // One person, one share: an earlier invitation to the same person is replaced.
      await db.delete(dashboardShare).where(and(eq(dashboardShare.dashboardId, share.dashboardId), eq(dashboardShare.userId, user.id)));
      await db.update(dashboardShare).set({ userId: user.id, acceptedAt: new Date() }).where(eq(dashboardShare.id, share.id));
    }
    return c.json({ dashboardId: share.dashboardId });
  });

  // --- the link anyone can open -------------------------------------------------

  const byToken = async (t: string) => {
    if (t.length < 20) return null;
    const [row] = await db.select().from(dashboard).where(eq(dashboard.linkToken, t));
    return row ?? null;
  };

  app.get("/api/v1/public/reports/:token", async (c) => {
    const board = await byToken(c.req.param("token"));
    if (!board) return c.json({ error: "This link is not on. Ask the report's owner for a new one." }, 404);
    const rows = await db.select().from(widget).where(eq(widget.dashboardId, board.id)).orderBy(asc(widget.position));
    record({ userId: null, kind: "report.opened_by_link", objectKind: "report", objectId: board.id, label: board.name, ownerId: board.ownerId });
    return c.json({ name: board.name, tabs: board.tabs ?? [], widgets: rows.map(publicWidget) });
  });

  app.get("/api/v1/public/reports/:token/fields", async (c) => {
    const board = await byToken(c.req.param("token"));
    if (!board) return c.json({ error: "not found" }, 404);
    return c.json(await reportFields(board.id, board.ownerId));
  });

  app.post("/api/v1/public/reports/:token/widgets/:id/view", async (c) => {
    const board = await byToken(c.req.param("token"));
    if (!board) return c.json({ error: "not found" }, 404);
    const [row] = await db.select().from(widget).where(and(eq(widget.id, c.req.param("id")), eq(widget.dashboardId, board.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    const parsed = z.object({ filters: z.array(reportFilter).max(12).default([]), compare: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Those filters are not valid." }, 400);
    try {
      return c.json(await viewWidget(board.ownerId, row, parsed.data.filters, parsed.data.compare));
    } catch (e) {
      // The reason may name a table or a column: a reader without an account is told only that it failed.
      if (e instanceof RefreshError) return c.json({ error: "This card could not be filtered." }, 400);
      throw e;
    }
  });
}
