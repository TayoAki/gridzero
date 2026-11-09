// Column menu for a Data Table or filtered-range header (PRD FR-7, E28): sort, filter
// by values or by condition, and, for tables, computed and hidden columns.

import { useEffect, useMemo, useState } from "react";

import type { Action, ColumnFilter, DataTarget, FilterOp, Range, Reply, TableInfo } from "../sheet-socket";
import { useEscape } from "../use-escape";

export type ColumnContext =
  | { kind: "table"; table: TableInfo; ci: number }
  | { kind: "range"; range: Range; col: number; filter: ColumnFilter | null }
  /** A slicer: only the filter controls, on any table or filtered range. */
  | { kind: "slicer"; target: DataTarget; col: number; filter: ColumnFilter | null; title: string; id: string };

const OPS: [FilterOp, string][] = [
  ["Eq", "is equal to"],
  ["Ne", "is not equal to"],
  ["Gt", "is greater than"],
  ["Ge", "is greater than or equal to"],
  ["Lt", "is less than"],
  ["Le", "is less than or equal to"],
  ["Contains", "contains"],
  ["NotContains", "does not contain"],
  ["StartsWith", "starts with"],
  ["EndsWith", "ends with"],
  ["Blank", "is blank"],
  ["NotBlank", "is not blank"],
];

export interface ColumnMenuProps {
  ctx: ColumnContext;
  x: number;
  y: number;
  send: (action: Action) => Promise<Reply>;
  onComputed: (table: TableInfo, ci: number | null) => void;
  onClose: () => void;
}

export function ColumnMenu({ ctx, x, y, send, onComputed, onClose }: ColumnMenuProps) {
  useEscape(onClose);
  const target: DataTarget = ctx.kind === "table" ? { type: "Table", table: ctx.table.id } : ctx.kind === "slicer" ? ctx.target : { type: "Range", range: ctx.range };
  const col = ctx.kind === "table" ? ctx.ci : ctx.col;
  const column = ctx.kind === "table" ? ctx.table.columns[ctx.ci] : null;
  const current = ctx.kind === "table" ? column!.filter : ctx.filter;
  const [values, setValues] = useState<[string, number][] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  // Checked values; null means "everything" (no value filter).
  const [checked, setChecked] = useState<Set<string> | null>(current?.type === "Values" ? new Set(current.values) : null);
  const [op, setOp] = useState<FilterOp>(current?.type === "Condition" ? current.op : "Eq");
  const [opValue, setOpValue] = useState(current?.type === "Condition" ? current.value : "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      send({ type: "DistinctValues", target, col, search: search || null, limit: 1000 }).then(
        (r) => {
          if (r.k !== "Distinct") return;
          setValues(r.values);
          setTotal(r.total);
        },
        (e: Error) => setError(e.message),
      );
    }, search ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [search]);

  const run = (action: Action) =>
    send(action).then(onClose, (e: Error) => setError(e.message));

  const sort = (desc: boolean | null) => {
    if (ctx.kind === "table") return run({ type: "SortTable", table: ctx.table.id, keys: desc === null ? [] : [{ col: ctx.ci, desc }] });
    if (desc !== null && ctx.kind === "range") return run({ type: "SortRange", range: ctx.range, keys: [{ col: ctx.col, desc }], header: true });
  };

  const applyValues = () => {
    const filter: ColumnFilter | null = checked === null ? null : { type: "Values", values: [...checked] };
    return run({ type: "SetFilter", target, col, filter });
  };

  const applyCondition = () => {
    if (op !== "Blank" && op !== "NotBlank" && !opValue.trim()) return setError("Enter a value");
    return run({ type: "SetFilter", target, col, filter: { type: "Condition", op, value: opValue } });
  };

  const toggle = (v: string) => {
    const all = values?.map(([s]) => s) ?? [];
    const next = new Set(checked ?? all);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setChecked(next.size === all.length && total === all.length ? null : next);
  };

  const hidden = useMemo(() => (ctx.kind === "table" ? ctx.table.columns.map((c, i) => [c, i] as const).filter(([c]) => c.hidden) : []), [ctx]);
  const left = Math.min(x, window.innerWidth - 300);
  const top = Math.min(y + 8, window.innerHeight - 520);

  return (
    <div className="dialog-backdrop transparent" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="column-menu" role="dialog" aria-label={`Column ${column?.name ?? ""} menu`} style={{ left, top: Math.max(8, top) }}>
        {error && <p className="error" role="alert">{error}</p>}
        {ctx.kind === "slicer" && <div className="cm-section"><strong>{ctx.title}</strong></div>}
        <div className="cm-section" hidden={ctx.kind === "slicer"}>
          <button onClick={() => void sort(false)}>Sort A → Z</button>
          <button onClick={() => void sort(true)}>Sort Z → A</button>
          {ctx.kind === "table" && column?.sort !== null && <button onClick={() => void sort(null)}>Clear sort</button>}
        </div>

        <div className="cm-section">
          <strong>Filter by values</strong>
          <input aria-label="Search values" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="cm-links">
            <button className="link-button" onClick={() => setChecked(null)}>Select all</button>
            <button className="link-button" onClick={() => setChecked(new Set())}>Clear</button>
            {total > (values?.length ?? 0) && <span>{(values?.length ?? 0).toLocaleString()} of {total.toLocaleString()} shown</span>}
          </div>
          <div className="cm-values" role="group" aria-label="Values">
            {values === null ? <span className="muted">Loading…</span> : values.map(([v, n]) => (
              <label key={v}>
                <input type="checkbox" checked={checked === null || checked.has(v)} onChange={() => toggle(v)} />
                <span className="cm-value">{v === "" ? "(Blanks)" : v}</span>
                <span className="muted">{n.toLocaleString()}</span>
              </label>
            ))}
          </div>
          <button className="primary-inline" onClick={() => void applyValues()}>Apply</button>
        </div>

        <div className="cm-section">
          <strong>Filter by condition</strong>
          <select aria-label="Condition" value={op} onChange={(e) => setOp(e.target.value as FilterOp)}>
            {OPS.map(([o, label]) => <option key={o} value={o}>{label}</option>)}
          </select>
          {op !== "Blank" && op !== "NotBlank" && <input aria-label="Condition value" value={opValue} onChange={(e) => setOpValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void applyCondition()} />}
          <button className="secondary" onClick={() => void applyCondition()}>Apply condition</button>
        </div>

        {ctx.kind === "slicer" && (
          <div className="cm-section">
            {current && <button onClick={() => void run({ type: "SetFilter", target, col, filter: null })}>Show all</button>}
            <button onClick={() => void run({ type: "DeleteObject", id: ctx.id })}>Delete slicer</button>
          </div>
        )}
        {current && ctx.kind !== "slicer" && (
          <div className="cm-section">
            <button onClick={() => void run({ type: "SetFilter", target, col, filter: null })}>Clear this filter</button>
            <button onClick={() => void run({ type: "ClearFilters", target })}>Clear all filters</button>
          </div>
        )}
        {ctx.kind === "range" && !current && (
          <div className="cm-section">
            <button onClick={() => void run({ type: "ClearFilters", target })}>Remove filter</button>
          </div>
        )}

        {ctx.kind === "table" && (
          <div className="cm-section">
            <button onClick={() => { onClose(); onComputed(ctx.table, null); }}>Add computed column…</button>
            {column?.expr && <button onClick={() => { onClose(); onComputed(ctx.table, ctx.ci); }}>Edit formula…</button>}
            {column?.expr && <button onClick={() => void run({ type: "DeleteTableColumn", table: ctx.table.id, col: ctx.ci })}>Delete column</button>}
            <button onClick={() => void run({ type: "SetTableColumnHidden", table: ctx.table.id, col: ctx.ci, hidden: true })}>Hide column</button>
            {hidden.map(([c, i]) => (
              <button key={i} onClick={() => void run({ type: "SetTableColumnHidden", table: ctx.table.id, col: i, hidden: false })}>Show “{c.name}”</button>
            ))}
            <button onClick={() => void run({ type: "RemoveDuplicates", target, cols: [ctx.ci], header: true })}>Remove duplicate {column?.name} rows</button>
          </div>
        )}
      </div>
    </div>
  );
}

export interface ComputedDialogProps {
  table: TableInfo;
  ci: number | null;
  send: (action: Action) => Promise<Reply>;
  onClose: () => void;
}

/** Add or edit a computed column: a formula evaluated for every row of the table. */
export function ComputedDialog({ table, ci, send, onClose }: ComputedDialogProps) {
  useEscape(onClose);
  const existing = ci === null ? null : table.columns[ci];
  const [name, setName] = useState(existing?.name ?? nextName(table));
  const [expr, setExpr] = useState(existing?.expr ?? "=");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await send(
        ci === null
          ? { type: "AddComputedColumn", table: table.id, name, expr }
          : { type: "UpdateComputedColumn", table: table.id, col: ci, name, expr },
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog computed-dialog" role="dialog" aria-modal="true" aria-label={ci === null ? "Add computed column" : "Edit computed column"}>
        <header className="dialog-head">
          <h2>{ci === null ? "Add computed column" : `Edit ${existing?.name}`}</h2>
          <button className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <label className="field">Column name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Formula (runs on every row of {table.name})
          <input className="mono" autoFocus value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        </label>
        <p className="hint">
          Columns: {table.columns.map((c) => `[${c.name}]`).join(" ")}<br />
          Operators + − * / ^ &amp; = &lt;&gt; &lt; &gt;. Functions: IF, AND, OR, NOT, ROUND, ABS, MIN, MAX, MOD, SQRT, POWER, LN, UPPER, LOWER, LEN, TRIM, LEFT, RIGHT, MID, CONCAT, SUBSTITUTE, CONTAINS, YEAR, MONTH, DAY, WEEKDAY, TEXT, VALUE, ISBLANK, COALESCE.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <footer className="dialog-foot">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary-inline" disabled={busy || !name.trim() || expr.trim().length < 2} onClick={() => void save()}>{busy ? "Computing…" : "Save"}</button>
        </footer>
      </div>
    </div>
  );
}

function nextName(t: TableInfo): string {
  let i = 1;
  while (t.columns.some((c) => c.name.toLowerCase() === `computed_${i}`)) i++;
  return `computed_${i}`;
}
