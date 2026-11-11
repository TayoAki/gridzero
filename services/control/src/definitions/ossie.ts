// Export definitions as an Apache Ossie semantic model (spec §4.5). Ossie has no place for
// status, owner, evidence or checks, so those travel in custom_extensions under GRIDZERO.

import { stringify } from "yaml";

import type { DefinitionRow } from "./store.ts";

/** The draft of the Ossie core spec on its main branch when this was written; 0.1.1 is the released one. */
export const OSSIE_VERSION = "0.3.0.dev0";

const DATATYPE: Record<string, string> = { int: "Integer", num: "Decimal", str: "String", bool: "Boolean", date: "Date", timestamp: "DateTime", other: "Opaque" };

const extension = (d: DefinitionRow, extra: Record<string, unknown> = {}) => [
  {
    vendor_name: "GRIDZERO",
    data: JSON.stringify({ status: d.status, confidence: d.confidence, confirmed_by: d.confirmedBy, confirmed_at: d.confirmedAt, owner: d.ownerId, version: d.version, evidence: d.evidence, check_number: d.checkNumber, ...extra }),
  },
];

export interface ExportOptions {
  name: string;
  /** Include definitions nobody has confirmed, each marked with its status. */
  all: boolean;
  columnKinds: Record<string, Record<string, string>>;
}

export function toOssie(defs: DefinitionRow[], opts: ExportOptions): string {
  const keep = (d: DefinitionRow) => opts.all || d.status === "confirmed";
  const bare = (fq: string) => fq.split(".").pop()!;
  const rules = defs.filter((d) => d.kind === "rule");
  const metrics = defs.filter((d) => d.kind === "metric" && keep(d));
  const links = defs.filter((d) => d.kind === "link" && keep(d));
  const dims = defs.filter((d) => d.kind === "dimension" && keep(d));
  // A dataset is exported when it is confirmed, or when something exported needs it.
  const needed = new Set<string>();
  for (const m of metrics) needed.add((m.body as any).entity);
  for (const l of links) for (const t of [(l.body as any).from_entity, (l.body as any).to_entity]) needed.add(t);
  for (const d of dims) needed.add((d.body as any).entity);
  const entities = defs.filter((d) => d.kind === "entity" && (keep(d) || needed.has((d.body as any).table)));

  const datasets = entities.map((e) => {
    const body = e.body as { table: string; grain: string[] | null };
    const kinds = opts.columnKinds[body.table] ?? {};
    const dimNames = new Map(dims.filter((d) => (d.body as any).entity === body.table).map((d) => [(d.body as any).expression as string, d]));
    return {
      name: bare(body.table),
      source: body.table,
      ...(body.grain ? { primary_key: body.grain } : {}),
      ...(e.description ? { description: e.description } : {}),
      fields: Object.entries(kinds).map(([col, kind]) => {
        const dim = dimNames.get(col);
        return {
          name: col,
          expression: { dialects: [{ dialect: "POSTGRES", expression: col }] },
          ...(dim ? { dimension: { is_time: kind === "date" || kind === "timestamp" }, label: dim.label } : {}),
          datatype: DATATYPE[kind] ?? "Opaque",
        };
      }),
      custom_extensions: extension(e),
    };
  });

  const relationships = links.map((l) => {
    const b = l.body as { from_entity: string; to_entity: string; from_columns: string[]; to_columns: string[]; cardinality: string; coverage: number | null };
    return { name: l.name, from: bare(b.from_entity), to: bare(b.to_entity), from_columns: b.from_columns, to_columns: b.to_columns, custom_extensions: extension(l, { cardinality: b.cardinality, coverage: b.coverage }) };
  });

  const outMetrics = metrics.map((m) => {
    const b = m.body as { expression: string; filters?: string[] };
    const used = (b.filters ?? []).map((n) => rules.find((r) => r.name === n)).filter((r): r is DefinitionRow => !!r);
    // Ossie has no filter on a metric, so rules are folded in the portable way: SUM(CASE WHEN rule THEN x END).
    const condition = used.map((r) => `(${(r.body as any).expression})`).join(" AND ");
    const folded = condition ? b.expression.replace(/^(\w+)\((DISTINCT\s+)?(.*)\)$/is, (_all, fn: string, distinct: string | undefined, arg: string) => `${fn}(${distinct ?? ""}CASE WHEN ${condition} THEN ${arg.trim() === "*" ? "1" : arg} END)`) : b.expression;
    return {
      name: m.name,
      expression: { dialects: [{ dialect: "POSTGRES", expression: folded }] },
      ...(m.description || m.label ? { description: m.description || m.label } : {}),
      ai_context: { synonyms: [m.label] },
      custom_extensions: extension(m, { expression: b.expression, rules: used.map((r) => ({ name: r.name, label: r.label, expression: (r.body as any).expression, status: r.status })) }),
    };
  });

  return stringify({ version: OSSIE_VERSION, name: opts.name, description: "Exported from GridZero. Only confirmed definitions unless stated in each item's GRIDZERO extension.", datasets, ...(relationships.length ? { relationships } : {}), metrics: outMetrics }, { lineWidth: 0 });
}
