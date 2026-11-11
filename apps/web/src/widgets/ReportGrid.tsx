// A report's cards on a 12-column grid: drag a card by its grip, resize it from its corner.
// The grid is react-grid-layout, the same one Prism BI's dashboards use.

import { useState } from "react";
import type { ReactNode } from "react";
import { Responsive, WidthProvider } from "react-grid-layout";
import type { Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";

import { FORM_CHART } from "./prism/adapt";
import type { Widget, WidgetLayout, WidgetSize } from "./spec";

const Grid = WidthProvider(Responsive);

export const ROW_HEIGHT = 140;
export const GAP = 12;

/** The grid units a card takes when nobody has placed it yet, from its old small, medium or large size. */
export const UNITS: Record<WidgetSize, [number, number]> = { s: [3, 1], m: [6, 1], l: [6, 2] };

export type Placed = WidgetLayout & { id: string };

/**
 * Where every card goes. Cards someone has placed keep their place; the rest flow left to right
 * underneath, in their saved order.
 */
export function placed(widgets: Widget[]): Placed[] {
  const out: Placed[] = [];
  let bottom = 0;
  for (const w of widgets) {
    if (!w.layout) continue;
    out.push({ id: w.id, ...w.layout });
    bottom = Math.max(bottom, w.layout.y + w.layout.h);
  }
  let x = 0;
  let y = bottom;
  let rowHeight = 0;
  for (const w of widgets) {
    if (w.layout) continue;
    const [cols, base] = UNITS[w.size] ?? UNITS.m;
    // A chart wider than a small card needs two rows to show its axes; a gauge reads fine in one.
    const rows = FORM_CHART[w.form] && w.form !== "gauge" && w.size !== "s" ? Math.max(base, 2) : base;
    if (x + cols > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    out.push({ id: w.id, x, y, w: cols, h: rows });
    x += cols;
    rowHeight = Math.max(rowHeight, rows);
  }
  return out;
}

export function ReportGrid({ widgets, render, onChange }: { widgets: Widget[]; render: (w: Widget) => ReactNode; onChange: (items: Placed[]) => void }) {
  // Below the wide layout the cards stack in one column and cannot be moved: that view is for reading.
  const [wide, setWide] = useState(true);
  const items = placed(widgets);
  const save = (layout: Layout[]) => {
    if (!wide) return;
    const next = layout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
    const same = next.every((n) => {
      const was = items.find((i) => i.id === n.id);
      return was && was.x === n.x && was.y === n.y && was.w === n.w && was.h === n.h;
    });
    if (!same) onChange(next);
  };
  return (
    <Grid
      className="report-grid"
      breakpoints={{ lg: 860, xs: 0 }}
      cols={{ lg: 12, xs: 1 }}
      layouts={{ lg: items.map((i) => ({ i: i.id, x: i.x, y: i.y, w: i.w, h: i.h, minW: 2, minH: 1, maxH: 8 })) }}
      rowHeight={ROW_HEIGHT}
      margin={[GAP, GAP]}
      containerPadding={[0, 0]}
      compactType="vertical"
      draggableHandle=".widget-grip"
      resizeHandles={["se"]}
      isDraggable={wide}
      isResizable={wide}
      onBreakpointChange={(bp) => setWide(bp === "lg")}
      onDragStop={save}
      onResizeStop={save}
    >
      {widgets.map((w) => (
        <div key={w.id} className="report-slot">
          {render(w)}
        </div>
      ))}
    </Grid>
  );
}
