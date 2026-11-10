// Sharing, copies and trash (BUILD-SPEC §5.3, M4).
//
// Invitations work by token, not by matching an email address: sign-up does not
// verify email yet, so holding the emailed link is what proves the address.

import { randomBytes } from "node:crypto";

import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Hono } from "hono";
import { sign } from "hono/jwt";

import { db } from "./db/client.ts";
import { auditEvent, user as userTable, workbook, workbookLink, workbookShare } from "./db/schema.ts";
import { env } from "./env.ts";
import { sendInvite } from "./mail.ts";
import type { Vars } from "./app.ts";

export type Role = "owner" | "editor" | "viewer";
type Workbook = typeof workbook.$inferSelect;

const TRASH_DAYS = 7;
const MAX_SHARES = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export const newWorkbookId = () => randomBytes(12).toString("hex").toUpperCase();

/** The caller's live workbook and their best role on it, or null. */
export async function access(userId: string, id: string): Promise<{ row: Workbook; role: Role } | null> {
  const [row] = await db
    .select()
    .from(workbook)
    .where(and(eq(workbook.id, id), isNull(workbook.deletedAt)));
  if (!row) return null;
  if (row.ownerId === userId) return { row, role: "owner" };
  const roles: Role[] = [];
  const [share] = await db
    .select({ role: workbookShare.role })
    .from(workbookShare)
    .where(and(eq(workbookShare.workbookId, id), eq(workbookShare.userId, userId)));
  if (share) roles.push(share.role);
  const [link] = await db.select().from(workbookLink).where(eq(workbookLink.workbookId, id));
  if (link?.linkAccess === "view") roles.push("viewer");
  if (link?.linkAccess === "edit") roles.push("editor");
  if (roles.length === 0) return null;
  return { row, role: roles.sort((a, b) => RANK[b] - RANK[a])[0]! };
}

export const audit = (workbookId: string, userId: string, event: string, detail: Record<string, unknown> = {}) =>
  db.insert(auditEvent).values({ workbookId, userId, event, detail });

/** Call the workbook host as the control plane. */
async function hostCall(path: "copy" | "purge" | "revoke", id: string, claims: Record<string, unknown> = {}, query = ""): Promise<boolean> {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = await sign({ wb: id, sub: "control", role: "owner", admin: true, exp, ...claims }, env.wbTokenSecret, "HS256");
  const base = env.wbhostUrl.replace(/^ws/, "http");
  const res = await fetch(`${base}/wb/${id}/${path}?token=${encodeURIComponent(token)}${query}`, { method: "POST" }).catch(() => null);
  return !!res?.ok;
}

/** Delete a workbook's files on the host, then its row. False if the host refused. */
export async function purgeWorkbook(id: string): Promise<boolean> {
  if (!(await hostCall("purge", id))) return false;
  await db.delete(workbook).where(eq(workbook.id, id));
  return true;
}

/** Close a user's open sessions so a changed role takes effect now. */
export const revoke =(id: string, userId: string | null) => (userId ? hostCall("revoke", id, {}, `&user=${encodeURIComponent(userId)}`) : Promise.resolve(true));

const inviteUrl = (token: string) => `${env.publicUrl}/invite/${token}`;

/** Delete workbooks that have been in the trash for over a week. */
export async function purgeExpired(): Promise<number> {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86_400_000);
  const rows = await db
    .select({ id: workbook.id })
    .from(workbook)
    .where(and(isNotNull(workbook.deletedAt), lt(workbook.deletedAt, cutoff)));
  let purged = 0;
  for (const { id } of rows) {
    // Files first: a row without files is harmless to retry, the reverse leaks them.
    if (await hostCall("purge", id)) {
      await db.delete(workbook).where(eq(workbook.id, id));
      purged++;
    }
  }
  return purged;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/workbooks/trash", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db
      .select({ id: workbook.id, title: workbook.title, deletedAt: workbook.deletedAt })
      .from(workbook)
      .where(and(eq(workbook.ownerId, user.id), isNotNull(workbook.deletedAt)));
    return c.json({ workbooks: rows, keepDays: TRASH_DAYS });
  });

  app.post("/api/v1/workbooks/:id/restore", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const id = c.req.param("id");
    const done = await db
      .update(workbook)
      .set({ deletedAt: null })
      .where(and(eq(workbook.id, id), eq(workbook.ownerId, user.id), isNotNull(workbook.deletedAt)))
      .returning({ id: workbook.id });
    if (done.length === 0) return c.json({ error: "not found" }, 404);
    await audit(id, user.id, "restore");
    return c.json({ id });
  });

  app.post("/api/v1/workbooks/:id/copy", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const [link] = await db.select().from(workbookLink).where(eq(workbookLink.workbookId, found.row.id));
    if (found.role === "viewer" && link && !link.allowCopy) return c.json({ error: "the owner has turned off copying" }, 403);
    const id = newWorkbookId();
    await db.insert(workbook).values({ id, ownerId: user.id, title: `Copy of ${found.row.title}`.slice(0, 255) });
    if (!(await hostCall("copy", found.row.id, { copy_to: id }))) {
      await db.delete(workbook).where(eq(workbook.id, id));
      return c.json({ error: "the copy could not be made" }, 502);
    }
    await audit(found.row.id, user.id, "copy", { to: id });
    return c.json({ id }, 201);
  });

  app.get("/api/v1/workbooks/:id/shares", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role !== "owner") return c.json({ error: "only the owner can manage sharing" }, 403);
    const rows = await db.select().from(workbookShare).where(eq(workbookShare.workbookId, found.row.id));
    const [link] = await db.select().from(workbookLink).where(eq(workbookLink.workbookId, found.row.id));
    return c.json({
      shares: rows.map((s) => ({
        id: s.id,
        email: s.email,
        role: s.role,
        pending: s.userId === null,
        inviteUrl: s.inviteToken ? inviteUrl(s.inviteToken) : null,
      })),
      link: { linkAccess: link?.linkAccess ?? "none", allowCopy: link?.allowCopy ?? true },
    });
  });

  app.post("/api/v1/workbooks/:id/shares/precheck", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role !== "owner") return c.json({ error: "only the owner can manage sharing" }, 403);
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const [existing] = await db
      .select({ id: workbookShare.id })
      .from(workbookShare)
      .where(and(eq(workbookShare.workbookId, found.row.id), eq(workbookShare.email, email)));
    return c.json({ valid: EMAIL.test(email), self: email === user.email.toLowerCase(), alreadyShared: !!existing });
  });

  // Invite someone, or change the role of someone already invited.
  app.put("/api/v1/workbooks/:id/shares", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role !== "owner") return c.json({ error: "only the owner can manage sharing" }, 403);
    const body = await c.req.json<{ email?: unknown; role?: unknown }>().catch(() => ({}) as { email?: unknown; role?: unknown });
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) return c.json({ error: "enter a valid email address" }, 400);
    if (body.role !== "editor" && body.role !== "viewer") return c.json({ error: "role must be editor or viewer" }, 400);
    if (email === user.email.toLowerCase()) return c.json({ error: "you already own this workbook" }, 400);
    const id = found.row.id;
    const [existing] = await db
      .select()
      .from(workbookShare)
      .where(and(eq(workbookShare.workbookId, id), eq(workbookShare.email, email)));
    if (existing) {
      await db.update(workbookShare).set({ role: body.role }).where(eq(workbookShare.id, existing.id));
      await revoke(id, existing.userId);
      await audit(id, user.id, "share.role", { email, role: body.role });
      return c.json({ id: existing.id, email, role: body.role, pending: existing.userId === null, inviteUrl: existing.inviteToken ? inviteUrl(existing.inviteToken) : null, emailed: false });
    }
    if ((await db.select({ id: workbookShare.id }).from(workbookShare).where(eq(workbookShare.workbookId, id))).length >= MAX_SHARES) {
      return c.json({ error: `a workbook can be shared with at most ${MAX_SHARES} people` }, 400);
    }
    const token = randomBytes(24).toString("hex");
    const shareId = randomBytes(12).toString("hex");
    await db.insert(workbookShare).values({ id: shareId, workbookId: id, email, role: body.role, inviteToken: token, invitedBy: user.id });
    const emailed = await sendInvite({ to: email, from: user.name || user.email, title: found.row.title, role: body.role, url: inviteUrl(token) });
    await audit(id, user.id, "share.invite", { email, role: body.role, emailed });
    return c.json({ id: shareId, email, role: body.role, pending: true, inviteUrl: inviteUrl(token), emailed }, 201);
  });

  app.delete("/api/v1/workbooks/:id/shares/:share", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role !== "owner") return c.json({ error: "only the owner can manage sharing" }, 403);
    const [gone] = await db
      .delete(workbookShare)
      .where(and(eq(workbookShare.id, c.req.param("share")), eq(workbookShare.workbookId, found.row.id)))
      .returning();
    if (!gone) return c.json({ error: "not found" }, 404);
    await revoke(found.row.id, gone.userId);
    await audit(found.row.id, user.id, "share.remove", { email: gone.email });
    return c.body(null, 204);
  });

  app.put("/api/v1/workbooks/:id/link", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role !== "owner") return c.json({ error: "only the owner can manage sharing" }, 403);
    const body = await c.req.json<{ linkAccess?: unknown; allowCopy?: unknown }>().catch(() => ({}) as { linkAccess?: unknown; allowCopy?: unknown });
    if (body.linkAccess !== "none" && body.linkAccess !== "view" && body.linkAccess !== "edit") return c.json({ error: "linkAccess must be none, view or edit" }, 400);
    const values = { linkAccess: body.linkAccess as "none" | "view" | "edit", allowCopy: body.allowCopy !== false };
    await db.insert(workbookLink).values({ workbookId: found.row.id, ...values }).onConflictDoUpdate({ target: workbookLink.workbookId, set: values });
    await audit(found.row.id, user.id, "share.link", values);
    return c.json(values);
  });

  app.post("/api/v1/invites/:token/accept", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [share] = await db.select().from(workbookShare).where(eq(workbookShare.inviteToken, c.req.param("token")));
    if (!share) return c.json({ error: "this invitation is no longer valid" }, 404);
    const [wb] = await db.select({ ownerId: workbook.ownerId }).from(workbook).where(eq(workbook.id, share.workbookId));
    if (wb?.ownerId === user.id) {
      // The owner clicked their own invitation: nothing to grant, and leave it for the invitee.
      return c.json({ workbook: share.workbookId });
    }
    // Someone with a share already keeps one row, at the better of the two roles.
    const [mine] = await db
      .select()
      .from(workbookShare)
      .where(and(eq(workbookShare.workbookId, share.workbookId), eq(workbookShare.userId, user.id)));
    if (mine) {
      if (RANK[share.role] > RANK[mine.role]) await db.update(workbookShare).set({ role: share.role }).where(eq(workbookShare.id, mine.id));
      await db.delete(workbookShare).where(eq(workbookShare.id, share.id));
    } else {
      await db.update(workbookShare).set({ userId: user.id, inviteToken: null, acceptedAt: new Date() }).where(eq(workbookShare.id, share.id));
    }
    await audit(share.workbookId, user.id, "share.accept", { email: share.email });
    return c.json({ workbook: share.workbookId });
  });

  app.get("/api/v1/workbooks", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db
      .selectDistinct({
        id: workbook.id,
        title: workbook.title,
        lastAccessedAt: workbook.lastAccessedAt,
        ownerId: workbook.ownerId,
        ownerName: userTable.name,
        shareRole: workbookShare.role,
      })
      .from(workbook)
      .innerJoin(userTable, eq(userTable.id, workbook.ownerId))
      .leftJoin(workbookShare, and(eq(workbookShare.workbookId, workbook.id), eq(workbookShare.userId, user.id)))
      .where(and(isNull(workbook.deletedAt), or(eq(workbook.ownerId, user.id), eq(workbookShare.userId, user.id))));
    rows.sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    return c.json({
      workbooks: rows.slice(0, 100).map((r) => ({
        id: r.id,
        title: r.title,
        lastAccessedAt: r.lastAccessedAt,
        role: r.ownerId === user.id ? "owner" : r.shareRole,
        owner: r.ownerName,
      })),
    });
  });
}
