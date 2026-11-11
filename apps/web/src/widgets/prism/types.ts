// The part of Prism BI's types its chart builder needs.

export type ChartType =
  | 'auto' | 'bar' | 'hbar' | 'stacked' | 'stacked100' | 'line' | 'area' | 'stackedArea'
  | 'combo' | 'pie' | 'donut' | 'scatter' | 'bubble' | 'heatmap' | 'treemap' | 'sunburst'
  | 'funnel' | 'radar' | 'gauge' | 'kpi' | 'table' | 'pivot' | 'histogram' | 'boxplot'
  | 'sankey' | 'waterfall'

export type ResultRow = Record<string, string | number | null | number[]>
export interface QueryResult {
  dimKeys: string[]
  measureKeys: string[]
  rows: ResultRow[]
  rowCount: number
  chart: Exclude<ChartType, 'auto'>
}
