// Routes for workspaces, sources and confirmed definitions (docs/specs/DEFINITIONS-SPEC.md).

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";

import type { Vars } from "../app.ts";
import { newId } from "../agents/run.ts";
import { encryptSecret, secretsConfigured, testConnection } from "../connectors.ts";
import { db } from "../db/client.ts";
import { connection, definition, definitionChange, definitionEvent, question, source, sourceCredential, user, workspace, workspaceMember } from "../db/schema.ts";
import { captureError } from "../errors.ts";
import { audit } from "../sharing.ts";
import { AiUnavailable, correctionProposal, nameDefinitions } from "./ai.ts";
import { EngineError } from "./engine.ts";
import { toOssie } from "./ossie.ts";
import { MetricSqlError, NoCredential, SourceError, memberAccess } from "./sql.ts";
import type { SourceConfig } from "./sql.ts";
import { AnswerError, ProposalError, TooCostly, answer, canEdit, confirm, definitionFor, latestScan, logEvent, membership, pendingChanges, propose, publish, runMetric, runScan, scanEstimate, sourceDefinitions, sourceFor } from "./store.ts";
import type { DefinitionRow, Proposal, ScanResult } from "./store.ts";
import "./tools.ts";

type C = Context<{ Variables: Vars }>;

const publicDefinition = (d: DefinitionRow) => ({
  id: d.id,
  kind: d.kind,
  name: d.name,
  label: d.label,
  description: d.description,
  body: d.body,
  status: d.status,
  confidence: d.confidence,
  evidence: d.evidence,
  ownerId: d.ownerId,
  confirmedBy: d.confirmedBy,
  confirmedAt: d.confirmedAt,
  checkNumber: d.checkNumber,
  version: d.version,
});

/** Errors a person can act on become a 4xx with their message; anything else is logged and reported plainly. */
function failure(c: C, e: unknown) {
  if (e instanceof NoCredential) return c.json({ error: e.message, code: "E_NO_CREDENTIAL" }, 409);
  if (e instanceof TooCostly) return c.json({ error: e.message, code: "E_COSTLY", estimate: e.estimate }, 409);
  if (e instanceof AnswerError || e instanceof ProposalError || e instanceof MetricSqlError) return c.json({ error: e.message }, 400);
  if (e instanceof AiUnavailable) return c.json({ error: e.message, code: "E_AI" }, 409);
  if (e instanceof EngineError) {
    captureError(e, { where: "semantic engine" });
    return c.json({ error: "The scan could not finish. It has been logged." }, 502);
  }
  if (e instanceof SourceError) return c.json({ error: `The database refused: ${e.message}` }, 502);
  throw e; // ours: logged and answered with the fixed message by app.onError
}

const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function routes(app: Hono<{ Variables: Vars }>) {
  // --- workspaces ---------------------------------------------------------------

  app.get("/api/v1/workspaces", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const rows = await db.select({ id: workspace.id, name: workspace.name, role: workspaceMember.role }).from(workspaceMember).innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId)).where(eq(workspaceMember.userId, me.id)).orderBy(asc(workspace.createdAt));
    return c.json({ workspaces: rows });
  });

  app.post("/api/v1/workspaces", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return c.json({ error: "name must be 1-80 characters" }, 400);
    const id = newId();
    await db.transaction(async (tx) => {
      await tx.insert(workspace).values({ id, name, createdBy: me.id });
      await tx.insert(workspaceMember).values({ id: newId(), workspaceId: id, userId: me.id, role: "admin" });
    });
    return c.json({ id, name, role: "admin" }, 201);
  });

  app.get("/api/v1/workspaces/:id/members", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    if (!(await membership(me.id, c.req.param("id")))) return c.json({ error: "not found" }, 404);
    const rows = await db.select({ userId: user.id, name: user.name, email: user.email, role: workspaceMember.role, team: workspaceMember.team }).from(workspaceMember).innerJoin(user, eq(user.id, workspaceMember.userId)).where(eq(workspaceMember.workspaceId, c.req.param("id"))).orderBy(asc(workspaceMember.createdAt));
    return c.json({ members: rows });
  });

  /** Add someone who already has an account. Invitations by email for people without one come later. */
  app.post("/api/v1/workspaces/:id/members", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const role = await membership(me.id, c.req.param("id"));
    if (!role) return c.json({ error: "not found" }, 404);
    if (role !== "admin") return c.json({ error: "Only an admin can add members." }, 403);
    const body = await c.req.json<{ email?: unknown; role?: unknown; team?: unknown }>().catch(() => ({}) as { email?: unknown; role?: unknown; team?: unknown });
    if (typeof body.email !== "string" || !["admin", "editor", "viewer"].includes(body.role as string)) return c.json({ error: "email and role (admin, editor or viewer) are required" }, 400);
    const [found] = await db.select({ id: user.id }).from(user).where(eq(user.email, body.email.trim().toLowerCase()));
    if (!found) return c.json({ error: "Nobody with that email has a GridZero account yet." }, 404);
    const team = typeof body.team === "string" && body.team.trim() ? body.team.trim().slice(0, 60) : null;
    await db
      .insert(workspaceMember)
      .values({ id: newId(), workspaceId: c.req.param("id"), userId: found.id, role: body.role as "admin" | "editor" | "viewer", team })
      .onConflictDoUpdate({ target: [workspaceMember.workspaceId, workspaceMember.userId], set: { role: body.role as "admin" | "editor" | "viewer", team } });
    return c.json({ userId: found.id, role: body.role, team }, 201);
  });

  // --- sources and each member's own sign-in ----------------------------------------

  app.get("/api/v1/workspaces/:id/sources", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const role = await membership(me.id, c.req.param("id"));
    if (!role) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(source).where(eq(source.workspaceId, c.req.param("id"))).orderBy(asc(source.createdAt));
    const creds = rows.length ? await db.select({ sourceId: sourceCredential.sourceId, username: sourceCredential.username }).from(sourceCredential).where(and(eq(sourceCredential.userId, me.id), inArray(sourceCredential.sourceId, rows.map((r) => r.id)))) : [];
    const out = [];
    for (const s of rows) {
      const last = await latestScan(s.id);
      out.push({ id: s.id, name: s.name, kind: s.kind, config: s.config, mySignIn: s.kind === "workbook" ? "your access to the workbook" : (creds.find((x) => x.sourceId === s.id)?.username ?? null), lastScanAt: last?.finishedAt ?? null });
    }
    return c.json({ role, sources: out });
  });

  app.post("/api/v1/workspaces/:id/sources", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const role = await membership(me.id, c.req.param("id"));
    if (!role) return c.json({ error: "not found" }, 404);
    if (role !== "admin") return c.json({ error: "Only an admin can add a source." }, 403);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    let config: SourceConfig;
    let name = typeof body.name === "string" ? body.name.trim() : "";
    let copy: { username: string; secret: string } | null = null;
    if (typeof body.connectionId === "string") {
      // Start from one of the person's own connections: the address is shared, the sign-in stays theirs.
      const [conn] = await db.select().from(connection).where(and(eq(connection.id, body.connectionId), eq(connection.ownerId, me.id)));
      if (!conn) return c.json({ error: "Choose one of your connections." }, 400);
      if (conn.kind !== "postgres") return c.json({ error: "Only Postgres sources can be scanned so far." }, 400);
      const cc = conn.config as { host?: string; port?: number; database?: string; ssl?: SourceConfig["ssl"]; user?: string };
      config = { host: cc.host ?? "", port: cc.port, database: cc.database ?? "", ssl: cc.ssl };
      name ||= conn.name;
      if (cc.user) copy = { username: cc.user, secret: conn.secret };
    } else {
      const port = body.port === undefined || body.port === null || body.port === "" ? undefined : Number(body.port);
      const ssl = body.ssl === undefined ? "verify" : body.ssl;
      if (typeof body.host !== "string" || !HOST.test(body.host) || typeof body.database !== "string" || !body.database.trim()) return c.json({ error: "host and database are required" }, 400);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return c.json({ error: "port must be between 1 and 65535" }, 400);
      if (!["verify", "require", "disable"].includes(ssl as string)) return c.json({ error: "ssl must be verify, require or disable" }, 400);
      config = { host: body.host, port, database: body.database.trim(), ssl: ssl as SourceConfig["ssl"] };
    }
    if (Array.isArray(body.schemas) && body.schemas.length) {
      if (!body.schemas.every((s) => typeof s === "string" && NAME.test(s)) || body.schemas.length > 20) return c.json({ error: "schemas must be up to 20 plain names" }, 400);
      config.schemas = body.schemas as string[];
    }
    if (!name || name.length > 80) return c.json({ error: "name must be 1-80 characters" }, 400);
    const [dupe] = await db.select({ id: source.id }).from(source).where(and(eq(source.workspaceId, c.req.param("id")), eq(source.name, name)));
    if (dupe) return c.json({ error: `This workspace already has a source named ${name}.` }, 409);
    const id = newId();
    await db.insert(source).values({ id, workspaceId: c.req.param("id"), kind: "postgres", name, config, createdBy: me.id });
    if (copy) await db.insert(sourceCredential).values({ sourceId: id, userId: me.id, username: copy.username, secret: copy.secret });
    await audit("", me.id, "source.create", { id, name });
    return c.json({ id, name, config, mySignIn: copy?.username ?? null }, 201);
  });

  /** Save the caller's own sign-in for a source, after checking that it works. */
  app.put("/api/v1/sources/:id/credential", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!secretsConfigured()) return c.json({ error: "Connections are not set up on this server" }, 503);
    const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => ({}) as { username?: unknown; password?: unknown });
    if (typeof body.username !== "string" || !body.username.trim() || typeof body.password !== "string" || !body.password) return c.json({ error: "username and password are required" }, 400);
    const cfg = found.src.config as SourceConfig;
    try {
      await testConnection("postgres", { host: cfg.host, port: cfg.port, database: cfg.database, ssl: cfg.ssl, user: body.username.trim() }, body.password);
    } catch (e) {
      return c.json({ error: `That sign-in did not work: ${(e as Error).message.slice(0, 300)}` }, 400);
    }
    const secret = encryptSecret(body.password);
    await db
      .insert(sourceCredential)
      .values({ sourceId: found.src.id, userId: me.id, username: body.username.trim(), secret })
      .onConflictDoUpdate({ target: [sourceCredential.sourceId, sourceCredential.userId], set: { username: body.username.trim(), secret } });
    await audit("", me.id, "source.credential", { id: found.src.id });
    return c.json({ mySignIn: body.username.trim() });
  });

  app.delete("/api/v1/sources/:id/credential", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    await db.delete(sourceCredential).where(and(eq(sourceCredential.sourceId, found.src.id), eq(sourceCredential.userId, me.id)));
    return c.body(null, 204);
  });

  // --- scan -----------------------------------------------------------------------

  app.get("/api/v1/sources/:id/scan/estimate", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await scanEstimate(found.src, me.id));
    } catch (e) {
      return failure(c, e);
    }
  });

  app.post("/api/v1/sources/:id/scan", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot start a scan." }, 403);
    try {
      const summary = await runScan(found.src, me.id);
      // Business names are a nicety: with no AI key the draft keeps its plain names.
      const fresh = (await sourceDefinitions(found.src.id)).filter((d) => d.status !== "confirmed" && !d.description);
      const named = await nameDefinitions(me.id, fresh);
      for (const n of named) {
        const d = fresh.find((x) => x.name === n.name && (!n.kind || x.kind === n.kind));
        if (d) await db.update(definition).set({ label: n.label, description: n.description }).where(eq(definition.id, d.id));
      }
      await audit("", me.id, "source.scan", { id: found.src.id, ...summary });
      return c.json({ ...summary, named: named.length });
    } catch (e) {
      return failure(c, e);
    }
  });

  /** Everything the review screen shows for one source. */
  app.get("/api/v1/sources/:id/review", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const last = await latestScan(found.src.id);
    const defs = await sourceDefinitions(found.src.id);
    const questions = await db.select().from(question).where(eq(question.sourceId, found.src.id)).orderBy(asc(question.rank));
    const members = await db.select({ userId: user.id, name: user.name, email: user.email, role: workspaceMember.role, team: workspaceMember.team }).from(workspaceMember).innerJoin(user, eq(user.id, workspaceMember.userId)).where(eq(workspaceMember.workspaceId, found.src.workspaceId));
    const [cred] = await db.select({ username: sourceCredential.username }).from(sourceCredential).where(and(eq(sourceCredential.sourceId, found.src.id), eq(sourceCredential.userId, me.id)));
    const scanResult = last?.result as ScanResult | undefined;
    return c.json({
      source: { id: found.src.id, name: found.src.name, workspaceId: found.src.workspaceId, config: found.src.config },
      role: found.role,
      me: me.id,
      mySignIn: found.src.kind === "workbook" ? "your access to the workbook" : (cred?.username ?? null),
      kind: found.src.kind,
      scan: last ? { id: last.id, finishedAt: last.finishedAt, startedBy: last.startedBy, stats: last.stats, tables: Object.entries(scanResult?.tables ?? {}).map(([fq, t]) => ({ name: fq, rows: t.rows, sampled: t.sampled, columns: t.columns.length })) } : null,
      definitions: defs.map(publicDefinition),
      questions: questions.map((q) => ({ id: q.id, kind: q.kind, topic: q.topic, prompt: q.prompt, options: q.options, rank: q.rank, atSetup: q.atSetup, assigneeId: q.assigneeId, status: q.status, answer: q.answer, answeredBy: q.answeredBy })),
      changes: (await pendingChanges(found.src.id)).map((ch) => ({ id: ch.id, definitionId: ch.definitionId, origin: ch.origin, request: ch.request, preview: ch.preview, proposedBy: ch.proposedBy, createdAt: ch.createdAt })),
      members,
    });
  });

  // --- questions ---------------------------------------------------------------------

  const ownQuestion = async (userId: string, id: string) => {
    const [q] = await db.select().from(question).where(eq(question.id, id));
    if (!q) return null;
    const found = await sourceFor(userId, q.sourceId);
    return found ? { q, ...found } : null;
  };

  app.post("/api/v1/questions/:id/answer", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await ownQuestion(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot answer questions." }, 403);
    if (found.q.status !== "open") return c.json({ error: "That question was already answered." }, 409);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    try {
      return c.json(
        await answer(found.q, found.src, me.id, {
          option: Number.isInteger(body.option) ? (body.option as number) : undefined,
          text: typeof body.text === "string" ? body.text : undefined,
          definitionId: typeof body.definitionId === "string" ? body.definitionId : undefined,
          value: typeof body.value === "number" ? body.value : undefined,
        }),
      );
    } catch (e) {
      return failure(c, e);
    }
  });

  app.post("/api/v1/questions/:id/assign", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await ownQuestion(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot pass a question on." }, 403);
    const body = await c.req.json<{ userId?: unknown }>().catch(() => ({}) as { userId?: unknown });
    if (typeof body.userId !== "string" || !(await membership(body.userId, found.src.workspaceId))) return c.json({ error: "Choose a member of this workspace." }, 400);
    await db.update(question).set({ assigneeId: body.userId }).where(eq(question.id, found.q.id));
    return c.json({ assigneeId: body.userId });
  });

  app.post("/api/v1/questions/:id/skip", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await ownQuestion(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot skip questions." }, 403);
    await db.update(question).set({ status: "skipped", answeredBy: me.id, answeredAt: new Date() }).where(and(eq(question.id, found.q.id), eq(question.status, "open")));
    return c.body(null, 204);
  });

  // --- definitions ---------------------------------------------------------------------

  /** A metric's number right now, with the estimate and the SQL. `proceed=1` after the person has seen a high estimate. */
  app.get("/api/v1/definitions/:id/value", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await definitionFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.def.kind !== "metric") return c.json({ error: "Only a metric has a number." }, 400);
    try {
      const all = (await sourceDefinitions(found.src.id)).map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, status: d.status, body: d.body as Record<string, any> }));
      const v = await runMetric(await memberAccess(found.src, me.id), all.find((d) => d.id === found.def.id)!, all, {}, c.req.query("proceed") === "1");
      return c.json({ value: v.value, sql: v.sql, estimate: v.estimate, status: found.def.status });
    } catch (e) {
      return failure(c, e);
    }
  });

  app.post("/api/v1/definitions/:id/confirm", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await definitionFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot confirm definitions." }, 403);
    try {
      return c.json({ definition: publicDefinition(await confirm(found.def, found.src, me.id)) });
    } catch (e) {
      return failure(c, e);
    }
  });

  /** Any member can object to a confirmed definition. It keeps serving, marked as under review. */
  app.post("/api/v1/definitions/:id/dispute", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await definitionFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({}) as { reason?: unknown });
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (!reason) return c.json({ error: "Say what is wrong." }, 400);
    if (found.def.status !== "confirmed") return c.json({ error: "Only a confirmed definition can be disputed." }, 409);
    const [row] = await db.update(definition).set({ status: "disputed", updatedAt: new Date() }).where(eq(definition.id, found.def.id)).returning();
    await logEvent(found.def.id, me.id, "disputed", { reason });
    return c.json({ definition: publicDefinition(row!) });
  });

  app.get("/api/v1/definitions/:id/history", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await definitionFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const events = await db.select().from(definitionEvent).where(eq(definitionEvent.definitionId, found.def.id)).orderBy(asc(definitionEvent.id));
    return c.json({ events });
  });

  /**
   * Propose a correction. `request` in plain words is rewritten by AI (the caller's own key); or pass
   * `expression` / `filters` to edit directly. Either way nothing changes until the change is published.
   */
  app.post("/api/v1/definitions/:id/correct", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await definitionFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot correct definitions." }, 403);
    if (found.def.kind !== "metric" && found.def.kind !== "rule") return c.json({ error: "Only metrics and rules can be corrected this way so far." }, 400);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const request = typeof body.request === "string" ? body.request.trim() : "";
    const direct: Proposal = {
      expression: typeof body.expression === "string" ? body.expression : undefined,
      filters: Array.isArray(body.filters) && body.filters.every((f) => typeof f === "string") ? (body.filters as string[]) : undefined,
    };
    const isDirect = direct.expression !== undefined || direct.filters !== undefined;
    if (!isDirect && !request) return c.json({ error: "Say what should change." }, 400);
    try {
      let proposal: Proposal & { explanation?: string } = direct;
      if (!isDirect) {
        const last = await latestScan(found.src.id);
        if (!last) return c.json({ error: "Scan the source first." }, 409);
        const rules = (await sourceDefinitions(found.src.id)).filter((d) => d.kind === "rule");
        proposal = await correctionProposal(me.id, found.def, rules, last.result as ScanResult, request);
      }
      const change = await propose(found.def, found.src, me.id, "correction", request || "Edited directly", proposal);
      return c.json({ change: { id: change.id, definitionId: change.definitionId, request: change.request, preview: change.preview, explanation: proposal.explanation ?? null } }, 201);
    } catch (e) {
      return failure(c, e);
    }
  });

  const ownChange = async (userId: string, id: string) => {
    const [ch] = await db.select().from(definitionChange).where(eq(definitionChange.id, id));
    if (!ch) return null;
    const found = await definitionFor(userId, ch.definitionId);
    return found ? { ch, ...found } : null;
  };

  app.post("/api/v1/changes/:id/publish", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await ownChange(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot publish changes." }, 403);
    try {
      return c.json({ definition: publicDefinition(await publish(found.ch.id, me.id)) });
    } catch (e) {
      return failure(c, e);
    }
  });

  app.post("/api/v1/changes/:id/discard", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await ownChange(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!canEdit(found.role)) return c.json({ error: "Viewers cannot discard changes." }, 403);
    await db.update(definitionChange).set({ status: "discarded", decidedBy: me.id, decidedAt: new Date() }).where(and(eq(definitionChange.id, found.ch.id), eq(definitionChange.status, "proposed")));
    return c.body(null, 204);
  });

  // --- export ------------------------------------------------------------------------

  app.get("/api/v1/sources/:id/export", async (c) => {
    const me = c.get("user");
    if (!me) return c.json({ error: "unauthenticated" }, 401);
    const found = await sourceFor(me.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const last = await latestScan(found.src.id);
    const scanResult = (last?.result as ScanResult | undefined) ?? { tables: {}, links: [] };
    const columnKinds = Object.fromEntries(Object.entries(scanResult.tables).map(([fq, t]) => [fq, Object.fromEntries(t.columns.map((col) => [col.name, col.kind]))]));
    const name = found.src.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^(\d)/, "_$1") || "gridzero";
    const yaml = toOssie(await sourceDefinitions(found.src.id), { name, all: c.req.query("all") === "1", columnKinds });
    return c.body(yaml, 200, { "Content-Type": "text/yaml; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.ossie.yaml"` });
  });
}
