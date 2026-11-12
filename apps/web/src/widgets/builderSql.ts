// The queries the card builder writes. Pure functions, so they can be tested without a browser.
// Every name is quoted; values are written as literals with quotes doubled.

export interface Column {
  name: string;
  kind: "text" | "number" | "date";
  /** How the column is written in SQL when that is not just its quoted name: a joined or made-up column. */
  expr?: string;
}

export const MEASURES = ["count", "sum", "avg", "min", "max"] as const;
export type Measure = (typeof MEASURES)[number];
export const BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type Bucket = (typeof BUCKETS)[number];
const BUCKET_FORMAT: Record<Bucket, string> = { day: "%Y-%m-%d", week: "%Y-%m-%d", month: "%Y-%m", quarter: "%Y-%m", year: "%Y" };
export const OPS = ["is", "is not", "contains", ">", ">=", "<", "<="] as const;
export type Op = (typeof OPS)[number];

export interface Keep {
  column: string;
  op: Op;
  value: string;
}
export interface Total {
  measure: Measure;
  column: string;
}
export interface Choice {
  table: string;
  measure: Measure;
  column: string;
  split: string;
  bucket: Bucket;
  second: string;
  /** Rows to keep: every condition must hold. */
  keep: Keep[];
  /** Further totals shown beside the first. */
  more?: Total[];
  /** A second table looked up from the first: each row of the first should match at most one row of it. */
  join?: { table: string; left: string; right: string } | null;
  /** A column worked out from the others, such as amount * 0.2. */
  custom?: { name: string; expr: string } | null;
}
export interface Built {
  sql: string;
  shape: "number" | "series" | "table";
  title: string;
}

export const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const WORDS: Record<Measure, string> = { count: "Rows", sum: "Total", avg: "Average", min: "Lowest", max: "Highest" };

/**
 * The columns a choice can use: the table's own, the joined table's (named table.column), and the
 * custom one. With a join, every column is written with its table's alias so names cannot clash.
 */
export function columnsOf(c: Pick<Choice, "join" | "custom">, own: Column[], joined: Column[] = []): Column[] {
  const base = c.join ? [...own.map((x) => ({ ...x, expr: `a.${q(x.name)}` })), ...joined.map((x) => ({ ...x, name: `${c.join!.table}.${x.name}`, expr: `b.${q(x.name)}` }))] : own;
  const name = c.custom?.name.trim();
  const expr = c.custom?.expr.trim();
  return name && expr ? [...base, { name, kind: "number", expr: `(${expr})` }] : base;
}

const sqlOf = (name: string, columns: Column[]) => columns.find((x) => x.name === name)?.expr ?? q(name);

function condition(k: Keep, columns: Column[]): string | null {
  const col = columns.find((c) => c.name === k.column);
  if (!col || k.value.trim() === "") return null;
  const left = sqlOf(k.column, columns);
  const value = col.kind === "number" && Number.isFinite(Number(k.value)) ? String(Number(k.value)) : lit(k.value);
  if (k.op === "contains") return `CAST(${left} AS VARCHAR) ILIKE '%${k.value.replace(/[\\%_]/g, "\\$&").replace(/'/g, "''")}%' ESCAPE '\\'`;
  return `${left} ${k.op === "is" ? "=" : k.op === "is not" ? "<>" : k.op} ${value}`;
}

const totalOf = (t: Total, columns: Column[]) => ({ sql: t.measure === "count" ? "COUNT(*)" : `${t.measure.toUpperCase()}(${sqlOf(t.column, columns)})`, name: t.measure === "count" ? "Rows" : `${WORDS[t.measure]} ${t.column}` });

/** Totals from one table, optionally split, with a looked-up table, further totals and a custom column. */
export function buildSql(c: Choice, columns: Column[]): Built {
  const totals = [{ measure: c.measure, column: c.column }, ...(c.more ?? [])].filter((t) => t.measure === "count" || t.column).map((t) => totalOf(t, columns));
  // Two totals with the same name would collide as column titles.
  const seen = new Set<string>();
  const values = totals.filter((t) => !seen.has(t.name) && seen.add(t.name));
  const what = values[0]!.name;
  const list = values.map((t) => `${t.sql} AS ${q(t.name)}`).join(", ");
  const isDate = (name: string) => columns.find((x) => x.name === name)?.kind === "date";
  const dim = (name: string) => (isDate(name) ? `strftime(date_trunc('${c.bucket}', ${sqlOf(name, columns)}), '${BUCKET_FORMAT[c.bucket]}')` : sqlOf(name, columns));
  const from = c.join ? `${q(c.table)} AS a LEFT JOIN ${q(c.join.table)} AS b ON a.${q(c.join.left)} = b.${q(c.join.right)}` : q(c.table);
  const kept = (c.keep ?? []).flatMap((k) => condition(k, columns) ?? []);
  const where = (...more: string[]) => ([...more, ...kept].length ? ` WHERE ${[...more, ...kept].join(" AND ")}` : "");
  const many = values.length > 1;
  const names = many ? values.map((t) => t.name).join(" and ") : what;
  if (!c.split) return { sql: `SELECT ${list} FROM ${from}${where()}`, shape: many ? "table" : "number", title: names };
  const by = isDate(c.split) ? `${c.split} (${c.bucket})` : c.split;
  if (!c.second || many) {
    const order = isDate(c.split) ? "1 LIMIT 60" : "2 DESC LIMIT 25";
    return { sql: `SELECT ${dim(c.split)} AS ${q(c.split)}, ${list} FROM ${from}${where(`${sqlOf(c.split, columns)} IS NOT NULL`)} GROUP BY 1 ORDER BY ${order}`, shape: many ? "table" : "series", title: `${names} by ${by}` };
  }
  return {
    sql: `SELECT ${dim(c.split)} AS ${q(c.split)}, ${dim(c.second)} AS ${q(c.second)}, ${list} FROM ${from}${where(`${sqlOf(c.split, columns)} IS NOT NULL`, `${sqlOf(c.second, columns)} IS NOT NULL`)} GROUP BY 1, 2 ORDER BY 1, 3 DESC LIMIT 500`,
    shape: "table",
    title: `${what} by ${by} and ${c.second}`,
  };
}

export interface Side {
  table: string;
  measure: Measure;
  column: string;
  /** The column both sides are lined up on. */
  by: string;
  name: string;
}
/**
 * Two tables side by side, such as actual against plan. Each is totalled by the shared column first
 * and only then joined, so a row on one side is never counted once per matching row on the other.
 */
export function compareSql(a: Side, b: Side, date: { isDate: boolean; bucket: Bucket }): Built {
  const key = (s: Side) => (date.isDate ? `strftime(date_trunc('${date.bucket}', ${q(s.by)}), '${BUCKET_FORMAT[date.bucket]}')` : `CAST(${q(s.by)} AS VARCHAR)`);
  const side = (s: Side) => `SELECT ${key(s)} AS k, ${s.measure === "count" ? "COUNT(*)" : `${s.measure.toUpperCase()}(${q(s.column)})`} AS v FROM ${q(s.table)} WHERE ${q(s.by)} IS NOT NULL GROUP BY 1`;
  const an = a.name.trim() || "Actual";
  const bn = b.name.trim() || "Plan";
  return {
    sql: `SELECT COALESCE(a.k, b.k) AS ${q(a.by)}, a.v AS ${q(an)}, b.v AS ${q(bn)}, COALESCE(a.v, 0) - COALESCE(b.v, 0) AS "Difference" FROM (${side(a)}) a FULL JOIN (${side(b)}) b ON a.k = b.k ORDER BY 1 LIMIT 200`,
    shape: "table",
    title: `${an} against ${bn} by ${a.by}`,
  };
}

/** How many distinct people (or things) reached each step, in the order the steps are given. */
export function funnelSql(table: string, stepColumn: string, steps: string[], idColumn: string): Built {
  const order = steps.map((s, i) => `WHEN ${lit(s)} THEN ${i + 1}`).join(" ");
  const counted = idColumn ? `COUNT(DISTINCT ${q(idColumn)})` : "COUNT(*)";
  return {
    sql: `SELECT ${q(stepColumn)}, ${counted} AS ${q(idColumn ? `Distinct ${idColumn}` : "Rows")} FROM ${q(table)} WHERE ${q(stepColumn)} IN (${steps.map(lit).join(", ")}) GROUP BY 1 ORDER BY CASE ${q(stepColumn)} ${order} END`,
    shape: "series",
    title: `Funnel by ${stepColumn}`,
  };
}

/**
 * Retention by cohort: people are grouped by the period of their first row, and counted in each
 * later period they appear in. One row per cohort and period.
 */
export function cohortSql(table: string, idColumn: string, dateColumn: string, bucket: Bucket): Built {
  const p = `date_trunc('${bucket}', ${q(dateColumn)})`;
  return {
    sql: `WITH firsts AS (SELECT ${q(idColumn)} AS id, MIN(${p}) AS cohort FROM ${q(table)} WHERE ${q(dateColumn)} IS NOT NULL GROUP BY 1), seen AS (SELECT DISTINCT ${q(idColumn)} AS id, ${p} AS period FROM ${q(table)} WHERE ${q(dateColumn)} IS NOT NULL) SELECT strftime(firsts.cohort, '${BUCKET_FORMAT[bucket]}') AS "Cohort", '${bucket} ' || LPAD(CAST(date_diff('${bucket}', firsts.cohort, seen.period) AS VARCHAR), 2, '0') AS "Period", COUNT(DISTINCT seen.id) AS ${q(`Distinct ${idColumn}`)} FROM firsts JOIN seen ON seen.id = firsts.id GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 1000`,
    shape: "table",
    title: `Retention by ${bucket} of first ${dateColumn}`,
  };
}
