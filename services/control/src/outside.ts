// What tools outside the app can use. A personal token reads (and only reads) what its owner can see:
// a catalog of sources and their definitions with version numbers and the latest release, and the
// read-only query over a workbook's tables. A model whose predictions land in a workbook table can be
// registered, so a new version reaches the owners of the reports that read it.

import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { apiToken, definition, modelAsset, release, source, user as userTable, workbookShare, workspaceMember } from "./db/schema.ts";
import { access } from "./sharing.ts";
import { downstreamOwners } from "./usedby.ts";

const MAX_TOKENS = 10;

/** Workbook sources the person can open through the workbook itself, without belonging to its workspace. */
async function guestSources(userId: string, already: Set<string>) {
  const shared = await db.select({ id: workbookShare.workbookId }).from(workbookShare).where(eq(workbookShare.userId, userId));
  if (!shared.length) return [];
  const all = await db.select().from(source).where(eq(source.kind, "workbook"));
  const mine = new Set(shared.map((s) => s.id));
  return all.filter((s) => !already.has(s.id) && mine.has((s.config as { workbookId?: string }).workbookId ?? ""));
}
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** The person a token belongs to, when the request is one a token may make: any read, or the read-only table query. */
export async function tokenUser(header: string | undefined, method: string, path: string) {
  const token = header?.startsWith("Bearer gz_") ? header.slice(7) : null;
  if (!token) return null;
  // A token reads. The two things it may send are the read-only query, and a record of an experiment run.
  if (method !== "GET" && !(method === "POST" && /^\/api\/v1\/workbooks\/[^/]+\/(query|experiments)$/.test(path))) return null;
  const [row] = await db.select().from(apiToken).where(eq(apiToken.hash, hashOf(token)));
  if (!row) return null;
  const [who] = await db.select().from(userTable).where(eq(userTable.id, row.ownerId));
  if (!who) return null;
  // Not on every request: once a minute is enough to show it is in use.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) await db.update(apiToken).set({ lastUsedAt: new Date() }).where(eq(apiToken.id, row.id));
  return who;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/tokens", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select({ id: apiToken.id, name: apiToken.name, createdAt: apiToken.createdAt, lastUsedAt: apiToken.lastUsedAt }).from(apiToken).where(eq(apiToken.ownerId, user.id)).orderBy(apiToken.createdAt);
    return c.json({ tokens: rows });
  });

  /** Make a token. It is shown once, here, and never again. Tokens are made while signed in, never with another token. */
  app.post("/api/v1/tokens", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Give the token a name, such as the notebook that will use it." }, 400);
    const have = await db.select({ id: apiToken.id }).from(apiToken).where(eq(apiToken.ownerId, user.id));
    if (have.length >= MAX_TOKENS) return c.json({ error: `You can have ${MAX_TOKENS} tokens. Remove one first.` }, 400);
    const token = `gz_${randomBytes(24).toString("base64url")}`;
    const [row] = await db.insert(apiToken).values({ id: newId(), ownerId: user.id, name: parsed.data.name, hash: hashOf(token) }).returning();
    record({ userId: user.id, kind: "token.made", objectKind: "account", objectId: user.id, label: parsed.data.name, ownerId: user.id });
    return c.json({ id: row!.id, name: row!.name, token }, 201);
  });

  app.delete("/api/v1/tokens/:id", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const gone = await db.delete(apiToken).where(and(eq(apiToken.id, c.req.param("id")), eq(apiToken.ownerId, user.id))).returning({ id: apiToken.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  /** Every source the person can see, its definitions with their versions, and its latest release. */
  app.get("/api/v1/catalog", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const spaces = (await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, user.id))).map((s) => s.id);
    const member = spaces.length ? await db.select().from(source).where(inArray(source.workspaceId, spaces)) : [];
    // Someone who can open a workbook, but is not in the workspace that holds its definitions, still sees the confirmed ones.
    const guest = await guestSources(user.id, new Set(member.map((s) => s.id)));
    const sources = [...member, ...guest];
    const guests = new Set(guest.map((s) => s.id));
    const ids = sources.map((s) => s.id);
    const defs = ids.length ? await db.select().from(definition).where(inArray(definition.sourceId, ids)) : [];
    const releases = ids.length ? await db.select().from(release).where(inArray(release.sourceId, ids)).orderBy(desc(release.createdAt)) : [];
    const only = c.req.query("status");
    return c.json({
      sources: sources.map((s) => {
        const last = releases.find((r) => r.sourceId === s.id);
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          workbookId: s.kind === "workbook" ? ((s.config as { workbookId?: string }).workbookId ?? null) : null,
          release: last ? { label: last.label, at: last.createdAt, passed: (last.results as { passed?: boolean }).passed ?? null } : null,
          definitions: defs.filter((d) => d.sourceId === s.id && (!only || d.status === only) && (!guests.has(s.id) || d.status === "confirmed")).map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, description: d.description, status: d.status, version: d.version, body: d.body, confirmedAt: d.confirmedAt, updatedAt: d.updatedAt })),
        };
      }),
    });
  });

  /** Find a definition by its name or what it says. */
  app.get("/api/v1/search/definitions", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const term = (c.req.query("q") ?? "").trim().toLowerCase();
    if (term.length < 2) return c.json({ definitions: [] });
    const spaces = (await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, user.id))).map((s) => s.id);
    const member = spaces.length ? await db.select().from(source).where(inArray(source.workspaceId, spaces)) : [];
    const guest = await guestSources(user.id, new Set(member.map((s) => s.id)));
    const guests = new Set(guest.map((s) => s.id));
    const names = new Map([...member, ...guest].map((s) => [s.id, s.name]));
    const defs = names.size ? await db.select().from(definition).where(inArray(definition.sourceId, [...names.keys()])) : [];
    const hits = defs.filter((d) => (!guests.has(d.sourceId) || d.status === "confirmed") && `${d.label} ${d.name} ${d.description}`.toLowerCase().includes(term));
    // Confirmed first: that is what a person searching for a number should land on.
    hits.sort((a, b) => Number(b.status === "confirmed") - Number(a.status === "confirmed") || a.label.localeCompare(b.label));
    return c.json({ definitions: hits.slice(0, 20).map((d) => ({ id: d.id, label: d.label, kind: d.kind, status: d.status, sourceId: d.sourceId, source: names.get(d.sourceId) ?? "" })) });
  });

  // --- models -------------------------------------------------------------------

  const shape = (m: typeof modelAsset.$inferSelect) => ({ monitor: m.monitor, baseline: m.baseline, health: m.health, id: m.id, name: m.name, version: m.version, workbookId: m.workbookId, table: m.tableName, notes: m.notes, history: m.history, updatedAt: m.updatedAt });

  app.get("/api/v1/models", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select().from(modelAsset).where(eq(modelAsset.ownerId, user.id)).orderBy(modelAsset.createdAt);
    return c.json({ models: rows.map(shape) });
  });

  app.post("/api/v1/models", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = z.object({ name: z.string().trim().min(1).max(80), version: z.string().trim().min(1).max(40), workbookId: z.string().min(1).max(64), table: z.string().trim().min(1).max(200), notes: z.string().trim().max(1000).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A model needs a name, a version, and the workbook table its predictions land in." }, 400);
    const p = parsed.data;
    const found = await access(user.id, p.workbookId);
    if (!found || found.role === "viewer") return c.json({ error: "not found" }, 404);
    const [row] = await db.insert(modelAsset).values({ id: newId(), ownerId: user.id, name: p.name, version: p.version, workbookId: p.workbookId, tableName: p.table, notes: p.notes ?? "" }).returning();
    record({ userId: user.id, kind: "model.registered", objectKind: "workbook", objectId: p.workbookId, label: `${p.name} ${p.version}`, ownerId: found.row.ownerId });
    return c.json({ model: shape(row!) }, 201);
  });

  /** A new version: recorded, and the owners of every report that reads its predictions are told. */
  app.patch("/api/v1/models/:id", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(modelAsset).where(and(eq(modelAsset.id, c.req.param("id")), eq(modelAsset.ownerId, user.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    const parsed = z.object({ version: z.string().trim().min(1).max(40), notes: z.string().trim().max(1000).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Give the new version." }, 400);
    const p = parsed.data;
    if (p.version === row.version) return c.json({ error: "That is the version it already has." }, 400);
    // A new version starts with a clean record: it is scored afresh.
    const [done] = await db.update(modelAsset).set({ health: null, baseline: null, version: p.version, notes: p.notes ?? row.notes, history: [...row.history, { version: row.version, at: row.updatedAt.toISOString(), notes: row.notes }].slice(-50), updatedAt: new Date() }).where(eq(modelAsset.id, row.id)).returning();
    const down = await downstreamOwners(user.id, "table", `${row.workbookId}:${row.tableName}`);
    const others = (down?.owners ?? []).filter((o) => o !== user.id);
    for (const o of others) await notify(o, "model", `${row.name} is now version ${p.version}`, `It was ${row.version}. ${down!.found.cards.length} card${down!.found.cards.length === 1 ? "" : "s"} read its predictions.${p.notes ? ` ${p.notes}` : ""}`, null);
    record({ userId: user.id, kind: "model.versioned", objectKind: "workbook", objectId: row.workbookId, label: `${row.name} ${p.version}`, ownerId: user.id, detail: { from: row.version, told: others.length } });
    return c.json({ model: shape(done!), told: others.length });
  });

  app.delete("/api/v1/models/:id", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const gone = await db.delete(modelAsset).where(and(eq(modelAsset.id, c.req.param("id")), eq(modelAsset.ownerId, user.id))).returning({ id: modelAsset.id });
    return gone.length ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
}
