// Sensitive fields. A column of a workbook table can be marked sensitive; the scan of column names
// suggests candidates. Marking does not hide anything by itself: it makes sharing deliberate (a report
// that reads the field cannot be shared without hiding it from that person or saying yes, and the yes
// is logged), and it lets anyone who can open the workbook see where the field is used.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { activity, sensitiveField, widget } from "./db/schema.ts";
import { tableFields } from "./definitions/tables.ts";
import { access } from "./sharing.ts";

/** Names that usually hold something personal or confidential, with why. */
const HINTS: [RegExp, string][] = [
  [/(^|_)(e?mail)(_|$)|email/i, "looks like an email address"],
  [/phone|mobile|(^|_)tel(_|$)/i, "looks like a phone number"],
  [/salary|wage|(^|_)pay(_|$)|compensation|bonus|income/i, "looks like pay"],
  [/ssn|social_?sec|national_?id|passport|tax_?id|(^|_)nin(_|$)/i, "looks like a government identifier"],
  [/birth|(^|_)dob(_|$)|(^|_)age(_|$)/i, "looks like a date of birth or age"],
  [/first_?name|last_?name|full_?name|surname|(^|_)name(_|$)/i, "looks like a person's name"],
  [/address|street|postcode|zip/i, "looks like an address"],
  [/gender|ethnic|religion|disab|health|diagnos|medical/i, "looks like a protected characteristic"],
  [/iban|card_?number|account_?number|(^|_)pan(_|$)/i, "looks like a bank or card number"],
  [/password|secret|token/i, "looks like a credential"],
];
const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i");

/** The sensitive columns a report's cards read, by name. `SELECT *` reads every column of its table. */
export async function sensitiveOn(dashboardId: string): Promise<string[]> {
  const cards = await db.select({ source: widget.source }).from(widget).where(eq(widget.dashboardId, dashboardId));
  const books = [...new Set(cards.map((c) => (c.source as { workbookId?: string }).workbookId).filter((x): x is string => !!x))];
  if (!books.length) return [];
  const marked = await db.select().from(sensitiveField).where(inArray(sensitiveField.workbookId, books));
  const hit = new Set<string>();
  for (const m of marked) {
    for (const c of cards) {
      const s = c.source as { workbookId?: string; sql?: string; kind: string };
      if (s.workbookId !== m.workbookId) continue;
      // A card that is not a query over tables (a sheet range, for one) could read anything in the workbook.
      if (s.kind !== "table_query" || !s.sql) hit.add(m.columnName);
      else if (word(m.tableName).test(s.sql) && (word(m.columnName).test(s.sql) || s.sql.replace(/count\s*\(\s*\*\s*\)/gi, "").includes("*"))) hit.add(m.columnName);
    }
  }
  return [...hit].sort();
}

export function routes(app: Hono<{ Variables: Vars }>) {
  /** What is marked, what the names suggest, and for each marked field the cards that read it and the approvals given. */
  app.get("/api/v1/workbooks/:id/sensitive", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const marked = await db.select().from(sensitiveField).where(eq(sensitiveField.workbookId, found.row.id));
    const isMarked = (t: string, col: string) => marked.some((m) => m.tableName === t && m.columnName === col);
    const { tables } = await tableFields(found.row.id);
    const suggested = tables.flatMap((t) => t.columns.flatMap((col) => {
      const why = HINTS.find(([re]) => re.test(col.name))?.[1];
      return why && !isMarked(t.table, col.name) ? [{ table: t.table, column: col.name, why }] : [];
    }));
    const cards = await db.select({ id: widget.id, title: widget.title, dashboardId: widget.dashboardId, source: widget.source }).from(widget).where(sql`${widget.source}->>'workbookId' = ${found.row.id}`);
    const approvals = marked.length ? await db.select().from(activity).where(and(eq(activity.kind, "share.sensitive_approved"), inArray(activity.objectId, [...new Set(cards.map((k) => k.dashboardId))].concat("")))) : [];
    return c.json({
      marked: marked.map((m) => {
        const uses = cards.filter((k) => {
          const q = (k.source as { sql?: string }).sql ?? "";
          return word(m.tableName).test(q) && (word(m.columnName).test(q) || q.replace(/count\s*\(\s*\*\s*\)/gi, "").includes("*"));
        });
        return {
          table: m.tableName,
          column: m.columnName,
          at: m.at,
          cards: uses.map((k) => ({ id: k.id, title: k.title, reportId: k.dashboardId })),
          approvals: approvals.filter((a) => ((a.detail as { fields?: string[] }).fields ?? []).includes(m.columnName)).map((a) => ({ at: a.at, report: a.label, to: (a.detail as { email?: string }).email ?? "" })),
        };
      }),
      suggested,
      canMark: found.role !== "viewer",
    });
  });

  app.put("/api/v1/workbooks/:id/sensitive", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot mark fields." }, 403);
    const parsed = z.object({ table: z.string().min(1).max(200), column: z.string().min(1).max(200), on: z.boolean() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Name the table and the column, and say on or off." }, 400);
    const { table, column, on } = parsed.data;
    const { tables } = await tableFields(found.row.id);
    if (!tables.find((t) => t.table === table)?.columns.some((col) => col.name === column)) return c.json({ error: "That column is not in this workbook." }, 404);
    if (on) await db.insert(sensitiveField).values({ workbookId: found.row.id, tableName: table, columnName: column, markedBy: user.id }).onConflictDoNothing();
    else await db.delete(sensitiveField).where(and(eq(sensitiveField.workbookId, found.row.id), eq(sensitiveField.tableName, table), eq(sensitiveField.columnName, column)));
    record({ userId: user.id, kind: on ? "field.marked_sensitive" : "field.unmarked", objectKind: "workbook", objectId: found.row.id, label: `${table}.${column}`, ownerId: found.row.ownerId });
    return c.json({ table, column, sensitive: on });
  });
}
