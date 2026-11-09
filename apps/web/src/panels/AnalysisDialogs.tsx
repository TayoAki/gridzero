// Dialogs for M3 objects: chart settings, conditional formatting, and dropdown lists.

import { useEffect, useState } from "react";

import type { Action, ChartKind, ChartSpec, CondOp, CondRule, CondStyle, IconSetKind, Range, Reply, SheetInfo, ValidationSpec } from "../sheet-socket";
import { useEscape } from "../use-escape";
import { formatRange, parseRange } from "./refs";

const KINDS: [ChartKind, string][] = [
  ["Column", "Column"],
  ["Bar", "Bar (horizontal)"],
  ["Line", "Line"],
  ["Area", "Area"],
  ["Scatter", "Scatter"],
  ["Pie", "Pie"],
  ["Histogram", "Histogram"],
];

interface Base {
  send: (a: Action) => Promise<Reply>;
  sheets: SheetInfo[];
  sheet: number;
  onClose: () => void;
}

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "" : "small-dialog"}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- charts

export function ChartDialog({ spec, send, sheets, sheet, onClose }: Base & { spec: ChartSpec }) {
  const fmt = (r: Range | null) => (r ? formatRange(r, sheets, sheet) : "");
  const [kind, setKind] = useState(spec.kind);
  const [title, setTitle] = useState(spec.title);
  const [x, setX] = useState(fmt(spec.x));
  const [series, setSeries] = useState(spec.series.map((s) => ({ ref: s.range ? fmt(s.range) : "#REF!", name: s.name ?? "", kind: s.kind ?? "", axis: s.axis })));
  const [bins, setBins] = useState(spec.bins ?? 0);
  const [stacked, setStacked] = useState(spec.stacked);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const xr = x.trim() ? parseRange(x, sheets, sheet) : null;
    if (x.trim() && !xr) return setError(`Can't read the category reference "${x}"`);
    const parsed = series.map((s) => ({ ...s, range: parseRange(s.ref, sheets, sheet) }));
    const bad = parsed.find((s) => !s.range);
    if (bad) return setError(`Can't read the series reference "${bad.ref}"`);
    try {
      await send({
        type: "UpdateChart",
        spec: {
          ...spec,
          kind,
          title,
          x: xr,
          series: parsed.map((s) => ({ range: s.range, name: s.name || null, kind: (s.kind || null) as ChartKind | null, axis: s.axis })),
          bins: bins > 0 ? bins : null,
          stacked,
        },
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title="Chart" onClose={onClose} wide>
      <div className="form-grid">
        <label>Type <select value={kind} onChange={(e) => setKind(e.target.value as ChartKind)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {kind !== "Histogram" && <label>Categories (x) <input className="mono" placeholder="e.g. A2:A20" value={x} onChange={(e) => setX(e.target.value)} /></label>}
        {kind === "Histogram" && <label>Buckets <input type="number" min={0} max={200} value={bins} onChange={(e) => setBins(Number(e.target.value) || 0)} /> <small className="muted">0 = automatic</small></label>}
        {kind !== "Pie" && kind !== "Histogram" && <label><input type="checkbox" checked={stacked} onChange={(e) => setStacked(e.target.checked)} /> Stacked</label>}
      </div>
      <table className="series-table">
        <thead><tr><th>Series cells</th><th>Name</th><th>Type</th><th>Axis</th><th /></tr></thead>
        <tbody>
          {series.map((s, i) => (
            <tr key={i}>
              <td><input className="mono" aria-label={`Series ${i + 1} reference`} value={s.ref} onChange={(e) => setSeries(series.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))} /></td>
              <td><input aria-label={`Series ${i + 1} name`} value={s.name} onChange={(e) => setSeries(series.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
              <td>
                <select aria-label={`Series ${i + 1} type`} value={s.kind} onChange={(e) => setSeries(series.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                  <option value="">Same as chart</option>
                  {KINDS.filter(([k]) => ["Column", "Line", "Area", "Scatter"].includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </td>
              <td>
                <select aria-label={`Series ${i + 1} axis`} value={s.axis} onChange={(e) => setSeries(series.map((x, j) => (j === i ? { ...x, axis: e.target.value as "Left" | "Right" } : x)))}>
                  <option value="Left">Left</option>
                  <option value="Right">Right</option>
                </select>
              </td>
              <td><button className="link-button danger" onClick={() => setSeries(series.filter((_, j) => j !== i))} disabled={series.length < 2}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="link-button" onClick={() => setSeries([...series, { ref: "", name: "", kind: "", axis: "Left" }])}>+ Add series</button>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="dialog-foot">
        <button className="link-button danger" onClick={() => window.confirm("Delete this chart?") && send({ type: "DeleteObject", id: spec.id }).then(onClose, (e: Error) => setError(e.message))}>Delete chart</button>
        <span style={{ flex: 1 }} />
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary-inline" onClick={() => void save()}>Save</button>
      </footer>
    </Dialog>
  );
}

// ------------------------------------------------------------- conditional formatting

type RuleKind = "Gt" | "Lt" | "Between" | "Eq" | "TextContains" | "Blanks" | "Duplicates" | "Top" | "Bottom" | "AboveAvg" | "BelowAvg" | "Formula" | "ColorScale" | "DataBar" | "IconSet";
const RULES: [RuleKind, string][] = [
  ["Gt", "Greater than"],
  ["Lt", "Less than"],
  ["Between", "Between"],
  ["Eq", "Equal to"],
  ["TextContains", "Text contains"],
  ["Blanks", "Is blank"],
  ["Duplicates", "Duplicate values"],
  ["Top", "Top N"],
  ["Bottom", "Bottom N"],
  ["AboveAvg", "Above average"],
  ["BelowAvg", "Below average"],
  ["Formula", "Custom formula"],
  ["ColorScale", "Color scale"],
  ["DataBar", "Data bar"],
  ["IconSet", "Icon set"],
];
const ICON_SETS: [IconSetKind, string][] = [
  ["Arrows", "Arrows ▲ ► ▼"],
  ["TrafficLights", "Traffic lights ● ● ●"],
  ["Flags", "Flags"],
  ["Symbols", "Symbols ✓ ! ✕"],
];

export function CondFormatDialog({ range, send, sheets, sheet, onClose }: Base & { range: Range }) {
  const [kind, setKind] = useState<RuleKind>("Gt");
  const [value, setValue] = useState("");
  const [value2, setValue2] = useState("");
  const [fill, setFill] = useState("#FCE8E6");
  const [color, setColor] = useState("#C5221F");
  const [bold, setBold] = useState(false);
  const [scale, setScale] = useState({ min: "#F8696B", mid: "#FFEB84", max: "#63BE7B", useMid: true });
  const [bar, setBar] = useState("#638EC6");
  const [icons, setIcons] = useState<{ set: IconSetKind; reverse: boolean }>({ set: "Arrows", reverse: false });
  const [list, setList] = useState<{ index: number; range: string; summary: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => send({ type: "ListCondFormats", sheet }).then((r) => r.k === "CondFormats" && setList(r.list), () => {});
  useEffect(() => void load(), []);

  const rule = (): CondRule | null => {
    const op = (o: CondOp): CondRule => ({ type: "CellIs", op: o, value, value2: o === "Between" ? value2 : null });
    switch (kind) {
      case "Gt": return op("Gt");
      case "Lt": return op("Lt");
      case "Eq": return op("Eq");
      case "Between": return op("Between");
      case "TextContains": return { type: "TextContains", value };
      case "Blanks": return { type: "Blanks" };
      case "Duplicates": return { type: "Duplicates" };
      case "Top": return { type: "Top", rank: Number(value) || 10, bottom: false, percent: false };
      case "Bottom": return { type: "Top", rank: Number(value) || 10, bottom: true, percent: false };
      case "AboveAvg": return { type: "Average", below: false };
      case "BelowAvg": return { type: "Average", below: true };
      case "Formula": return value.trim() ? { type: "Formula", formula: value } : null;
      case "ColorScale": return { type: "ColorScale", min: scale.min, mid: scale.useMid ? scale.mid : null, max: scale.max };
      case "DataBar": return { type: "DataBar", color: bar };
      case "IconSet": return { type: "IconSet", ...icons };
    }
  };
  const needsValue = ["Gt", "Lt", "Eq", "Between", "TextContains", "Top", "Bottom", "Formula"].includes(kind);
  const styled = !["ColorScale", "DataBar", "IconSet"].includes(kind);

  const add = async () => {
    const r = rule();
    if (!r || (needsValue && !value.trim())) return setError("Enter a value");
    const style: CondStyle = { fill, color, bold };
    try {
      await send({ type: "AddCondFormat", range, rule: r, style });
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title={`Conditional formatting · ${formatRange(range, sheets, sheet)}`} onClose={onClose} wide>
      <div className="form-grid">
        <label>Format cells if <select value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {needsValue && <label>{kind === "Formula" ? "Formula (true = format)" : kind === "Top" || kind === "Bottom" ? "N" : "Value"} <input className={kind === "Formula" ? "mono" : undefined} value={value} placeholder={kind === "Formula" ? "=A1>B1" : undefined} onChange={(e) => setValue(e.target.value)} /></label>}
        {kind === "Between" && <label>and <input value={value2} onChange={(e) => setValue2(e.target.value)} /></label>}
        {styled && (
          <>
            <label>Fill <input type="color" value={fill} onChange={(e) => setFill(e.target.value.toUpperCase())} /></label>
            <label>Text <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} /></label>
            <label><input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /> Bold</label>
          </>
        )}
        {kind === "ColorScale" && (
          <>
            <label>Lowest <input type="color" value={scale.min} onChange={(e) => setScale({ ...scale, min: e.target.value.toUpperCase() })} /></label>
            <label><input type="checkbox" checked={scale.useMid} onChange={(e) => setScale({ ...scale, useMid: e.target.checked })} /> Middle <input type="color" value={scale.mid} onChange={(e) => setScale({ ...scale, mid: e.target.value.toUpperCase() })} /></label>
            <label>Highest <input type="color" value={scale.max} onChange={(e) => setScale({ ...scale, max: e.target.value.toUpperCase() })} /></label>
          </>
        )}
        {kind === "IconSet" && (
          <>
            <label>Icons <select aria-label="Icon style" value={icons.set} onChange={(e) => setIcons({ ...icons, set: e.target.value as IconSetKind })}>{ICON_SETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label><input type="checkbox" checked={icons.reverse} onChange={(e) => setIcons({ ...icons, reverse: e.target.checked })} /> Reverse order</label>
            <p className="hint">Top third of values, middle third, bottom third.</p>
          </>
        )}
        {kind === "DataBar" && <label>Bar color <input type="color" value={bar} onChange={(e) => setBar(e.target.value.toUpperCase())} /></label>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="dialog-foot"><button className="primary-inline" onClick={() => void add()}>Add rule</button></footer>
      <section>
        <strong>Rules on this sheet</strong>
        {list.length === 0 ? <p className="muted">None yet.</p> : (
          <ul className="rule-list">
            {list.map((cf) => (
              <li key={cf.index}>
                <span className="mono">{cf.range}</span> {cf.summary}
                <button className="link-button danger" onClick={() => void send({ type: "DeleteCondFormat", sheet, index: cf.index }).then(load, (e: Error) => setError(e.message))}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}

// ------------------------------------------------------------- dropdown lists

export function ValidationDialog({ range, existing, send, sheets, sheet, onClose }: Base & { range: Range; existing: ValidationSpec | null }) {
  const [values, setValues] = useState(existing?.values.join("\n") ?? "");
  const [source, setSource] = useState(existing?.source ? formatRange(existing.source, sheets, sheet) : "");
  const [strict, setStrict] = useState(existing?.strict ?? true);
  const [error, setError] = useState<string | null>(null);
  const target = existing?.range ?? range;

  const save = async () => {
    const src = source.trim() ? parseRange(source, sheets, sheet) : null;
    if (source.trim() && !src) return setError(`Can't read the reference "${source}"`);
    try {
      await send({ type: "SetValidation", spec: { id: existing?.id ?? "", range: target, values: values.split(/[\n,]/).map((v) => v.trim()).filter(Boolean), source: src, strict } });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog title={`Dropdown list · ${formatRange(target, sheets, sheet)}`} onClose={onClose}>
      <label className="field">Allowed values (one per line or comma-separated)
        <textarea rows={5} value={values} onChange={(e) => setValues(e.target.value)} />
      </label>
      <label className="field">…and/or the values in these cells
        <input className="mono" placeholder="e.g. Lists!A2:A20" value={source} onChange={(e) => setSource(e.target.value)} />
      </label>
      <label><input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} /> Reject other values</label>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="dialog-foot">
        {existing && <button className="link-button danger" onClick={() => send({ type: "DeleteObject", id: existing.id }).then(onClose, (e: Error) => setError(e.message))}>Remove dropdown</button>}
        <span style={{ flex: 1 }} />
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary-inline" onClick={() => void save()}>Save</button>
      </footer>
    </Dialog>
  );
}
