// Draws one widget's data in its form, theme and size (agent spec §8.2).

import { useEffect, useRef } from "react";

import { ChatText } from "../agents/AgentChatPage";
import { THEME_COLORS } from "./spec";
import { FORM_CHART, toResult } from "./prism/adapt";
import { PRISM_PALETTE, buildChart } from "./prism/charts";
import type { QueryResult } from "./prism/types";
import type { WidgetData, WidgetForm, WidgetSize, WidgetTheme } from "./spec";

const charting = () => import("../panels/charting");

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/**
 * One chart, drawn by the Prism chart builder in the page's own colours. The first colour is the
 * widget's theme; the rest are Prism's palette, for charts with several series or slices.
 */
function PrismChart({ result, color, compact, onPick }: { result: QueryResult; color: string; compact: boolean; onPick?: (label: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  // The latest handler, so a new one does not redraw the chart.
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    let disposed = false;
    let chart: { setOption: (o: unknown) => void; resize: () => void; dispose: () => void; on: (event: string, fn: (p: unknown) => void) => void } | null = null;
    const observer = new ResizeObserver(() => chart?.resize());
    charting().then((c) => {
      if (disposed || !el.current) return;
      const css = getComputedStyle(el.current);
      const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      const built = buildChart(result, compact, {
        text: token("--text", "#1f2328"),
        muted: token("--muted", "#5f6368"),
        grid: token("--border", "#dadce0"),
        axis: token("--border", "#dadce0"),
        surface: token("--bg", "#ffffff"),
        strong: token("--text", "#1f2328"),
        palette: [color, ...PRISM_PALETTE.filter((p) => p !== color)],
      });
      if (!built) return;
      chart = c.init(el.current);
      chart.setOption(built.option);
      // Clicking a bar, slice or point names its first label: the report can be filtered by it.
      chart.on("click", (p) => {
        const label = built.pick(p)?.[0];
        if (label !== null && label !== undefined) pick.current?.(label);
      });
      observer.observe(el.current);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      chart?.dispose();
    };
  }, [result, color, compact]);
  return <div className={`widget-chart${onPick ? " pickable" : ""}`} ref={el} />;
}

export function WidgetBody({ form, theme, size, data, title, onPick }: { form: WidgetForm; theme: WidgetTheme; size: WidgetSize; data: WidgetData; title?: string; onPick?: (label: string) => void }) {
  const colors = THEME_COLORS[theme] ?? THEME_COLORS.blue;
  const compact = size === "s";
  switch (data.kind) {
    case "number": {
      // A gauge shows the same figure against a scale.
      const dial = form === "gauge" ? toResult(data, form, title ?? "") : null;
      if (dial) return <PrismChart result={dial} color={colors.chart} compact={compact} />;
      return (
        <div className="widget-number">
          <div className="widget-value" style={{ color: colors.accent }}>
            {fmt(data.value)}
            {data.unit && <span className="widget-unit">{data.unit}</span>}
          </div>
          {data.delta !== null && data.delta !== 0 && (
            <span className={`widget-delta ${data.delta > 0 ? "up" : "down"}`}>
              {data.delta > 0 ? "▲" : "▼"} {fmt(Math.abs(data.delta))}
            </span>
          )}
          {data.label && <div className="widget-label">{data.label}</div>}
        </div>
      );
    }
    case "series": {
      const result = toResult(data, FORM_CHART[form] ? form : "trend", title ?? "");
      return result ? <PrismChart result={result} color={colors.chart} compact={compact} onPick={onPick} /> : null;
    }
    case "table": {
      // A table drawn as a chart, when it has the columns that chart needs; otherwise the table itself.
      const result = form === "table" ? null : toResult(data, form, title ?? "");
      if (result) return <PrismChart result={result} color={colors.chart} compact={compact} onPick={onPick} />;
      return (
        <div className="widget-table">
          <table>
            <thead><tr>{data.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>{data.columns.map((_, j) => <td key={j} className={typeof r[j] === "number" ? "num" : undefined}>{r[j] === null || r[j] === undefined ? "" : typeof r[j] === "number" ? fmt(r[j] as number) : String(r[j])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "list":
      return (
        <ul className="widget-list">
          {data.items.map((it, i) => (
            <li key={i}>
              {it.url && it.url.startsWith("https://") ? <a href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a> : <strong>{it.title}</strong>}
              {!compact && it.detail && <span className="widget-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      );
    case "text":
      return <div className="widget-text"><ChatText text={data.text} /></div>;
    case "slicer":
      return null;
  }
}

export function WidgetFrame({ title, theme, size, children, head, foot, state }: { title: string; theme: WidgetTheme; size: WidgetSize; children: React.ReactNode; head?: React.ReactNode; foot?: React.ReactNode; state?: "stale" }) {
  const colors = THEME_COLORS[theme] ?? THEME_COLORS.blue;
  return (
    <div className={`widget-card size-${size}${state ? ` ${state}` : ""}`} style={{ borderTopColor: colors.accent }}>
      <div className="widget-head">
        <span className="widget-title">{title}</span>
        {head}
      </div>
      <div className="widget-body">{children}</div>
      {foot && <div className="widget-foot">{foot}</div>}
    </div>
  );
}
