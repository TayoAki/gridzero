// A record of how things stood. A snapshot freezes every card on a report (title, form and data) at a
// moment, by hand or on a schedule, so last week can be opened beside this week and an auditor can see
// what was shown on a date. A release freezes a source's definitions with the test results they went
// out with, and says what changed since the release before.

import { postWebhook, webhookProblem } from "./webhook.ts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { newId } from "./agents/run.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { dataCheck, definition, release, reportSnapshot, user as userTable, widget } from "./db/schema.ts";
import { canEdit, sourceFor } from "./definitions/store.ts";
import { answersOf } from "./definitions/trusted.ts";
import { dashboardAccess } from "./widgets/access.ts";
import { RefreshError, refreshWidget } from "./widgets/refresh.ts";

const MAX_SNAPSHOTS = 200;
interface FrozenCard {
  id: string;
  title: string;
  form: string;
  theme: string;
  size: string;
  layout: unknown;
  tab: string | null;
  options: unknown;
  data: { kind: string; value?: number; unit?: string | null };
}

/** Freeze a report now. With `refresh`, every card is worked out again first, as its owner. */
export async function takeSnapshot(dashboardId: string, ownerId: string, by: string | null, label: string, refresh: boolean): Promise<typeof reportSnapshot.$inferSelect> {
  let rows = await db.select().from(widget).where(eq(widget.dashboardId, dashboardId)).orderBy(widget.position);
  if (refresh) {
    const fresh = [];
    for (const w of rows) {
      try {
        fresh.push(await refreshWidget(ownerId, w));
      } catch (e) {
        if (!(e instanceof RefreshError)) throw e;
        fresh.push(w);
      }
    }
    rows = fresh;
  }
  const cards: FrozenCard[] = rows.filter((w) => (w.data as { kind: string }).kind !== "slicer").map((w) => ({ id: w.id, title: w.title, form: w.form, theme: w.theme, size: w.size, layout: w.layout, tab: w.tab, options: w.options, data: w.data as FrozenCard["data"] }));
  const [row] = await db.insert(reportSnapshot).values({ id: newId(), dashboardId, label: label.slice(0, 120), takenBy: by, cards }).returning();
  // Keep the newest; the oldest fall away.
  const all = await db.select({ id: reportSnapshot.id }).from(reportSnapshot).where(eq(reportSnapshot.dashboardId, dashboardId)).orderBy(desc(reportSnapshot.takenAt));
  if (all.length > MAX_SNAPSHOTS) await db.delete(reportSnapshot).where(inArray(reportSnapshot.id, all.slice(MAX_SNAPSHOTS).map((a) => a.id)));
  return row!;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  // Someone held to certain rows never gets a snapshot: it holds every row's figures.
  const whole = async (userId: string, id: string) => {
    const found = await dashboardAccess(userId, id);
    return found && !found.limits.length && !found.hide.length && found.minGroup <= 1 ? found : null;
  };

  app.get("/api/v1/dashboards/:id/snapshots", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await whole(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const rows = await db.select({ id: reportSnapshot.id, label: reportSnapshot.label, takenAt: reportSnapshot.takenAt, takenBy: reportSnapshot.takenBy }).from(reportSnapshot).where(eq(reportSnapshot.dashboardId, found.row.id)).orderBy(desc(reportSnapshot.takenAt)).limit(MAX_SNAPSHOTS);
    const ids = [...new Set(rows.map((r) => r.takenBy).filter((x): x is string => !!x))];
    const who = new Map((ids.length ? await db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(inArray(userTable.id, ids)) : []).map((u) => [u.id, u.name]));
    return c.json({ snapshots: rows.map((r) => ({ id: r.id, label: r.label, takenAt: r.takenAt, by: r.takenBy ? (who.get(r.takenBy) ?? "") : "a schedule" })) });
  });

  app.post("/api/v1/dashboards/:id/snapshots", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await whole(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.role === "viewer") return c.json({ error: "Viewers cannot take a snapshot." }, 403);
    const parsed = z.object({ label: z.string().trim().max(120).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A label is at most 120 characters." }, 400);
    const row = await takeSnapshot(found.row.id, found.row.ownerId, user.id, parsed.data.label ?? "", false);
    record({ userId: user.id, kind: "snapshot.taken", objectKind: "report", objectId: found.row.id, label: found.row.name, ownerId: found.row.ownerId, detail: { label: row.label } });
    return c.json({ snapshot: { id: row.id, label: row.label, takenAt: row.takenAt } }, 201);
  });

  /** The report as it stood, with each single figure set beside what it is now. */
  app.get("/api/v1/snapshots/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(reportSnapshot).where(eq(reportSnapshot.id, c.req.param("id")));
    const found = row ? await whole(user.id, row.dashboardId) : null;
    if (!row || !found) return c.json({ error: "not found" }, 404);
    const cards = row.cards as FrozenCard[];
    const now = await db.select().from(widget).where(eq(widget.dashboardId, row.dashboardId));
    const nowBy = new Map(now.map((w) => [w.id, w.data as FrozenCard["data"]]));
    const figures = cards
      .filter((k) => k.data.kind === "number" && typeof k.data.value === "number")
      .map((k) => {
        const cur = nowBy.get(k.id);
        const present = cur?.kind === "number" && typeof cur.value === "number" ? cur.value : null;
        return { id: k.id, title: k.title, unit: k.data.unit ?? null, then: k.data.value!, now: present, change: present === null ? null : present - k.data.value! };
      });
    record({ userId: user.id, kind: "snapshot.opened", objectKind: "report", objectId: row.dashboardId, label: found.row.name, ownerId: found.row.ownerId, detail: { takenAt: row.takenAt } });
    return c.json({ id: row.id, report: found.row.name, dashboardId: row.dashboardId, label: row.label, takenAt: row.takenAt, cards, figures, tabs: found.row.tabs ?? [] });
  });

  app.delete("/api/v1/snapshots/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select({ id: reportSnapshot.id, dashboardId: reportSnapshot.dashboardId }).from(reportSnapshot).where(eq(reportSnapshot.id, c.req.param("id")));
    const found = row ? await dashboardAccess(user.id, row.dashboardId) : null;
    if (!row || !found || found.role !== "owner") return c.json({ error: "not found" }, 404);
    await db.delete(reportSnapshot).where(eq(reportSnapshot.id, row.id));
    return c.body(null, 204);
  });

  // --- releases -----------------------------------------------------------------

  app.get("/api/v1/sources/:id/releases", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(release).where(eq(release.sourceId, found.src.id)).orderBy(desc(release.createdAt)).limit(50);
    const ids = [...new Set(rows.map((r) => r.createdBy))];
    const who = new Map((ids.length ? await db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(inArray(userTable.id, ids)) : []).map((u) => [u.id, u.name]));
    return c.json({ releases: rows.map((r) => ({ id: r.id, label: r.label, notes: r.notes, at: r.createdAt, by: who.get(r.createdBy) ?? "", results: r.results })) });
  });

  /** Cut a release: what the definitions are now, what changed since the last one, and how the tests stand. */
  app.post("/api/v1/sources/:id/releases", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot cut a release." }, 403);
    const parsed = z.object({ label: z.string().trim().min(1).max(80), notes: z.string().trim().max(2000).optional(), evenIfFailing: z.boolean().optional(), webhook: z.string().trim().max(500).optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "A release needs a name of 1 to 80 characters." }, 400);
    const defs = await db.select({ id: definition.id, label: definition.label, kind: definition.kind, version: definition.version, status: definition.status }).from(definition).where(eq(definition.sourceId, found.src.id));
    const [last] = await db.select().from(release).where(eq(release.sourceId, found.src.id)).orderBy(desc(release.createdAt)).limit(1);
    const before = new Map(((last?.results as { definitions?: typeof defs } | undefined)?.definitions ?? []).map((d) => [d.id, d]));
    const changed = [
      ...defs.filter((d) => !before.has(d.id)).map((d) => ({ label: d.label, what: last ? "new" : "first release" })),
      ...defs.filter((d) => before.has(d.id) && (before.get(d.id)!.version !== d.version || before.get(d.id)!.status !== d.status)).map((d) => ({ label: d.label, what: before.get(d.id)!.version !== d.version ? `changed (version ${before.get(d.id)!.version} to ${d.version})` : `now ${d.status.replace("_", " ")}` })),
      ...[...before.values()].filter((d) => !defs.some((x) => x.id === d.id)).map((d) => ({ label: d.label, what: "removed" })),
    ];
    const answers = await answersOf(found.src.id);
    const workbookId = found.src.kind === "workbook" ? (found.src.config as { workbookId?: string }).workbookId : null;
    const checks = workbookId ? await db.select().from(dataCheck).where(eq(dataCheck.workbookId, workbookId)) : [];
    const tests = {
      answers: { total: answers.length, pass: answers.filter((a) => a.lastStatus === "pass").length, fail: answers.filter((a) => a.lastStatus === "fail" || a.lastStatus === "error").length, notRun: answers.filter((a) => !a.lastStatus).length, failing: answers.filter((a) => a.lastStatus === "fail" || a.lastStatus === "error").map((a) => a.question) },
      checks: { total: checks.length, pass: checks.filter((k) => k.lastStatus === "ok").length, fail: checks.filter((k) => k.lastStatus === "failing" || k.lastStatus === "error").length, failing: checks.filter((k) => k.lastStatus === "failing" || k.lastStatus === "error").map((k) => k.name) },
    };
    const passed = tests.answers.fail === 0 && tests.checks.fail === 0;
    if (!passed && !parsed.data.evenIfFailing) return c.json({ error: `Tests are failing: ${[...tests.answers.failing, ...tests.checks.failing].slice(0, 5).join("; ")}. Fix them, or release anyway and it will be recorded as released with failures.`, tests }, 409);
    if (parsed.data.webhook) {
      const bad = await webhookProblem(parsed.data.webhook);
      if (bad) return c.json({ error: bad }, 400);
    }
    const [row] = await db.insert(release).values({ id: newId(), sourceId: found.src.id, label: parsed.data.label, notes: parsed.data.notes ?? "", createdBy: user.id, results: { definitions: defs, changed, tests, passed } }).returning();
    record({ userId: user.id, kind: "release.cut", objectKind: "source", objectId: found.src.id, label: found.src.name, ownerId: found.src.createdBy, detail: { label: row!.label, passed, changed: changed.length } });
    // For a pipeline that commits the definitions somewhere else: the whole release, posted once.
    const posted = parsed.data.webhook ? await postWebhook(parsed.data.webhook, { text: `${found.src.name}: release ${row!.label}${passed ? "" : " (with failures)"}`, source: { id: found.src.id, name: found.src.name }, release: { label: row!.label, notes: row!.notes, at: row!.createdAt, ...((row!.results as object) ?? {}) } }) : null;
    return c.json({ release: { id: row!.id, label: row!.label, notes: row!.notes, at: row!.createdAt, results: row!.results }, ...(parsed.data.webhook ? { webhook: posted ?? "sent" } : {}) }, 201);
  });
}
