// Tables people type into, on a report. Either free rows, or columns added beside the rows of a table
// card and matched by a key column (an owner and a status for each account, say). Entries are kept
// here, in this app; nothing is written back to a warehouse. A table takes entries only once the
// report's owner has approved it, and every entry records who made it.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { dashboardShare, inputRow, inputTable, user as userTable, widget } from "./db/schema.ts";
import { postWebhook, webhookProblem } from "./webhook.ts";
import { dashboardAccess, guarded } from "./widgets/access.ts";

const MAX_TABLES = 10;
const MAX_ROWS = 2000;
const column = z.object({ name: z.string().trim().min(1).max(40), kind: z.enum(["text", "number", "date", "choice"]), options: z.array(z.string().trim().min(1).max(60)).max(20).optional() }).strict();
type Table = typeof inputTable.$inferSelect;

/** One entry checked against its column: the cleaned value, or what is wrong with it. */
function clean(col: Table["columns"][number], v: unknown): { value: string | number | null } | { problem: string } {
  if (v === null || v === undefined || v === "") return { value: null };
  if (col.kind === "number") {
    const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? { value: n } : { problem: `${col.name} takes a number.` };
  }
  const s = String(v).trim().slice(0, 500);
  if (col.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { value: s } : { problem: `${col.name} takes a date written YYYY-MM-DD.` };
  if (col.kind === "choice") return (col.options ?? []).includes(s) ? { value: s } : { problem: `${col.name} takes one of: ${(col.options ?? []).join(", ")}.` };
  return { value: s };
}

export function routes(app: Hono<{ Variables: Vars }>) {
  const shape = async (tables: Table[], rows: (typeof inputRow.$inferSelect)[]) => {
    const ids = [...new Set(rows.flatMap((r) => [r.updatedBy]))];
    const who = new Map((ids.length ? await db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(inArray(userTable.id, ids)) : []).map((u) => [u.id, u.name]));
    return tables.map((t) => ({ id: t.id, name: t.name, columns: t.columns, widgetId: t.widgetId, keyColumn: t.keyColumn, status: t.status, handoff: t.handoff, exportedVersion: t.exportedVersion, rows: rows.filter((r) => r.tableId === t.id).map((r) => ({ id: r.id, key: r.key, values: r.values, by: who.get(r.updatedBy) ?? "", at: r.updatedAt })) }));
  };

  /** The tables on a report. People who only read see the ones that are live; a guarded reader sees only their own entries. */
  app.get("/api/v1/dashboards/:id/inputs", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const all = await db.select().from(inputTable).where(eq(inputTable.dashboardId, found.row.id)).orderBy(asc(inputTable.createdAt));
    const tables = found.role === "viewer" ? all.filter((t) => t.status === "live") : all;
    const rows = tables.length ? await db.select().from(inputRow).where(inArray(inputRow.tableId, tables.map((t) => t.id))).orderBy(asc(inputRow.updatedAt)) : [];
    return c.json({ tables: await shape(tables, guarded(found) ? rows.filter((r) => r.createdBy === user.id) : rows), role: found.role });
  });

  app.post("/api/v1/dashboards/:id/inputs", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await dashboardAccess(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot add a table." }, 403);
    const parsed = z.object({ name: z.string().trim().min(1).max(80), columns: z.array(column).min(1).max(8), widgetId: z.string().max(64).nullable().optional(), keyColumn: z.string().max(200).nullable().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A table needs a name and 1 to 8 columns, each with a name and a kind." }, 400);
    const p = parsed.data;
    if (new Set(p.columns.map((x) => x.name.toLowerCase())).size !== p.columns.length) return c.json({ error: "Two columns have the same name." }, 400);
    if (p.columns.some((x) => x.kind === "choice" && !(x.options ?? []).length)) return c.json({ error: "A choice column needs its choices." }, 400);
    if (p.widgetId) {
      const [card] = await db.select().from(widget).where(and(eq(widget.id, p.widgetId), eq(widget.dashboardId, found.row.id)));
      const data = card?.data as { kind: string; columns?: string[] } | undefined;
      if (!card || data?.kind !== "table") return c.json({ error: "Columns can be added beside a card that shows a table." }, 400);
      if (!p.keyColumn || !(data.columns ?? []).includes(p.keyColumn)) return c.json({ error: "Choose which of the card's columns tells its rows apart." }, 400);
    }
    const existing = await db.select({ id: inputTable.id }).from(inputTable).where(eq(inputTable.dashboardId, found.row.id));
    if (existing.length >= MAX_TABLES) return c.json({ error: `A report can have ${MAX_TABLES} such tables.` }, 400);
    const [row] = await db.insert(inputTable).values({ id: newId(), dashboardId: found.row.id, name: p.name, columns: p.columns, widgetId: p.widgetId ?? null, keyColumn: p.widgetId ? (p.keyColumn ?? null) : null, createdBy: user.id }).returning();
    return c.json({ table: (await shape([row!], []))[0] }, 201);
  });

  const own = async (userId: string, id: string) => {
    const [t] = await db.select().from(inputTable).where(eq(inputTable.id, id));
    const found = t ? await dashboardAccess(userId, t.dashboardId) : null;
    return t && found ? { t, found } : null;
  };

  /** Ask for it to be published, approve it, or take it back to a draft. */
  app.post("/api/v1/inputs/:id/:step{submit|approve|withdraw}", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const hit = await own(user.id, c.req.param("id"));
    if (!hit || hit.found.role === "viewer") return c.json({ error: "not found" }, 404);
    const { t, found } = hit;
    const step = c.req.param("step");
    if (step === "submit") {
      if (t.status !== "draft") return c.json({ error: "It has already been sent for approval." }, 400);
      await db.update(inputTable).set({ status: "pending" }).where(eq(inputTable.id, t.id));
      const shares = await db.select({ id: dashboardShare.id }).from(dashboardShare).where(eq(dashboardShare.dashboardId, found.row.id));
      if (found.row.ownerId !== user.id) await notify(found.row.ownerId, "approval", `${user.name || user.email} asks to publish a table people can type into`, `"${t.name}" on ${found.row.name}. ${shares.length + 1} people can open that report and would be able to add entries.`, `/dashboards/${found.row.id}`);
      return c.json({ status: "pending" });
    }
    // Approving and withdrawing are the owner's.
    if (found.role !== "owner") return c.json({ error: "Only the report's owner can do that." }, 403);
    if (step === "approve") {
      await db.update(inputTable).set({ status: "live", approvedBy: user.id, approvedAt: new Date() }).where(eq(inputTable.id, t.id));
      record({ userId: user.id, kind: "input.approved", objectKind: "report", objectId: found.row.id, label: t.name, ownerId: found.row.ownerId });
      if (t.createdBy !== user.id) await notify(t.createdBy, "approval", `"${t.name}" is published`, `People who can open ${found.row.name} can now add entries.`, `/dashboards/${found.row.id}`);
      return c.json({ status: "live" });
    }
    await db.update(inputTable).set({ status: "draft", approvedBy: null, approvedAt: null }).where(eq(inputTable.id, t.id));
    record({ userId: user.id, kind: "input.withdrawn", objectKind: "report", objectId: found.row.id, label: t.name, ownerId: found.row.ownerId });
    return c.json({ status: "draft" });
  });

  /** Add an entry, or change one. With a key, the entry belongs to that row of the card. */
  app.put("/api/v1/inputs/:id/rows", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const hit = await own(user.id, c.req.param("id"));
    if (!hit) return c.json({ error: "not found" }, 404);
    const { t, found } = hit;
    if (t.status !== "live") return c.json({ error: "This table is not published yet, so it takes no entries." }, 409);
    const parsed = z.object({ id: z.string().max(64).optional(), key: z.string().min(1).max(300).optional(), values: z.record(z.string(), z.unknown()) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "An entry is a set of values, one per column." }, 400);
    const p = parsed.data;
    if (t.widgetId && !p.key && !p.id) return c.json({ error: "Say which row the entry belongs to." }, 400);
    const values: Record<string, string | number | null> = {};
    for (const col of t.columns) {
      if (!(col.name in p.values)) continue;
      const out = clean(col, p.values[col.name]);
      if ("problem" in out) return c.json({ error: out.problem }, 400);
      values[col.name] = out.value;
    }
    if (Object.keys(p.values).some((k) => !t.columns.some((col) => col.name === k))) return c.json({ error: "That column is not in this table." }, 400);
    const [old] = p.id ? await db.select().from(inputRow).where(and(eq(inputRow.id, p.id), eq(inputRow.tableId, t.id))) : p.key ? await db.select().from(inputRow).where(and(eq(inputRow.tableId, t.id), eq(inputRow.key, p.key))) : [];
    if (p.id && !old) return c.json({ error: "not found" }, 404);
    // Someone who only reads changes their own free entries; a row of the card is everyone's to update unless they see only part of the report.
    if (old && old.createdBy !== user.id && (guarded(found) || (found.role === "viewer" && !old.key))) return c.json({ error: "That entry was made by someone else." }, 403);
    let saved;
    if (old) [saved] = await db.update(inputRow).set({ values: { ...old.values, ...values }, updatedBy: user.id, updatedAt: new Date() }).where(eq(inputRow.id, old.id)).returning();
    else {
      const count = await db.select({ id: inputRow.id }).from(inputRow).where(eq(inputRow.tableId, t.id));
      if (count.length >= MAX_ROWS) return c.json({ error: `A table holds ${MAX_ROWS} entries.` }, 400);
      [saved] = await db.insert(inputRow).values({ id: newId(), tableId: t.id, key: p.key ?? null, values, createdBy: user.id, updatedBy: user.id }).returning();
    }
    // A finished row is sent on once, when the chosen column first takes the chosen value.
    const h = t.handoff;
    if (h && saved!.values[h.column] === h.value && old?.values[h.column] !== h.value) {
      const problem = await postWebhook(h.webhook, { text: `${t.name}: ${saved!.key ?? "an entry"} is now ${h.value}`, table: t.name, report: found.row.name, key: saved!.key, values: saved!.values, by: user.name || user.email, at: new Date().toISOString() });
      record({ userId: user.id, kind: problem ? "input.handoff_failed" : "input.handed_on", objectKind: "report", objectId: found.row.id, label: t.name, ownerId: found.row.ownerId, detail: { key: saved!.key, problem } });
    }
    record({ userId: user.id, kind: "input.saved", objectKind: "report", objectId: found.row.id, label: t.name, ownerId: found.row.ownerId, detail: { key: saved!.key, values } });
    return c.json({ row: { id: saved!.id, key: saved!.key, values: saved!.values, by: user.name, at: saved!.updatedAt } });
  });

  app.delete("/api/v1/inputs/:id/rows/:row", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const hit = await own(user.id, c.req.param("id"));
    if (!hit) return c.json({ error: "not found" }, 404);
    const [old] = await db.select().from(inputRow).where(and(eq(inputRow.id, c.req.param("row")), eq(inputRow.tableId, hit.t.id)));
    if (!old || (old.createdBy !== user.id && hit.found.role === "viewer")) return c.json({ error: "not found" }, 404);
    await db.delete(inputRow).where(eq(inputRow.id, old.id));
    return c.body(null, 204);
  });

  /** Where finished rows are sent on, or null to stop. */
  app.put("/api/v1/inputs/:id/handoff", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const hit = await own(user.id, c.req.param("id"));
    if (!hit || hit.found.role !== "owner") return c.json({ error: "not found" }, 404);
    const parsed = z.object({ webhook: z.string().trim().max(500), column: z.string().max(40), value: z.string().max(60) }).strict().nullable().safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Give the address, the column to watch and the value that means a row is finished." }, 400);
    if (parsed.data) {
      if (!hit.t.columns.some((x) => x.name === parsed.data!.column)) return c.json({ error: "That column is not in this table." }, 400);
      const bad = await webhookProblem(parsed.data.webhook);
      if (bad) return c.json({ error: bad }, 400);
    }
    await db.update(inputTable).set({ handoff: parsed.data }).where(eq(inputTable.id, hit.t.id));
    return c.json({ handoff: parsed.data });
  });

  app.delete("/api/v1/inputs/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const hit = await own(user.id, c.req.param("id"));
    if (!hit || hit.found.role !== "owner") return c.json({ error: "not found" }, 404);
    await db.delete(inputTable).where(eq(inputTable.id, hit.t.id));
    return c.body(null, 204);
  });
}
