// Agent routes (spec §5.5).

import { and, desc, eq, gte, sql as dsql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";

import type { Vars } from "../app.ts";
import { db } from "../db/client.ts";
import { agent, agentMessage, agentRun } from "../db/schema.ts";
import { AVATARS, COLORS, ERRORS } from "./catalog.ts";
import { KeyError, deleteKey, keyStatus, loadKey, overCap, saveKey, setCap } from "./keys.ts";
import { listMessages, newId, runAgent } from "./run.ts";
import "./workbook-tools.ts";
import type { StreamLine } from "./run.ts";

type AgentRow = typeof agent.$inferSelect;
const publicAgent = (a: AgentRow) => ({ id: a.id, name: a.name, avatar: a.avatar, color: a.color, instructions: a.instructions, createdAt: a.createdAt });

/** Validate agent fields; `partial` allows a subset. Returns the fields or an error message. */
function agentFields(body: Record<string, unknown>, partial: boolean): Partial<Pick<AgentRow, "name" | "avatar" | "color" | "instructions">> | string {
  const out: Partial<Pick<AgentRow, "name" | "avatar" | "color" | "instructions">> = {};
  const has = (k: string) => body[k] !== undefined;
  if (!partial || has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) return "name must be 1-60 characters";
    out.name = name;
  }
  if (!partial || has("avatar")) {
    if (!(AVATARS as readonly unknown[]).includes(body.avatar)) return `avatar must be one of ${AVATARS.join(", ")}`;
    out.avatar = body.avatar as string;
  }
  if (!partial || has("color")) {
    if (!(COLORS as readonly unknown[]).includes(body.color)) return `color must be one of ${COLORS.join(", ")}`;
    out.color = body.color as string;
  }
  if (!partial || has("instructions")) {
    const instructions = body.instructions === undefined ? "" : body.instructions;
    if (typeof instructions !== "string" || instructions.length > 4000) return "instructions must be at most 4000 characters";
    out.instructions = instructions;
  }
  return out;
}

export async function ownAgent(userId: string, id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agent).where(and(eq(agent.id, id), eq(agent.ownerId, userId)));
  return row ?? null;
}

/**
 * Run the agent on `userText` after the key, cap and busy checks, streaming NDJSON
 * lines (spec §4.2). The run finishes even if the browser leaves.
 */
export async function streamRun(c: Context, row: AgentRow, userId: string, userText: string) {
  const key = await loadKey(userId);
  if (!key) return c.json({ error: ERRORS.E_NO_KEY, code: "E_NO_KEY" }, 409);
  const over = await overCap(userId, key);
  if (over) return c.json({ error: ERRORS[over], code: over }, 429);
  const [busy] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(and(eq(agentRun.agentId, row.id), eq(agentRun.status, "running"), gte(agentRun.startedAt, new Date(Date.now() - 10 * 60_000))));
  if (busy) return c.json({ error: ERRORS.E_BUSY, code: "E_BUSY" }, 409);

  c.header("Content-Type", "application/x-ndjson");
  c.header("Cache-Control", "no-store");
  return stream(c, async (s) => {
    let open = true;
    s.onAbort(() => {
      open = false;
    });
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    const emit = (line: StreamLine) => {
      lines.push(JSON.stringify(line) + "\n");
      wake?.();
    };
    let finished = false;
    const run = runAgent({ agent: row, userId, apiKey: key.key, provider: key.provider, keySource: key.source, kind: "chat", userText, store: true, emit }).finally(() => {
      finished = true;
      wake?.();
    });
    while (!finished || lines.length) {
      if (!lines.length) {
        await new Promise<void>((r) => (wake = r));
        wake = null;
        continue;
      }
      const line = lines.shift()!;
      if (open) await s.write(line).catch(() => (open = false));
    }
    await run;
  });
}

export function routes(app: Hono<{ Variables: Vars }>) {
  // --- key ---------------------------------------------------------------
  app.get("/api/v1/ai-key", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json(await keyStatus(user.id));
  });

  app.put("/api/v1/ai-key", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
    try {
      return c.json(await saveKey(user.id, typeof body.key === "string" ? body.key : ""));
    } catch (e) {
      if (e instanceof KeyError) return c.json({ error: ERRORS[e.code] }, e.code === "E_BAD_KEY" ? 400 : 502);
      throw e;
    }
  });

  app.patch("/api/v1/ai-key", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ monthlyCapUsd?: unknown }>().catch(() => ({}) as { monthlyCapUsd?: unknown });
    const cap = Number(body.monthlyCapUsd);
    if (!Number.isFinite(cap) || cap < 1 || cap > 10_000) return c.json({ error: "monthlyCapUsd must be between 1 and 10000" }, 400);
    if (!(await setCap(user.id, cap))) return c.json({ error: ERRORS.E_NO_KEY }, 409);
    return c.json({ monthlyCapUsd: cap });
  });

  app.delete("/api/v1/ai-key", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    await deleteKey(user.id);
    return c.body(null, 204);
  });

  // --- agents ------------------------------------------------------------
  app.get("/api/v1/agents", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select().from(agent).where(eq(agent.ownerId, user.id)).orderBy(desc(agent.createdAt));
    return c.json({ agents: rows.map(publicAgent) });
  });

  app.post("/api/v1/agents", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const fields = agentFields(await c.req.json().catch(() => ({})), false);
    if (typeof fields === "string") return c.json({ error: fields }, 400);
    const [row] = await db
      .insert(agent)
      .values({ id: newId(), ownerId: user.id, name: fields.name!, avatar: fields.avatar!, color: fields.color!, instructions: fields.instructions ?? "" })
      .returning();
    return c.json({ agent: publicAgent(row!) }, 201);
  });

  app.patch("/api/v1/agents/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownAgent(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const fields = agentFields(await c.req.json().catch(() => ({})), true);
    if (typeof fields === "string") return c.json({ error: fields }, 400);
    const [row] = await db
      .update(agent)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(agent.id, c.req.param("id")))
      .returning();
    return c.json({ agent: publicAgent(row!) });
  });

  app.delete("/api/v1/agents/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownAgent(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    await db.delete(agent).where(eq(agent.id, c.req.param("id")));
    return c.body(null, 204);
  });

  // --- messages ----------------------------------------------------------
  app.get("/api/v1/agents/:id/messages", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownAgent(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const before = Number(c.req.query("before"));
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
    return c.json(await listMessages(c.req.param("id"), Number.isInteger(before) && before > 0 ? before : null, limit));
  });

  app.delete("/api/v1/agents/:id/messages", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!(await ownAgent(user.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    await db.delete(agentMessage).where(eq(agentMessage.agentId, c.req.param("id")));
    return c.body(null, 204);
  });

  // --- chat --------------------------------------------------------------
  app.post("/api/v1/agents/:id/chat", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await ownAgent(user.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 8000) return c.json({ error: "Message must be 1-8000 characters." }, 400);

    return streamRun(c, row, user.id, text);
  });

  // --- usage -------------------------------------------------------------
  app.get("/api/v1/usage", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const days = [7, 30, 90].includes(Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const where = and(eq(agentRun.ownerId, user.id), gte(agentRun.startedAt, since));
    const byDay = await db
      .select({ date: dsql<string>`to_char(${agentRun.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`, cost: dsql<string>`sum(${agentRun.costMicroUsd})` })
      .from(agentRun)
      .where(where)
      .groupBy(dsql`1`)
      .orderBy(dsql`1`);
    const byAgent = await db
      .select({ agentId: agentRun.agentId, name: agent.name, cost: dsql<string>`sum(${agentRun.costMicroUsd})` })
      .from(agentRun)
      .innerJoin(agent, eq(agent.id, agentRun.agentId))
      .where(where)
      .groupBy(agentRun.agentId, agent.name);
    const [totals] = await db.select({ cost: dsql<string>`coalesce(sum(${agentRun.costMicroUsd}), 0)`, runs: dsql<string>`count(*)` }).from(agentRun).where(where);
    const usd = (v: string | null | undefined) => Number(v ?? 0) / 1_000_000;
    return c.json({
      totalCostUsd: usd(totals?.cost),
      runs: Number(totals?.runs ?? 0),
      byDay: byDay.map((d) => ({ date: d.date, costUsd: usd(d.cost) })),
      byAgent: byAgent.map((a) => ({ agentId: a.agentId, name: a.name, costUsd: usd(a.cost) })),
    });
  });
}
