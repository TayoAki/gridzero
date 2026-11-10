// Connected apps, their agent tools, and approvals for actions that change things
// (agent spec §10.2, §10.3).

import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import type { Vars } from "../app.ts";
import { ownAgent, streamRun } from "../agents/routes.ts";
import { appendMessage, newId } from "../agents/run.ts";
import { ToolError, registerTool } from "../agents/tools.ts";
import type { ClientTool } from "../agents/tools.ts";
import { db } from "../db/client.ts";
import { approval } from "../db/schema.ts";
import { captureError } from "../errors.ts";
import { CATALOG, FakeAppProvider, appName, appProvider, isReadOnly } from "./provider.ts";

const NOT_SET_UP = "Connected apps are not set up on this server.";
const MAX_RESULT = 4000;

function provider() {
  const p = appProvider();
  if (!p) throw new ToolError(NOT_SET_UP);
  return p;
}

const known = (slug: string) => CATALOG.some((a) => a.slug === slug);

/** Tool results stay small; a long result is cut with a note. */
function clip(value: unknown, max = MAX_RESULT): string {
  const text = JSON.stringify(value ?? null);
  return text.length <= max ? text : `${text.slice(0, max)}… (cut to ${max} characters)`;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  // Tests only: what the in-memory provider was asked to run.
  if (process.env.APP_PROVIDER === "fake") {
    app.get("/api/v1/apps/fake-calls", (c) => {
      const p = appProvider();
      return c.json({ calls: p instanceof FakeAppProvider ? p.calls.filter((x) => x.userId === c.get("user")?.id) : [] });
    });
  }

  app.get("/api/v1/apps", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const p = appProvider();
    if (!p) return c.json({ configured: false, apps: CATALOG.map((a) => ({ ...a, status: "none" })) });
    let connections: { slug: string; status: string }[] = [];
    try {
      connections = await p.connections(user.id);
    } catch (e) {
      captureError(e, { job: "apps.connections" });
      return c.json({ error: "The app service could not be reached. Try again in a moment." }, 502);
    }
    return c.json({ configured: true, apps: CATALOG.map((a) => ({ ...a, status: connections.find((x) => x.slug === a.slug)?.status ?? "none" })) });
  });

  app.post("/api/v1/apps/:slug/connect", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const p = appProvider();
    if (!p) return c.json({ error: NOT_SET_UP }, 409);
    if (!known(c.req.param("slug"))) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ returnUrl?: unknown }>().catch(() => ({}) as { returnUrl?: unknown });
    // Only back to our own pages.
    const origin = new URL(c.req.url).origin;
    const returnUrl = typeof body.returnUrl === "string" && body.returnUrl.startsWith("/") && !body.returnUrl.startsWith("//") ? origin + body.returnUrl : `${origin}/apps`;
    try {
      return c.json({ url: await p.connectUrl(user.id, c.req.param("slug"), returnUrl) });
    } catch (e) {
      captureError(e, { job: "apps.connect" });
      return c.json({ error: "The app service could not start the sign-in. Try again in a moment." }, 502);
    }
  });

  app.delete("/api/v1/apps/:slug", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const p = appProvider();
    if (!p) return c.json({ error: NOT_SET_UP }, 409);
    if (!known(c.req.param("slug"))) return c.json({ error: "not found" }, 404);
    await p.disconnect(user.id, c.req.param("slug"));
    return c.body(null, 204);
  });

  app.get("/api/v1/approvals/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const [row] = await db.select().from(approval).where(and(eq(approval.id, c.req.param("id")), eq(approval.ownerId, user.id)));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ id: row.id, agentId: row.agentId, action: row.action, args: row.args, status: row.status, createdAt: row.createdAt, decidedAt: row.decidedAt });
  });

  /** Decide once: the row moves from pending to `to`, or someone already decided. */
  async function decide(userId: string, id: string, to: "approved" | "refused") {
    const [row] = await db
      .update(approval)
      .set({ status: to, decidedAt: new Date() })
      .where(and(eq(approval.id, id), eq(approval.ownerId, userId), eq(approval.status, "pending")))
      .returning();
    return row ?? null;
  }

  async function exists(userId: string, id: string) {
    const [row] = await db.select({ id: approval.id }).from(approval).where(and(eq(approval.id, id), eq(approval.ownerId, userId)));
    return !!row;
  }

  app.post("/api/v1/approvals/:id/approve", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const p = appProvider();
    if (!p) return c.json({ error: NOT_SET_UP }, 409);
    const row = await decide(user.id, c.req.param("id"), "approved");
    if (!row) return (await exists(user.id, c.req.param("id"))) ? c.json({ error: "Already decided." }, 409) : c.json({ error: "not found" }, 404);
    const agentRow = await ownAgent(user.id, row.agentId);
    // The stored arguments run; the model is not asked again.
    let result: string;
    try {
      result = `Approved: ${row.action}. Result: ${clip(await p.runAction(user.id, row.action, row.args as object))}`;
    } catch (e) {
      captureError(e, { job: "approval", approvalId: row.id });
      result = `Approved: ${row.action}. The action failed: ${(e as Error).message.slice(0, 500)}`;
    }
    if (!agentRow) return c.json({ status: "approved", result });
    // Continue the conversation so the agent can report back.
    return streamRun(c, agentRow, user.id, result);
  });

  app.post("/api/v1/approvals/:id/refuse", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const row = await decide(user.id, c.req.param("id"), "refused");
    if (!row) return (await exists(user.id, c.req.param("id"))) ? c.json({ error: "Already decided." }, 409) : c.json({ error: "not found" }, 404);
    const text = `Refused: ${row.action}.`;
    await appendMessage(row.agentId, "user", [{ type: "text", text }], text, null);
    return c.json({ status: "refused" });
  });
}

// --- agent tools -------------------------------------------------------------

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const slugSchema = { type: "string", enum: CATALOG.map((a) => a.slug) };

const checkApp: ClientTool<{ slug: string }> = {
  name: "check_app",
  description: `Check whether the user has connected an app. Apps: ${CATALOG.map((a) => `${a.slug} (${a.name})`).join(", ")}.`,
  inputSchema: obj({ slug: slugSchema }),
  schema: z.object({ slug: z.string() }).strict(),
  readOnly: true,
  privateData: false,
  async run(input, ctx) {
    if (!known(input.slug)) throw new ToolError(`Unknown app ${input.slug}.`);
    const connected = (await provider().connections(ctx.userId)).some((c) => c.slug === input.slug && c.status === "active");
    if (connected) return { connected: true };
    ctx.emit({ type: "app_connect", slug: input.slug, name: appName(input.slug) });
    return { connected: false, next: `Ask the user to connect ${appName(input.slug)} and try again.` };
  },
  summary: (i, r) => `${appName(i.slug)} ${(r as { connected: boolean }).connected ? "is connected" : "is not connected"}`,
};

const findActions: ClientTool<{ slug: string; query: string }> = {
  name: "find_app_actions",
  description: "Find up to 10 actions in a connected app that match what you want to do. Returns each action's name, description, whether it only reads, and its input schema.",
  inputSchema: obj({ slug: slugSchema, query: { type: "string" } }),
  schema: z.object({ slug: z.string(), query: z.string() }).strict(),
  readOnly: true,
  privateData: false,
  async run(input, ctx) {
    if (!known(input.slug)) throw new ToolError(`Unknown app ${input.slug}.`);
    return { actions: await provider().findActions(ctx.userId, input.slug, input.query.slice(0, 200)) };
  },
  summary: (i) => `Looked for ${appName(i.slug)} actions`,
};

const runAction: ClientTool<{ name: string; args_json: string }> = {
  name: "run_app_action",
  description:
    "Run an app action found with find_app_actions. args_json is the action's arguments as a JSON object string. Actions that only read run at once. Actions that send, create, change or delete anything wait for the user to approve them in the chat; tell the user what you asked for and stop.",
  inputSchema: obj({ name: { type: "string" }, args_json: { type: "string" } }),
  schema: z.object({ name: z.string().regex(/^[A-Z0-9_]{3,120}$/, "must be an action name like GMAIL_SEND_EMAIL"), args_json: z.string().max(20_000) }).strict(),
  readOnly: false,
  privateData: true,
  kinds: ["chat"],
  async run(input, ctx) {
    let args: unknown;
    try {
      args = JSON.parse(input.args_json || "{}");
    } catch {
      throw new ToolError("args_json is not valid JSON.");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolError("args_json must be a JSON object.");
    const p = provider();
    if (isReadOnly(input.name)) {
      let raw: unknown;
      try {
        raw = await p.runAction(ctx.userId, input.name, args);
      } catch (e) {
        throw new ToolError(`The action failed: ${(e as Error).message.slice(0, 500)}`);
      }
      const text = JSON.stringify(raw ?? null);
      return text.length <= MAX_RESULT ? { result: raw } : { result_text: clip(raw) };
    }
    const id = newId();
    await db.insert(approval).values({ id, ownerId: ctx.userId, agentId: ctx.agentId, runId: ctx.runId, action: input.name, args });
    ctx.emit({ type: "approval", approvalId: id });
    return { status: "waiting for the user's approval", approval_id: id };
  },
  summary: (i) => (isReadOnly(i.name) ? `Ran ${i.name}` : `Asked to run ${i.name}`),
};

registerTool(checkApp as ClientTool<any>);
registerTool(findActions as ClientTool<any>);
registerTool(runAction as ClientTool<any>);
