// Control-plane HTTP API (BUILD-SPEC §5.3). M0 ships auth, /me and the
// workbook list; the rest of /api/v1 lands in M1.

import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { auth } from "./auth.ts";
import type { Session } from "./auth.ts";
import { db, sql } from "./db/client.ts";
import { workbook } from "./db/schema.ts";

type Vars = { user: Session["user"] | null; session: Session["session"] | null };

export const app = new Hono<{ Variables: Vars }>();

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/api/v1/*", async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", result?.user ?? null);
  c.set("session", result?.session ?? null);
  await next();
});

app.get("/api/v1/health", async (c) => {
  await sql`select 1`;
  return c.json({ ok: true });
});

app.get("/api/v1/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  return c.json({ id: user.id, email: user.email, name: user.name });
});

app.get("/api/v1/workbooks", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  const rows = await db
    .select({ id: workbook.id, title: workbook.title, lastAccessedAt: workbook.lastAccessedAt })
    .from(workbook)
    .where(and(eq(workbook.ownerId, user.id), isNull(workbook.deletedAt)))
    .orderBy(desc(workbook.lastAccessedAt))
    .limit(100);
  return c.json({ workbooks: rows });
});
