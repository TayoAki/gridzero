// A slicer card: tick values, press buttons, or drag a from-to range, and the report's other cards
// show only what matches. Modelled on the slicers in Prism BI.

import { useEffect, useRef, useState } from "react";

import type { Pick, SliceField } from "./slicing";
import { SLICER_STYLES } from "./spec";
import type { SlicerStyle } from "./spec";

const STYLE_NAMES: Record<SlicerStyle, string> = { list: "List", dropdown: "Dropdown", buttons: "Buttons", range: "Range" };

/** Grid units for a new slicer of each style. */
export const SLICER_UNITS: Record<SlicerStyle, [number, number]> = { list: [3, 2], dropdown: [3, 1], buttons: [6, 1], range: [4, 1] };

/** The style a new slicer starts with: buttons for a handful of values, a list for more, a range for numbers. */
export const startStyle = (f: SliceField): SlicerStyle => (f.type === "number" ? "range" : f.values.length <= 6 ? "buttons" : "list");

const short = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

interface Props {
  title: string;
  style: SlicerStyle;
  field: SliceField | undefined;
  pick: Pick | undefined;
  onPick: (p: Pick | null) => void;
  /** Left out where the report cannot be edited, such as on a wall screen. */
  onStyle?: (s: SlicerStyle) => void;
  onRemove?: () => void;
}

export function SlicerCard({ title, style, field, pick, onPick, onStyle, onRemove }: Props) {
  const active = !!pick && ((pick.values?.length ?? 0) > 0 || !!pick.range);
  return (
    <div className={`slicer-card${active ? " active" : ""}`}>
      <div className="slicer-head">
        {onStyle && <span className="widget-grip" title="Drag to move" aria-hidden="true">⠿</span>}
        <span className="slicer-title" title={title}>{title}</span>
        {active && <button className="link-button" onClick={() => onPick(null)}>Clear</button>}
        {onStyle && (
          <span className="slicer-tools">
            {field?.type === "text" && SLICER_STYLES.filter((s) => s !== "range").map((s) => (
              <button key={s} className={style === s ? "selected" : ""} onClick={() => onStyle(s)} title={`Show as ${STYLE_NAMES[s].toLowerCase()}`}>{STYLE_NAMES[s]}</button>
            ))}
            {onRemove && <button className="danger" onClick={onRemove} aria-label={`Remove the ${title} slicer`} title="Remove slicer">✕</button>}
          </span>
        )}
      </div>
      <div className="slicer-body">
        {!field ? (
          <p className="slicer-missing">No card on this report has “{title}” any more.</p>
        ) : field.type === "number" ? (
          <RangeSlicer field={field} pick={pick} onPick={onPick} />
        ) : (
          <ValueSlicer field={field} style={style} pick={pick} onPick={onPick} />
        )}
      </div>
    </div>
  );
}

function ValueSlicer({ field, style, pick, onPick }: { field: SliceField; style: SlicerStyle; pick: Pick | undefined; onPick: (p: Pick | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The dropdown closes on a press anywhere outside it, or on Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const selected = new Set(pick?.values ?? []);
  // Choosing nothing, or everything, is the same as no slicer.
  const commit = (next: Set<string>) => onPick(next.size > 0 && next.size < field.values.length ? { values: field.values.filter((v) => next.has(v)) } : null);
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    commit(next);
  };

  if (style === "buttons") {
    return (
      <div className="slicer-buttons">
        {field.values.map((v) => (
          <button
            key={v}
            aria-pressed={selected.has(v)}
            className={selected.has(v) ? "on" : ""}
            title="Hold Ctrl, ⌘ or Shift to choose several"
            onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? toggle(v) : commit(selected.size === 1 && selected.has(v) ? new Set() : new Set([v])))}
          >
            {v}
          </button>
        ))}
      </div>
    );
  }

  const shown = q ? field.values.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : field.values;
  const list = (
    <div className="slicer-list">
      {field.values.length > 8 && <input className="slicer-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${field.name}`} />}
      <label><input type="checkbox" checked={selected.size === 0} onChange={() => onPick(null)} /> <strong>All</strong></label>
      {shown.map((v) => (
        <label key={v}><input type="checkbox" checked={selected.has(v)} onChange={() => toggle(v)} /> <span>{v}</span></label>
      ))}
    </div>
  );
  if (style !== "dropdown") return list;
  const summary = selected.size === 0 ? "All" : selected.size === 1 ? [...selected][0] : `${selected.size} chosen`;
  return (
    <div ref={box} className={`slicer-dropdown${open ? " slicer-open" : ""}`}>
      <button className="slicer-dropdown-button" aria-expanded={open} onClick={() => setOpen(!open)}><span>{summary}</span><span aria-hidden="true">▾</span></button>
      {open && <div className="slicer-popup">{list}</div>}
    </div>
  );
}

function RangeSlicer({ field, pick, onPick }: { field: SliceField; pick: Pick | undefined; onPick: (p: Pick | null) => void }) {
  const [lo, hi] = field.range;
  const current: [number, number] = pick?.range ?? [lo, hi];
  // While a handle is being dragged the cards wait: they change when it is let go.
  const [drag, setDrag] = useState<[number, number] | null>(null);
  useEffect(() => setDrag(null), [pick]);
  const [a, b] = drag ?? current;
  const step = Number.isInteger(lo) && Number.isInteger(hi) && hi - lo >= 20 ? 1 : (hi - lo) / 200;
  const round = (v: number) => Math.round(v * 100) / 100;
  const commit = (r: [number, number]) => {
    setDrag(null);
    const x = Math.max(lo, Math.min(r[0], r[1]));
    const y = Math.min(hi, Math.max(r[0], r[1]));
    onPick(x <= lo && y >= hi ? null : { range: [round(x), round(y)] });
  };
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const end = () => drag && commit(drag);
  return (
    <div className="slicer-range">
      <div className="slicer-range-inputs">
        <NumberBox label={`${field.name} from`} value={round(a)} onCommit={(v) => commit([v, b])} />
        <span>to</span>
        <NumberBox label={`${field.name} to`} value={round(b)} onCommit={(v) => commit([a, v])} />
      </div>
      <div className="dual-range" onPointerUp={end} onKeyUp={end} onBlur={end}>
        <div className="track" />
        <div className="fill" style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%` }} />
        <input type="range" aria-label={`${field.name} from`} min={lo} max={hi} step={step} value={a} onChange={(e) => setDrag([Math.min(+e.target.value, b), b])} />
        <input type="range" aria-label={`${field.name} to`} min={lo} max={hi} step={step} value={b} onChange={(e) => setDrag([a, Math.max(+e.target.value, a)])} />
      </div>
      <div className="slicer-range-ends"><span>{short(lo)}</span><span>{short(hi)}</span></div>
    </div>
  );
}

function NumberBox({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      aria-label={label}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== "" && Number.isFinite(Number(draft))) onCommit(Number(draft));
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
