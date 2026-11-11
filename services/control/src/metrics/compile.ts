// Apache Ossie semantic models: validation and SQL for one metric (agent spec §7.1, §7.3).

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Kind } from "../connectors.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const name = z.string().regex(NAME, "must be a name of letters, digits and underscores (up to 63, not starting with a digit)");

const expression = z
  .object({
    dialects: z.array(z.object({ dialect: z.string(), expression: z.string().min(1) }).passthrough()).min(1),
  })
  .passthrough();

const field = z.object({ name, expression, description: z.string().optional() }).passthrough();
const dataset = z.object({ name, source: z.string().min(1), fields: z.array(field) }).passthrough();
const metric = z.object({ name, expression, description: z.string().optional() }).passthrough();

export const ossieModel = z
  .object({
    name,
    description: z.string().optional(),
    datasets: z.array(dataset).min(1),
    metrics: z.array(metric).default([]),
  })
  .passthrough();

export type OssieModel = z.infer<typeof ossieModel>;
export type Dialect = "POSTGRES" | "REDSHIFT" | "SNOWFLAKE" | "DATABRICKS" | "BIGQUERY";

export const DIALECT: Record<Kind, Dialect> = {
  // A web address runs no SQL: a model cannot be put on one, so this is never used.
  web: "POSTGRES",
  postgres: "POSTGRES",
  redshift: "REDSHIFT",
  snowflake: "SNOWFLAKE",
  databricks: "DATABRICKS",
  bigquery: "BIGQUERY",
};

export class MetricError extends Error {}

/** Parse and validate an Ossie YAML document. Throws MetricError("<path>: <message>"). */
export function parseModel(source: string): OssieModel {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    throw new MetricError(`yaml: ${(e as Error).message.split("\n")[0]}`);
  }
  const result = ossieModel.safeParse(doc);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new MetricError(`${issue.path.join(".") || "(document)"}: ${issue.message}`);
  }
  return result.data;
}

export interface MetricQuery {
  metric: string;
  group_by: string[];
  filters: { field: string; op: string; value: unknown }[];
  order: "asc" | "desc";
  limit: number;
}

const OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "in"]);

function sqlFor(item: { name: string; expression: { dialects: { dialect: string; expression: string }[] } }, dialect: Dialect): string {
  const d = item.expression.dialects;
  const hit = d.find((x) => x.dialect === dialect) ?? d.find((x) => x.dialect === "ANSI_SQL");
  if (!hit) throw new MetricError(`No SQL for ${item.name} in ${dialect}.`);
  return hit.expression.trim();
}

function literal(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new MetricError("Unsupported filter value.");
}

/** The SQL for one metric, optionally grouped and filtered (spec §7.3, whitespace exact). */
export function compileQuery(model: OssieModel, dialect: Dialect, q: MetricQuery): string {
  if (model.datasets.length !== 1) throw new MetricError("This model has more than one dataset, which GridZero cannot query yet.");
  const ds = model.datasets[0]!;
  const m = model.metrics.find((x) => x.name === q.metric);
  if (!m) throw new MetricError(`Unknown metric ${q.metric}.`);
  const fieldOf = (n: string) => {
    const f = ds.fields.find((x) => x.name === n);
    if (!f) throw new MetricError(`Unknown field ${n}.`);
    return f;
  };
  if (q.group_by.length > 3) throw new MetricError("Group by at most 3 fields.");
  if (q.filters.length > 5) throw new MetricError("Use at most 5 filters.");
  const quote = dialect === "BIGQUERY" || dialect === "DATABRICKS" ? (s: string) => `\`${s}\`` : (s: string) => `"${s}"`;

  const where = q.filters.map((f) => {
    if (!OPS.has(f.op)) throw new MetricError(`Unsupported operator ${f.op}.`);
    const expr = `(${sqlFor(fieldOf(f.field), dialect)})`;
    if (f.op === "in") {
      if (!Array.isArray(f.value) || f.value.length < 1 || f.value.length > 50) throw new MetricError("Unsupported filter value.");
      return `${expr} IN (${f.value.map(literal).join(", ")})`;
    }
    return `${expr} ${f.op} ${literal(f.value)}`;
  });
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const metricSql = `(${sqlFor(m, dialect)}) AS ${quote(m.name)}`;

  if (q.group_by.length === 0) return `SELECT ${metricSql} FROM ${ds.source}${whereSql}`;

  const groups = q.group_by.map((g) => `(${sqlFor(fieldOf(g), dialect)}) AS ${quote(g)}`);
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit)));
  const positions = q.group_by.map((_, i) => String(i + 1)).join(", ");
  return `SELECT ${groups.join(", ")}, ${metricSql} FROM ${ds.source}${whereSql} GROUP BY ${positions} ORDER BY ${q.group_by.length + 1} ${q.order === "asc" ? "ASC" : "DESC"} LIMIT ${limit}`;
}

/** What the API and the agent see of a model. */
export function summarize(model: OssieModel) {
  return {
    metrics: model.metrics.map((m) => ({ name: m.name, description: m.description ?? "" })),
    fields: model.datasets.flatMap((d) => d.fields.map((f) => f.name)),
  };
}
