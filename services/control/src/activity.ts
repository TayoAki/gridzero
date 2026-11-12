// The activity log: who opened, queried, changed and shared what. The owner of a thing can read its
// log. On top of it sit a usage view (what gets opened, by how many people), a cost view (query time
// and AI spending) and, for administrators named in ADMIN_EMAILS, a list of every person, connection
// and share, with "view as" to see what one person can reach.

import { and, count, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Hono } from "hono";

import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { activity, agentRun, connection, dashboard, dashboardShare, source, user as userTable, workbook, workbookShare, workspace, workspaceMember } from "./db/schema.ts";
import { env } from "./env.ts";
import { captureError } from "./errors.ts";

export interface Event {
  userId: string | null;
  kind: string;
  objectKind: string;
  objectId: string;
  label?: string;
  ownerId?: string | null;
  detail?: Record<string, unknown>;
  ms?: number;
}

/** Write one event. Never fails the request it is part of. */
export function record(e: Event): void {
  db.insert(activity)
    .values({ userId: e.userId, kind: e.kind, objectKind: e.objectKind, objectId: e.objectId, label: (e.label ?? "").slice(0, 200), ownerId: e.ownerId ?? null, detail: e.detail ?? {}, ms: e.ms == null ? null : Math.round(e.ms) })
    .catch((err: unknown) => captureError(err, { job: "activity" }));
}

export const isAdmin = (email: string) => env.adminEmails.includes(email.toLowerCase());
export const isAuditor = (email: string) => env.auditorEmails.includes(email.toLowerCase());

const days = (q: string | undefined) => ([7, 30, 90].includes(Number(q)) ? Number(q) : 30);
const since = (n: number) => new Date(Date.now() - n * 86_400_000);

async function names(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = wanted.length ? await db.select({ id: userTable.id, name: userTable.name, email: userTable.email }).from(userTable).where(inArray(userTable.id, wanted)) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Opens per report, for the reports matching `where`. */
async function reportUsage(where: ReturnType<typeof eq> | undefined, n: number) {
  const reports = await db.select({ id: dashboard.id, name: dashboard.name, ownerId: dashboard.ownerId, createdAt: dashboard.createdAt }).from(dashboard).where(where);
  if (!reports.length) return [];
  const opens = await db
    .select({ id: activity.objectId, opens: count(), people: sql<number>`count(distinct coalesce(${activity.userId}, 'link'))::int`, last: sql<string>`max(${activity.at})` })
    .from(activity)
    .where(and(eq(activity.objectKind, "report"), inArray(activity.kind, ["report.opened", "report.opened_by_link"]), gte(activity.at, since(n)), inArray(activity.objectId, reports.map((r) => r.id))))
    .groupBy(activity.objectId);
  const by = new Map(opens.map((o) => [o.id, o]));
  const who = await names(reports.map((r) => r.ownerId));
  return reports
    .map((r) => ({ id: r.id, name: r.name, owner: who.get(r.ownerId)?.name ?? "", opens: by.get(r.id)?.opens ?? 0, people: by.get(r.id)?.people ?? 0, lastOpened: by.get(r.id)?.last ?? null }))
    .sort((a, b) => b.opens - a.opens);
}

/** Query time and AI spending, by owner. */
async function cost(owner: string | null, n: number) {
  const mine = owner ? eq(activity.ownerId, owner) : undefined;
  const queries = await db
    .select({ ownerId: activity.ownerId, objectKind: activity.objectKind, objectId: activity.objectId, label: sql<string>`max(${activity.label})`, runs: count(), ms: sql<number>`coalesce(sum(${activity.ms}), 0)::int` })
    .from(activity)
    .where(and(isNotNull(activity.ms), gte(activity.at, since(n)), mine))
    .groupBy(activity.ownerId, activity.objectKind, activity.objectId)
    .orderBy(desc(sql`sum(${activity.ms})`))
    .limit(100);
  const ai = await db
    .select({ ownerId: agentRun.ownerId, runs: count(), micro: sql<number>`coalesce(sum(${agentRun.costMicroUsd}), 0)::bigint` })
    .from(agentRun)
    .where(and(gte(agentRun.startedAt, since(n)), owner ? eq(agentRun.ownerId, owner) : undefined))
    .groupBy(agentRun.ownerId);
  const who = await names([...queries.map((q) => q.ownerId), ...ai.map((a) => a.ownerId)]);
  return {
    queries: queries.map((q) => ({ owner: who.get(q.ownerId ?? "")?.name ?? "", kind: q.objectKind, id: q.objectId, label: q.label, runs: q.runs, seconds: Math.round(q.ms / 100) / 10 })),
    ai: ai.map((a) => ({ owner: who.get(a.ownerId)?.name ?? "", runs: a.runs, usd: Math.round(Number(a.micro) / 10_000) / 100 })),
  };
}

/** Everything one person can reach: reports, workbooks, workspaces and their own connections. */
async function reach(userId: string) {
  const ownedReports = await db.select({ id: dashboard.id, name: dashboard.name }).from(dashboard).where(eq(dashboard.ownerId, userId));
  const sharedReports = await db.select({ id: dashboard.id, name: dashboard.name, role: dashboardShare.role, limits: dashboardShare.limits, hide: dashboardShare.hide, minGroup: dashboard.minGroup, shareId: dashboardShare.id }).from(dashboardShare).innerJoin(dashboard, eq(dashboard.id, dashboardShare.dashboardId)).where(eq(dashboardShare.userId, userId));
  const ownedBooks = await db.select({ id: workbook.id, title: workbook.title }).from(workbook).where(eq(workbook.ownerId, userId));
  const sharedBooks = await db.select({ id: workbook.id, title: workbook.title, role: workbookShare.role }).from(workbookShare).innerJoin(workbook, eq(workbook.id, workbookShare.workbookId)).where(eq(workbookShare.userId, userId));
  const spaces = await db.select({ id: workspace.id, name: workspace.name, role: workspaceMember.role }).from(workspaceMember).innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId)).where(eq(workspaceMember.userId, userId));
  const conns = await db.select({ id: connection.id, name: connection.name, kind: connection.kind }).from(connection).where(eq(connection.ownerId, userId));
  return {
    reports: [
      ...ownedReports.map((r) => ({ id: r.id, name: r.name, role: "owner", rows: "all rows", columns: "all columns", tables: "can open the tables and queries", shareId: null as string | null })),
      ...sharedReports.map((r) => ({ id: r.id, name: r.name, role: r.role as string, rows: r.limits?.length ? r.limits.map((l) => `${l.field} is ${l.values.join(" or ")}`).join("; ") : "all rows", columns: `${r.role === "viewer" && r.hide?.length ? `never ${r.hide.join(", ")}` : "all columns"}${r.role === "viewer" && r.minGroup > 1 ? `; no group under ${r.minGroup}` : ""}`, tables: "cards only: no tables, no queries", shareId: r.shareId as string | null })),
    ],
    workbooks: [...ownedBooks.map((w) => ({ id: w.id, title: w.title, role: "owner" })), ...sharedBooks.map((w) => ({ id: w.id, title: w.title, role: w.role as string }))],
    workspaces: spaces,
    connections: conns,
  };
}

export function routes(app: Hono<{ Variables: Vars }>) {
  /** The log for one thing (for its owner, an administrator or an auditor), or for everything the person owns or did. */
  app.get("/api/v1/activity", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const all = isAdmin(user.email) || isAuditor(user.email);
    const kind = c.req.query("kind");
    const id = c.req.query("id");
    const mine = or(eq(activity.ownerId, user.id), eq(activity.userId, user.id));
    const where = kind && id ? and(eq(activity.objectKind, kind), eq(activity.objectId, id), all ? undefined : mine) : c.req.query("everyone") && all ? undefined : mine;
    const rows = await db.select().from(activity).where(where).orderBy(desc(activity.at)).limit(200);
    const who = await names(rows.map((r) => r.userId));
    return c.json({ events: rows.map((r) => ({ id: r.id, at: r.at, who: r.userId ? (who.get(r.userId)?.name || who.get(r.userId)?.email || "Someone who has left") : "Someone with the link", kind: r.kind, objectKind: r.objectKind, objectId: r.objectId, label: r.label, detail: r.detail, ms: r.ms })) });
  });

  /** What gets used: the person's own reports, or everyone's for an administrator who asks. */
  app.get("/api/v1/activity/usage", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const n = days(c.req.query("days"));
    const everyone = !!c.req.query("everyone") && isAdmin(user.email);
    const reports = await reportUsage(everyone ? undefined : eq(dashboard.ownerId, user.id), n);
    return c.json({ days: n, reports, unopened: reports.filter((r) => r.opens === 0).length, cost: await cost(everyone ? null : user.id, n) });
  });

  /** A list as a file a spreadsheet opens: reports and their use, people, spend, or contracts. */
  app.get("/api/v1/activity/export", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const what = c.req.query("what") ?? "reports";
    const n = days(c.req.query("days"));
    const admin = isAdmin(user.email);
    const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
    let head: string[], rows: unknown[][];
    if (what === "reports") {
      const list = await reportUsage(c.req.query("everyone") && admin ? undefined : eq(dashboard.ownerId, user.id), n);
      head = ["Report", "Owner", `Opens in ${n} days`, "People", "Last opened"];
      rows = list.map((r) => [r.name, r.owner, r.opens, r.people, r.lastOpened ?? ""]);
    } else if (!admin) return c.json({ error: "Only an administrator can download this." }, 403);
    else if (what === "people") {
      const people = await db.select({ id: userTable.id, name: userTable.name, email: userTable.email, joined: userTable.createdAt }).from(userTable).orderBy(userTable.createdAt).limit(5000);
      const seen = await db.select({ userId: activity.userId, last: sql<string>`max(${activity.at})`, events: count() }).from(activity).where(and(isNotNull(activity.userId), gte(activity.at, since(n)))).groupBy(activity.userId);
      const by = new Map(seen.map((s) => [s.userId, s]));
      head = ["Name", "Email", "Joined", `Active in ${n} days`, "Last active", "Events"];
      rows = people.map((p) => [p.name, p.email, p.joined.toISOString().slice(0, 10), by.has(p.id) ? "yes" : "no", by.get(p.id)?.last ?? "", by.get(p.id)?.events ?? 0]);
    } else if (what === "spend") {
      const all = await cost(null, n);
      head = ["Kind", "Owner", "What", "Runs", "Seconds or US dollars"];
      rows = [...all.queries.map((q) => ["query time", q.owner, q.label || q.id, q.runs, q.seconds]), ...all.ai.map((a) => ["AI spending", a.owner, "", a.runs, a.usd])];
    } else if (what === "contracts") {
      const { contractsWithUse } = await import("./books.ts");
      head = ["Vendor", "Product", "Seats bought", "Active here in 90 days", "Unused", "Yearly cost", "Renews on", "Days left", "Owner", "Notes"];
      rows = (await contractsWithUse()).map((k) => [k.vendor, k.product, k.seats ?? "", "active90" in k ? k.active90 : "", "unused" in k ? (k.unused ?? "") : "", k.yearlyCost ?? "", k.renewsOn ?? "", k.daysLeft ?? "", k.owner, k.notes]);
    } else return c.json({ error: "Choose reports, people, spend or contracts." }, 400);
    record({ userId: user.id, kind: "usage.downloaded", objectKind: "account", objectId: user.id, label: what, ownerId: user.id });
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="gridzero-${what}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body([head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n");
  });

  /** Everything, for administrators: people, connections and sources. */
  app.get("/api/v1/admin/overview", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!isAdmin(user.email)) return c.json({ error: "Only an administrator can see this." }, 403);
    const n = days(c.req.query("days"));
    const people = await db.select({ id: userTable.id, name: userTable.name, email: userTable.email, joined: userTable.createdAt }).from(userTable).orderBy(userTable.createdAt).limit(2000);
    const seen = await db.select({ userId: activity.userId, last: sql<string>`max(${activity.at})`, events: count() }).from(activity).where(and(isNotNull(activity.userId), gte(activity.at, since(n)))).groupBy(activity.userId);
    const bySeen = new Map(seen.map((s) => [s.userId, s]));
    const conns = await db.select({ id: connection.id, name: connection.name, kind: connection.kind, config: connection.config, ownerId: connection.ownerId, createdAt: connection.createdAt }).from(connection);
    const used = await db.select({ id: activity.objectId, last: sql<string>`max(${activity.at})`, failed: sql<number>`count(*) filter (where ${activity.kind} = 'connection.failed')::int` }).from(activity).where(eq(activity.objectKind, "connection")).groupBy(activity.objectId);
    const byUsed = new Map(used.map((u) => [u.id, u]));
    const sources = await db.select({ id: source.id, name: source.name, kind: source.kind, workspace: workspace.name }).from(source).innerJoin(workspace, eq(workspace.id, source.workspaceId));
    const who = await names(conns.map((x) => x.ownerId));
    return c.json({
      days: n,
      people: people.map((p) => ({ ...p, lastActive: bySeen.get(p.id)?.last ?? null, events: bySeen.get(p.id)?.events ?? 0, admin: isAdmin(p.email), auditor: isAuditor(p.email) })),
      active: people.filter((p) => bySeen.has(p.id)).length,
      connections: conns.map((x) => ({ id: x.id, name: x.name, kind: x.kind, host: (x.config as { host?: string; url?: string }).host ?? (x.config as { url?: string }).url ?? "", owner: who.get(x.ownerId)?.name ?? "", lastUsed: byUsed.get(x.id)?.last ?? null, failures: byUsed.get(x.id)?.failed ?? 0 })),
      sources,
    });
  });

  /** View as: what one person can reach, and how it was last changed. */
  app.get("/api/v1/admin/access", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!isAdmin(user.email)) return c.json({ error: "Only an administrator can see this." }, 403);
    const email = (c.req.query("email") ?? "").trim().toLowerCase();
    const [who] = await db.select({ id: userTable.id, name: userTable.name, email: userTable.email }).from(userTable).where(eq(userTable.email, email));
    if (!who) return c.json({ error: "Nobody has signed up with that address." }, 404);
    const changes = await db.select().from(activity).where(and(inArray(activity.kind, ["share.added", "share.changed", "share.removed", "link.changed"]), sql`${activity.detail}->>'email' = ${email}`)).orderBy(desc(activity.at)).limit(30);
    const by = await names(changes.map((x) => x.userId));
    return c.json({ person: who, ...(await reach(who.id)), changes: changes.map((x) => ({ at: x.at, kind: x.kind, label: x.label, by: by.get(x.userId ?? "")?.name ?? "", detail: x.detail })) });
  });
}
