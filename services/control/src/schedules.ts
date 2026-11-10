// Schedules: refresh a widget or run a read-only agent task on a cron (agent spec §9).

import { and, count, eq, lte } from "drizzle-orm";
import type { Hono } from "hono";

import type { Vars } from "./app.ts";
import { ERRORS } from "./agents/catalog.ts";
import { loadKey, monthSpend } from "./agents/keys.ts";
import { appendMessage, newId, runAgent } from "./agents/run.ts";
import { nextRun } from "./connected.ts";
import { db } from "./db/client.ts";
import { agent, dashboard, schedule, widget } from "./db/schema.ts";
import { captureError } from "./errors.ts";
import { RefreshError, refreshWidget } from "./widgets/refresh.ts";

type ScheduleRow = typeof schedule.$inferSelect;

const MAX_PER_WIDGET = 2;
const MAX_PER_USER = 20;
const CLAIMS_PER_TICK = 5;

const publicSchedule = (s: ScheduleRow) => ({
  id: s.id,
  kind: s.kind,
  agentId: s.agentId,
  widgetId: s.widgetId,
  prompt: s.prompt,
  cron: s.cron,
  label: s.label,
  paused: s.paused,
  nextRunAt: s.nextRunAt,
  lastRunAt: s.lastRunAt,
  lastStatus: s.lastStatus,
  lastError: s.lastError,
});

function checkCron(cron: unknown): string | null {
  return typeof cron === "string" && nextRun(cron, new Date()) ? null : "cron must be a 5-field schedule in UTC";
}

function checkLabel(label: unknown): string | null {
  return typeof label === "string" && label.trim() && label.length <= 100 ? null : "label must be 1-100 characters";
}

function checkPrompt(prompt: unknown): string | null {
  return typeof prompt === "string" && prompt.trim() && prompt.length <= 4000 ? null : "prompt must be 1-4000 characters";
}

async function ownWidget(userId: string, id: string) {
  const [row] = await db
    .select({ id: widget.id })
    .from(widget)
    .innerJoin(dashboard, eq(dashboard.id, widget.dashboardId))
    .where(and(eq(widget.id, id), eq(dashboard.ownerId, userId)));
  return row ?? null;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/schedules", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select().from(schedule).where(eq(schedule.ownerId, user.id)).orderBy(schedule.createdAt);
    return c.json({ schedules: rows.map(publicSchedule) });
  });

  app.post("/api/v1/schedules", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const problem = checkCron(b.cron) ?? checkLabel(b.label);
    if (problem) return c.json({ error: problem }, 400);
    const [{ n }] = (await db.select({ n: count() }).from(schedule).where(eq(schedule.ownerId, user.id))) as [{ n: number }];
    if (n >= MAX_PER_USER) return c.json({ error: `You can have at most ${MAX_PER_USER} schedules.` }, 400);

    const values = { id: newId(), ownerId: user.id, cron: (b.cron as string).trim(), label: (b.label as string).trim(), nextRunAt: nextRun(b.cron as string, new Date()) };
    if (b.kind === "widget_refresh") {
      if (typeof b.widgetId !== "string" || !(await ownWidget(user.id, b.widgetId))) return c.json({ error: "not found" }, 404);
      const [{ w }] = (await db.select({ w: count() }).from(schedule).where(eq(schedule.widgetId, b.widgetId))) as [{ w: number }];
      if (w >= MAX_PER_WIDGET) return c.json({ error: `A widget can have at most ${MAX_PER_WIDGET} schedules.` }, 400);
      const [row] = await db.insert(schedule).values({ ...values, kind: "widget_refresh", widgetId: b.widgetId }).returning();
      return c.json({ schedule: publicSchedule(row!) }, 201);
    }
    if (b.kind === "task") {
      const bad = checkPrompt(b.prompt);
      if (bad) return c.json({ error: bad }, 400);
      const [a] = typeof b.agentId === "string" ? await db.select({ id: agent.id }).from(agent).where(and(eq(agent.id, b.agentId), eq(agent.ownerId, user.id))) : [];
      if (!a) return c.json({ error: "not found" }, 404);
      const [row] = await db.insert(schedule).values({ ...values, kind: "task", agentId: a.id, prompt: (b.prompt as string).trim() }).returning();
      return c.json({ schedule: publicSchedule(row!) }, 201);
    }
    return c.json({ error: 'kind must be "widget_refresh" or "task"' }, 400);
  });

  app.patch("/api/v1/schedules/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(schedule).where(and(eq(schedule.id, c.req.param("id")), eq(schedule.ownerId, user.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const set: Partial<ScheduleRow> = {};
    if (b.paused !== undefined) {
      if (typeof b.paused !== "boolean") return c.json({ error: "paused must be true or false" }, 400);
      set.paused = b.paused;
    }
    if (b.cron !== undefined) {
      const problem = checkCron(b.cron);
      if (problem) return c.json({ error: problem }, 400);
      set.cron = (b.cron as string).trim();
    }
    if (b.label !== undefined) {
      const problem = checkLabel(b.label);
      if (problem) return c.json({ error: problem }, 400);
      set.label = (b.label as string).trim();
    }
    if (b.prompt !== undefined) {
      if (row.kind !== "task") return c.json({ error: "only tasks have a prompt" }, 400);
      const problem = checkPrompt(b.prompt);
      if (problem) return c.json({ error: problem }, 400);
      set.prompt = (b.prompt as string).trim();
    }
    // Resuming or a new time starts counting from now, so missed runs are not replayed.
    if (set.cron !== undefined || set.paused === false) set.nextRunAt = nextRun(set.cron ?? row.cron, new Date());
    const [updated] = await db.update(schedule).set(set).where(eq(schedule.id, row.id)).returning();
    return c.json({ schedule: publicSchedule(updated!) });
  });

  app.delete("/api/v1/schedules/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const deleted = await db.delete(schedule).where(and(eq(schedule.id, c.req.param("id")), eq(schedule.ownerId, user.id))).returning({ id: schedule.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });
}

// --- runner ------------------------------------------------------------------

/**
 * Claim one due schedule by moving its next run forward. The move is a single
 * compare-and-set on the next_run_at we read, so when several processes see the same
 * row only one update matches and only that process runs it.
 */
async function claim(now: Date): Promise<ScheduleRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [hit] = await db
      .select({ id: schedule.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
      .from(schedule)
      .where(and(eq(schedule.paused, false), lte(schedule.nextRunAt, now)))
      .orderBy(schedule.nextRunAt)
      .limit(1);
    if (!hit?.nextRunAt) return null;
    const [row] = await db
      .update(schedule)
      .set({ nextRunAt: nextRun(hit.cron, now) })
      .where(and(eq(schedule.id, hit.id), eq(schedule.nextRunAt, hit.nextRunAt)))
      .returning();
    if (row) return row;
  }
  return null;
}

async function finish(id: string, status: "ok" | "error", error: string | null) {
  await db.update(schedule).set({ lastRunAt: new Date(), lastStatus: status, lastError: error }).where(eq(schedule.id, id));
}

async function runTask(s: ScheduleRow): Promise<string | null> {
  const [a] = s.agentId ? await db.select().from(agent).where(eq(agent.id, s.agentId)) : [];
  if (!a || !s.prompt) return "The agent for this task no longer exists.";
  const key = await loadKey(s.ownerId);
  if (!key) return ERRORS.E_NO_KEY;
  if ((await monthSpend(s.ownerId)) >= key.capMicroUsd) return ERRORS.E_LIMIT;
  const result = await runAgent({ agent: a, userId: s.ownerId, apiKey: key.key, kind: "scheduled", userText: s.prompt, store: false, emit: () => {} });
  if (!result.ok) return ERRORS[result.errorCode!];
  // A hidden request and a visible reply, so the chat history keeps alternating turns.
  await appendMessage(a.id, "user", [{ type: "text", text: `(Scheduled task: ${s.label})\n\n${s.prompt}` }], null, result.runId);
  await appendMessage(a.id, "assistant", [{ type: "text", text: `Scheduled: ${s.label}\n\n${result.finalText.trim() || "(no reply)"}` }], null, result.runId);
  return null;
}

async function runOne(s: ScheduleRow): Promise<void> {
  try {
    let error: string | null = null;
    if (s.kind === "widget_refresh") {
      const [w] = s.widgetId ? await db.select().from(widget).where(eq(widget.id, s.widgetId)) : [];
      if (!w) error = "The widget no longer exists.";
      else {
        try {
          await refreshWidget(s.ownerId, w);
        } catch (e) {
          if (!(e instanceof RefreshError)) throw e;
          error = e.message;
        }
      }
    } else {
      error = await runTask(s);
    }
    await finish(s.id, error ? "error" : "ok", error);
  } catch (e) {
    captureError(e, { job: "schedule", scheduleId: s.id });
    await finish(s.id, "error", "Something went wrong on our side. It has been logged.").catch(() => {});
  }
}

let running = false;

/** Run up to 5 due schedules. Safe to call from several processes at once. */
export async function runDueSchedules(now = new Date()): Promise<number> {
  if (running) return 0;
  running = true;
  let ran = 0;
  try {
    for (let i = 0; i < CLAIMS_PER_TICK; i++) {
      const s = await claim(now);
      if (!s) break;
      await runOne(s);
      ran++;
    }
  } finally {
    running = false;
  }
  return ran;
}
