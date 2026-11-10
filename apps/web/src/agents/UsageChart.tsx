// Agent spend by day (agent spec §11.3).

import { useEffect, useRef } from "react";

const charting = () => import("../panels/charting");

export function UsageChart({ days }: { days: { date: string; costUsd: number }[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let chart: { setOption: (o: unknown) => void; resize: () => void; dispose: () => void } | null = null;
    const observer = new ResizeObserver(() => chart?.resize());
    charting().then((c) => {
      if (disposed || !el.current) return;
      chart = c.init(el.current);
      chart.setOption({
        animation: false,
        color: ["#1a73e8"],
        tooltip: { trigger: "axis", valueFormatter: (v: number) => `$${v.toFixed(4)}` },
        grid: { left: 8, right: 8, top: 12, bottom: 8, containLabel: true },
        xAxis: { type: "category", data: days.map((d) => d.date.slice(5)), axisTick: { show: false } },
        yAxis: { type: "value", axisLabel: { formatter: (v: number) => `$${v}` }, splitLine: { lineStyle: { color: "#eee" } } },
        series: [{ type: "bar", data: days.map((d) => d.costUsd), barMaxWidth: 28 }],
      });
      observer.observe(el.current);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      chart?.dispose();
    };
  }, [days]);
  return <div className="usage-chart" ref={el} role="img" aria-label="Cost by day" />;
}
