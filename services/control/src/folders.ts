// Folders: a person's own way of filing their workbooks and reports. Where something is filed is theirs
// alone: filing a report someone shared with you does not move it for its owner. The model (a folder,
// and an item pointing at it) follows DataDungeon's file tree, kept to one level.

import { and, asc, count, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { newId } from "./agents/run.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { folder, folderItem } from "./db/schema.ts";
import { access } from "./sharing.ts";
import { dashboardAccess } from "./widgets/access.ts";

const MAX_FOLDERS = 50;
const name = z.string().trim().min(1).max(60);

export function routes(app: Hono<{ Variables: Vars }>) {
  /** The person's folders, and what they have filed where. */
  app.get("/api/v1/folders", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const folders = await db.select({ id: folder.id, name: folder.name }).from(folder).where(eq(folder.ownerId, user.id)).orderBy(asc(folder.name));
    const items = await db.select({ kind: folderItem.kind, itemId: folderItem.itemId, folderId: folderItem.folderId }).from(folderItem).where(eq(folderItem.userId, user.id));
    return c.json({ folders, items });
  });

  app.post("/api/v1/folders", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ name }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A folder's name is 1 to 60 characters." }, 400);
    const [{ n }] = (await db.select({ n: count() }).from(folder).where(eq(folder.ownerId, user.id))) as [{ n: number }];
    if (n >= MAX_FOLDERS) return c.json({ error: `You can have at most ${MAX_FOLDERS} folders.` }, 400);
    const [taken] = await db.select({ id: folder.id }).from(folder).where(and(eq(folder.ownerId, user.id), eq(folder.name, parsed.data.name)));
    if (taken) return c.json({ error: "You already have a folder with that name." }, 409);
    const [row] = await db.insert(folder).values({ id: newId(), ownerId: user.id, name: parsed.data.name }).returning({ id: folder.id, name: folder.name });
    return c.json({ folder: row }, 201);
  });

  app.patch("/api/v1/folders/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ name }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A folder's name is 1 to 60 characters." }, 400);
    const [clash] = await db.select({ id: folder.id }).from(folder).where(and(eq(folder.ownerId, user.id), eq(folder.name, parsed.data.name)));
    if (clash && clash.id !== c.req.param("id")) return c.json({ error: "You already have a folder with that name." }, 409);
    const [row] = await db.update(folder).set({ name: parsed.data.name }).where(and(eq(folder.id, c.req.param("id")), eq(folder.ownerId, user.id))).returning({ id: folder.id, name: folder.name });
    return row ? c.json({ folder: row }) : c.json({ error: "not found" }, 404);
  });

  /** Remove a folder. What was in it is kept and goes back to the unfiled list. */
  app.delete("/api/v1/folders/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const gone = await db.delete(folder).where(and(eq(folder.id, c.req.param("id")), eq(folder.ownerId, user.id))).returning({ id: folder.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  /** File a workbook or a report in one of your folders, or take it out (folderId null). */
  app.put("/api/v1/folders/place", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ kind: z.enum(["workbook", "report"]), itemId: z.string().min(1).max(64), folderId: z.string().max(64).nullable() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Say what to file and where." }, 400);
    const { kind, itemId, folderId } = parsed.data;
    // Only something you can open can be filed, and only in a folder of your own.
    const can = kind === "workbook" ? await access(user.id, itemId) : await dashboardAccess(user.id, itemId);
    if (!can) return c.json({ error: "not found" }, 404);
    if (folderId) {
      const [mine] = await db.select({ id: folder.id }).from(folder).where(and(eq(folder.id, folderId), eq(folder.ownerId, user.id)));
      if (!mine) return c.json({ error: "not found" }, 404);
    }
    await db.delete(folderItem).where(and(eq(folderItem.userId, user.id), eq(folderItem.kind, kind), eq(folderItem.itemId, itemId)));
    if (folderId) await db.insert(folderItem).values({ userId: user.id, kind, itemId, folderId });
    return c.json({ kind, itemId, folderId });
  });
}
