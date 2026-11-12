// Closing a period, and keeping track of contracts.
//
// Closing a month or quarter for a workbook says its figures are certified: every report built on the
// workbook is snapshotted at that moment, the reports show the period as closed with who closed it,
// and whoever closed it is told if a definition or the data changes afterwards. Closing does not
// lock anything; it makes a later change visible.
//
// A contract is a line an administrator keeps: what was bought, what it costs and when it renews.
// Seats bought for this app are set against the people active in it, and administrators are told
// 30 days and 7 days before a renewal.

import { and, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { isAdmin, record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { activity, contract, dashboard, periodClose, user as userTable, widget } from "./db/schema.ts";
import { env } from "./env.ts";
import { captureError } from "./errors.ts";
import { access } from "./sharing.ts";
import { takeSnapshot } from "./snapshots.ts";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/;

/** The first and last day of a period: 2026-10, or 2026-Q4. */
export function periodRange(period: string): { from: string; to: string } {
  const year = Number(period.slice(0, 4));
  const q = /Q([1-4])$/.exec(period);
  const first = q ? (Number(q[1]) - 1) * 3 : Number(period.slice(5)) - 1;
  const months = q ? 3 : 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(new Date(Date.UTC(year, first, 1))), to: iso(new Date(Date.UTC(year, first + months, 0))) };
}

/** The closed periods of the workbooks a report's cards read. */
export async function closedFor(workbookIds: string[]) {
  if (!workbookIds.length) return [];
  const rows = await db.select({ period: periodClose.period, at: periodClose.closedAt, note: periodClose.note, by: userTable.name }).from(periodClose).innerJoin(userTable, eq(userTable.id, periodClose.closedBy)).where(inArray(periodClose.workbookId, workbookIds)).orderBy(periodClose.period);
  return rows.map((r) => ({ period: r.period, ...periodRange(r.period), by: r.by, at: r.at, note: r.note }));
}

/** Tell whoever closed a period that something under it has changed since. */
export async function warnClosers(workbookId: string, what: string, byUserId: string | null): Promise<number> {
  const rows = await db.select().from(periodClose).where(eq(periodClose.workbookId, workbookId));
  const closers = new Map<string, string[]>();
  for (const r of rows) closers.set(r.closedBy, [...(closers.get(r.closedBy) ?? []), r.period]);
  for (const [id, periods] of closers) if (id !== byUserId) await notify(id, "close", `Something changed after you closed ${periods.join(", ")}`, `${what} The snapshots taken at the close still show the certified figures.`, `/workbook/${workbookId}`);
  return closers.size;
}

/** Tell administrators about renewals 30 days and 7 days out, once each. */
export async function remindRenewals(now = new Date()): Promise<number> {
  const rows = await db.select().from(contract).where(isNotNull(contract.renewsOn));
  let told = 0;
  for (const k of rows) {
    const left = Math.ceil((new Date(`${k.renewsOn}T00:00:00Z`).getTime() - now.getTime()) / 86_400_000);
    const stage = left <= 7 ? 7 : left <= 30 ? 30 : null;
    if (left < 0 || stage === null || (k.reminded !== null && k.reminded <= stage)) continue;
    const claimed = await db.update(contract).set({ reminded: stage }).where(and(eq(contract.id, k.id), sql`${contract.reminded} is distinct from ${stage}`)).returning({ id: contract.id });
    if (!claimed.length) continue;
    const admins = env.adminEmails.length ? await db.select({ id: userTable.id }).from(userTable).where(inArray(userTable.email, env.adminEmails)) : [];
    for (const a of admins) await notify(a.id, "renewal", `${k.vendor}${k.product ? ` ${k.product}` : ""} renews in ${left} day${left === 1 ? "" : "s"}`, `${k.seats ? `${k.seats} seats. ` : ""}${k.yearlyCost ? `${k.yearlyCost.toLocaleString("en-US")} a year. ` : ""}${k.owner ? `Owner: ${k.owner}.` : ""}`.trim(), "/admin");
    told++;
  }
  return told;
}

/** The contracts, each with the days left and, for this app's seats, how many people are active. */
export async function contractsWithUse() {
  const rows = await db.select().from(contract).orderBy(contract.renewsOn);
  const [{ active }] = (await db.select({ active: sql<number>`count(distinct ${activity.userId})::int` }).from(activity).where(and(isNotNull(activity.userId), gte(activity.at, new Date(Date.now() - 90 * 86_400_000))))) as [{ active: number }];
  const [{ people }] = (await db.select({ people: count() }).from(userTable)) as [{ people: number }];
  return rows.map((k) => ({ id: k.id, vendor: k.vendor, product: k.product, seats: k.seats, countsHere: k.countsHere, yearlyCost: k.yearlyCost, renewsOn: k.renewsOn, owner: k.owner, notes: k.notes, daysLeft: k.renewsOn ? Math.ceil((new Date(`${k.renewsOn}T00:00:00Z`).getTime() - Date.now()) / 86_400_000) : null, ...(k.countsHere ? { signedUp: people, active90: active, unused: k.seats === null ? null : Math.max(0, k.seats - active) } : {}) }));
}

export function routes(app: Hono<{ Variables: Vars }>) {
  // --- closing a period ---------------------------------------------------------

  app.get("/api/v1/workbooks/:id/periods", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await access(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    return c.json({ closed: await closedFor([c.req.param("id")]) });
  });

  /** Close a period. Every report built on the workbook is refreshed and snapshotted, and its owner told. */
  app.post("/api/v1/workbooks/:id/periods", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot close a period." }, 403);
    const parsed = z.object({ period: z.string().regex(PERIOD), note: z.string().trim().max(300).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A period is a month, written 2026-10, or a quarter, written 2026-Q4." }, 400);
    const { period } = parsed.data;
    if (periodRange(period).to >= new Date().toISOString().slice(0, 10)) return c.json({ error: "That period has not ended yet." }, 400);
    const [taken] = await db.select({ id: periodClose.id }).from(periodClose).where(and(eq(periodClose.workbookId, found.row.id), eq(periodClose.period, period)));
    if (taken) return c.json({ error: `${period} is already closed.` }, 409);
    const cards = await db.select({ dashboardId: widget.dashboardId }).from(widget).where(sql`${widget.source}->>'workbookId' = ${found.row.id}`);
    const reports = cards.length ? await db.select().from(dashboard).where(inArray(dashboard.id, [...new Set(cards.map((k) => k.dashboardId))])) : [];
    const snapshots: string[] = [];
    for (const r of reports) {
      const snap = await takeSnapshot(r.id, r.ownerId, user.id, `Closed ${period}`, true).catch((e: unknown) => (captureError(e, { job: "close" }), null));
      if (snap) snapshots.push(snap.id);
      if (r.ownerId !== user.id) await notify(r.ownerId, "close", `${period} is closed for ${found.row.title}`, `${user.name || user.email} certified it. ${r.name} was snapshotted as it stood.`, `/dashboards/${r.id}`);
    }
    await db.insert(periodClose).values({ id: newId(), workbookId: found.row.id, period, closedBy: user.id, note: parsed.data.note ?? "", snapshots });
    record({ userId: user.id, kind: "period.closed", objectKind: "workbook", objectId: found.row.id, label: period, ownerId: found.row.ownerId, detail: { reports: reports.length } });
    return c.json({ period, ...periodRange(period), snapshots: snapshots.length }, 201);
  });

  /** Reopen a period. Only the workbook's owner; it is logged, and the snapshots from the close are kept. */
  app.delete("/api/v1/workbooks/:id/periods/:period", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const gone = await db.delete(periodClose).where(and(eq(periodClose.workbookId, found.row.id), eq(periodClose.period, c.req.param("period")))).returning({ by: periodClose.closedBy });
    if (!gone.length) return c.json({ error: "not found" }, 404);
    if (gone[0]!.by !== user.id) await notify(gone[0]!.by, "close", `${c.req.param("period")} was reopened for ${found.row.title}`, `${user.name || user.email} reopened it.`, `/workbook/${found.row.id}`);
    record({ userId: user.id, kind: "period.reopened", objectKind: "workbook", objectId: found.row.id, label: c.req.param("period"), ownerId: found.row.ownerId });
    return c.body(null, 204);
  });

  // --- contracts ----------------------------------------------------------------

  const shape = z.object({ vendor: z.string().trim().min(1).max(80), product: z.string().trim().max(80).optional(), seats: z.number().int().min(0).max(1_000_000).nullable().optional(), countsHere: z.boolean().optional(), yearlyCost: z.number().min(0).max(1e12).nullable().optional(), renewsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), owner: z.string().trim().max(120).optional(), notes: z.string().trim().max(1000).optional() }).strict();

  app.get("/api/v1/admin/contracts", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!isAdmin(user.email)) return c.json({ error: "Only an administrator can see this." }, 403);
    return c.json({ contracts: await contractsWithUse() });
  });

  app.post("/api/v1/admin/contracts", async (c) => {
    const user = c.get("user");
    if (!user || !isAdmin(user.email)) return c.json({ error: "Only an administrator can do this." }, user ? 403 : 401);
    const parsed = shape.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A contract needs a vendor. A renewal date is written YYYY-MM-DD." }, 400);
    const p = parsed.data;
    const [row] = await db.insert(contract).values({ id: newId(), vendor: p.vendor, product: p.product ?? "", seats: p.seats ?? null, countsHere: p.countsHere ?? false, yearlyCost: p.yearlyCost ?? null, renewsOn: p.renewsOn ?? null, owner: p.owner ?? "", notes: p.notes ?? "", createdBy: user.id }).returning({ id: contract.id });
    return c.json({ id: row!.id }, 201);
  });

  app.patch("/api/v1/admin/contracts/:id", async (c) => {
    const user = c.get("user");
    if (!user || !isAdmin(user.email)) return c.json({ error: "Only an administrator can do this." }, user ? 403 : 401);
    const parsed = shape.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "That change was not understood." }, 400);
    // A new renewal date starts the reminders again.
    const [row] = await db.update(contract).set({ ...parsed.data, ...(parsed.data.renewsOn !== undefined ? { reminded: null } : {}) }).where(eq(contract.id, c.req.param("id"))).returning({ id: contract.id });
    return row ? c.json({ id: row.id }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/api/v1/admin/contracts/:id", async (c) => {
    const user = c.get("user");
    if (!user || !isAdmin(user.email)) return c.json({ error: "Only an administrator can do this." }, user ? 403 : 401);
    const gone = await db.delete(contract).where(eq(contract.id, c.req.param("id"))).returning({ id: contract.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
}
