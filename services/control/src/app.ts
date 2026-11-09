// Control-plane HTTP API (BUILD-SPEC §5.3).

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";

import { auth } from "./auth.ts";
import type { Session } from "./auth.ts";
import { db, sql } from "./db/client.ts";
import { workbook } from "./db/schema.ts";
import { env } from "./env.ts";
import * as sharing from "./sharing.ts";

const ROUTING_TOKEN_TTL_S = 10 * 60;
const MAX_TITLE = 255;

export type Vars = { user: Session["user"] | null; session: Session["session"] | null };

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

sharing.routes(app);

app.post("/api/v1/workbooks", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  // 24 uppercase hex chars, the same id shape the reference product uses.
  const id = sharing.newWorkbookId();
  const [row] = await db.insert(workbook).values({ id, ownerId: user.id }).returning({ id: workbook.id, title: workbook.title });
  return c.json(row, 201);
});

app.patch("/api/v1/workbooks/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({}) as { title?: unknown });
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > MAX_TITLE) return c.json({ error: "title must be 1-255 characters" }, 400);
  const found = await sharing.access(user.id, c.req.param("id"));
  if (!found) return c.json({ error: "not found" }, 404);
  if (found.role === "viewer") return c.json({ error: "viewers cannot rename a workbook" }, 403);
  await db.update(workbook).set({ title }).where(eq(workbook.id, found.row.id));
  return c.json({ id: found.row.id, title });
});

app.delete("/api/v1/workbooks/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  const found = await sharing.access(user.id, c.req.param("id"));
  if (!found) return c.json({ error: "not found" }, 404);
  if (found.role !== "owner") return c.json({ error: "only the owner can delete a workbook" }, 403);
  await db.update(workbook).set({ deletedAt: new Date() }).where(eq(workbook.id, found.row.id));
  await sharing.audit(found.row.id, user.id, "trash");
  return c.body(null, 204);
});

/** Grant a short-lived routing token for the workbook host (BUILD-SPEC §3.1 step 1). */
app.post("/api/v1/workbooks/:id/open", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  const found = await sharing.access(user.id, c.req.param("id"));
  if (!found) return c.json({ error: "not found" }, 404);
  const { row, role } = found;
  await db.update(workbook).set({ lastAccessedAt: new Date() }).where(eq(workbook.id, row.id));
  const exp = Math.floor(Date.now() / 1000) + ROUTING_TOKEN_TTL_S;
  const token = await sign({ wb: row.id, sub: user.id, role, name: user.name || user.email, exp }, env.wbTokenSecret, "HS256");
  return c.json({ id: row.id, title: row.title, role, endpoint: `${env.wbhostUrl}/wb/${row.id}/ws`, token, expiresAt: exp });
});
