// The chart builder from Prism BI (the same author's browser BI tool), brought in as the way GridZero
// draws widget charts. It turns a query result (dimension keys, measure keys, rows) into an ECharts option
// for 20-odd chart types. Changed here: colours come from the caller's theme, and animation is off so a
// widget looks the same on every refresh. Funnel labels sit beside the steps and the heatmap runs from
// the page's surface to the theme colour, so both read on a light page.

import type { EChartsOption } from 'echarts'

import type { QueryResult, ResultRow } from './types'
import { fmtCompact, fmtFull } from './format'

export const PRISM_PALETTE = ['#818cf8', '#22d3ee', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#a3e635', '#fb923c', '#38bdf8', '#e879f9', '#facc15', '#2dd4bf', '#f87171', '#94a3b8']
/** The colours a chart is drawn in. GridZero passes its theme's; these are Prism's own dark defaults. */
export interface Ink { text: string; muted: string; grid: string; axis: string; surface: string; strong: string; palette?: string[] }
let PALETTE: string[] = PRISM_PALETTE
let TEXT = '#cbd5e1', MUTED = '#8391a7', GRID = '#1f2635', AXIS = '#334155', SURFACE = '#11141b', STRONG = '#f1f5f9'

type Pick = (p: any) => (string | null)[] | null
export interface BuiltChart {
  option: EChartsOption
  pick: Pick
}

const tooltipBase = () => ({
  backgroundColor: SURFACE,
  borderColor: AXIS,
  textStyle: { color: STRONG, fontSize: 12 },
  valueFormatter: (v: unknown) => fmtFull(v as number),
  confine: true,
})
const catAxis = (data: string[], extra: object = {}) => ({
  type: 'category' as const,
  data,
  axisLine: { lineStyle: { color: AXIS } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, hideOverlap: true, fontSize: 11, formatter: (v: string) => (v.length > 18 ? v.slice(0, 17) + '…' : v) },
  ...extra,
})
const valAxis = (extra: object = {}) => ({
  type: 'value' as const,
  axisLabel: { color: MUTED, fontSize: 11, formatter: (v: number) => fmtCompact(v) },
  splitLine: { lineStyle: { color: GRID } },
  axisLine: { show: false },
  ...extra,
})
const legend = (show: boolean, extra: object = {}) => ({ show, type: 'scroll' as const, top: 0, textStyle: { color: TEXT, fontSize: 11 }, pageTextStyle: { color: MUTED }, pageIconColor: TEXT, icon: 'roundRect', itemWidth: 10, itemHeight: 10, ...extra })

const s = (v: unknown) => String(v ?? '')
const n = (v: unknown) => (typeof v === 'number' ? v : null)

function uniq(rows: ResultRow[], key: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) { const k = s(r[key]); if (!seen.has(k)) { seen.add(k); out.push(k) } }
  return out
}
function pivot(rows: ResultRow[], d0: string, d1: string, m: string) {
  const cats = uniq(rows, d0)
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(s(r[d1]), (totals.get(s(r[d1])) ?? 0) + (n(r[m]) ?? 0))
  let series = uniq(rows, d1)
  if (series.length > 12 && !/^\d{4}/.test(series[0] ?? '')) series = [...series].sort((a, b) => totals.get(b)! - totals.get(a)!)
  const cell = new Map<string, number | null>()
  for (const r of rows) cell.set(s(r[d0]) + '\u0001' + s(r[d1]), n(r[m]))
  const get = (c: string, sr: string) => cell.get(c + '\u0001' + sr) ?? null
  return { cats, series, get }
}

function niceCeil(v: number) {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x * mag >= v) ?? 10) * mag
}

export function buildChart(res: QueryResult, compact = false, ink?: Ink): BuiltChart | null {
  if (ink) { TEXT = ink.text; MUTED = ink.muted; GRID = ink.grid; AXIS = ink.axis; SURFACE = ink.surface; STRONG = ink.strong; PALETTE = ink.palette ?? PRISM_PALETTE }
  const { dimKeys, measureKeys, rows, chart } = res
  const d0 = dimKeys[0], d1 = dimKeys[1], m0 = measureKeys[0], m1 = measureKeys[1], m2 = measureKeys[2]
  const base: EChartsOption = {
    color: PALETTE,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    animation: false,
    tooltip: { ...tooltipBase() },
  }
  const grid = (hasLegend: boolean, extra: object = {}) => ({ left: 8, right: 18, top: hasLegend ? 34 : 14, bottom: 6, containLabel: true, ...extra })
  const catPick: Pick = (p) => (d1 ? [s(p.name), p.seriesName && p.seriesType !== 'pie' ? s(p.seriesName) : null] : [s(p.name)])

  switch (chart) {
    case 'kpi':
    case 'table':
    case 'pivot':
      return null

    case 'bar': case 'hbar': case 'stacked': case 'stacked100': case 'line': case 'area': case 'stackedArea': case 'histogram': {
      const isLine = chart === 'line' || chart === 'area' || chart === 'stackedArea'
      const stacked = chart === 'stacked' || chart === 'stacked100' || chart === 'stackedArea'
      let cats: string[]
      let series: { name: string; data: (number | null)[] }[]
      if (!d0) {
        cats = ['Total']
        series = measureKeys.map((m) => ({ name: m, data: [n(rows[0]?.[m])] }))
      } else if (d1) {
        const p = pivot(rows, d0, d1, m0)
        cats = p.cats
        series = p.series.slice(0, 24).map((sr) => ({ name: sr, data: cats.map((c) => p.get(c, sr)) }))
      } else {
        cats = rows.map((r) => s(r[d0]))
        series = measureKeys.map((m) => ({ name: m, data: rows.map((r) => n(r[m])) }))
      }
      if (chart === 'stacked100') {
        const totals = cats.map((_, i) => series.reduce((acc, sr) => acc + Math.abs(sr.data[i] ?? 0), 0))
        series = series.map((sr) => ({ ...sr, data: sr.data.map((v, i) => (v == null || !totals[i] ? null : (Math.abs(v) / totals[i]) * 100)) }))
      }
      const horizontal = chart === 'hbar'
      const single = series.length === 1
      const showLabels = !isLine && single && cats.length <= (horizontal ? 25 : 14) && chart !== 'histogram'
      const many = cats.length > 50
      const option: EChartsOption = {
        ...base,
        legend: legend(series.length > 1),
        grid: grid(series.length > 1, many && isLine && !compact ? { bottom: 36 } : {}),
        tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: isLine ? 'line' : 'shadow' }, ...(chart === 'stacked100' ? { valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(1) + '%' : '—') } : {}) },
        xAxis: horizontal ? valAxis() : catAxis(cats, { boundaryGap: !isLine }),
        yAxis: horizontal ? catAxis(cats, { inverse: true }) : valAxis(chart === 'stacked100' ? { max: 100, axisLabel: { color: MUTED, formatter: '{value}%' } } : {}),
        dataZoom: many && isLine && !compact ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 6, borderColor: GRID, textStyle: { color: MUTED }, fillerColor: 'rgba(129,140,248,0.15)' }] : undefined,
        series: series.map((sr, i) => ({
          name: sr.name,
          type: isLine ? 'line' : 'bar',
          data: sr.data,
          stack: stacked ? 'total' : undefined,
          smooth: isLine ? 0.3 : undefined,
          showSymbol: isLine && cats.length <= 36,
          symbolSize: 6,
          lineStyle: isLine ? { width: 2.4 } : undefined,
          areaStyle: chart === 'area' ? { opacity: 0.18 } : chart === 'stackedArea' ? { opacity: 0.55 } : undefined,
          barMaxWidth: 48,
          barCategoryGap: chart === 'histogram' ? '4%' : undefined,
          itemStyle: !isLine ? { borderRadius: stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0], color: single && !stacked ? { type: 'linear', x: 0, y: 0, x2: horizontal ? 1 : 0, y2: horizontal ? 0 : 1, colorStops: horizontal ? [{ offset: 0, color: PALETTE[i] + '99' }, { offset: 1, color: PALETTE[i] }] : [{ offset: 0, color: PALETTE[i] }, { offset: 1, color: PALETTE[i] + '88' }] } : undefined } : undefined,
          label: showLabels ? { show: true, position: horizontal ? 'right' : 'top', color: TEXT, fontSize: 10, formatter: (p: any) => fmtCompact(p.value) } : undefined,
          emphasis: { focus: 'series' },
        })) as any,
      }
      return { option, pick: chart === 'histogram' ? () => null : catPick }
    }

    case 'combo': {
      const cats = rows.map((r) => s(r[d0]))
      const option: EChartsOption = {
        ...base,
        legend: legend(true),
        grid: grid(true),
        tooltip: { ...tooltipBase(), trigger: 'axis' },
        xAxis: catAxis(cats),
        yAxis: [valAxis(), valAxis({ splitLine: { show: false } })],
        series: [
          { name: m0, type: 'bar', data: rows.map((r) => n(r[m0])), itemStyle: { borderRadius: [4, 4, 0, 0] }, barMaxWidth: 40 },
          ...(m1 ? [{ name: m1, type: 'line' as const, yAxisIndex: 1, smooth: 0.3, data: rows.map((r) => n(r[m1])), lineStyle: { width: 2.5 }, symbolSize: 6 }] : []),
        ],
      }
      return { option, pick: (p) => [s(p.name)] }
    }

    case 'pie': case 'donut': {
      const key = d0
      let data = rows.map((r) => ({ name: key ? s(r[key]) : m0, value: n(r[m0]) ?? 0 })).filter((x) => x.value > 0)
      data.sort((a, b) => b.value - a.value)
      if (data.length > 10) {
        const other = data.slice(9).reduce((acc, x) => acc + x.value, 0)
        data = [...data.slice(0, 9), { name: 'Other', value: other }]
      }
      const total = data.reduce((acc, x) => acc + x.value, 0)
      const donut = chart === 'donut'
      const option: EChartsOption = {
        ...base,
        tooltip: { ...tooltipBase(), trigger: 'item', formatter: (p: any) => `${p.marker}${p.name}<br/><b>${fmtFull(p.value)}</b> (${p.percent}%)` },
        legend: legend(!compact, { top: undefined, bottom: 0 }),
        title: donut ? { text: fmtCompact(total), subtext: m0, left: 'center', top: compact ? '40%' : '38%', textStyle: { color: STRONG, fontSize: compact ? 18 : 24, fontWeight: 700 }, subtextStyle: { color: MUTED, fontSize: 11 } } : undefined,
        series: [{
          type: 'pie',
          radius: donut ? ['48%', '72%'] : [0, '72%'],
          center: ['50%', compact ? '50%' : '46%'],
          data,
          padAngle: donut ? 2 : 0,
          itemStyle: { borderRadius: donut ? 6 : 3, borderColor: SURFACE, borderWidth: 2 },
          label: { show: !compact || data.length <= 6, color: TEXT, fontSize: 11, formatter: '{b}\n{d}%' },
          labelLine: { lineStyle: { color: AXIS } },
        }],
      }
      return { option, pick: (p) => (p.name === 'Other' ? null : [s(p.name)]) }
    }

    case 'scatter': case 'bubble': {
      if (!m1) return buildChart({ ...res, chart: 'bar' }, compact)
      const groups = d1 ? uniq(rows, d1) : [m0]
      const sizes = m2 ? rows.map((r) => n(r[m2]) ?? 0) : []
      const maxSize = Math.max(1, ...sizes)
      const labels = rows.length <= 30
      const option: EChartsOption = {
        ...base,
        legend: legend(!!d1),
        grid: grid(!!d1, { left: 16, bottom: 22 }),
        tooltip: { ...tooltipBase(), trigger: 'item', formatter: (p: any) => `<b>${p.data.name}</b><br/>${m0}: ${fmtFull(p.data.value[0])}<br/>${m1}: ${fmtFull(p.data.value[1])}${m2 ? `<br/>${m2}: ${fmtFull(p.data.value[2])}` : ''}` },
        xAxis: valAxis({ name: m0, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: MUTED }, scale: true }),
        yAxis: valAxis({ name: m1, nameTextStyle: { color: MUTED, align: 'left' }, scale: true }),
        series: groups.map((g) => ({
          name: g,
          type: 'scatter',
          data: rows.filter((r) => !d1 || s(r[d1]) === g).map((r) => ({ name: d0 ? s(r[d0]) : '', value: [n(r[m0]), n(r[m1]), m2 ? n(r[m2]) : 0] })),
          symbolSize: (v: number[]) => (chart === 'bubble' && m2 ? 8 + Math.sqrt(Math.max(0, v[2]) / maxSize) * 46 : 12),
          itemStyle: { opacity: 0.8, borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1 },
          label: labels ? { show: true, position: 'top', color: MUTED, fontSize: 10, formatter: (p: any) => p.data.name } : undefined,
          emphasis: { focus: 'series', label: { show: true, color: TEXT, formatter: (p: any) => p.data.name } },
        })) as any,
      }
      return { option, pick: (p) => [s(p.data?.name), d1 ? s(p.seriesName) : null] }
    }

    case 'heatmap': {
      if (!d1) return buildChart({ ...res, chart: 'bar' }, compact)
      const p = pivot(rows, d0, d1, m0)
      const ys = p.series.slice(0, 40)
      const data: [number, number, number | null][] = []
      let min = Infinity, max = -Infinity
      p.cats.forEach((c, i) => ys.forEach((y, j) => { const v = p.get(c, y); if (v != null) { min = Math.min(min, v); max = Math.max(max, v) } data.push([i, j, v]) }))
      const option: EChartsOption = {
        ...base,
        tooltip: { ...tooltipBase(), trigger: 'item', formatter: (x: any) => `${p.cats[x.data[0]]} · ${ys[x.data[1]]}<br/><b>${fmtFull(x.data[2])}</b>` },
        grid: grid(false, { right: compact ? 10 : 70 }),
        xAxis: catAxis(p.cats, { splitArea: { show: false } }),
        yAxis: catAxis(ys),
        visualMap: { min: isFinite(min) ? min : 0, max: isFinite(max) ? max : 1, calculable: true, orient: 'vertical', right: 0, top: 'middle', show: !compact, itemHeight: 120, textStyle: { color: MUTED }, formatter: (v: any) => fmtCompact(v), inRange: { color: [GRID, PALETTE[0]!] } },
        series: [{ type: 'heatmap', data, label: { show: p.cats.length * ys.length <= 80, color: STRONG, fontSize: 10, fontWeight: 600, formatter: (x: any) => fmtCompact(x.data[2]) }, itemStyle: { borderColor: SURFACE, borderWidth: 2, borderRadius: 3 } }],
      }
      return { option, pick: (x) => [p.cats[x.data[0]], ys[x.data[1]]] }
    }

    case 'treemap': case 'sunburst': {
      let data: any[]
      if (d1) {
        const map = new Map<string, any>()
        for (const r of rows) {
          const k = s(r[d0])
          if (!map.has(k)) map.set(k, { name: k, value: 0, children: [] })
          const v = Math.max(0, n(r[m0]) ?? 0)
          map.get(k).value += v
          map.get(k).children.push({ name: s(r[d1]), value: v })
        }
        data = [...map.values()]
      } else data = rows.map((r) => ({ name: d0 ? s(r[d0]) : m0, value: Math.max(0, n(r[m0]) ?? 0) }))
      const option: EChartsOption = chart === 'treemap'
        ? {
            ...base,
            tooltip: { ...tooltipBase(), formatter: (p: any) => `${p.treePathInfo?.slice(1).map((t: any) => t.name).join(' › ')}<br/><b>${fmtFull(p.value)}</b>` },
            series: [{
              type: 'treemap', data, roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
              label: { show: true, formatter: (p: any) => `{n|${p.name}}\n{v|${fmtCompact(p.value)}}`, rich: { n: { fontSize: 12, color: '#fff', fontWeight: 600, lineHeight: 18 }, v: { fontSize: 11, color: 'rgba(255,255,255,0.8)', lineHeight: 16 } } },
              upperLabel: d1 ? { show: true, height: 22, color: '#fff', fontWeight: 600 } : undefined,
              itemStyle: { borderColor: SURFACE, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
              levels: d1 ? [{ itemStyle: { borderWidth: 3, gapWidth: 3, borderColor: SURFACE } }, { colorSaturation: [0.35, 0.6], itemStyle: { gapWidth: 1, borderColorSaturation: 0.6 } }] : undefined,
            }] as any,
          }
        : {
            ...base,
            tooltip: { ...tooltipBase(), formatter: (p: any) => `${p.treePathInfo?.slice(1).map((t: any) => t.name).join(' › ')}<br/><b>${fmtFull(p.value)}</b>` },
            series: [{ type: 'sunburst', data, radius: [compact ? '12%' : '15%', '92%'], nodeClick: false, itemStyle: { borderColor: SURFACE, borderWidth: 2, borderRadius: 4 }, label: { color: '#fff', fontSize: 10, minAngle: 8, rotate: 'radial' }, levels: [{}, { label: { rotate: 'tangential' } }, { label: { align: 'right' } }] }] as any,
          }
      return { option, pick: (p) => { const path = (p.treePathInfo ?? []).slice(1).map((t: any) => s(t.name)); return path.length ? [path[0], path[1] ?? null] : null } }
    }

    case 'funnel': {
      const data = rows.map((r) => ({ name: d0 ? s(r[d0]) : m0, value: n(r[m0]) ?? 0 })).sort((a, b) => b.value - a.value).slice(0, 12)
      const option: EChartsOption = {
        ...base,
        tooltip: { ...tooltipBase(), trigger: 'item' },
        series: [{ type: 'funnel', data, left: '6%', right: '34%', top: 10, bottom: 10, gap: 3, sort: 'descending', label: { show: true, position: 'right', color: TEXT, formatter: (p: any) => `${p.name}  ${fmtCompact(p.value)}` }, itemStyle: { borderWidth: 0, borderRadius: 4 } as any }],
      }
      return { option, pick: (p) => [s(p.name)] }
    }

    case 'radar': {
      if (!d0) return buildChart({ ...res, chart: 'kpi' }, compact)
      let cats: string[]
      let series: { name: string; data: number[] }[]
      if (d1) {
        const p = pivot(rows, d0, d1, m0)
        cats = p.cats.slice(0, 16)
        series = p.series.slice(0, 8).map((sr) => ({ name: sr, data: cats.map((c) => p.get(c, sr) ?? 0) }))
      } else {
        cats = rows.slice(0, 16).map((r) => s(r[d0]))
        series = measureKeys.map((m) => ({ name: m, data: rows.slice(0, 16).map((r) => n(r[m]) ?? 0) }))
      }
      const max = cats.map((_, i) => niceCeil(Math.max(...series.map((sr) => sr.data[i])) * 1.05))
      const option: EChartsOption = {
        ...base,
        legend: legend(series.length > 1),
        tooltip: { ...tooltipBase(), trigger: 'item' },
        radar: { indicator: cats.map((c, i) => ({ name: c, max: series.length > 1 && !d1 ? max[i] : Math.max(...max) })), radius: compact ? '62%' : '68%', center: ['50%', '55%'], axisName: { color: MUTED, fontSize: 11 }, splitLine: { lineStyle: { color: GRID } }, splitArea: { areaStyle: { color: ['rgba(255,255,255,0.01)', 'rgba(255,255,255,0.03)'] } }, axisLine: { lineStyle: { color: GRID } } },
        series: [{ type: 'radar', data: series.map((sr) => ({ name: sr.name, value: sr.data, areaStyle: { opacity: 0.18 } })), symbolSize: 4, lineStyle: { width: 2 } }],
      }
      return { option, pick: () => null }
    }

    case 'gauge': {
      const v = n(rows[0]?.[m0]) ?? 0
      const max = niceCeil(Math.abs(v) * 1.3)
      const option: EChartsOption = {
        ...base,
        series: [{
          type: 'gauge', min: 0, max, startAngle: 210, endAngle: -30, radius: '92%', center: ['50%', '58%'],
          progress: { show: true, width: compact ? 12 : 18, roundCap: true, itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#818cf8' }, { offset: 1, color: '#22d3ee' }] } } },
          axisLine: { lineStyle: { width: compact ? 12 : 18, color: [[1, GRID]] }, roundCap: true },
          axisTick: { show: false }, splitLine: { show: false }, pointer: { show: false },
          axisLabel: { show: !compact, color: MUTED, distance: 24, formatter: (x: number) => (x === 0 || x === max ? fmtCompact(x) : '') },
          title: { show: true, offsetCenter: [0, '32%'], color: MUTED, fontSize: 12 },
          detail: { valueAnimation: true, offsetCenter: [0, '-2%'], fontSize: compact ? 22 : 32, fontWeight: 700, color: STRONG, formatter: (x: number) => fmtCompact(x) },
          data: [{ value: v, name: m0 }],
        }],
      }
      return { option, pick: () => null }
    }

    case 'boxplot': {
      const cats = rows.map((r) => s(r[d0]))
      const option: EChartsOption = {
        ...base,
        grid: grid(false),
        tooltip: { ...tooltipBase(), trigger: 'item', formatter: (p: any) => { const [, a, b, c, d, e] = p.data; return `<b>${p.name}</b><br/>Max: ${fmtFull(e)}<br/>Q3: ${fmtFull(d)}<br/>Median: ${fmtFull(c)}<br/>Q1: ${fmtFull(b)}<br/>Min: ${fmtFull(a)}` } },
        xAxis: catAxis(cats),
        yAxis: valAxis({ name: m0, nameTextStyle: { color: MUTED, align: 'left' } }),
        series: [{ type: 'boxplot', data: rows.map((r) => r[m0] as number[]), itemStyle: { color: 'rgba(129,140,248,0.25)', borderColor: '#818cf8', borderWidth: 1.5 } }],
      }
      return { option, pick: (p) => [s(p.name)] }
    }

    case 'sankey': {
      if (!d1) return buildChart({ ...res, chart: 'bar' }, compact)
      const left = new Set(rows.map((r) => s(r[d0])))
      const rightName = (v: string) => (left.has(v) ? v + ' ' : v)
      const nodes = [...left, ...new Set(rows.map((r) => rightName(s(r[d1]))))].map((name) => ({ name }))
      const links = rows.filter((r) => (n(r[m0]) ?? 0) > 0).map((r) => ({ source: s(r[d0]), target: rightName(s(r[d1])), value: n(r[m0]) }))
      const option: EChartsOption = {
        ...base,
        tooltip: { ...tooltipBase(), trigger: 'item' },
        series: [{ type: 'sankey', data: nodes, links, left: 8, right: compact ? 90 : 120, top: 8, bottom: 8, nodeGap: 10, emphasis: { focus: 'adjacency' }, lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.35 }, label: { color: TEXT, fontSize: 11 }, itemStyle: { borderWidth: 0 } }] as any,
      }
      return { option, pick: (p) => (p.dataType === 'node' ? null : [s(p.data?.source), s(p.data?.target).trim()]) }
    }

    case 'waterfall': {
      const cats = [...rows.map((r) => s(r[d0])), 'Total']
      const vals = rows.map((r) => n(r[m0]) ?? 0)
      let run = 0
      const baseData: (number | string)[] = [], up: (number | string)[] = [], down: (number | string)[] = []
      for (const v of vals) {
        const start = run
        run += v
        baseData.push(Math.min(start, run)); up.push(v >= 0 ? v : '-'); down.push(v < 0 ? -v : '-')
      }
      baseData.push(0); up.push('-'); down.push('-')
      const total = cats.map((_, i) => (i === cats.length - 1 ? run : '-'))
      const option: EChartsOption = {
        ...base,
        legend: legend(false),
        grid: grid(false),
        tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: any) => { const i = ps[0].dataIndex; return `<b>${cats[i]}</b><br/>${fmtFull(i === cats.length - 1 ? run : vals[i])}` } },
        xAxis: catAxis(cats),
        yAxis: valAxis(),
        series: [
          { type: 'bar', stack: 'w', data: baseData, itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, silent: true },
          { type: 'bar', stack: 'w', name: 'Increase', data: up, itemStyle: { color: '#34d399', borderRadius: 3 } },
          { type: 'bar', stack: 'w', name: 'Decrease', data: down, itemStyle: { color: '#f87171', borderRadius: 3 } },
          { type: 'bar', stack: 'w', name: 'Total', data: total, itemStyle: { color: '#818cf8', borderRadius: 3 } },
        ] as any,
      }
      return { option, pick: (p) => (p.name === 'Total' ? null : [s(p.name)]) }
    }
  }
  return null
}

export const CHART_TYPES: { type: string; label: string; needs?: string }[] = [
  { type: 'auto', label: 'Auto' },
  { type: 'bar', label: 'Bar' },
  { type: 'hbar', label: 'Horizontal bar' },
  { type: 'stacked', label: 'Stacked bar', needs: '2 dimensions' },
  { type: 'stacked100', label: '100% stacked', needs: '2 dimensions' },
  { type: 'line', label: 'Line' },
  { type: 'area', label: 'Area' },
  { type: 'stackedArea', label: 'Stacked area', needs: '2 dimensions' },
  { type: 'combo', label: 'Bar + line', needs: '2 measures' },
  { type: 'pie', label: 'Pie' },
  { type: 'donut', label: 'Donut' },
  { type: 'scatter', label: 'Scatter', needs: '2 measures' },
  { type: 'bubble', label: 'Bubble', needs: '3 measures' },
  { type: 'heatmap', label: 'Heatmap', needs: '2 dimensions' },
  { type: 'treemap', label: 'Treemap' },
  { type: 'sunburst', label: 'Sunburst' },
  { type: 'funnel', label: 'Funnel' },
  { type: 'radar', label: 'Radar' },
  { type: 'gauge', label: 'Gauge' },
  { type: 'kpi', label: 'KPI card' },
  { type: 'table', label: 'Table' },
  { type: 'pivot', label: 'Pivot table', needs: '2 dimensions' },
  { type: 'histogram', label: 'Histogram', needs: '1 measure' },
  { type: 'boxplot', label: 'Box plot' },
  { type: 'sankey', label: 'Sankey', needs: '2 dimensions' },
  { type: 'waterfall', label: 'Waterfall' },
]
