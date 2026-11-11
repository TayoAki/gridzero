// Analytics drawn over a line or bar chart: a straight trend line, a forecast with its likely range, and
// flags on unusual points. From Prism BI (lib/analytics.ts), the same author's browser BI tool, with its
// query-engine helpers left out: the period is read from the labels instead. These are quick, exploratory
// calculations, not validated predictions; the report says so where it offers them.

import type { EChartsOption } from 'echarts'

export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year'
export interface Analytics { trend?: boolean; forecast?: number; anomalies?: boolean; clusters?: number }

/** The period a chart's labels step by, read from how they are written. Undefined when they are not dates. */
export function grainOf(labels: string[]): Grain | undefined {
  const first = labels[0]
  if (!first || !labels.every((l) => typeof l === 'string')) return undefined
  if (labels.every((l) => /^\d{4}-\d{2}$/.test(l))) return 'month'
  if (labels.every((l) => /^\d{4} Q\d$/.test(l))) return 'quarter'
  if (labels.every((l) => /^\d{4}$/.test(l))) return 'year'
  if (labels.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l))) {
    const gap = labels.length > 1 ? (Date.parse(labels[1]) - Date.parse(labels[0])) / 86400000 : 1
    return gap >= 6 ? 'week' : 'day'
  }
  return undefined
}

const SEASON: Partial<Record<Grain, number>> = { month: 12, quarter: 4, week: 52, day: 7 }

export function holtWinters(y: number[], h: number, season = 0): { fc: number[]; sigma: number } {
  const n = y.length
  if (n < 3) return { fc: Array(h).fill(y[n - 1] ?? 0), sigma: 0 }
  const useSeason = season > 1 && n >= season * 2
  const a = 0.4, b = 0.1, g = 0.3
  let level = y[0], trend = (y[Math.min(n - 1, useSeason ? season : 1)] - y[0]) / (useSeason ? season : 1)
  const s: number[] = []
  if (useSeason) {
    const mean = y.slice(0, season).reduce((x, v) => x + v, 0) / season
    for (let i = 0; i < season; i++) s.push(y[i] - mean)
    level = mean
  }
  let sse = 0
  for (let t = 0; t < n; t++) {
    const si = useSeason ? s[t % season] : 0
    const pred = level + trend + si
    if (t > 0) sse += (y[t] - pred) ** 2
    const prevLevel = level
    level = a * (y[t] - si) + (1 - a) * (level + trend)
    trend = b * (level - prevLevel) + (1 - b) * trend
    if (useSeason) s[t % season] = g * (y[t] - level) + (1 - g) * si
  }
  const fc = Array.from({ length: h }, (_, k) => level + (k + 1) * trend + (useSeason ? s[(n + k) % season] : 0))
  return { fc, sigma: Math.sqrt(sse / Math.max(1, n - 1)) }
}

export function linearFit(y: (number | null)[]): (number | null)[] {
  const pts = y.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (pts.length < 2) return y.map(() => null)
  const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0)
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0)
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), icpt = (sy - slope * sx) / n
  return y.map((_, i) => icpt + slope * i)
}

export function anomalies(y: (number | null)[], z = 2.5): boolean[] {
  const w = 3
  const resid = y.map((v, i) => {
    if (v == null) return null
    const win = y.slice(Math.max(0, i - w), i + w + 1).filter((x, j) => x != null && j !== Math.min(i, w)) as number[]
    return win.length ? v - win.reduce((a, b) => a + b, 0) / win.length : null
  })
  const vals = resid.filter((r): r is number => r != null)
  if (vals.length < 6) return y.map(() => false)
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1
  return resid.map((r) => r != null && Math.abs((r - mean) / sd) > z)
}

export function kmeans(pts: number[][], k: number): number[] {
  if (pts.length <= k) return pts.map((_, i) => i)
  const dims = pts[0].length
  const mins = Array.from({ length: dims }, (_, d) => Math.min(...pts.map((p) => p[d])))
  const maxs = Array.from({ length: dims }, (_, d) => Math.max(...pts.map((p) => p[d])))
  const norm = pts.map((p) => p.map((v, d) => (v - mins[d]) / (maxs[d] - mins[d] || 1)))
  const sorted = [...norm.keys()].sort((a, b) => norm[a][0] + norm[a][1] - norm[b][0] - norm[b][1])
  let cents = Array.from({ length: k }, (_, i) => norm[sorted[Math.floor(((i + 0.5) / k) * sorted.length)]])
  let assign = norm.map(() => 0)
  for (let it = 0; it < 30; it++) {
    const next = norm.map((p) => { let best = 0, bd = Infinity; cents.forEach((c, j) => { const d = c.reduce((a, v, i) => a + (v - p[i]) ** 2, 0); if (d < bd) { bd = d; best = j } }); return best })
    const changed = next.some((v, i) => v !== assign[i])
    assign = next
    cents = cents.map((c, j) => { const m = norm.filter((_, i) => assign[i] === j); return m.length ? c.map((_, d) => m.reduce((a, p) => a + p[d], 0) / m.length) : c })
    if (!changed) break
  }
  return assign
}

export function nextLabels(last: string, grain: Grain | undefined, h: number): string[] {
  const out: string[] = []
  let m: RegExpMatchArray | null
  for (let k = 1; k <= h; k++) {
    if ((m = last.match(/^(\d{4})-(\d{2})$/))) { const t = +m[1] * 12 + +m[2] - 1 + k; out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`) }
    else if ((m = last.match(/^(\d{4}) Q(\d)$/))) { const t = +m[1] * 4 + +m[2] - 1 + k; out.push(`${Math.floor(t / 4)} Q${(t % 4) + 1}`) }
    else if (/^\d{4}$/.test(last)) out.push(String(+last + k))
    else if (/^\d{4}-\d{2}-\d{2}$/.test(last)) out.push(new Date(Date.parse(last) + k * (grain === 'week' ? 7 : 1) * 86400000).toISOString().slice(0, 10))
    else out.push(`+${k}`)
  }
  return out
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function applyAnalytics(option: EChartsOption, an: Analytics | undefined, grain: Grain | undefined): EChartsOption {
  if (!an || !(an.trend || an.forecast || an.anomalies || an.clusters)) return option
  const o: any = { ...option }
  const series: any[] = Array.isArray(o.series) ? o.series.map((s: any) => ({ ...s })) : []
  if (an.clusters && series.length && series.every((s) => s.type === 'scatter')) {
    const items = series.flatMap((s) => s.data as any[])
    const k = Math.max(2, Math.min(8, an.clusters))
    const assign = kmeans(items.map((d) => [d.value[0] ?? 0, d.value[1] ?? 0]), k)
    o.series = Array.from({ length: k }, (_, j) => ({ ...series[0], name: `Cluster ${j + 1}`, data: items.filter((_, i) => assign[i] === j) }))
    o.legend = { ...(o.legend ?? {}), show: true }
    return o
  }
  const xAxis = Array.isArray(o.xAxis) ? o.xAxis[0] : o.xAxis
  if (!xAxis || xAxis.type !== 'category' || !Array.isArray(xAxis.data)) return option
  const base = series.filter((s) => (s.type === 'line' || s.type === 'bar') && !s.stack)
  if (!base.length) return option
  const cats: string[] = [...xAxis.data]
  const n = cats.length
  const extra: any[] = []
  const h = an.forecast && grain ? Math.max(1, Math.min(60, an.forecast)) : 0
  for (const s of base.slice(0, 3)) {
    const y: (number | null)[] = s.data.map((v: any) => (typeof v === 'number' ? v : v?.value ?? null))
    if (an.trend) extra.push({ name: `${s.name} trend`, type: 'line', data: linearFit(y), symbol: 'none', smooth: false, lineStyle: { type: 'dashed', width: 1.5 }, z: 3 })
    if (an.anomalies) {
      const flags = anomalies(y)
      extra.push({ name: `${s.name} anomalies`, type: 'scatter', data: y.map((v, i) => (flags[i] ? v : null)), symbolSize: 13, itemStyle: { color: '#f43f5e', borderColor: '#fff', borderWidth: 1.5 }, z: 5 })
    }
    if (h) {
      const clean = y.map((v) => v ?? 0)
      const { fc, sigma } = holtWinters(clean, h, SEASON[grain!] ?? 0)
      const pad = Array(n - 1).fill(null)
      extra.push({ name: `${s.name} forecast`, type: 'line', data: [...pad, clean[n - 1], ...fc], symbol: 'circle', symbolSize: 4, lineStyle: { type: 'dashed', width: 2.2 }, z: 4 })
      const lo = fc.map((v, k) => v - 1.28 * sigma * Math.sqrt(k + 1))
      const band = fc.map((v, k) => v + 1.28 * sigma * Math.sqrt(k + 1) - lo[k])
      extra.push({ name: `${s.name} 80% range`, type: 'line', stack: `band-${s.name}`, data: [...pad, null, ...lo], symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false } })
      extra.push({ name: `${s.name} 80% range`, type: 'line', stack: `band-${s.name}`, data: [...pad, null, ...band], symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.15 }, tooltip: { show: false } })
    }
  }
  if (h) {
    const fut = nextLabels(String(cats[n - 1]), grain, h)
    const ax = { ...xAxis, data: [...cats, ...fut] }
    o.xAxis = Array.isArray(o.xAxis) ? [ax, ...o.xAxis.slice(1)] : ax
    o.dataZoom = undefined
    for (const s of series) if (Array.isArray(s.data)) s.data = [...s.data, ...Array(h).fill(null)]
  }
  o.series = [...series, ...extra]
  o.legend = { ...(o.legend ?? {}), show: true, data: o.series.map((s: any) => s.name).filter((nm: string, i: number, a: string[]) => a.indexOf(nm) === i) }
  if (o.grid && !Array.isArray(o.grid)) o.grid = { ...o.grid, top: 34 }
  return o
}

