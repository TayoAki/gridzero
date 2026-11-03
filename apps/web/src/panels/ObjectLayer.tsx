// Floating objects over the grid (PRD FR-13/FR-14): charts rendered with ECharts from
// server-evaluated series, and slicer chips. Each is anchored to a cell; positions
// follow the grid's scroll on every frame without re-rendering React.

import type { EChartsType } from "echarts/core";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";

import { COL_HEADER_H, ROW_HEADER_W, SCROLLBAR } from "../grid/grid";
import type { CanvasGrid } from "../grid/grid";
import type { Action, ChartData, ChartSpec, ColumnFilter, Reply, SlicerSpec } from "../sheet-socket";

// ECharts loads on first use, so workbooks without charts do not download it.
const charting = () => import("./charting");

export interface SlicerView {
  spec: SlicerSpec;
  column_name: string;
  filter: ColumnFilter | null;
}

export interface ObjectLayerHandle {
  /** Reposition every object (called after each grid frame). */
  layout(): void;
}

interface Props {
  grid: CanvasGrid | null;
  charts: ChartSpec[];
  slicers: SlicerView[];
  /** Bumped on every server change, so charts refetch their data. */
  seq: number;
  readOnly: boolean;
  send: (a: Action) => Promise<Reply>;
  /** Chart series, fetched over HTTP. */
  fetchChart: (id: string) => Promise<ChartData>;
  onEditChart: (spec: ChartSpec) => void;
  onSlicer: (s: SlicerView, x: number, y: number) => void;
  handle: Ref<ObjectLayerHandle>;
}

export function ObjectLayer({ grid, charts, slicers, seq, readOnly, send, fetchChart, onEditChart, onSlicer, handle }: Props) {
  const nodes = useRef(new Map<string, { el: HTMLElement; row: number; col: number }>());
  const layerRef = useRef<HTMLDivElement>(null);

  const layout = () => {
    if (!grid) return;
    for (const { el, row, col } of nodes.current.values()) {
      if (row >= grid.rows.count) continue;
      el.style.transform = `translate(${grid.colX(col)}px, ${grid.rowY(row)}px)`;
    }
  };
  useImperativeHandle(handle, () => ({ layout }), [grid]);
  useEffect(layout);

  const register = (id: string, row: number, col: number) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, { el, row, col });
    else nodes.current.delete(id);
  };

  /** The cell under a point in the layer, for dropping a moved object. */
  const cellAt = (x: number, y: number) => {
    if (!grid) return null;
    const hit = grid.hitTest(x, y);
    return hit.kind === "cell" ? { row: hit.row, col: hit.col } : null;
  };

  return (
    <div
      ref={layerRef}
      className="object-layer"
      style={{ clipPath: `inset(${COL_HEADER_H}px ${SCROLLBAR}px ${SCROLLBAR}px ${ROW_HEADER_W}px)` }}
    >
      {charts.map((c) => (
        <ChartBox
          key={c.id}
          spec={c}
          seq={seq}
          readOnly={readOnly}
          send={send}
          fetchChart={fetchChart}
          refEl={register(c.id, c.row, c.col)}
          cellAt={cellAt}
          layer={layerRef}
          onEdit={() => onEditChart(c)}
        />
      ))}
      {slicers.map((s) => (
        <button
          key={s.spec.id}
          ref={register(s.spec.id, s.spec.row, s.spec.col)}
          className={`slicer-chip${s.filter ? " active" : ""}`}
          onClick={(e) => onSlicer(s, e.clientX, e.clientY)}
          title="Slicer: choose which values to show"
        >
          <span className="slicer-title">{s.spec.title || s.column_name}</span>
          <span className="slicer-state">{describe(s.filter)}</span>
        </button>
      ))}
    </div>
  );
}

function describe(f: ColumnFilter | null): string {
  if (!f) return "All";
  if (f.type === "Values") return f.values.length <= 2 ? f.values.map((v) => v || "(Blanks)").join(", ") || "None" : `${f.values.length} selected`;
  return `${f.op} ${f.value}`.trim();
}

interface ChartBoxProps {
  spec: ChartSpec;
  seq: number;
  readOnly: boolean;
  send: (a: Action) => Promise<Reply>;
  fetchChart: (id: string) => Promise<ChartData>;
  refEl: (el: HTMLElement | null) => void;
  cellAt: (x: number, y: number) => { row: number; col: number } | null;
  layer: React.RefObject<HTMLDivElement | null>;
  onEdit: () => void;
}

function ChartBox({ spec, seq, readOnly, send, fetchChart, refEl, cellAt, layer, onEdit }: ChartBoxProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [size, setSize] = useState({ w: spec.w, h: spec.h });
  const [errors, setErrors] = useState<string[]>([]);
  const drag = useRef<{ mode: "move" | "resize"; x: number; y: number; w: number; h: number; dx: number; dy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setSize({ w: spec.w, h: spec.h }), [spec.w, spec.h]);

  useEffect(() => {
    let disposed = false;
    void charting().then((c) => {
      if (!disposed) chartRef.current = c.init(plotRef.current!);
    });
    return () => {
      disposed = true;
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([fetchChart(spec.id), charting()]).then(
      ([data, c]) => {
        if (!live) return;
        setErrors(data.errors);
        if (!chartRef.current) chartRef.current = c.init(plotRef.current!);
        chartRef.current.setOption(c.chartOption(spec, data), { notMerge: true });
      },
      (e: Error) => live && setErrors([e.message]),
    );
    return () => {
      live = false;
    };
  }, [seq, JSON.stringify(spec)]);

  useEffect(() => chartRef.current?.resize(), [size.w, size.h]);

  const start = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, w: size.w, h: size.h, dx: 0, dy: 0 };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    if (d.mode === "resize") setSize({ w: Math.max(200, d.w + d.dx), h: Math.max(150, d.h + d.dy) });
    else if (boxRef.current) boxRef.current.style.translate = `${d.dx}px ${d.dy}px`;
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "resize") {
      void send({ type: "UpdateChart", spec: { ...spec, w: Math.round(Math.max(200, d.w + d.dx)), h: Math.round(Math.max(150, d.h + d.dy)) } }).catch(() => {});
      return;
    }
    if (boxRef.current) boxRef.current.style.translate = "";
    const layerBox = layer.current?.getBoundingClientRect();
    const box = boxRef.current?.getBoundingClientRect();
    if (!layerBox || !box || (Math.abs(d.dx) < 3 && Math.abs(d.dy) < 3)) return;
    const target = cellAt(box.left - layerBox.left + d.dx + 1, box.top - layerBox.top + d.dy + 1);
    if (target) void send({ type: "UpdateChart", spec: { ...spec, row: target.row, col: target.col } }).catch(() => {});
  };

  return (
    <div
      className="chart-box"
      ref={(el) => {
        boxRef.current = el;
        refEl(el);
      }}
      style={{ width: size.w, height: size.h }}
      onPointerMove={move}
      onPointerUp={end}
      onDoubleClick={() => !readOnly && onEdit()}
    >
      <div className="chart-bar" onPointerDown={start("move")}>
        <span>{spec.title || "Chart"}</span>
        {!readOnly && <button className="link-button" onPointerDown={(e) => e.stopPropagation()} onClick={onEdit}>Edit</button>}
      </div>
      <div className="chart-plot" ref={plotRef} />
      {errors.length > 0 && <div className="chart-errors" role="status">{errors.join(" · ")}</div>}
      {!readOnly && <div className="chart-resize" onPointerDown={start("resize")} aria-label="Resize chart" />}
    </div>
  );
}

