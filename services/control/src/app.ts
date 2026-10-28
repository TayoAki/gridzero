// Control-plane HTTP API (BUILD-SPEC §5.3).

import { randomBytes } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";

import { auth } from "./auth.ts";
import type { Session } from "./auth.ts";
import { db, sql } from "./db/client.ts";
import { workbook } from "./db/schema.ts";
import { env } from "./env.ts";

const ROUTING_TOKEN_TTL_S = 10 * 60;
const MAX_TITLE = 255;

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

app.post("/api/v1/workbooks", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  // 24 uppercase hex chars, the same id shape the reference product uses.
  const id = randomBytes(12).toString("hex").toUpperCase();
  const [row] = await db.insert(workbook).values({ id, ownerId: user.id }).returning({ id: workbook.id, title: workbook.title });
  return c.json(row, 201);
});

/** The caller's live workbook, or null. Ownership is the only access path until sharing lands (M4). */
async function ownedWorkbook(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(workbook)
    .where(and(eq(workbook.id, id), eq(workbook.ownerId, userId), isNull(workbook.deletedAt)));
  return row ?? null;
}

app.patch("/api/v1/workbooks/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({}) as { title?: unknown });
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > MAX_TITLE) return c.json({ error: "title must be 1-255 characters" }, 400);
  if (!(await ownedWorkbook(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  await db.update(workbook).set({ title }).where(eq(workbook.id, c.req.param("id")));
  return c.json({ id: c.req.param("id"), title });
});

app.delete("/api/v1/workbooks/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  if (!(await ownedWorkbook(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  await db.update(workbook).set({ deletedAt: new Date() }).where(eq(workbook.id, c.req.param("id")));
  return c.body(null, 204);
});

/** Grant a short-lived routing token for the workbook host (BUILD-SPEC §3.1 step 1). */
app.post("/api/v1/workbooks/:id/open", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  const row = await ownedWorkbook(user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  await db.update(workbook).set({ lastAccessedAt: new Date() }).where(eq(workbook.id, row.id));
  const exp = Math.floor(Date.now() / 1000) + ROUTING_TOKEN_TTL_S;
  const token = await sign({ wb: row.id, sub: user.id, role: "owner", exp }, env.wbTokenSecret, "HS256");
  return c.json({ id: row.id, title: row.title, endpoint: `${env.wbhostUrl}/wb/${row.id}/ws`, token, expiresAt: exp });
});
