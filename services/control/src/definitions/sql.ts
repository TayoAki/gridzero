// Queries on a workspace source, always as the member who asked (definitions spec §9.2), and the
// SQL for a metric built from its definition.

import { and, eq } from "drizzle-orm";

import { decryptSecret, postgresEstimate, runQuery } from "../connectors.ts";
import type { Config } from "../connectors.ts";
import { db } from "../db/client.ts";
import { source, sourceCredential } from "../db/schema.ts";
import { access } from "../sharing.ts";
import { EngineError } from "./engine.ts";
import { TablesError, queryTables, stage } from "./tables.ts";

export type SourceRow = typeof source.$inferSelect;
export interface SourceConfig {
  host: string;
  port?: number;
  database: string;
  ssl?: "verify" | "require" | "disable";
  schemas?: string[];
  /** A workbook source: the workbook whose Data Tables are the data. */
  workbookId?: string;
}

/** Thrown when the asker has not saved their own sign-in for the source. */
export class NoCredential extends Error {
  constructor(message = "Save your own sign-in for this source first. Queries run with your access, not anyone else's.") {
    super(message);
  }
}

/** The source database said no (bad SQL, no permission, unreachable). Its message is safe to show the asker. */
export class SourceError extends Error {}

const fromSource = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    throw e instanceof SourceError ? e : new SourceError((e as Error).message.slice(0, 400));
  }
};

/** How the asker reaches a source: their own database sign-in, or their access to a workbook. */
export type Member = { kind: "postgres"; config: Config; secret: string } | { kind: "workbook"; workbookId: string };

/** The asker's own way into a source. Throws NoCredential when they have none. */
export async function memberAccess(src: SourceRow, userId: string): Promise<Member> {
  if (src.kind === "workbook") {
    const workbookId = (src.config as SourceConfig).workbookId ?? "";
    // A workbook has no database permissions: what counts is whether the asker can open it.
    if (!(await access(userId, workbookId))) throw new NoCredential("This source is a workbook you cannot open. Ask its owner to share it with you.");
    return { kind: "workbook", workbookId };
  }
  const [cred] = await db.select().from(sourceCredential).where(and(eq(sourceCredential.sourceId, src.id), eq(sourceCredential.userId, userId)));
  if (!cred) throw new NoCredential();
  const c = src.config as SourceConfig;
  return { kind: "postgres", config: { host: c.host, port: c.port, database: c.database, ssl: c.ssl, user: cred.username }, secret: decryptSecret(cred.secret) };
}

/** RFC 4180 CSV to rows. An unquoted empty field is NULL, which is how Postgres writes one. */
export function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let cell = "";
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => {
    row.push(cell === "" && !wasQuoted ? null : cell);
    cell = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ",") endCell();
    else if (ch === "\n") {
      endCell();
      rows.push(row);
      row = [];
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    endCell();
    rows.push(row);
  }
  return rows;
}

const MAX_RESULT_BYTES = 8 * 1024 * 1024;

/** Run one read-only query as the member and return its rows (header removed). */
export async function query(member: Member, sql: string, maxRows = 100_000): Promise<{ columns: string[]; rows: (string | null)[][] }> {
  if (member.kind === "workbook") {
    try {
      const out = await queryTables(member.workbookId, sql, maxRows);
      return { columns: out.columns, rows: out.rows };
    } catch (e) {
      // DuckDB's message (a wrong column, bad SQL) is for the asker; anything else is ours.
      if (e instanceof EngineError || e instanceof TablesError) throw new SourceError(e.message.replace(/^\w+Exception: /, "").slice(0, 400));
      throw e;
    }
  }
  let text = "";
  const decoder = new TextDecoder();
  await fromSource(() =>
    runQuery("postgres", member.config, member.secret, sql, async (csv) => {
      for await (const chunk of csv) {
        text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        if (text.length > MAX_RESULT_BYTES) throw new Error("The result is larger than 8 MB.");
      }
    }),
  );
  const all = parseCsv(text);
  return { columns: (all[0] ?? []).map((c) => c ?? ""), rows: all.slice(1, maxRows + 1) };
}

/** The planner's estimate for a query, shown before it runs (spec §9.3). */
export async function estimate(member: Member, sql: string): Promise<{ rows: number; cost: number }> {
  if (member.kind === "workbook") {
    // An uploaded table is read whole: the estimate is simply how many rows it holds.
    const rows = (await stage(member.workbookId)).tables.reduce((n, t) => n + t.totalRows, 0);
    return { rows, cost: rows };
  }
  return fromSource(() => postgresEstimate(member.config, member.secret, sql));
}

// --- metric SQL --------------------------------------------------------------

export interface Def {
  id: string;
  kind: string;
  name: string;
  label: string;
  status: string;
  body: Record<string, any>;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const rel = (fq: string) => fq.split(".").map(ident).join(".");
const bare = (fq: string) => fq.split(".").pop()!;

export class MetricSqlError extends Error {}

export interface MetricQuery {
  /** Dimension definitions to group by (same entity as the metric, or one link away). */
  groupBy?: Def[];
  /** Extra rules to apply on top of the metric's own. */
  extraRules?: Def[];
  /** Names of the metric's own rules to leave out (to show the number without them). */
  withoutRules?: string[];
  limit?: number;
}

/**
 * SELECT for one metric: its expression over its entity, the rules it names as filters, and a
 * LEFT JOIN for every rule or dimension that lives on a linked table (many-to-one links only, so
 * the join cannot multiply rows).
 */
export function metricSql(metric: Def, all: Def[], q: MetricQuery = {}): string {
  const entity = metric.body.entity as string | undefined;
  if (!entity) throw new MetricSqlError(`${metric.label} has no table.`);
  const without = new Set(q.withoutRules ?? []);
  const rules = [
    ...((metric.body.filters as string[] | undefined) ?? []).filter((n) => !without.has(n)).map((n) => {
      const r = all.find((d) => d.kind === "rule" && d.name === n);
      if (!r) throw new MetricSqlError(`${metric.label} uses the rule ${n}, which no longer exists.`);
      return r;
    }),
    ...(q.extraRules ?? []),
  ];
  const groups = q.groupBy ?? [];
  const joins: string[] = [];
  const joined = new Set([entity]);
  const need = (table: string) => {
    if (joined.has(table)) return;
    const link = all.find((d) => d.kind === "link" && d.body.from_entity === entity && d.body.to_entity === table && d.body.cardinality !== "many_to_many");
    if (!link) throw new MetricSqlError(`There is no link from ${bare(entity)} to ${bare(table)}.`);
    const on = (link.body.from_columns as string[]).map((c, i) => `${ident(bare(entity))}.${ident(c)} = ${ident(bare(table))}.${ident((link.body.to_columns as string[])[i]!)}`);
    joins.push(` LEFT JOIN ${rel(table)} AS ${ident(bare(table))} ON ${on.join(" AND ")}`);
    joined.add(table);
  };
  for (const t of (metric.body.tables as string[] | undefined) ?? []) need(t);
  for (const r of rules) need(r.body.entity as string);
  for (const g of groups) need(g.body.entity as string);
  const where = rules.length ? ` WHERE ${rules.map((r) => `(${r.body.expression})`).join(" AND ")}` : "";
  const value = `${metric.body.expression} AS ${ident(metric.name)}`;
  const from = ` FROM ${rel(entity)} AS ${ident(bare(entity))}${joins.join("")}${where}`;
  if (!groups.length) return `SELECT ${value}${from}`;
  const cols = groups.map((g) => `${ident(bare(g.body.entity as string))}.${ident(g.body.expression as string)} AS ${ident(g.name)}`);
  const limit = Math.min(500, Math.max(1, q.limit ?? 100));
  return `SELECT ${cols.join(", ")}, ${value}${from} GROUP BY ${groups.map((_, i) => i + 1).join(", ")} ORDER BY ${groups.length + 1} DESC LIMIT ${limit}`;
}

/** A single number as people read it: 1,240,000 or 1.24M. */
export function humanNumber(v: string | null): string {
  if (v === null) return "nothing";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
