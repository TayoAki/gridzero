// "Used by": for a workbook, one of its tables or fields, a source, a definition or a card, what is
// built on it and who sees that. Table and field use is found by reading the name in each card's query
// and each definition's body, so a name that only appears in a comment or a string still counts.
// Announcing a change tells the owners of everything downstream before it happens.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { announcement, dashboard, dashboardShare, definition, source, user as userTable, widget } from "./db/schema.ts";
import { definitionFor, sourceFor } from "./definitions/store.ts";
import { access } from "./sharing.ts";
import { dashboardAccess, widgetAccess } from "./widgets/access.ts";

export const OBJECT_KINDS = ["workbook", "table", "field", "source", "definition", "card", "report"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export interface UsedBy {
  item: { kind: ObjectKind; id: string; label: string; ownerId: string | null; owner: string | null };
  definitions: { id: string; label: string; kind: string; status: string }[];
  cards: { id: string; title: string; reportId: string; report: string }[];
  reports: { id: string; name: string; ownerId: string; owner: string; link: boolean }[];
  people: { total: number; outside: number; list: { email: string; role: string; limited: boolean; report: string }[] };
}

const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i");
const domain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/** What the caller may ask about, with the names to look for. Null when they cannot see it. */
async function resolve(userId: string, kind: ObjectKind, id: string) {
  if (kind === "workbook" || kind === "table" || kind === "field") {
    const [workbookId, table, column] = id.split(":");
    if (!workbookId || (kind !== "workbook" && !table) || (kind === "field" && !column)) return null;
    const found = await access(userId, workbookId);
    if (!found) return null;
    const label = kind === "workbook" ? found.row.title : kind === "table" ? table! : `${table}.${column}`;
    return { label, ownerId: found.row.ownerId, workbookId, names: kind === "workbook" ? [] : kind === "table" ? [table!] : [table!, column!], definitionIds: null as string[] | null, cardIds: null as string[] | null, sourceId: null as string | null };
  }
  if (kind === "source") {
    const found = await sourceFor(userId, id);
    if (!found) return null;
    return { label: found.src.name, ownerId: found.src.createdBy, workbookId: found.src.kind === "workbook" ? ((found.src.config as { workbookId?: string }).workbookId ?? null) : null, names: [], definitionIds: null, cardIds: null, sourceId: found.src.id };
  }
  if (kind === "definition") {
    const found = await definitionFor(userId, id);
    if (!found) return null;
    // A rule reaches cards through the metrics that apply it.
    const all = await db.select({ id: definition.id, kind: definition.kind, body: definition.body }).from(definition).where(eq(definition.sourceId, found.def.sourceId));
    const through = found.def.kind === "rule" ? all.filter((d) => d.kind === "metric" && ((d.body as { filters?: string[] }).filters ?? []).includes(found.def.name)).map((d) => d.id) : [];
    return { label: found.def.label, ownerId: found.def.ownerId ?? found.def.confirmedBy ?? found.src.createdBy, workbookId: null, names: [], definitionIds: [found.def.id, ...through], cardIds: null, sourceId: null, self: found.def.id };
  }
  if (kind === "card") {
    const found = await widgetAccess(userId, id);
    if (!found || found.role === "viewer") return null;
    return { label: found.row.title, ownerId: found.board.ownerId, workbookId: null, names: [], definitionIds: [], cardIds: [found.row.id], sourceId: null };
  }
  const found = await dashboardAccess(userId, id);
  if (!found || found.role === "viewer") return null;
  const cards = await db.select({ id: widget.id }).from(widget).where(eq(widget.dashboardId, id));
  return { label: found.row.name, ownerId: found.row.ownerId, workbookId: null, names: [], definitionIds: [], cardIds: cards.map((c) => c.id), sourceId: null, reportId: id };
}

export async function usedBy(userId: string, kind: ObjectKind, id: string): Promise<UsedBy | null> {
  const r = await resolve(userId, kind, id);
  if (!r) return null;
  const hit = (text: string) => r.names.every((n) => word(n).test(text));

  // Definitions built on it.
  let defs: (typeof definition.$inferSelect)[] = [];
  if (r.definitionIds) defs = r.definitionIds.length ? await db.select().from(definition).where(inArray(definition.id, r.definitionIds)) : [];
  else {
    const sources = r.sourceId ? [r.sourceId] : r.workbookId ? (await db.select({ id: source.id }).from(source).where(and(eq(source.kind, "workbook"), sql`${source.config}->>'workbookId' = ${r.workbookId}`))).map((s) => s.id) : [];
    const all = sources.length ? await db.select().from(definition).where(inArray(definition.sourceId, sources)) : [];
    defs = all.filter((d) => hit(JSON.stringify(d.body)));
  }
  const self = (r as { self?: string }).self;
  const defIds = defs.map((d) => d.id);

  // Cards built on it, or on one of those definitions.
  let cards: (typeof widget.$inferSelect)[] = [];
  if (r.cardIds) cards = r.cardIds.length ? await db.select().from(widget).where(inArray(widget.id, r.cardIds)) : [];
  else {
    if (r.workbookId) {
      const onBook = await db.select().from(widget).where(sql`${widget.source}->>'workbookId' = ${r.workbookId}`);
      cards.push(...onBook.filter((w) => !r.names.length || hit((w.source as { sql?: string }).sql ?? "")));
    }
    if (defIds.length) cards.push(...(await db.select().from(widget).where(inArray(sql`${widget.source}->>'definitionId'`, defIds))));
  }
  cards = [...new Map(cards.map((c) => [c.id, c])).values()];

  const reportIds = [...new Set(cards.map((c) => c.dashboardId))];
  const reports = reportIds.length ? await db.select({ id: dashboard.id, name: dashboard.name, ownerId: dashboard.ownerId, linkToken: dashboard.linkToken, owner: userTable.name, ownerEmail: userTable.email }).from(dashboard).innerJoin(userTable, eq(userTable.id, dashboard.ownerId)).where(inArray(dashboard.id, reportIds)) : [];
  const nameOf = new Map(reports.map((x) => [x.id, x.name]));
  const shares = reportIds.length ? await db.select().from(dashboardShare).where(inArray(dashboardShare.dashboardId, reportIds)) : [];
  const list = [
    ...reports.map((x) => ({ email: x.ownerEmail, role: "owner", limited: false, report: x.name })),
    ...shares.map((s) => ({ email: s.email, role: s.role as string, limited: !!s.limits?.length, report: nameOf.get(s.dashboardId) ?? "" })),
  ];
  const homes = new Set(reports.map((x) => domain(x.ownerEmail)));
  const distinct = new Set(list.map((p) => p.email));
  const [owner] = r.ownerId ? await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, r.ownerId)) : [];
  return {
    item: { kind, id, label: r.label, ownerId: r.ownerId, owner: owner?.name ?? null },
    definitions: defs.filter((d) => d.id !== self).map((d) => ({ id: d.id, label: d.label, kind: d.kind, status: d.status })),
    cards: kind === "card" ? [] : cards.map((c) => ({ id: c.id, title: c.title, reportId: c.dashboardId, report: nameOf.get(c.dashboardId) ?? "" })),
    reports: kind === "report" ? [] : reports.map((x) => ({ id: x.id, name: x.name, ownerId: x.ownerId, owner: x.owner, link: !!x.linkToken })),
    people: { total: distinct.size, outside: [...distinct].filter((e) => !homes.has(domain(e))).length, list: list.slice(0, 200) },
  };
}

/** Everyone who should hear about a change to this thing: owners of the reports and definitions built on it. */
export async function downstreamOwners(userId: string, kind: ObjectKind, id: string): Promise<{ found: UsedBy; owners: string[] } | null> {
  const found = await usedBy(userId, kind, id);
  if (!found) return null;
  const defs = found.definitions.length ? await db.select({ ownerId: definition.ownerId, confirmedBy: definition.confirmedBy }).from(definition).where(inArray(definition.id, found.definitions.map((d) => d.id))) : [];
  const owners = new Set<string>([...found.reports.map((r) => r.ownerId), ...defs.flatMap((d) => [d.ownerId, d.confirmedBy]).filter((x): x is string => !!x)]);
  if (found.item.ownerId) owners.add(found.item.ownerId);
  return { found, owners: [...owners] };
}

const ref = z.object({ kind: z.enum(OBJECT_KINDS), id: z.string().min(1).max(300) });

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/used-by", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = ref.safeParse({ kind: c.req.query("kind"), id: c.req.query("id") });
    if (!parsed.success) return c.json({ error: "Say what to look up: a kind and an id." }, 400);
    const found = await usedBy(user.id, parsed.data.kind, parsed.data.id);
    if (!found) return c.json({ error: "not found" }, 404);
    const said = await db.select().from(announcement).where(and(eq(announcement.objectKind, parsed.data.kind), eq(announcement.objectId, parsed.data.id))).orderBy(desc(announcement.createdAt)).limit(10);
    return c.json({ ...found, announcements: said.map((a) => ({ id: a.id, message: a.message, effectiveOn: a.effectiveOn, told: a.told, at: a.createdAt })) });
  });

  /** Say a change is coming. The owners of what is built on it are told, in the app. */
  app.post("/api/v1/announcements", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const parsed = ref.extend({ message: z.string().trim().min(3).max(500), effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Say what is changing (3 to 500 characters), and optionally the date as YYYY-MM-DD." }, 400);
    const { kind, id, message, effectiveOn } = parsed.data;
    const down = await downstreamOwners(user.id, kind, id);
    if (!down) return c.json({ error: "not found" }, 404);
    const others = down.owners.filter((o) => o !== user.id);
    const when = effectiveOn ? ` From ${effectiveOn}.` : "";
    const reach = `${down.found.definitions.length} definition${down.found.definitions.length === 1 ? "" : "s"}, ${down.found.cards.length} card${down.found.cards.length === 1 ? "" : "s"}`;
    for (const o of others) await notify(o, "change", `${down.found.item.label} is changing`, `${user.name || user.email}: ${message}${when} You own something built on it (${reach} in all).`, null);
    const [row] = await db.insert(announcement).values({ id: newId(), objectKind: kind, objectId: id, label: down.found.item.label, message, effectiveOn: effectiveOn ?? null, told: others.length, createdBy: user.id }).returning();
    record({ userId: user.id, kind: "change.announced", objectKind: kind, objectId: id, label: down.found.item.label, ownerId: down.found.item.ownerId, detail: { message, effectiveOn: effectiveOn ?? null, told: others.length } });
    return c.json({ id: row!.id, told: others.length }, 201);
  });
}
