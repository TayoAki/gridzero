// Control-plane HTTP API (BUILD-SPEC §5.3).

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";

import { auth, authOptions } from "./auth.ts";
import type { Session } from "./auth.ts";
import { db, sql } from "./db/client.ts";
import { workbook } from "./db/schema.ts";
import { env } from "./env.ts";
import { allowClientReport, captureClientError, captureError, parseClientError } from "./errors.ts";
import * as account from "./account.ts";
import * as agents from "./agents/routes.ts";
import * as connected from "./connected.ts";
import * as definitions from "./definitions/routes.ts";
import * as metrics from "./metrics/routes.ts";
import * as a2ui from "./a2ui.ts";
import * as activityLog from "./activity.ts";
import * as alerts from "./alerts.ts";
import * as usedby from "./usedby.ts";
import * as fields from "./fields.ts";
import * as folders from "./folders.ts";
import * as home from "./home.ts";
import * as inputs from "./inputs.ts";
import * as monitor from "./monitor.ts";
import * as needs from "./needs.ts";
import * as outside from "./outside.ts";
import * as work from "./work.ts";
import * as widgets from "./widgets/routes.ts";
import * as reportShare from "./widgets/share.ts";
import * as schedules from "./schedules.ts";
import * as apps from "./apps/routes.ts";
import * as sharing from "./sharing.ts";
import * as snapshots from "./snapshots.ts";

const ROUTING_TOKEN_TTL_S = 10 * 60;
const MAX_TITLE = 255;

export type Vars = { user: Session["user"] | null; session: Session["session"] | null };

export const app = new Hono<{ Variables: Vars }>();

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
// What the sign-in page can offer here: a password reset needs email set up, Google needs its keys.
app.get("/api/v1/auth/options", (c) => c.json(authOptions()));

app.use("/api/v1/*", async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  // Without a session, a personal token may stand in, for reading only. The session stays empty, so
  // routes that make tokens or change things can tell the two apart.
  const byToken = result ? null : await outside.tokenUser(c.req.header("authorization"), c.req.method, c.req.path);
  c.set("user", result?.user ?? (byToken as Session["user"] | null) ?? null);
  c.set("session", result?.session ?? null);
  await next();
});

app.onError((err, c) => {
  captureError(err, { method: c.req.method, path: c.req.path, userId: c.get("user")?.id ?? null });
  return c.json({ error: "Something went wrong on our side. It has been logged." }, 500);
});

/** Errors from browsers (apps/web reports window errors and crashes here). */
app.post("/api/v1/client-errors", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!allowClientReport(ip)) return c.body(null, 429);
  const report = parseClientError(await c.req.json().catch(() => null));
  if (!report) return c.json({ error: "message is required" }, 400);
  captureClientError(report, c.get("user")?.id ?? null);
  return c.body(null, 204);
});

app.get("/api/v1/health", async (c) => {
  await sql`select 1`;
  return c.json({ ok: true });
});

app.get("/api/v1/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  return c.json({ id: user.id, email: user.email, name: user.name, admin: activityLog.isAdmin(user.email), auditor: activityLog.isAuditor(user.email) });
});

sharing.routes(app);
connected.routes(app);
account.routes(app);
agents.routes(app);
metrics.routes(app);
definitions.routes(app);
widgets.routes(app);
reportShare.routes(app);
alerts.routes(app);
activityLog.routes(app);
usedby.routes(app);
folders.routes(app);
inputs.routes(app);
home.routes(app);
fields.routes(app);
a2ui.routes(app);
needs.routes(app);
outside.routes(app);
work.routes(app);
monitor.routes(app);
snapshots.routes(app);
schedules.routes(app);
apps.routes(app);

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
  activityLog.record({ userId: user.id, kind: "workbook.opened", objectKind: "workbook", objectId: row.id, label: row.title, ownerId: row.ownerId, detail: { role } });
  const exp = Math.floor(Date.now() / 1000) + ROUTING_TOKEN_TTL_S;
  const token = await sign({ wb: row.id, sub: user.id, role, name: user.name || user.email, exp }, env.wbTokenSecret, "HS256");
  return c.json({ id: row.id, title: row.title, role, endpoint: `${env.wbhostUrl}/wb/${row.id}/ws`, token, expiresAt: exp });
});
