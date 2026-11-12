// Alerts and notifications. An alert watches one number card: when a refresh takes the figure past a
// line, the person who set it is told once, in the app and by email when email is set up. They are told
// again only after the figure has come back and crossed the line another time.

import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { newId } from "./agents/run.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { alert, dashboard, notification, user as userTable, widget } from "./db/schema.ts";
import { env } from "./env.ts";
import { captureError } from "./errors.ts";
import { sendMail } from "./mail.ts";
import { postWebhook, webhookProblem } from "./webhook.ts";
import { dashboardAccess, widgetAccess } from "./widgets/access.ts";

const MAX_PER_WIDGET = 4;
const MAX_PER_USER = 50;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plain = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export async function notify(userId: string, kind: string, title: string, body: string, link: string | null) {
  await db.insert(notification).values({ id: newId(), userId, kind, title: title.slice(0, 200), body: body.slice(0, 500), link });
}

/** After a card refreshes: tell whoever set an alert that its figure has just crossed their line. */
export async function checkAlerts(row: typeof widget.$inferSelect): Promise<void> {
  const data = row.data as { kind: string; value?: number; unit?: string | null };
  if (data.kind !== "number" || typeof data.value !== "number") return;
  const value = data.value;
  const alerts = await db.select().from(alert).where(eq(alert.widgetId, row.id));
  for (const a of alerts) {
    const past = a.op === "above" ? value > a.threshold : value < a.threshold;
    await db.update(alert).set({ lastValue: value, firing: past, ...(past && !a.firing ? { lastFiredAt: new Date() } : {}) }).where(eq(alert.id, a.id));
    if (!past || a.firing) continue;
    // Whoever set it may have lost the report since.
    if (!(await dashboardAccess(a.ownerId, row.dashboardId))) continue;
    const unit = data.unit ?? "";
    const title = `${row.title} is ${a.op} ${plain(a.threshold)}${unit}`;
    const body = `It is now ${plain(value)}${unit}. You asked to be told when it goes ${a.op} ${plain(a.threshold)}${unit}.`;
    const link = `/dashboards/${row.dashboardId}`;
    await notify(a.ownerId, "alert", title, body, link);
    const [to] = await db.select({ email: userTable.email }).from(userTable).where(eq(userTable.id, a.ownerId));
    if (a.webhook) await postWebhook(a.webhook, { text: `${title}. ${body}` }).catch(() => null);
    if (to) await sendMail({ to: to.email, subject: title, html: `<p>${escape(body)}</p><p><a href="${escape(env.publicUrl + link)}">Open the report</a></p>` }).catch((e: unknown) => captureError(e, { job: "alert-mail" }));
  }
}

const publicAlert = (a: typeof alert.$inferSelect) => ({ webhook: a.webhook, id: a.id, widgetId: a.widgetId, op: a.op, threshold: a.threshold, firing: a.firing, lastValue: a.lastValue, lastFiredAt: a.lastFiredAt });

export function routes(app: Hono<{ Variables: Vars }>) {
  /** The signed-in person's own alerts on a card. Anyone who can see the report can set one. */
  app.get("/api/v1/widgets/:id/alerts", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await widgetAccess(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(alert).where(and(eq(alert.widgetId, found.row.id), eq(alert.ownerId, user.id))).orderBy(alert.createdAt);
    return c.json({ alerts: rows.map(publicAlert) });
  });

  app.post("/api/v1/widgets/:id/alerts", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await widgetAccess(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    // An alert reports the card's whole figure, which someone held to certain rows may not see.
    if (found.limits.length || found.hide.length || found.minGroup > 1) return c.json({ error: "Alerts are not available on a report you see part of." }, 403);
    const data = found.row.data as { kind: string; value?: number };
    if (data.kind !== "number" || typeof data.value !== "number") return c.json({ error: "An alert watches a card that shows one figure." }, 400);
    const parsed = z.object({ op: z.enum(["above", "below"]), threshold: z.number().finite(), webhook: z.string().trim().max(500).nullable().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Choose above or below, and a number." }, 400);
    if (parsed.data.webhook) {
      const bad = await webhookProblem(parsed.data.webhook);
      if (bad) return c.json({ error: bad }, 400);
    }
    const [{ mine }] = (await db.select({ mine: count() }).from(alert).where(eq(alert.ownerId, user.id))) as [{ mine: number }];
    if (mine >= MAX_PER_USER) return c.json({ error: `You can have at most ${MAX_PER_USER} alerts.` }, 400);
    const [{ here }] = (await db.select({ here: count() }).from(alert).where(and(eq(alert.widgetId, found.row.id), eq(alert.ownerId, user.id)))) as [{ here: number }];
    if (here >= MAX_PER_WIDGET) return c.json({ error: `A card can have at most ${MAX_PER_WIDGET} alerts.` }, 400);
    // Already past the line: it starts as firing, so the first message is for the next crossing.
    const firing = parsed.data.op === "above" ? data.value > parsed.data.threshold : data.value < parsed.data.threshold;
    const [row] = await db.insert(alert).values({ id: newId(), ownerId: user.id, widgetId: found.row.id, op: parsed.data.op, threshold: parsed.data.threshold, webhook: parsed.data.webhook || null, firing, lastValue: data.value }).returning();
    return c.json({ alert: publicAlert(row!) }, 201);
  });

  app.delete("/api/v1/alerts/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const gone = await db.delete(alert).where(and(eq(alert.id, c.req.param("id")), eq(alert.ownerId, user.id))).returning({ id: alert.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  /** Every alert the person has, with the card and report it is on. */
  app.get("/api/v1/alerts", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db
      .select({ a: alert, title: widget.title, dashboardId: widget.dashboardId, report: dashboard.name })
      .from(alert)
      .innerJoin(widget, eq(widget.id, alert.widgetId))
      .innerJoin(dashboard, eq(dashboard.id, widget.dashboardId))
      .where(eq(alert.ownerId, user.id))
      .orderBy(alert.createdAt);
    return c.json({ alerts: rows.map((r) => ({ ...publicAlert(r.a), title: r.title, dashboardId: r.dashboardId, report: r.report })) });
  });

  app.get("/api/v1/notifications", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select().from(notification).where(eq(notification.userId, user.id)).orderBy(desc(notification.createdAt)).limit(30);
    const [{ unread }] = (await db.select({ unread: count() }).from(notification).where(and(eq(notification.userId, user.id), isNull(notification.readAt)))) as [{ unread: number }];
    return c.json({ notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.readAt, at: n.createdAt })), unread });
  });

  /** Mark some, or all, as read. */
  app.post("/api/v1/notifications/read", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ ids: z.array(z.string()).max(100).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "ids must be a list" }, 400);
    const mine = and(eq(notification.userId, user.id), isNull(notification.readAt));
    await db.update(notification).set({ readAt: new Date() }).where(parsed.data.ids ? and(mine, inArray(notification.id, parsed.data.ids.length ? parsed.data.ids : [""])) : mine);
    return c.body(null, 204);
  });
}
