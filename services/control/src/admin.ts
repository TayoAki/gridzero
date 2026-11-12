// What administrators can do, and what is kept for them: change or remove anyone's access to a report,
// keep groups of people, let the identity provider add and switch off people (SCIM), set the starter
// list for each kind of work, see the questions people ask most, and read reliability, quality and
// warehouse spend over time.

import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { isAdmin, record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { activity, agent, agentMessage, checkRun, checklist, checklistDone, connectedTable, dashboard, dashboardGroupShare, dashboardShare, dataCheck, deactivatedUser, groupMember, peopleGroup, session as sessionTable, setting, user as userTable } from "./db/schema.ts";
import { TablesError, queryTables } from "./definitions/tables.ts";
import { env } from "./env.ts";
import { sensitiveOn } from "./fields.ts";
import { access } from "./sharing.ts";
import { dashboardAccess } from "./widgets/access.ts";

const LENSES = ["decide", "analyse", "build", "govern", "run"] as const;
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
const days = (v: string | undefined, d = 90) => ([7, 30, 90, 365].includes(Number(v)) ? Number(v) : d);
const since = (n: number) => new Date(Date.now() - n * 86_400_000);

export async function isDeactivated(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: deactivatedUser.userId }).from(deactivatedUser).where(eq(deactivatedUser.userId, userId));
  return !!row;
}

/** The warehouse's own bill, read from a table someone has pointed to: total, by day and by owner. */
async function warehouseSpend(n: number) {
  const [row] = await db.select().from(setting).where(eq(setting.key, "billing"));
  const b = row?.value as { workbookId: string; table: string; date: string; cost: string; owner?: string | null } | undefined;
  if (!b) return null;
  const from = since(n).toISOString().slice(0, 10);
  try {
    const where = `WHERE CAST(${q(b.date)} AS DATE) >= DATE '${from}'`;
    const total = await queryTables(b.workbookId, `SELECT COALESCE(SUM(${q(b.cost)}), 0) FROM ${q(b.table)} ${where}`, 1);
    const byDay = await queryTables(b.workbookId, `SELECT strftime(CAST(${q(b.date)} AS DATE), '%Y-%m-%d'), SUM(${q(b.cost)}) FROM ${q(b.table)} ${where} GROUP BY 1 ORDER BY 1`, 400);
    const byOwner = b.owner ? await queryTables(b.workbookId, `SELECT CAST(${q(b.owner)} AS VARCHAR), SUM(${q(b.cost)}) FROM ${q(b.table)} ${where} GROUP BY 1 ORDER BY 2 DESC`, 50) : null;
    return { table: b.table, total: Number(total.rows[0]?.[0] ?? 0), byDay: byDay.rows.map((r) => ({ day: r[0], cost: Number(r[1]) })), byOwner: byOwner ? byOwner.rows.map((r) => ({ owner: r[0], cost: Number(r[1]) })) : null };
  } catch (e) {
    return { table: b.table, error: e instanceof TablesError ? e.message : "The billing table could not be read." };
  }
}

export function routes(app: Hono<{ Variables: Vars }>) {
  const admin = (c: { get: (k: "user") => Vars["user"] }) => {
    const user = c.get("user");
    return user && isAdmin(user.email) ? user : null;
  };

  // --- other people's access ----------------------------------------------------

  /** Change or remove someone's access to a report. The report's owner is told, and it is logged as the administrator's doing. */
  app.patch("/api/v1/admin/shares/:id", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: c.get("user") ? "Only an administrator can do this." : "unauthenticated" }, c.get("user") ? 403 : 401);
    const parsed = z.object({ role: z.enum(["viewer", "editor"]).optional(), remove: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || (!parsed.data.role && !parsed.data.remove)) return c.json({ error: "Say the new role, or that the access is to be removed." }, 400);
    const [share] = await db.select().from(dashboardShare).where(eq(dashboardShare.id, c.req.param("id")));
    const [board] = share ? await db.select().from(dashboard).where(eq(dashboard.id, share.dashboardId)) : [];
    if (!share || !board) return c.json({ error: "not found" }, 404);
    if (parsed.data.remove) await db.delete(dashboardShare).where(eq(dashboardShare.id, share.id));
    // An editor cannot be guarded, so making someone an editor lifts their limits; that is the owner's to decide.
    else if (parsed.data.role === "editor" && (share.limits?.length || share.hide?.length || share.mask?.length)) return c.json({ error: "This person is held to certain rows or columns. Only the report's owner can make them an editor." }, 400);
    else await db.update(dashboardShare).set({ role: parsed.data.role }).where(eq(dashboardShare.id, share.id));
    record({ userId: me.id, kind: parsed.data.remove ? "share.removed" : "share.changed", objectKind: "report", objectId: board.id, label: board.name, ownerId: board.ownerId, detail: { email: share.email, role: parsed.data.role ?? null, byAdministrator: true } });
    if (board.ownerId !== me.id) await notify(board.ownerId, "share", `An administrator ${parsed.data.remove ? "removed" : "changed"} ${share.email}'s access to ${board.name}`, `${me.name || me.email} did this.`, `/dashboards/${board.id}`);
    return c.json({ ok: true });
  });

  // --- groups -------------------------------------------------------------------

  const groupsWith = async () => {
    const groups = await db.select().from(peopleGroup).orderBy(peopleGroup.name);
    const members = groups.length ? await db.select({ groupId: groupMember.groupId, email: userTable.email, name: userTable.name }).from(groupMember).innerJoin(userTable, eq(userTable.id, groupMember.userId)) : [];
    return groups.map((g) => ({ id: g.id, name: g.name, members: members.filter((m) => m.groupId === g.id).map((m) => ({ email: m.email, name: m.name })) }));
  };

  /** Group names, for anyone choosing who to share with; the members are for administrators. */
  app.get("/api/v1/groups", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const all = await groupsWith();
    return c.json({ groups: all.map((g) => (isAdmin(user.email) ? g : { id: g.id, name: g.name, members: g.members.length })) });
  });

  app.post("/api/v1/admin/groups", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const parsed = z.object({ name: z.string().trim().min(2).max(60) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A group needs a name of 2 to 60 characters." }, 400);
    const [taken] = await db.select({ id: peopleGroup.id }).from(peopleGroup).where(eq(peopleGroup.name, parsed.data.name));
    if (taken) return c.json({ error: "There is already a group with that name." }, 409);
    const [row] = await db.insert(peopleGroup).values({ id: newId(), name: parsed.data.name, createdBy: me.id }).returning();
    return c.json({ group: { id: row!.id, name: row!.name, members: [] } }, 201);
  });

  app.put("/api/v1/admin/groups/:id/members", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const parsed = z.object({ email: z.string().trim().toLowerCase().email(), on: z.boolean() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Give an email address, and say in or out." }, 400);
    const [g] = await db.select().from(peopleGroup).where(eq(peopleGroup.id, c.req.param("id")));
    const [who] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, parsed.data.email));
    if (!g) return c.json({ error: "not found" }, 404);
    if (!who) return c.json({ error: "Nobody has signed up with that address." }, 400);
    if (parsed.data.on) await db.insert(groupMember).values({ groupId: g.id, userId: who.id }).onConflictDoNothing();
    else await db.delete(groupMember).where(and(eq(groupMember.groupId, g.id), eq(groupMember.userId, who.id)));
    record({ userId: me.id, kind: parsed.data.on ? "group.joined" : "group.left", objectKind: "group", objectId: g.id, label: g.name, ownerId: me.id, detail: { email: parsed.data.email } });
    return c.json({ ok: true });
  });

  app.delete("/api/v1/admin/groups/:id", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const gone = await db.delete(peopleGroup).where(eq(peopleGroup.id, c.req.param("id"))).returning({ id: peopleGroup.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  /** Share a report with a group: its members become viewers, with the guards given here. */
  app.put("/api/v1/dashboards/:id/group-shares", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const list = z.array(z.string().trim().min(1).max(200)).max(50);
    const parsed = z.object({ groupId: z.string().min(1).max(64), limits: z.array(z.object({ field: z.string().trim().min(1).max(200), values: z.array(z.string().max(500)).min(1).max(200) }).strict()).max(5).optional(), hide: list.optional(), mask: list.optional(), acknowledge: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Choose a group." }, 400);
    // The same rule as sharing with a person: a sensitive field is hidden, masked, or shared on purpose.
    const kept = [...(parsed.data.hide ?? []), ...(parsed.data.mask ?? [])].map((x) => x.toLowerCase());
    const exposed = (await sensitiveOn(found.row.id)).filter((f) => !kept.includes(f.toLowerCase()));
    if (exposed.length && !parsed.data.acknowledge) return c.json({ error: `This report reads fields marked sensitive: ${exposed.join(", ")}. Hide or mask them for this group, or confirm you mean to share them.`, sensitive: exposed }, 409);
    const [g] = await db.select().from(peopleGroup).where(eq(peopleGroup.id, parsed.data.groupId));
    if (!g) return c.json({ error: "not found" }, 404);
    const values = { limits: parsed.data.limits?.length ? parsed.data.limits : null, hide: parsed.data.hide?.length ? parsed.data.hide : null, mask: parsed.data.mask?.length ? parsed.data.mask : null };
    await db.insert(dashboardGroupShare).values({ id: newId(), dashboardId: found.row.id, groupId: g.id, ...values }).onConflictDoUpdate({ target: [dashboardGroupShare.dashboardId, dashboardGroupShare.groupId], set: values });
    if (exposed.length) record({ userId: user.id, kind: "share.sensitive_approved", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { email: `the group ${g.name}`, fields: exposed } });
    record({ userId: user.id, kind: "share.added", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { email: `the group ${g.name}`, role: "viewer", limits: values.limits } });
    return c.json({ group: g.name });
  });

  app.get("/api/v1/dashboards/:id/group-shares", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    const rows = await db.select({ id: dashboardGroupShare.id, groupId: dashboardGroupShare.groupId, name: peopleGroup.name, limits: dashboardGroupShare.limits, hide: dashboardGroupShare.hide, mask: dashboardGroupShare.mask }).from(dashboardGroupShare).innerJoin(peopleGroup, eq(peopleGroup.id, dashboardGroupShare.groupId)).where(eq(dashboardGroupShare.dashboardId, found.row.id));
    return c.json({ shares: rows.map((r) => ({ ...r, limits: r.limits ?? [], hide: r.hide ?? [], mask: r.mask ?? [] })) });
  });

  app.delete("/api/v1/dashboards/:id/group-shares/:groupId", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    await db.delete(dashboardGroupShare).where(and(eq(dashboardGroupShare.dashboardId, found.row.id), eq(dashboardGroupShare.groupId, c.req.param("groupId"))));
    return c.body(null, 204);
  });

  // --- the starter list ---------------------------------------------------------

  app.get("/api/v1/checklists/:lens", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [list] = await db.select().from(checklist).where(eq(checklist.lens, c.req.param("lens")));
    const [mine] = await db.select().from(checklistDone).where(and(eq(checklistDone.userId, user.id), eq(checklistDone.lens, c.req.param("lens"))));
    const done = new Set(mine?.done ?? []);
    return c.json({ items: (list?.items ?? []).map((i) => ({ ...i, done: done.has(i.text) })) });
  });

  app.put("/api/v1/admin/checklists/:lens", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const lens = c.req.param("lens");
    const parsed = z.object({ items: z.array(z.object({ text: z.string().trim().min(2).max(140), link: z.string().trim().max(200).regex(/^\//).nullable().optional() }).strict()).max(12) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!(LENSES as readonly string[]).includes(lens) || !parsed.success) return c.json({ error: "A list has up to 12 steps of 2 to 140 characters; a link starts with /." }, 400);
    const items = parsed.data.items.map((i) => ({ text: i.text, link: i.link ?? null }));
    await db.insert(checklist).values({ lens, items, updatedBy: me.id }).onConflictDoUpdate({ target: checklist.lens, set: { items, updatedBy: me.id, updatedAt: new Date() } });
    return c.json({ items });
  });

  app.post("/api/v1/checklists/:lens/done", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ text: z.string().max(140), on: z.boolean() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Say which step, and done or not." }, 400);
    const lens = c.req.param("lens");
    const [mine] = await db.select().from(checklistDone).where(and(eq(checklistDone.userId, user.id), eq(checklistDone.lens, lens)));
    const done = new Set(mine?.done ?? []);
    if (parsed.data.on) done.add(parsed.data.text);
    else done.delete(parsed.data.text);
    await db.insert(checklistDone).values({ userId: user.id, lens, done: [...done] }).onConflictDoUpdate({ target: [checklistDone.userId, checklistDone.lens], set: { done: [...done] } });
    return c.json({ done: [...done] });
  });

  /** How far people have got through the starter lists. */
  app.get("/api/v1/admin/checklists", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const lists = await db.select().from(checklist);
    const done = await db.select().from(checklistDone);
    return c.json({ lists: lists.map((l) => ({ lens: l.lens, items: l.items.map((i) => ({ ...i, people: done.filter((d) => d.lens === l.lens && d.done.includes(i.text)).length })), started: done.filter((d) => d.lens === l.lens && d.done.length).length })) });
  });

  // --- what people ask ----------------------------------------------------------

  /** The questions put to agents more than once, by how many times and by how many people. No names. */
  app.get("/api/v1/admin/questions", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const n = days(c.req.query("days"), 30);
    const rows = await db.select({ content: agentMessage.content, visible: agentMessage.visible, owner: agent.ownerId }).from(agentMessage).innerJoin(agent, eq(agent.id, agentMessage.agentId)).where(and(eq(agentMessage.role, "user"), gte(agentMessage.createdAt, since(n)))).orderBy(desc(agentMessage.createdAt)).limit(5000);
    const seen = new Map<string, { text: string; times: number; people: Set<string> }>();
    for (const r of rows) {
      const parts = Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : [];
      const text = (r.visible ?? parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")).trim();
      // What a tool sent back is stored as a user turn too; a question is short and has no tool result in it.
      if (!text || text.length > 200 || parts.some((p) => p.type === "tool_result")) continue;
      const key = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
      if (key.length < 6) continue;
      const hit = seen.get(key) ?? { text, times: 0, people: new Set<string>() };
      hit.times++;
      hit.people.add(r.owner);
      seen.set(key, hit);
    }
    // ?about=churn keeps only the questions that mention a word.
    const about = (c.req.query("about") ?? "").trim().toLowerCase();
    const asked = [...seen.values()].filter((x) => x.times >= 2 && (!about || x.text.toLowerCase().includes(about))).sort((a, b) => b.people.size - a.people.size || b.times - a.times).slice(0, 30);
    return c.json({ days: n, questions: asked.map((x) => ({ text: x.text, times: x.times, people: x.people.size })), read: rows.length });
  });

  // --- reliability, quality, spend ----------------------------------------------

  /** How often each connected table was late or failed, and for how long, by week. */
  app.get("/api/v1/activity/reliability", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const n = days(c.req.query("days"));
    const all = !!c.req.query("everyone") && isAdmin(user.email);
    const rows = await db.select().from(activity).where(and(inArray(activity.kind, ["table.late", "table.recovered", "connection.used", "connection.failed"]), gte(activity.at, since(n)), all ? undefined : eq(activity.ownerId, user.id))).orderBy(activity.at).limit(20_000);
    const by = new Map<string, { name: string; refreshes: number; failed: number; incidents: number; lateHours: number; openSince: Date | null }>();
    const weeks = new Map<string, { week: string; incidents: number; failed: number; refreshes: number }>();
    const weekOf = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    for (const e of rows) {
      const t = by.get(e.label) ?? { name: e.label, refreshes: 0, failed: 0, incidents: 0, lateHours: 0, openSince: null };
      const w = weeks.get(weekOf(e.at)) ?? { week: weekOf(e.at), incidents: 0, failed: 0, refreshes: 0 };
      if (e.kind === "connection.used") { t.refreshes++; w.refreshes++; }
      if (e.kind === "connection.failed") { t.refreshes++; t.failed++; w.refreshes++; w.failed++; }
      if (e.kind === "table.late") { t.incidents++; w.incidents++; t.openSince = e.at; }
      if (e.kind === "table.recovered" && t.openSince) { t.lateHours += (e.at.getTime() - t.openSince.getTime()) / 3_600_000; t.openSince = null; }
      by.set(e.label, t);
      weeks.set(w.week, w);
    }
    const tables = [...by.values()].map((t) => ({ name: t.name, refreshes: t.refreshes, failed: t.failed, onTime: t.refreshes ? Math.round(((t.refreshes - t.failed) / t.refreshes) * 1000) / 10 : null, incidents: t.incidents, lateHours: Math.round((t.lateHours + (t.openSince ? (Date.now() - t.openSince.getTime()) / 3_600_000 : 0)) * 10) / 10, lateNow: !!t.openSince }));
    const watched = await db.select({ id: connectedTable.id }).from(connectedTable).where(sql`${connectedTable.expectEveryHours} is not null`);
    const total = tables.reduce((a, t) => a + t.refreshes, 0), failed = tables.reduce((a, t) => a + t.failed, 0);
    return c.json({ days: n, score: total ? Math.round(((total - failed) / total) * 1000) / 10 : null, watched: watched.length, tables: tables.sort((a, b) => b.incidents - a.incidents || b.failed - a.failed), weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)) });
  });

  /** Each check's record over time, and the share of runs that passed, day by day. */
  app.get("/api/v1/workbooks/:id/quality", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await access(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const n = days(c.req.query("days"), 30);
    const checks = await db.select({ id: dataCheck.id, name: dataCheck.name }).from(dataCheck).where(eq(dataCheck.workbookId, c.req.param("id")));
    const runs = await db.select().from(checkRun).where(and(eq(checkRun.workbookId, c.req.param("id")), gte(checkRun.at, since(n)))).orderBy(checkRun.at).limit(20_000);
    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const byDay = new Map<string, { day: string; runs: number; passed: number }>();
    for (const r of runs) {
      const d = byDay.get(dayOf(r.at)) ?? { day: dayOf(r.at), runs: 0, passed: 0 };
      d.runs++;
      if (r.status === "ok") d.passed++;
      byDay.set(d.day, d);
    }
    const passed = runs.filter((r) => r.status === "ok").length;
    return c.json({
      days: n,
      score: runs.length ? Math.round((passed / runs.length) * 1000) / 10 : null,
      runs: runs.length,
      checks: [
        ...checks.map((k) => ({ id: k.id, name: k.name, removed: false, mine: runs.filter((r) => r.checkId === k.id) })),
        // A check that was removed keeps its record, so taking a failing check away does not tidy up the score.
        ...[...new Set(runs.filter((r) => r.checkId === null).map((r) => r.checkName))].map((name) => ({ id: `removed:${name}`, name: name || "A removed check", removed: true, mine: runs.filter((r) => r.checkId === null && r.checkName === name) })),
      ].map(({ mine, ...k }) => { return { ...k, runs: mine.length, passRate: mine.length ? Math.round((mine.filter((r) => r.status === "ok").length / mine.length) * 1000) / 10 : null, last: mine.slice(-20).map((r) => ({ at: r.at, status: r.status, count: r.count })) }; }),
      byDay: [...byDay.values()].map((d) => ({ ...d, score: Math.round((d.passed / d.runs) * 1000) / 10 })),
    });
  });

  /** Point at the table that holds the warehouse's bill: a date, a cost and, if there is one, who it is charged to. */
  app.put("/api/v1/admin/billing", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    const parsed = z.object({ workbookId: z.string().min(1).max(64), table: z.string().min(1).max(200), date: z.string().min(1).max(200), cost: z.string().min(1).max(200), owner: z.string().max(200).nullable().optional() }).strict().nullable().safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Name the workbook, the table, and its date and cost columns." }, 400);
    if (!parsed.data) {
      await db.delete(setting).where(eq(setting.key, "billing"));
      return c.json({ billing: null });
    }
    if (!(await access(me.id, parsed.data.workbookId))) return c.json({ error: "You cannot open that workbook." }, 404);
    try {
      await queryTables(parsed.data.workbookId, `SELECT CAST(${q(parsed.data.date)} AS DATE), SUM(${q(parsed.data.cost)})${parsed.data.owner ? `, CAST(${q(parsed.data.owner)} AS VARCHAR)` : ""} FROM ${q(parsed.data.table)} GROUP BY ALL LIMIT 1`, 1);
    } catch (e) {
      return c.json({ error: e instanceof TablesError ? e.message : "That table does not have those columns, or the date and cost cannot be read as a date and a number." }, 400);
    }
    await db.insert(setting).values({ key: "billing", value: parsed.data, updatedBy: me.id }).onConflictDoUpdate({ target: setting.key, set: { value: parsed.data, updatedBy: me.id } });
    return c.json({ billing: parsed.data });
  });

  app.get("/api/v1/admin/spend", async (c) => {
    const me = admin(c);
    if (!me) return c.json({ error: "Only an administrator can do this." }, 403);
    return c.json({ days: days(c.req.query("days"), 30), warehouse: await warehouseSpend(days(c.req.query("days"), 30)) });
  });

  // --- the identity provider adds and switches off people (SCIM 2.0) --------------

  const scimUser = (u: { id: string; email: string; name: string }, active: boolean) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id: u.id, userName: u.email, displayName: u.name, name: { formatted: u.name }, emails: [{ value: u.email, primary: true }], active, meta: { resourceType: "User" } });
  const scimError = (c: { json: (b: unknown, s: 400 | 401 | 404 | 409) => Response }, status: 400 | 401 | 404 | 409, detail: string) => c.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail }, status);
  const scimAuth = (header: string | undefined) => !!env.scimToken && header === `Bearer ${env.scimToken}`;
  const setActive = async (id: string, active: boolean) => {
    if (active) await db.delete(deactivatedUser).where(eq(deactivatedUser.userId, id));
    else {
      await db.insert(deactivatedUser).values({ userId: id }).onConflictDoNothing();
      // Signed out everywhere, at once.
      await db.delete(sessionTable).where(eq(sessionTable.userId, id));
    }
  };

  app.get("/scim/v2/Users", async (c) => {
    if (!scimAuth(c.req.header("authorization"))) return scimError(c, 401, "A valid bearer token is required.");
    const match = /^userName eq "([^"]+)"$/i.exec(c.req.query("filter") ?? "");
    const rows = match ? await db.select().from(userTable).where(eq(userTable.email, match[1]!.toLowerCase())) : await db.select().from(userTable).orderBy(userTable.createdAt).limit(200);
    const off = new Set((await db.select().from(deactivatedUser)).map((d) => d.userId));
    return c.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: rows.length, startIndex: 1, itemsPerPage: rows.length, Resources: rows.map((u) => scimUser(u, !off.has(u.id))) });
  });

  app.post("/scim/v2/Users", async (c) => {
    if (!scimAuth(c.req.header("authorization"))) return scimError(c, 401, "A valid bearer token is required.");
    const body = (await c.req.json().catch(() => ({}))) as { userName?: string; displayName?: string; name?: { formatted?: string; givenName?: string; familyName?: string }; active?: boolean };
    const email = (body.userName ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return scimError(c, 400, "userName must be an email address.");
    const [taken] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email));
    if (taken) return scimError(c, 409, "A person with that address already exists.");
    const name = (body.displayName ?? body.name?.formatted ?? [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ")).trim() || email.split("@")[0]!;
    // No password: the person signs in through the company's identity provider.
    const [row] = await db.insert(userTable).values({ id: randomUUID().replace(/-/g, ""), name, email, emailVerified: true }).returning();
    if (body.active === false) await setActive(row!.id, false);
    record({ userId: null, kind: "person.provisioned", objectKind: "account", objectId: row!.id, label: email, ownerId: row!.id });
    return c.json(scimUser(row!, body.active !== false), 201);
  });

  app.get("/scim/v2/Users/:id", async (c) => {
    if (!scimAuth(c.req.header("authorization"))) return scimError(c, 401, "A valid bearer token is required.");
    const [row] = await db.select().from(userTable).where(eq(userTable.id, c.req.param("id")));
    return row ? c.json(scimUser(row, !(await isDeactivated(row.id)))) : scimError(c, 404, "No such person.");
  });

  /** Switch someone off or on again. Both the PATCH and the PUT that identity providers send are understood. */
  app.on(["PATCH", "PUT"], "/scim/v2/Users/:id", async (c) => {
    if (!scimAuth(c.req.header("authorization"))) return scimError(c, 401, "A valid bearer token is required.");
    const [row] = await db.select().from(userTable).where(eq(userTable.id, c.req.param("id")));
    if (!row) return scimError(c, 404, "No such person.");
    const body = (await c.req.json().catch(() => ({}))) as { active?: boolean; Operations?: { op?: string; path?: string; value?: unknown }[] };
    let active: boolean | undefined = typeof body.active === "boolean" ? body.active : undefined;
    for (const op of body.Operations ?? []) {
      const v = op.value as { active?: unknown } | boolean | string | undefined;
      if (op.path === "active") active = v === true || v === "true" || v === "True";
      else if (v && typeof v === "object" && "active" in v) active = v.active === true || v.active === "true";
    }
    if (active !== undefined) {
      await setActive(row.id, active);
      record({ userId: null, kind: active ? "person.switched_on" : "person.switched_off", objectKind: "account", objectId: row.id, label: row.email, ownerId: row.id });
    }
    return c.json(scimUser(row, !(await isDeactivated(row.id))));
  });

  app.delete("/scim/v2/Users/:id", async (c) => {
    if (!scimAuth(c.req.header("authorization"))) return scimError(c, 401, "A valid bearer token is required.");
    const [row] = await db.select().from(userTable).where(eq(userTable.id, c.req.param("id")));
    if (!row) return scimError(c, 404, "No such person.");
    // Switched off, not erased: what they own stays until an owner or administrator decides.
    await setActive(row.id, false);
    record({ userId: null, kind: "person.switched_off", objectKind: "account", objectId: row.id, label: row.email, ownerId: row.id });
    return c.body(null, 204);
  });
}
