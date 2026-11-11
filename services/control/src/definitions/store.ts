// Confirmed definitions: the scan job, questions with numbers, confirm, correct and publish
// (docs/specs/DEFINITIONS-SPEC.md §3-§7). Routes are in routes.ts; agents use tools.ts.

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { newId } from "../agents/run.ts";
import { db } from "../db/client.ts";
import { connectedTable, connection, definition, definitionChange, definitionEvent, question, scan, source, user, workspace, workspaceMember } from "../db/schema.ts";
import { engineJob } from "./engine.ts";
import { MetricSqlError, estimate, humanNumber, memberAccess, metricSql, query } from "./sql.ts";
import type { Def, Member, SourceConfig, SourceRow } from "./sql.ts";
import { stage } from "./tables.ts";
import type { TableFilter } from "./tables.ts";
import { trustConfirmed } from "./trusted.ts";

/** The SQL dialect a source's expressions are written in. */
export const dialectOf = (src: SourceRow) => (src.kind === "workbook" ? "duckdb" : "postgres");

export type DefinitionRow = typeof definition.$inferSelect;
export type QuestionRow = typeof question.$inferSelect;
export type Role = "admin" | "editor" | "viewer";

export interface Evidence {
  type: string;
  text: string;
  count?: number;
  people?: number;
}

interface ScanTable {
  schema: string;
  table: string;
  rows: number;
  sampled: boolean;
  columns: { name: string; type: string; kind: string; distinct: number | null; nulls: number | null; top: [string, number][] | null }[];
  keys: { columns: string[] }[];
  flags: { column: string; kind: "flag" | "status"; values: string[]; rows: number }[];
  grain_breaks: { column: string; rows: number; distinct: number }[];
}
export interface ScanResult {
  tables: Record<string, ScanTable>;
  links: { from: string; to: string; from_columns: string[]; to_columns: string[]; proposed?: boolean }[];
}
interface Draft {
  kind: DefinitionRow["kind"];
  name: string;
  label: string;
  body: Record<string, any>;
  evidence: Evidence[];
  confidence: DefinitionRow["confidence"];
  status: DefinitionRow["status"];
}
interface DraftQuestion {
  kind: string;
  topic: string;
  prompt: string;
  options: { label: string; change: string; expression?: string }[];
  data: Record<string, any>;
  rank: number;
  at_setup: boolean;
}
interface Analysis {
  scan: ScanResult;
  definitions: Draft[];
  questions: DraftQuestion[];
  findings: { check: string; level: string; message: string }[];
  history: { statements: number; unparsed: number; joins: number; named_totals: number };
}

export async function membership(userId: string, workspaceId: string): Promise<Role | null> {
  const [row] = await db.select({ role: workspaceMember.role }).from(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
  return (row?.role as Role | undefined) ?? null;
}

export const canEdit = (role: Role | null) => role === "admin" || role === "editor";

/** A source the user can see, with their role in its workspace. */
export async function sourceFor(userId: string, sourceId: string): Promise<{ src: SourceRow; role: Role } | null> {
  const [src] = await db.select().from(source).where(eq(source.id, sourceId));
  if (!src) return null;
  const role = await membership(userId, src.workspaceId);
  return role ? { src, role } : null;
}

export async function definitionFor(userId: string, id: string): Promise<{ def: DefinitionRow; src: SourceRow; role: Role } | null> {
  const [def] = await db.select().from(definition).where(eq(definition.id, id));
  if (!def) return null;
  const found = await sourceFor(userId, def.sourceId);
  return found ? { def, ...found } : null;
}

const asDef = (d: DefinitionRow): Def => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, status: d.status, body: d.body as Record<string, any> });

export async function sourceDefinitions(sourceId: string): Promise<DefinitionRow[]> {
  return db.select().from(definition).where(eq(definition.sourceId, sourceId)).orderBy(asc(definition.kind), asc(definition.name));
}

export const logEvent = (definitionId: string, userId: string, event: string, detail: Record<string, unknown> = {}) =>
  db.insert(definitionEvent).values({ definitionId, userId, event, detail });

// --- running a metric ----------------------------------------------------------

/** Above this many estimated rows a run needs the person to say go (spec §9.3). */
export const ESTIMATE_LIMIT_ROWS = 50_000_000;

export interface MetricValue {
  sql: string;
  value: string | null;
  columns: string[];
  rows: (string | null)[][];
  estimate: { rows: number; cost: number };
}

export class TooCostly extends Error {
  readonly estimate: { rows: number; cost: number };
  constructor(e: { rows: number; cost: number }) {
    super(`This would read about ${e.rows.toLocaleString("en-US")} rows. Confirm to run it.`);
    this.estimate = e;
  }
}

/** Estimate, then run, one metric as the member. `proceed` skips the limit after the person has agreed. */
export async function runMetric(member: Member, metric: Def, all: Def[], q: Parameters<typeof metricSql>[2] = {}, proceed = false, filters: TableFilter[] = []): Promise<MetricValue & { applied?: string[] }> {
  const sql = metricSql(metric, all, q);
  const est = await estimate(member, sql);
  if (est.rows > ESTIMATE_LIMIT_ROWS && !proceed) throw new TooCostly(est);
  const res = await query(member, sql, 500, filters);
  const value = q.groupBy?.length ? null : (res.rows[0]?.[0] ?? null);
  return { sql, value, columns: res.columns, rows: res.rows, estimate: est, applied: res.applied };
}

// --- history -------------------------------------------------------------------

/**
 * What people wrote against this database: pg_stat_statements when the member may read it, and
 * the SQL of GridZero connected tables on the same host and database. Missing history is fine.
 */
async function history(src: SourceRow, member: Member): Promise<{ statements: { sql: string; user: string }[]; note: string }> {
  const statements: { sql: string; user: string }[] = [];
  const notes: string[] = [];
  if (member.kind !== "postgres") return { statements, note: "" };
  try {
    // The extension's view can live in any schema, and the member's search path may not include it.
    const where = await query(member, "select quote_ident(n.nspname) from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements'");
    if (!where.rows[0]?.[0]) throw new Error("not installed");
    const res = await query(
      member,
      `select r.rolname, s.query from ${where.rows[0][0]}.pg_stat_statements s join` + " pg_roles r on r.oid = s.userid join pg_database d on d.oid = s.dbid " +
        "where d.datname = current_database() and s.query ~* '^\\s*(select|with)' and s.query !~* 'pg_catalog|information_schema|pg_stat_statements|pg_extension' and s.query not like '%<insufficient privilege>%' order by s.calls desc limit 2000",
    );
    for (const [who, sql] of res.rows) if (sql) statements.push({ sql, user: who ?? "?" });
    notes.push(`${res.rows.length} statements from the database's own query log`);
  } catch {
    notes.push("the database's query log (pg_stat_statements) is not available to you");
  }
  const cfg = src.config as SourceConfig;
  const tables = await db
    .select({ sql: connectedTable.sql, by: connectedTable.createdBy, config: connection.config, kind: connection.kind })
    .from(connectedTable)
    .innerJoin(connection, eq(connection.id, connectedTable.connectionId));
  // Only connected tables made by members of this workspace: other customers may use the same host.
  const members = new Set((await db.select({ userId: workspaceMember.userId }).from(workspaceMember).where(eq(workspaceMember.workspaceId, src.workspaceId))).map((m) => m.userId));
  const mine = tables.filter((t) => members.has(t.by) && t.kind === "postgres" && (t.config as { host?: string; database?: string }).host === cfg.host && (t.config as { database?: string }).database === cfg.database);
  for (const t of mine) statements.push({ sql: t.sql, user: `gridzero:${t.by}` });
  if (mine.length) notes.push(`${mine.length} connected tables in GridZero`);
  return { statements, note: notes.join("; ") };
}

// --- the scan job --------------------------------------------------------------

const SYSTEM_SCHEMAS = "'information_schema', 'pg_catalog', 'pg_toast'";

/** What a scan would read, shown before it starts: tables and the planner's row counts. */
export async function scanEstimate(src: SourceRow, userId: string): Promise<{ tables: number; rows: number }> {
  const member = await memberAccess(src, userId);
  if (member.kind === "workbook") {
    const { tables } = await stage(member.workbookId);
    return { tables: tables.length, rows: tables.reduce((n, t) => n + t.totalRows, 0) };
  }
  const schemas = (src.config as SourceConfig).schemas;
  const only = schemas?.length ? ` and n.nspname in (${schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")})` : "";
  const res = await query(member, `select count(*), coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'v', 'm', 'p') and n.nspname not in (${SYSTEM_SCHEMAS})${only}`);
  return { tables: Number(res.rows[0]?.[0] ?? 0), rows: Number(res.rows[0]?.[1] ?? 0) };
}

const questionKey = (kind: string, data: Record<string, any>) => `${kind}|${data.table ?? ""}|${data.column ?? ""}|${data.definition ?? ""}`;

/** The rule a "leave these rows out" answer creates. */
function exclusionRule(table: ScanTable, fq: string, flag: { column: string; kind: string; values: string[] }): Draft {
  const bare = table.table;
  const col = `${bare}.${flag.column}`;
  let expression: string;
  if (flag.kind === "flag") expression = flag.values[0] === "true" ? `NOT ${col}` : col;
  else expression = `${col} NOT IN (${flag.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
  const what = flag.kind === "flag" ? flag.column.replace(/^is_/, "") : flag.values.join(", ").toLowerCase();
  return {
    kind: "rule",
    name: `${bare}_without_${flag.column}`.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    label: flag.kind === "flag" && flag.values[0] === "false" ? `${flag.column.replace(/^is_/, "")} ${bare} only` : `${bare} that are not ${what}`,
    body: { entity: fq, expression, meaning: `Leaves out ${bare} rows where ${flag.column} is ${flag.values.join(" or ")}.` },
    evidence: [],
    confidence: "medium",
    status: "inferred",
  };
}

/** The table an expression mainly reads (its first table.column), so a formula on another table gets the right FROM. */
export function entityOf(expression: string, scanResult: ScanResult, fallback: string): string {
  for (const m of expression.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_"]/g)) {
    const hit = Object.keys(scanResult.tables).find((fq) => scanResult.tables[fq]!.table.toLowerCase() === m[1]!.toLowerCase());
    if (hit) return hit;
  }
  return fallback;
}

/** The metrics a rule on `fq` would change: metrics on that table, or on a table that links to it. */
function metricsTouching(defs: Def[], scanResult: ScanResult, fq: string): Def[] {
  const linkedFrom = new Set(scanResult.links.filter((l) => l.proposed && l.to === fq).map((l) => l.from));
  return defs.filter((d) => d.kind === "metric" && (d.body.entity === fq || linkedFrom.has(d.body.entity)));
}

/** Put a number on each choice of a question by running it (spec §6.4). Failures leave the choice without one. */
async function numberOptions(q: DraftQuestion, defs: Def[], scanResult: ScanResult, member: Member): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = q.options.map((o) => ({ ...o }));
  try {
    if (q.kind === "excluded_rows") {
      const table = scanResult.tables[q.data.table as string]!;
      const flag = table.flags.find((f) => f.column === q.data.column)!;
      const rule = exclusionRule(table, q.data.table, flag);
      // Show the number people care about most: a metric on this very table before one that links to it, a sum before a count.
      const weight = (m: Def) => Number(m.body.entity === q.data.table) * 2 + Number(m.body.expression !== "COUNT(*)");
      const target = metricsTouching(defs, scanResult, q.data.table).sort((a, b) => weight(b) - weight(a))[0];
      if (!target) return out;
      const ruleDef: Def = { ...rule, id: "" };
      const linkDefs = defs.filter((d) => d.kind === "link");
      const without = await runMetric(member, target, [...defs, ...linkDefs], { extraRules: [ruleDef] });
      const withThem = await runMetric(member, target, defs);
      for (const o of out) {
        const v = o.change === "exclude" ? without : withThem;
        Object.assign(o, { value: v.value, text: `${target.label}: ${humanNumber(v.value)}`, sql: v.sql, metric: target.name });
      }
    } else if (q.kind === "conflict") {
      const metric = defs.find((d) => d.kind === "metric" && d.name === q.data.definition);
      if (!metric) return out;
      const users = [metric.body.count ?? null, ...((metric.body.alternatives as { count: number }[]) ?? []).map((a) => a.count)];
      for (const [i, o] of out.entries()) {
        const v = await runMetric(member, { ...metric, body: { ...metric.body, expression: o.expression, entity: entityOf(o.expression, scanResult, metric.body.entity), tables: undefined } }, defs);
        Object.assign(o, { value: v.value, text: `${humanNumber(v.value)}${users[i] ? `, used in ${users[i]} quer${users[i] === 1 ? "y" : "ies"}` : ""}`, sql: v.sql });
      }
    } else if (q.kind === "duplicates") {
      const g = scanResult.tables[q.data.table as string]?.grain_breaks.find((b) => b.column === q.data.column);
      if (g) for (const o of out) Object.assign(o, { value: String(o.change === "latest" ? g.distinct : g.rows), text: `${(o.change === "latest" ? g.distinct : g.rows).toLocaleString("en-US")} rows` });
    }
  } catch (e) {
    if (!(e instanceof MetricSqlError)) for (const o of out) o.note ??= "The number could not be worked out.";
  }
  return out;
}

export interface ScanSummary {
  scanId: string;
  tables: number;
  definitions: number;
  questions: number;
  history: string;
  findings: number;
}

/** Scan a source as `userId`, draft definitions, run the checks and raise questions. */
export async function runScan(src: SourceRow, userId: string): Promise<ScanSummary> {
  const member = await memberAccess(src, userId);
  const scanId = newId();
  await db.insert(scan).values({ id: scanId, sourceId: src.id, startedBy: userId, status: "running" });
  try {
    let hist = { statements: [] as { sql: string; user: string }[], note: "uploaded tables have no query history" };
    let analysis: Analysis;
    if (member.kind === "workbook") {
      // Uploaded tables: the engine reads the staged files itself, with DuckDB.
      const files = (await stage(member.workbookId)).files;
      if (!files.length) throw new ProposalError("That workbook has no Data Tables yet. Import a file as a Data table first.");
      analysis = await engineJob<Analysis>({ job: "files_analyse", files });
    } else {
      hist = await history(src, member);
      analysis = await engineJob<Analysis>(
        { job: "analyse", dialect: "postgres", schemas: (src.config as SourceConfig).schemas ?? null, statements: hist.statements },
        async (sql) => (await query(member, sql)).rows,
      );
    }

    // Definitions: add new ones, refresh ones nobody has confirmed, never touch confirmed or disputed ones.
    const existing = await sourceDefinitions(src.id);
    const byKey = new Map(existing.map((d) => [`${d.kind}|${d.name}`, d]));
    const seen = new Set<string>();
    for (const d of analysis.definitions) {
      if (seen.has(`${d.kind}|${d.name}`)) continue; // one name, one definition
      seen.add(`${d.kind}|${d.name}`);
      const old = byKey.get(`${d.kind}|${d.name}`);
      if (old && (old.status === "confirmed" || old.status === "disputed")) continue;
      const first = d.kind === "metric" ? { ...d.body, count: (d.evidence.find((e) => e.type === "usage")?.count as number | undefined) ?? null } : d.body;
      if (old) await db.update(definition).set({ body: first, evidence: d.evidence, confidence: d.confidence, status: d.status, label: old.label, updatedAt: new Date() }).where(eq(definition.id, old.id));
      else await db.insert(definition).values({ id: newId(), workspaceId: src.workspaceId, sourceId: src.id, kind: d.kind, name: d.name, label: d.label, body: first, evidence: d.evidence, confidence: d.confidence, status: d.status });
    }
    const defs = (await sourceDefinitions(src.id)).map(asDef);

    // Questions: never ask again what someone already answered; replace the rest.
    const old = await db.select().from(question).where(eq(question.sourceId, src.id));
    const settled = new Set(old.filter((q) => q.status !== "open").map((q) => questionKey(q.kind, q.data as Record<string, any>)));
    await db.delete(question).where(and(eq(question.sourceId, src.id), eq(question.status, "open")));
    const [admin] = await db.select({ userId: workspaceMember.userId }).from(workspaceMember).where(and(eq(workspaceMember.workspaceId, src.workspaceId), eq(workspaceMember.role, "admin"))).orderBy(asc(workspaceMember.createdAt));
    let asked = 0;
    for (const q of analysis.questions) {
      if (settled.has(questionKey(q.kind, q.data))) continue;
      const options = await numberOptions(q, defs, analysis.scan, member);
      const owner = q.data.definition ? existing.find((d) => d.name === q.data.definition)?.ownerId : null;
      await db.insert(question).values({ id: newId(), workspaceId: src.workspaceId, sourceId: src.id, kind: q.kind, topic: q.topic, prompt: q.prompt, options, data: q.data, rank: q.rank, atSetup: q.at_setup, assigneeId: owner ?? admin?.userId ?? userId });
      asked++;
    }
    const stats = { tables: Object.keys(analysis.scan.tables).length, history: analysis.history, historyNote: hist.note, findings: analysis.findings };
    await db.update(scan).set({ status: "ok", result: analysis.scan, stats, finishedAt: new Date() }).where(eq(scan.id, scanId));
    return { scanId, tables: stats.tables, definitions: defs.length, questions: asked, history: hist.note, findings: analysis.findings.length };
  } catch (e) {
    await db.update(scan).set({ status: "error", error: (e as Error).message.slice(0, 2000), finishedAt: new Date() }).where(eq(scan.id, scanId));
    throw e;
  }
}

export async function latestScan(sourceId: string) {
  const [row] = await db.select().from(scan).where(and(eq(scan.sourceId, sourceId), eq(scan.status, "ok"))).orderBy(desc(scan.startedAt)).limit(1);
  return row ?? null;
}

// --- confirm -------------------------------------------------------------------

/** A person confirms a definition as it stands. A metric also stores its check number. */
export async function confirm(def: DefinitionRow, src: SourceRow, userId: string): Promise<DefinitionRow> {
  let checkNumber: Record<string, unknown> | null = null;
  if (def.kind === "metric") {
    const member = await memberAccess(src, userId);
    const v = await runMetric(member, asDef(def), (await sourceDefinitions(src.id)).map(asDef));
    checkNumber = { sql: v.sql, value: v.value, period: "all rows", takenAt: new Date().toISOString() };
  }
  const [who] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId));
  const stamp: Evidence = { type: "answer", text: `Confirmed by ${who?.name || who?.email || "a member"} on ${new Date().toISOString().slice(0, 10)}.` };
  const evidence = [...(def.evidence as Evidence[]).filter((e) => e.type !== "answer"), stamp];
  const [row] = await db
    .update(definition)
    .set({ status: "confirmed", confirmedBy: userId, confirmedAt: new Date(), checkNumber, evidence, confidence: "high", ownerId: def.ownerId ?? userId, updatedAt: new Date() })
    .where(eq(definition.id, def.id))
    .returning();
  await logEvent(def.id, userId, "confirmed", { from: def.status, version: def.version, checkNumber });
  // A confirmed number is also a question the agent must keep getting right.
  if (checkNumber) await trustConfirmed(row!, userId, checkNumber.value);
  return row!;
}

// --- questions -----------------------------------------------------------------

export class AnswerError extends Error {}

export interface AnswerInput {
  option?: number;
  text?: string;
  /** For the trusted-number question: which metric, and the number the business trusts. */
  definitionId?: string;
  value?: number;
}

/** Apply an answer. Returns what changed, in plain words. */
export async function answer(q: QuestionRow, src: SourceRow, userId: string, input: AnswerInput): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  const options = q.options as Record<string, any>[];
  const chosen = input.option !== undefined ? options[input.option] : undefined;
  if (input.option !== undefined && !chosen) throw new AnswerError("Choose one of the options.");
  const data = q.data as Record<string, any>;
  const latest = await latestScan(src.id);
  const scanResult = latest?.result as ScanResult | undefined;
  const rows = await sourceDefinitions(src.id);
  const [who] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId));
  const by = who?.name || who?.email || "a member";
  const today = new Date().toISOString().slice(0, 10);

  if (q.kind === "excluded_rows" && chosen && scanResult) {
    const table = scanResult.tables[data.table as string];
    const flag = table?.flags.find((f) => f.column === data.column);
    if (!table || !flag) throw new AnswerError("That column is no longer in the latest scan. Scan again.");
    const entity = rows.find((d) => d.kind === "entity" && (d.body as { table: string }).table === data.table);
    if (chosen.change === "exclude") {
      const rule = exclusionRule(table, data.table, flag);
      const evidence: Evidence[] = [{ type: "answer", text: `${by} answered on ${today}: leave these rows out.` }];
      const existing = rows.find((d) => d.kind === "rule" && d.name === rule.name);
      if (existing) await db.update(definition).set({ body: rule.body, status: "confirmed", confirmedBy: userId, confirmedAt: new Date(), evidence, confidence: "high", updatedAt: new Date() }).where(eq(definition.id, existing.id));
      else await db.insert(definition).values({ id: newId(), workspaceId: src.workspaceId, sourceId: src.id, kind: "rule", name: rule.name, label: rule.label, body: rule.body, evidence, confidence: "high", status: "confirmed", confirmedBy: userId, confirmedAt: new Date(), ownerId: userId });
      applied.push(`Added the rule "${rule.label}".`);
      for (const m of metricsTouching(rows.map(asDef), scanResult, data.table)) {
        const row = rows.find((d) => d.id === m.id)!;
        if (row.status === "confirmed") continue; // a confirmed metric changes only through a published change
        const filters = [...new Set([...((m.body.filters as string[]) ?? []), rule.name])];
        await db.update(definition).set({ body: { ...m.body, filters }, version: row.version + 1, updatedAt: new Date() }).where(eq(definition.id, m.id));
        await logEvent(m.id, userId, "rule_added", { rule: rule.name, question: q.id });
        applied.push(`${m.label} now leaves them out.`);
      }
    } else if (entity) {
      const evidence = [...(entity.evidence as Evidence[]), { type: "answer", text: `${by} answered on ${today}: rows with ${data.column} = ${flag.values.join(", ")} count.` }];
      await db.update(definition).set({ evidence, updatedAt: new Date() }).where(eq(definition.id, entity.id));
      applied.push("Recorded: these rows count.");
    }
  } else if (q.kind === "conflict" && chosen) {
    const metric = rows.find((d) => d.kind === "metric" && d.name === data.definition);
    if (!metric) throw new AnswerError("That metric no longer exists.");
    const was = metric.body as Record<string, any>;
    const body = { ...was, expression: chosen.expression, entity: scanResult ? entityOf(chosen.expression, scanResult, was.entity) : was.entity, alternatives: [], tables: undefined };
    const evidence = [...(metric.evidence as Evidence[]).filter((e) => e.type !== "conflict"), { type: "answer", text: `${by} chose this formula on ${today}.` }];
    const [updated] = await db.update(definition).set({ body, evidence, status: "inferred", version: metric.version + 1, updatedAt: new Date() }).where(eq(definition.id, metric.id)).returning();
    await logEvent(metric.id, userId, "formula_chosen", { expression: chosen.expression, question: q.id });
    await confirm(updated!, src, userId);
    applied.push(`${metric.label} is now ${chosen.expression}, confirmed.`);
  } else if (q.kind === "trusted_number") {
    if (!input.definitionId || typeof input.value !== "number" || !Number.isFinite(input.value)) throw new AnswerError("Choose a metric and enter the number you trust.");
    const metric = rows.find((d) => d.id === input.definitionId && d.kind === "metric");
    if (!metric) throw new AnswerError("Choose one of this source's metrics.");
    const member = await memberAccess(src, userId);
    const got = await runMetric(member, asDef(metric), rows.map(asDef));
    const mine = Number(got.value);
    const matches = Number.isFinite(mine) && Math.abs(mine - input.value) <= 0.005 * Math.max(1, Math.abs(input.value));
    const line: Evidence = matches
      ? { type: "check", text: `Matches the number ${by} trusts (${humanNumber(String(input.value))}), checked on ${today}.` }
      : { type: "conflict", text: `GridZero gets ${humanNumber(got.value)}; ${by} trusts ${humanNumber(String(input.value))} (${today}).` };
    await db
      .update(definition)
      .set({ evidence: [...(metric.evidence as Evidence[]), line], ...(matches ? {} : { status: metric.status === "confirmed" ? "disputed" : "needs_answer", confidence: "low" as const }), updatedAt: new Date() })
      .where(eq(definition.id, metric.id));
    await logEvent(metric.id, userId, "trusted_number", { trusted: input.value, got: got.value, matches });
    applied.push(matches ? `${metric.label} matches the trusted number.` : `${metric.label} gives ${humanNumber(got.value)}, not ${humanNumber(String(input.value))}. It is marked as needing an answer; correct it in plain words to close the gap.`);
  } else {
    // Answers GridZero records but cannot yet turn into a definition on its own (time zones, late data, units).
    if (!chosen && !input.text?.trim()) throw new AnswerError("Choose an option or write an answer.");
    const said = chosen ? chosen.label : input.text!.trim().slice(0, 1000);
    const entity = rows.find((d) => d.kind === "entity" && (d.body as { table: string }).table === data.table);
    if (entity) {
      const evidence = [...(entity.evidence as Evidence[]), { type: "answer", text: `${q.topic}: "${said}" (${by}, ${today}).` }];
      await db.update(definition).set({ evidence, updatedAt: new Date() }).where(eq(definition.id, entity.id));
    }
    applied.push("Recorded. This kind of answer is kept as evidence; use a correction to change a formula.");
  }
  await db.update(question).set({ status: "answered", answer: { ...input, label: chosen?.label ?? null, applied }, answeredBy: userId, answeredAt: new Date() }).where(eq(question.id, q.id));
  return { applied };
}

// --- correct and publish ---------------------------------------------------------

export interface NewRule {
  name: string;
  label: string;
  entity: string;
  expression: string;
  meaning?: string;
}
export interface Proposal {
  expression?: string;
  filters?: string[];
  newRules?: NewRule[];
  label?: string;
  description?: string;
}

export class ProposalError extends Error {}

/**
 * Turn a proposed edit into a change waiting to be published: every expression must resolve against
 * the scan (C10), the checks rerun, and old and new numbers are worked out for this definition and for
 * every metric that depends on it (spec §7.2, §7.3).
 */
export async function propose(def: DefinitionRow, src: SourceRow, userId: string, origin: "correction" | "chat" | "question", request: string, p: Proposal) {
  const latest = await latestScan(src.id);
  if (!latest) throw new ProposalError("Scan the source first.");
  const scanResult = latest.result as ScanResult;
  const rows = await sourceDefinitions(src.id);
  const all = rows.map(asDef);
  const body = { ...(def.body as Record<string, any>) };
  const newRules: Draft[] = [];

  const resolve = async (expression: string) => {
    const r = await engineJob<{ ok: boolean; error?: string; expression?: string; tables?: string[]; aggregate?: boolean }>({ job: "resolve", dialect: dialectOf(src), expression, scan: scanResult });
    if (!r.ok) throw new ProposalError(r.error ?? "That expression does not work.");
    return r;
  };
  for (const r of p.newRules ?? []) {
    const ok = await resolve(r.expression);
    if (ok.aggregate) throw new ProposalError(`The rule ${r.label} must be a row filter, not a total.`);
    const entity = ok.tables?.[0] ?? r.entity;
    if (!scanResult.tables[entity]) throw new ProposalError(`The rule ${r.label} does not use a scanned table.`);
    newRules.push({ kind: "rule", name: r.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60), label: r.label.slice(0, 120), body: { entity, expression: ok.expression, meaning: r.meaning ?? "" }, evidence: [], confidence: "medium", status: "inferred" });
  }
  if (p.expression !== undefined) {
    const ok = await resolve(p.expression);
    if (def.kind === "metric" && !ok.aggregate) throw new ProposalError("A metric needs a total such as SUM or COUNT.");
    if (def.kind === "rule" && ok.aggregate) throw new ProposalError("A rule must be a row filter, not a total.");
    body.expression = ok.expression;
    if (def.kind === "metric") {
      body.tables = ok.tables;
      if (ok.tables?.length && !ok.tables.includes(body.entity)) body.entity = ok.tables[0];
    }
  }
  if (p.filters !== undefined && def.kind === "metric") {
    for (const n of p.filters) if (!all.some((d) => d.kind === "rule" && d.name === n) && !newRules.some((r) => r.name === n)) throw new ProposalError(`There is no rule named ${n}.`);
    body.filters = p.filters;
  }

  // Old and new numbers for everything that reads this definition.
  const member = await memberAccess(src, userId);
  const pending: Def[] = newRules.map((r) => ({ ...r, id: "" }));
  const after = [...all.map((d) => (d.id === def.id ? { ...d, body } : d)), ...pending];
  const affected = def.kind === "metric" ? [asDef(def)] : def.kind === "rule" ? all.filter((d) => d.kind === "metric" && ((d.body.filters as string[]) ?? []).includes(def.name)) : [];
  const impact: { definitionId: string; label: string; oldValue: string | null; newValue: string | null; oldSql: string; newSql: string }[] = [];
  for (const m of affected) {
    const before = await runMetric(member, m, all);
    const now = await runMetric(member, after.find((d) => d.id === m.id)!, after);
    impact.push({ definitionId: m.id, label: m.label, oldValue: before.value, newValue: now.value, oldSql: before.sql, newSql: now.sql });
  }
  const own = impact.find((i) => i.definitionId === def.id);
  const findings = own ? (await engineJob<{ findings: { check: string; level: string; message: string }[] }>({ job: "lint", dialect: dialectOf(src), sql: own.newSql, scan: scanResult })).findings : [];
  const preview = { oldValue: own?.oldValue ?? null, newValue: own?.newValue ?? null, oldSql: own?.oldSql ?? null, newSql: own?.newSql ?? null, findings, impact, newRules, label: p.label ?? null, description: p.description ?? null };
  const [row] = await db.insert(definitionChange).values({ id: newId(), definitionId: def.id, proposedBy: userId, origin, request: request.slice(0, 2000), newBody: body, preview }).returning();
  return row!;
}

/** Publish a proposed change: a new version of the definition; the old body stays in its history. */
export async function publish(changeId: string, userId: string): Promise<DefinitionRow> {
  const [change] = await db.update(definitionChange).set({ status: "published", decidedBy: userId, decidedAt: new Date() }).where(and(eq(definitionChange.id, changeId), eq(definitionChange.status, "proposed"))).returning();
  if (!change) throw new ProposalError("That change was already published or discarded.");
  const [def] = await db.select().from(definition).where(eq(definition.id, change.definitionId));
  const [src] = await db.select().from(source).where(eq(source.id, def!.sourceId));
  const preview = change.preview as { newRules?: Draft[]; label?: string | null; description?: string | null };
  for (const r of preview.newRules ?? []) {
    await db
      .insert(definition)
      .values({ id: newId(), workspaceId: def!.workspaceId, sourceId: def!.sourceId, kind: "rule", name: r.name, label: r.label, body: r.body, evidence: [{ type: "answer", text: `Added with a correction to ${def!.label}.` }], confidence: "medium", status: "inferred" })
      .onConflictDoUpdate({ target: [definition.sourceId, definition.kind, definition.name], set: { body: r.body, label: r.label, updatedAt: new Date() } });
  }
  await logEvent(def!.id, userId, "published", { change: change.id, request: change.request, oldBody: def!.body, version: def!.version + 1 });
  const [updated] = await db
    .update(definition)
    .set({ body: change.newBody, version: def!.version + 1, status: "inferred", label: preview.label ?? def!.label, description: preview.description ?? def!.description, updatedAt: new Date() })
    .where(eq(definition.id, def!.id))
    .returning();
  // The person publishing has seen old and new numbers, so the new version is theirs to confirm.
  return confirm(updated!, src!, userId);
}

export async function pendingChanges(sourceId: string) {
  const defs = await db.select({ id: definition.id }).from(definition).where(eq(definition.sourceId, sourceId));
  if (!defs.length) return [];
  return db.select().from(definitionChange).where(and(inArray(definitionChange.definitionId, defs.map((d) => d.id)), eq(definitionChange.status, "proposed"))).orderBy(desc(definitionChange.createdAt));
}


// --- a workbook as a source ------------------------------------------------------

/**
 * The source for a workbook's tables, made on first use: in a workspace the person already belongs
 * to if one has it, else in their own. Someone with no workspace gets a personal one, so a single
 * person with one uploaded file needs no setup.
 */
export async function workbookSource(userId: string, workbookId: string, title: string): Promise<SourceRow> {
  const memberships = await db.select({ workspaceId: workspaceMember.workspaceId, role: workspaceMember.role }).from(workspaceMember).where(eq(workspaceMember.userId, userId)).orderBy(asc(workspaceMember.createdAt));
  if (memberships.length) {
    const rows = await db.select().from(source).where(and(inArray(source.workspaceId, memberships.map((m) => m.workspaceId)), eq(source.kind, "workbook")));
    const hit = rows.find((r) => (r.config as SourceConfig).workbookId === workbookId);
    if (hit) return hit;
  }
  let workspaceId = memberships.find((m) => m.role === "admin")?.workspaceId;
  if (!workspaceId) {
    const [who] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
    workspaceId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(workspace).values({ id: workspaceId!, name: `${who?.name?.split(" ")[0] || "My"}'s workspace`, createdBy: userId });
      await tx.insert(workspaceMember).values({ id: newId(), workspaceId: workspaceId!, userId, role: "admin" });
    });
  }
  // Source names are unique in a workspace; two workbooks can share a title.
  const taken = new Set((await db.select({ name: source.name }).from(source).where(eq(source.workspaceId, workspaceId))).map((r) => r.name));
  let name = title.slice(0, 70) || "Workbook";
  for (let i = 2; taken.has(name); i++) name = `${title.slice(0, 70)} (${i})`;
  const [row] = await db.insert(source).values({ id: newId(), workspaceId, kind: "workbook", name, config: { workbookId }, createdBy: userId }).returning();
  return row!;
}
