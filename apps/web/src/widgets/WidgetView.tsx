// Draws one widget's data in its form, theme and size (agent spec §8.2).

import { useEffect, useRef } from "react";

import { ChatText } from "../agents/AgentChatPage";
import { THEME_COLORS } from "./spec";
import type { WidgetData, WidgetForm, WidgetSize, WidgetTheme } from "./spec";

const charting = () => import("../panels/charting");

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function SeriesChart({ points, form, color, compact }: { points: { label: string; value: number }[]; form: "trend" | "bars"; color: string; compact: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let chart: { setOption: (o: unknown) => void; resize: () => void; dispose: () => void } | null = null;
    const observer = new ResizeObserver(() => chart?.resize());
    charting().then((c) => {
      if (disposed || !el.current) return;
      chart = c.init(el.current);
      // Axis colours follow the theme, so charts read in light and dark.
      const css = getComputedStyle(el.current);
      const line = css.getPropertyValue("--border").trim() || "#ddd";
      const muted = css.getPropertyValue("--muted").trim() || "#666";
      chart.setOption({
        animation: false,
        color: [color],
        tooltip: { trigger: "axis" },
        grid: { left: compact ? 4 : 8, right: 8, top: 8, bottom: compact ? 4 : 8, containLabel: !compact },
        xAxis: { type: "category", data: points.map((p) => p.label), axisLabel: { show: !compact, color: muted }, axisTick: { show: false }, axisLine: { lineStyle: { color: line } } },
        yAxis: { type: "value", splitNumber: 3, axisLabel: { show: !compact, color: muted }, splitLine: { lineStyle: { color: line } } },
        series: [form === "trend" ? { type: "line", data: points.map((p) => p.value), smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 } } : { type: "bar", data: points.map((p) => p.value) }],
      });
      observer.observe(el.current);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      chart?.dispose();
    };
  }, [points, form, color, compact]);
  return <div className="widget-chart" ref={el} />;
}

export function WidgetBody({ form, theme, size, data }: { form: WidgetForm; theme: WidgetTheme; size: WidgetSize; data: WidgetData }) {
  const colors = THEME_COLORS[theme] ?? THEME_COLORS.blue;
  const compact = size === "s";
  switch (data.kind) {
    case "number":
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
    case "series":
      return <SeriesChart points={data.points} form={form === "bars" ? "bars" : "trend"} color={colors.chart} compact={compact} />;
    case "table":
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
