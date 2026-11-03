// "Configure pivot table" side pane (PRD E27): source fields, and Rows / Columns /
// Values / Filters wells. Every change sends the whole spec (UpdatePivot).

import { useEffect, useState } from "react";

import type { Action, Agg, ColumnFilter, DateGroup, PivotInfo, PivotSpec, Reply } from "../sheet-socket";

const AGGS: [Agg, string][] = [
  ["Sum", "Sum"],
  ["Count", "Count"],
  ["CountUnique", "Count unique"],
  ["Avg", "Average"],
  ["Min", "Min"],
  ["Max", "Max"],
  ["Median", "Median"],
  ["Percentile", "Percentile"],
];
const GROUPS: DateGroup[] = ["Year", "Quarter", "Month", "Day"];

interface Props {
  info: PivotInfo;
  send: (a: Action) => Promise<Reply>;
  onClose: () => void;
}

export function PivotPane({ info, send, onClose }: Props) {
  const [spec, setSpec] = useState<PivotSpec>(info.spec);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filterField, setFilterField] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<[string, number][]>([]);
  useEffect(() => setSpec(info.spec), [JSON.stringify(info.spec)]);

  const update = (next: PivotSpec) => {
    setSpec(next);
    setError(null);
    send({ type: "UpdatePivot", spec: next }).catch((e: Error) => {
      setError(e.message);
      setSpec(info.spec);
    });
  };

  const isDate = (f: string) => ["date", "datetime"].includes(info.fields.find((x) => x.name === f)?.dtype ?? "");
  const isNumber = (f: string) => ["integer", "number"].includes(info.fields.find((x) => x.name === f)?.dtype ?? "");
  const used = new Set([...spec.rows, ...spec.columns].map((f) => f.field));

  const add = (field: string, well: "rows" | "columns" | "values" | "filters") => {
    if (well === "values") update({ ...spec, values: [...spec.values, { field, agg: isNumber(field) ? "Sum" : "Count", percentile: null }] });
    else if (well === "filters") openFilter(field);
    else update({ ...spec, [well]: [...spec[well], { field, group: null }] });
  };

  /** Column index of a field for DistinctValues on the source. */
  const sourceCol = (field: string) => {
    const i = info.fields.findIndex((f) => f.name === field);
    return spec.source.type === "Range" ? spec.source.range.c0 + i : i;
  };

  const openFilter = (field: string) => {
    setFilterField(field);
    send({ type: "DistinctValues", target: spec.source, col: sourceCol(field), search: null, limit: 500 }).then(
      (r) => r.k === "Distinct" && setFilterValues(r.values),
      (e: Error) => setError(e.message),
    );
  };
  const current = (field: string): ColumnFilter | undefined => spec.filters.find(([f]) => f === field)?.[1];
  const setFilter = (field: string, filter: ColumnFilter | null) =>
    update({ ...spec, filters: [...spec.filters.filter(([f]) => f !== field), ...(filter ? [[field, filter] as [string, ColumnFilter]] : [])] });

  const move = <K extends "rows" | "columns" | "values">(well: K, i: number, d: -1 | 1) => {
    const list = [...spec[well]];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    update({ ...spec, [well]: list });
  };

  return (
    <aside className="side-pane" aria-label="Configure pivot table">
      <header className="dialog-head">
        <h2>Pivot table</h2>
        <button className="link-button" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <p className="hint">Double-click a value to list the rows behind it.</p>
      <p className="hint">Source: {spec.source.type === "Table" ? "data table" : "range"} · {info.rows > 1 ? `${(info.rows - 1).toLocaleString()} rows of output` : "empty"}</p>
      {(error || info.error) && <p className="error" role="alert">{error ?? info.error}</p>}

      <section className="pp-fields">
        <input aria-label="Search fields" placeholder="Search fields" value={search} onChange={(e) => setSearch(e.target.value)} />
        <ul>
          {info.fields.filter((f) => f.name.toLowerCase().includes(search.toLowerCase())).map((f) => (
            <li key={f.name}>
              <span className={used.has(f.name) ? "pp-used" : undefined}>{f.name}<small>{f.dtype}</small></span>
              <span className="pp-add">
                <button title="Add to rows" onClick={() => add(f.name, "rows")}>Row</button>
                <button title="Add to columns" onClick={() => add(f.name, "columns")}>Col</button>
                <button title="Add to values" onClick={() => add(f.name, "values")}>Value</button>
                <button title="Filter" onClick={() => add(f.name, "filters")}>Filter</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {(["rows", "columns"] as const).map((well) => (
        <section className="pp-well" key={well}>
          <strong>{well === "rows" ? "Rows" : "Columns"}</strong>
          {spec[well].length === 0 && <span className="muted">Add fields above</span>}
          {spec[well].map((f, i) => (
            <div className="pp-item" key={`${f.field}-${i}`}>
              <span>{f.field}</span>
              {isDate(f.field) && (
                <select aria-label={`Group ${f.field}`} value={f.group ?? ""} onChange={(e) => update({ ...spec, [well]: spec[well].map((x, j) => (j === i ? { ...x, group: (e.target.value || null) as DateGroup | null } : x)) })}>
                  <option value="">No grouping</option>
                  {GROUPS.map((g) => <option key={g} value={g}>By {g.toLowerCase()}</option>)}
                </select>
              )}
              <button title="Move up" onClick={() => move(well, i, -1)}>↑</button>
              <button title="Remove" onClick={() => update({ ...spec, [well]: spec[well].filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
        </section>
      ))}

      <section className="pp-well">
        <strong>Values</strong>
        {spec.values.length === 0 && <span className="muted">Add fields above</span>}
        {spec.values.map((v, i) => (
          <div className="pp-item" key={`${v.field}-${i}`}>
            <select aria-label={`Aggregate ${v.field}`} value={v.agg} onChange={(e) => update({ ...spec, values: spec.values.map((x, j) => (j === i ? { ...x, agg: e.target.value as Agg } : x)) })}>
              {AGGS.filter(([a]) => isNumber(v.field) || ["Count", "CountUnique", "Min", "Max"].includes(a)).map(([a, label]) => <option key={a} value={a}>{label}</option>)}
            </select>
            <span>of {v.field}</span>
            {v.agg === "Percentile" && (
              <input aria-label="Percentile" type="number" min={1} max={99} value={Math.round((v.percentile ?? 0.9) * 100)} onChange={(e) => update({ ...spec, values: spec.values.map((x, j) => (j === i ? { ...x, percentile: Math.min(99, Math.max(1, Number(e.target.value) || 90)) / 100 } : x)) })} />
            )}
            <button title="Move up" onClick={() => move("values", i, -1)}>↑</button>
            <button title="Remove" onClick={() => update({ ...spec, values: spec.values.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
      </section>

      <section className="pp-well">
        <strong>Filters</strong>
        {spec.filters.length === 0 && <span className="muted">None</span>}
        {spec.filters.map(([field, f]) => (
          <div className="pp-item" key={field}>
            <span>{field}: {f.type === "Values" ? (f.values.length <= 3 ? f.values.join(", ") : `${f.values.length} values`) : `${f.op} ${f.value}`}</span>
            <button onClick={() => openFilter(field)}>Edit</button>
            <button title="Remove" onClick={() => setFilter(field, null)}>✕</button>
          </div>
        ))}
        {filterField && (
          <div className="pp-filter">
            <span>Show {filterField} values:</span>
            <div className="cm-values">
              {filterValues.map(([v, n]) => {
                const f = current(filterField);
                const on = !f || (f.type === "Values" && f.values.includes(v));
                return (
                  <label key={v}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const all = filterValues.map(([x]) => x);
                        const selected = new Set(f?.type === "Values" ? f.values : all);
                        if (selected.has(v)) selected.delete(v);
                        else selected.add(v);
                        setFilter(filterField, selected.size === all.length ? null : { type: "Values", values: [...selected] });
                      }}
                    />
                    <span className="cm-value">{v || "(Blanks)"}</span>
                    <span className="muted">{n.toLocaleString()}</span>
                  </label>
                );
              })}
            </div>
            <button className="secondary" onClick={() => setFilterField(null)}>Done</button>
          </div>
        )}
      </section>

      <section className="pp-well">
        <label><input type="checkbox" checked={spec.totals} onChange={(e) => update({ ...spec, totals: e.target.checked })} /> Show grand totals</label>
        <button className="link-button danger" onClick={() => window.confirm("Delete this pivot table?") && send({ type: "DeleteObject", id: spec.id }).then(onClose, (e: Error) => setError(e.message))}>Delete pivot table</button>
      </section>
    </aside>
  );
}
