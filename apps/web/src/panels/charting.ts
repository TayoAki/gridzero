// Chart rendering with ECharts (BUILD-SPEC D6), loaded on demand by ObjectLayer.
// Only the chart types and components we draw are registered, to keep it small.

import { BarChart, BoxplotChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, RadarChart, SankeyChart, ScatterChart, SunburstChart, TreemapChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, RadarComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import type { ChartData, ChartSpec } from "../sheet-socket";

// The second line is what the Prism chart builder draws for widgets.
echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);
echarts.use([BoxplotChart, FunnelChart, GaugeChart, HeatmapChart, RadarChart, SankeyChart, SunburstChart, TreemapChart, DataZoomComponent, RadarComponent, TitleComponent, VisualMapComponent]);

export function init(el: HTMLElement): echarts.EChartsType {
  return echarts.init(el, undefined, { renderer: "canvas" });
}

const PALETTE = ["#1a73e8", "#e8710a", "#188038", "#d93025", "#9334e6", "#12b5cb", "#f9ab00", "#5f6368"];

export function chartOption(spec: ChartSpec, data: ChartData): echarts.EChartsCoreOption {
  const base = { animation: false, color: PALETTE, tooltip: { trigger: spec.kind === "Pie" ? "item" : "axis" }, grid: { left: 48, right: 24, top: data.series.length > 1 ? 36 : 16, bottom: 28, containLabel: true } } as const;
  const legend = data.series.length > 1 || spec.kind === "Pie" ? { legend: { top: 0, type: "scroll" as const } } : {};
  if (spec.kind === "Pie") {
    const s = data.series[0];
    return {
      ...base,
      ...legend,
      series: [{ type: "pie", radius: ["0%", "70%"], data: (s?.values ?? []).map((v, i) => ({ name: data.x[i] ?? String(i + 1), value: v ?? 0 })) }],
    };
  }
  const horizontal = spec.kind === "Bar";
  const dual = data.series.some((s) => s.axis === "Right");
  const numericX = spec.kind === "Scatter" && data.x.every((x) => x !== "" && !Number.isNaN(Number(x)));
  const category = { type: numericX ? "value" : "category", data: numericX ? undefined : data.x, axisLabel: { hideOverlap: true } } as const;
  const value = (right: boolean) => ({ type: "value" as const, position: right ? ("right" as const) : ("left" as const), scale: spec.kind === "Scatter" });
  return {
    ...base,
    ...legend,
    xAxis: horizontal ? value(false) : category,
    yAxis: horizontal ? category : dual ? [value(false), value(true)] : value(false),
    series: data.series.map((s) => {
      const kind = s.kind;
      const type = kind === "Line" || kind === "Area" ? "line" : kind === "Scatter" ? "scatter" : "bar";
      const values = numericX ? s.values.map((v, i) => [Number(data.x[i]), v]) : s.values;
      return {
        name: s.name,
        type,
        data: values,
        yAxisIndex: !horizontal && dual && s.axis === "Right" ? 1 : 0,
        stack: spec.stacked && type !== "scatter" ? "total" : undefined,
        areaStyle: kind === "Area" ? {} : undefined,
        showSymbol: type === "line" ? s.values.length < 200 : undefined,
        barCategoryGap: spec.kind === "Histogram" ? "2%" : undefined,
        symbolSize: type === "scatter" ? 6 : undefined,
      };
    }),
  } as echarts.EChartsCoreOption;
}
