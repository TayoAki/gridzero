// Work that hangs off a thing, and who answers for it.
//
// An action is something a person must do, with a due date; it can be done or escalated. A decision
// records what was decided. A request asks for a report or dataset and runs from new to signed off by
// whoever asked. An issue is a defect in the data, followed until someone other than the fixer has
// verified it. Each keeps a trail of what happened.

import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { dashboard, definition, ownership, source, user as userTable, widget, workItem, workspaceMember } from "./db/schema.ts";
import { canEdit as canEditDefs, definitionFor, sourceFor } from "./definitions/store.ts";
import { access } from "./sharing.ts";
import { dashboardAccess, widgetAccess } from "./widgets/access.ts";

export type WorkKind = "action" | "decision" | "request" | "issue";
type Row = typeof workItem.$inferSelect;
const KINDS = ["action", "decision", "request", "issue"] as const;
const OBJECTS = ["workbook", "table", "field", "source", "definition", "card", "report"] as const;
const FIRST: Record<WorkKind, string> = { action: "open", decision: "recorded", request: "new", issue: "open" };
const CLOSED = new Set(["done", "recorded", "signed_off", "declined", "verified"]);
/** from → to → who may make the move. */
const MOVES: Record<WorkKind, Record<string, Record<string, "assignee" | "creator" | "either" | "not_fixer">>> = {
  action: { open: { done: "either", escalated: "assignee" }, escalated: { done: "either", open: "creator" } },
  decision: {},
  request: { new: { accepted: "assignee", declined: "assignee" }, accepted: { built: "assignee", declined: "assignee" }, built: { signed_off: "creator", accepted: "creator" } },
  issue: { open: { fixing: "assignee", fixed: "assignee" }, fixing: { fixed: "assignee", open: "assignee" }, fixed: { verified: "not_fixer", open: "either" } },
};
const WORDS: Record<string, string> = { open: "reopened it", done: "marked it done", escalated: "escalated it", accepted: "accepted it", declined: "declined it", built: "said it is built", signed_off: "signed it off", fixing: "started on it", fixed: "said it is fixed", verified: "verified the fix" };

/** What a thing is called, who it belongs to and where it opens, if this person may see it at all. */
export async function describe(userId: string, kind: string, id: string): Promise<{ label: string; ownerId: string | null; link: string | null; edit: boolean } | null> {
  if (kind === "report") {
    const f = await dashboardAccess(userId, id);
    return f ? { label: f.row.name, ownerId: f.row.ownerId, link: `/dashboards/${id}`, edit: f.role !== "viewer" } : null;
  }
  if (kind === "card") {
    const f = await widgetAccess(userId, id);
    return f ? { label: f.row.title, ownerId: f.board.ownerId, link: `/dashboards/${f.board.id}`, edit: f.role !== "viewer" } : null;
  }
  if (kind === "workbook" || kind === "table" || kind === "field") {
    const [workbookId, table, column] = id.split(":");
    const f = workbookId ? await access(userId, workbookId) : null;
    if (!f) return null;
    return { label: kind === "workbook" ? f.row.title : kind === "table" ? (table ?? "") : `${table}.${column}`, ownerId: f.row.ownerId, link: `/workbook/${workbookId}`, edit: f.role !== "viewer" };
  }
  if (kind === "source") {
    const f = await sourceFor(userId, id);
    return f ? { label: f.src.name, ownerId: f.src.createdBy, link: `/definitions/${id}`, edit: canEditDefs(f.role) } : null;
  }
  if (kind === "definition") {
    const f = await definitionFor(userId, id);
    return f ? { label: f.def.label, ownerId: f.def.ownerId ?? f.def.confirmedBy ?? f.src.createdBy, link: `/definitions/${f.src.id}`, edit: canEditDefs(f.role) } : null;
  }
  return null;
}

/** The person named as answering for a thing, if one was named. */
export async function namedOwner(kind: string, id: string): Promise<string | null> {
  const [row] = await db.select({ ownerId: ownership.ownerId }).from(ownership).where(and(eq(ownership.objectKind, kind), eq(ownership.objectId, id)));
  return row?.ownerId ?? null;
}

async function people(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = wanted.length ? await db.select({ id: userTable.id, name: userTable.name, email: userTable.email }).from(userTable).where(inArray(userTable.id, wanted)) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

async function shape(rows: Row[], me: string) {
  const who = await people(rows.flatMap((r) => [r.createdBy, r.assigneeId]));
  const name = (id: string | null) => (id ? who.get(id)?.name || who.get(id)?.email || "Someone who has left" : null);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    status: r.status,
    due: r.due,
    overdue: !!r.due && !CLOSED.has(r.status) && r.due < today,
    closed: CLOSED.has(r.status),
    createdBy: name(r.createdBy),
    assignee: name(r.assigneeId),
    mine: r.assigneeId === me,
    made: r.createdBy === me,
    object: r.objectKind ? { kind: r.objectKind, id: r.objectId, label: r.label } : null,
    acceptance: r.acceptance,
    links: r.links,
    events: r.events,
    createdAt: r.createdAt,
    /** The moves this person may make now. */
    moves: Object.entries(MOVES[r.kind][r.status] ?? {})
      .filter(([, by]) => (by === "either" ? r.assigneeId === me || r.createdBy === me : by === "assignee" ? r.assigneeId === me : by === "creator" ? r.createdBy === me : r.assigneeId !== me || r.createdBy === me))
      .map(([to]) => to),
  }));
}

/** Open a work item from code (a failing check, a late table). */
export async function openItem(v: { kind: WorkKind; title: string; body: string; createdBy: string; assigneeId: string | null; objectKind?: string; objectId?: string; label?: string; links?: Row["links"] }): Promise<Row> {
  const [row] = await db
    .insert(workItem)
    .values({ id: newId(), kind: v.kind, title: v.title.slice(0, 200), body: v.body.slice(0, 4000), status: FIRST[v.kind], createdBy: v.createdBy, assigneeId: v.assigneeId, objectKind: v.objectKind ?? null, objectId: v.objectId ?? null, label: v.label ?? "", links: v.links ?? [], events: [{ at: new Date().toISOString(), by: "GridZero", text: "opened it" }] })
    .returning();
  return row!;
}

export async function addEvent(id: string, by: string, text: string, set: Partial<typeof workItem.$inferInsert> = {}): Promise<void> {
  const [row] = await db.select().from(workItem).where(eq(workItem.id, id));
  if (!row) return;
  await db.update(workItem).set({ ...set, events: [...row.events, { at: new Date().toISOString(), by, text }].slice(-100), updatedAt: new Date() }).where(eq(workItem.id, id));
}

const text = (max: number) => z.string().trim().max(max);
const objectRef = z.object({ kind: z.enum(OBJECTS), id: z.string().min(1).max(300) }).strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function routes(app: Hono<{ Variables: Vars }>) {
  app.post("/api/v1/work", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z
      .object({ kind: z.enum(KINDS), title: text(200).min(3), body: text(4000).optional(), due: day.nullable().optional(), assignee: z.string().trim().toLowerCase().email().optional(), object: objectRef.optional(), acceptance: z.array(text(300).min(1)).max(20).optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Give it a title of at least 3 characters. A due date is written YYYY-MM-DD." }, 400);
    const p = parsed.data;
    const on = p.object ? await describe(user.id, p.object.kind, p.object.id) : null;
    if (p.object && !on) return c.json({ error: "not found" }, 404);
    // Who it goes to: the person named, else whoever answers for the thing, else whoever made it.
    let assigneeId: string | null = null;
    if (p.assignee) {
      const [to] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, p.assignee));
      if (!to) return c.json({ error: "Nobody has signed up with that address." }, 400);
      if (p.object && !(await describe(to.id, p.object.kind, p.object.id))) return c.json({ error: "That person cannot open this, so they could not act on it. Share it with them first." }, 400);
      assigneeId = to.id;
    } else if (p.object) assigneeId = (await namedOwner(p.object.kind, p.object.id)) ?? on!.ownerId;
    else if (p.kind !== "request") assigneeId = user.id;
    if (p.kind === "request" && !assigneeId) return c.json({ error: "Say who the request is for." }, 400);
    const status = FIRST[p.kind];
    const [row] = await db
      .insert(workItem)
      .values({ id: newId(), kind: p.kind, title: p.title, body: p.body ?? "", status, due: p.due ?? null, createdBy: user.id, assigneeId, objectKind: p.object?.kind ?? null, objectId: p.object?.id ?? null, label: on?.label ?? "", acceptance: (p.acceptance ?? []).map((t) => ({ text: t, done: false })), events: [{ at: new Date().toISOString(), by: user.name || user.email, text: p.kind === "decision" ? "recorded this decision" : "opened it" }], closedAt: CLOSED.has(status) ? new Date() : null })
      .returning();
    if (assigneeId && assigneeId !== user.id) await notify(assigneeId, p.kind, `${user.name || user.email} ${p.kind === "request" ? "asked you for" : p.kind === "issue" ? "raised an issue:" : "gave you an action:"} ${p.title}`, `${on ? `On ${on.label}. ` : ""}${p.due ? `Due ${p.due}.` : ""}`.trim(), "/needs-you?tab=work");
    record({ userId: user.id, kind: `${p.kind}.opened`, objectKind: p.object?.kind ?? "work", objectId: p.object?.id ?? row!.id, label: p.title, ownerId: on?.ownerId ?? user.id });
    return c.json({ item: (await shape([row!], user.id))[0] }, 201);
  });

  /** Mine (given to me, still open), made (by me), or everything on one thing. */
  app.get("/api/v1/work", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const scope = c.req.query("scope") ?? "mine";
    let rows: Row[];
    if (scope === "object") {
      const kind = c.req.query("kind") ?? "";
      const id = c.req.query("id") ?? "";
      if (!(await describe(user.id, kind, id))) return c.json({ error: "not found" }, 404);
      rows = await db.select().from(workItem).where(and(eq(workItem.objectKind, kind), eq(workItem.objectId, id))).orderBy(desc(workItem.createdAt)).limit(200);
    } else if (scope === "made") rows = await db.select().from(workItem).where(eq(workItem.createdBy, user.id)).orderBy(desc(workItem.createdAt)).limit(200);
    else if (scope === "all") rows = await db.select().from(workItem).where(or(eq(workItem.createdBy, user.id), eq(workItem.assigneeId, user.id))).orderBy(desc(workItem.updatedAt)).limit(300);
    else rows = await db.select().from(workItem).where(and(eq(workItem.assigneeId, user.id), isNull(workItem.closedAt), ne(workItem.kind, "decision"))).orderBy(desc(workItem.createdAt)).limit(200);
    return c.json({ items: await shape(rows, user.id) });
  });

  /** Move it on, tick an acceptance check, add a note, attach something, or pass it to someone else. */
  app.patch("/api/v1/work/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(workItem).where(eq(workItem.id, c.req.param("id")));
    if (!row || (row.createdBy !== user.id && row.assigneeId !== user.id)) return c.json({ error: "not found" }, 404);
    const parsed = z
      .object({ status: z.string().max(20).optional(), note: text(1000).min(1).optional(), acceptance: z.array(z.object({ text: text(300).min(1), done: z.boolean() }).strict()).max(20).optional(), assignee: z.string().trim().toLowerCase().email().optional(), link: z.object({ kind: z.enum(OBJECTS), id: z.string().min(1).max(300) }).strict().optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "That change was not understood." }, 400);
    const p = parsed.data;
    const me = user.name || user.email;
    const events = [...row.events];
    const set: Partial<typeof workItem.$inferInsert> = {};
    const say = (t: string) => events.push({ at: new Date().toISOString(), by: me, text: t });
    if (p.acceptance) {
      if (row.assigneeId !== user.id && row.createdBy !== user.id) return c.json({ error: "not found" }, 404);
      set.acceptance = p.acceptance;
    }
    if (p.link) {
      const on = await describe(user.id, p.link.kind, p.link.id);
      if (!on) return c.json({ error: "You cannot attach something you cannot open." }, 400);
      set.links = [...row.links.filter((l) => !(l.kind === p.link!.kind && l.id === p.link!.id)), { ...p.link, label: on.label }].slice(-20);
      say(`attached ${on.label}`);
    }
    if (p.assignee) {
      const [to] = await db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(eq(userTable.email, p.assignee));
      if (!to) return c.json({ error: "Nobody has signed up with that address." }, 400);
      if (row.objectKind && !(await describe(to.id, row.objectKind, row.objectId!))) return c.json({ error: "That person cannot open this. Share it with them first." }, 400);
      set.assigneeId = to.id;
      say(`passed it to ${to.name || p.assignee}`);
      if (to.id !== user.id) await notify(to.id, row.kind, `${me} passed you: ${row.title}`, row.label ? `On ${row.label}.` : "", "/needs-you?tab=work");
    }
    if (p.note) say(`said: ${p.note}`);
    if (p.status && p.status !== row.status) {
      const by = MOVES[row.kind][row.status]?.[p.status];
      const allowed = by === "either" ? true : by === "assignee" ? row.assigneeId === user.id : by === "creator" ? row.createdBy === user.id : by === "not_fixer" ? row.assigneeId !== user.id || row.createdBy === user.id : false;
      if (!allowed) return c.json({ error: by ? "That step is for the other person." : `It cannot go from ${row.status.replace("_", " ")} to ${p.status.replace("_", " ")}.` }, 400);
      if (p.status === "signed_off" && (set.acceptance ?? row.acceptance).some((a) => !a.done)) return c.json({ error: "Tick every acceptance check before signing off, or send it back." }, 400);
      set.status = p.status;
      set.closedAt = CLOSED.has(p.status) ? new Date() : null;
      say(WORDS[p.status] ?? `moved it to ${p.status}`);
      // Tell the other person, and on an escalation whoever answers for the thing.
      const tell = new Set([row.createdBy, row.assigneeId].filter((x): x is string => !!x && x !== user.id));
      if (p.status === "escalated" && row.objectKind) {
        const on = await describe(row.createdBy, row.objectKind, row.objectId!);
        const owner = (await namedOwner(row.objectKind, row.objectId!)) ?? on?.ownerId;
        if (owner && owner !== user.id) tell.add(owner);
      }
      for (const t of tell) await notify(t, row.kind, `${me} ${WORDS[p.status] ?? p.status}: ${row.title}`, p.note ?? (row.label ? `On ${row.label}.` : ""), "/needs-you?tab=work");
    }
    if (events.length === row.events.length && !set.acceptance) return c.json({ error: "Nothing to change." }, 400);
    const [done] = await db.update(workItem).set({ ...set, events: events.slice(-100), updatedAt: new Date() }).where(eq(workItem.id, row.id)).returning();
    return c.json({ item: (await shape([done!], user.id))[0] });
  });

  /** Name who answers for a thing. Anyone who can change it can; the person named must be able to open it. */
  app.put("/api/v1/owners", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = objectRef.extend({ email: z.string().trim().toLowerCase().email() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Say what it is and give an email address." }, 400);
    const { kind, id, email } = parsed.data;
    const on = await describe(user.id, kind, id);
    if (!on) return c.json({ error: "not found" }, 404);
    if (!on.edit) return c.json({ error: "Only someone who can change this can name its owner." }, 403);
    const [to] = await db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(eq(userTable.email, email));
    if (!to) return c.json({ error: "Nobody has signed up with that address." }, 400);
    if (!(await describe(to.id, kind, id))) return c.json({ error: "That person cannot open this. Share it with them first." }, 400);
    await db.insert(ownership).values({ objectKind: kind, objectId: id, ownerId: to.id, setBy: user.id }).onConflictDoUpdate({ target: [ownership.objectKind, ownership.objectId], set: { ownerId: to.id, setBy: user.id, at: new Date() } });
    if (kind === "definition") await db.update(definition).set({ ownerId: to.id }).where(eq(definition.id, id));
    if (to.id !== user.id) await notify(to.id, "owner", `You now answer for ${on.label}`, `${user.name || user.email} named you as its owner. Changes and problems that touch it come to you.`, on.link);
    record({ userId: user.id, kind: "owner.named", objectKind: kind, objectId: id, label: on.label, ownerId: on.ownerId, detail: { email } });
    return c.json({ owner: { name: to.name, email } });
  });

  /** How much of what the person's workspaces hold has an owner, is confirmed, and has issues open. */
  app.get("/api/v1/coverage", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const spaces = (await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, user.id))).map((s) => s.id);
    const sources = spaces.length ? await db.select().from(source).where(inArray(source.workspaceId, spaces)) : [];
    const defs = sources.length ? await db.select({ id: definition.id, sourceId: definition.sourceId, status: definition.status, ownerId: definition.ownerId, kind: definition.kind }).from(definition).where(inArray(definition.sourceId, sources.map((s) => s.id))) : [];
    const named = sources.length ? await db.select({ id: ownership.objectId }).from(ownership).where(and(eq(ownership.objectKind, "source"), inArray(ownership.objectId, sources.map((s) => s.id)))) : [];
    const hasOwner = new Set(named.map((n) => n.id));
    const reports = await db.select({ id: dashboard.id, name: dashboard.name }).from(dashboard).where(eq(dashboard.ownerId, user.id));
    const cards = reports.length ? await db.select({ id: widget.id }).from(widget).where(inArray(widget.dashboardId, reports.map((r) => r.id))) : [];
    const issues = await db.select().from(workItem).where(and(eq(workItem.kind, "issue"), isNull(workItem.closedAt), or(eq(workItem.createdBy, user.id), eq(workItem.assigneeId, user.id))));
    const age = (d: Date) => Math.floor((Date.now() - d.getTime()) / 86_400_000);
    return c.json({
      sources: sources.map((s) => {
        const mine = defs.filter((d) => d.sourceId === s.id);
        const metrics = mine.filter((d) => d.kind === "metric" || d.kind === "rule");
        return { id: s.id, name: s.name, hasOwner: hasOwner.has(s.id), definitions: mine.length, confirmed: mine.filter((d) => d.status === "confirmed").length, settled: mine.filter((d) => d.status === "settled").length, waiting: mine.filter((d) => d.status === "needs_answer" || d.status === "inferred" || d.status === "disputed").length, metrics: metrics.length, metricsOwned: metrics.filter((d) => d.ownerId).length };
      }),
      totals: { sources: sources.length, sourcesOwned: sources.filter((s) => hasOwner.has(s.id)).length, definitions: defs.length, confirmed: defs.filter((d) => d.status === "confirmed").length, reports: reports.length, cards: cards.length },
      issues: { open: issues.length, olderThanAWeek: issues.filter((i) => age(i.createdAt) > 7).length, oldestDays: issues.length ? Math.max(...issues.map((i) => age(i.createdAt))) : 0 },
    });
  });
}
