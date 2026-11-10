// Account deletion: DELETE /api/v1/account with the password and the word DELETE.
// Owned workbooks are purged from the host first (their files, then their rows); the
// user row goes last, and sessions, shares and connections go with it by cascade.

import { and, asc, eq, ne } from "drizzle-orm";
import type { Hono } from "hono";

import type { Vars } from "./app.ts";
import { auth } from "./auth.ts";
import { db } from "./db/client.ts";
import { account, user, workbook, workbookShare, workspace, workspaceMember } from "./db/schema.ts";
import { captureError } from "./errors.ts";
import { purgeWorkbook, revoke } from "./sharing.ts";

export function routes(app: Hono<{ Variables: Vars }>) {
  app.delete("/api/v1/account", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ password?: unknown; confirm?: unknown }>().catch(() => ({}) as { password?: unknown; confirm?: unknown });
    if (body.confirm !== "DELETE") return c.json({ error: "type DELETE to confirm" }, 400);
    if (typeof body.password !== "string" || !body.password) return c.json({ error: "enter your password" }, 400);

    const [cred] = await db
      .select({ hash: account.password })
      .from(account)
      .where(and(eq(account.userId, me.id), eq(account.providerId, "credential")));
    const ctx = await auth.$context;
    if (!cred?.hash || !(await ctx.password.verify({ hash: cred.hash, password: body.password }))) {
      return c.json({ error: "that password is not right" }, 403);
    }

    const owned = await db.select({ id: workbook.id }).from(workbook).where(eq(workbook.ownerId, me.id));
    const failed: string[] = [];
    for (const { id } of owned) if (!(await purgeWorkbook(id))) failed.push(id);
    if (failed.length) {
      captureError(new Error("account deletion could not purge workbooks"), { userId: me.id, workbooks: failed });
      return c.json({ error: "Some workbooks could not be deleted just now. Nothing else was removed; please try again." }, 503);
    }

    // Close any sessions the person has open on workbooks shared with them.
    const shared = await db.select({ id: workbookShare.workbookId }).from(workbookShare).where(eq(workbookShare.userId, me.id));
    await Promise.all(shared.map(({ id }) => revoke(id, me.id)));

    // Workspaces: one the person is alone in goes with them; a shared one stays, with an admin.
    const memberships = await db.select({ workspaceId: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, me.id));
    for (const { workspaceId } of memberships) {
      const others = await db.select({ id: workspaceMember.id, role: workspaceMember.role }).from(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), ne(workspaceMember.userId, me.id))).orderBy(asc(workspaceMember.createdAt));
      if (others.length === 0) await db.delete(workspace).where(eq(workspace.id, workspaceId));
      else if (!others.some((o) => o.role === "admin")) await db.update(workspaceMember).set({ role: "admin" }).where(eq(workspaceMember.id, others[0]!.id));
    }

    await db.delete(user).where(eq(user.id, me.id));
    console.log(JSON.stringify({ level: "info", event: "account.delete", userId: me.id, workbooks: owned.length }));
    return c.body(null, 204);
  });
}
