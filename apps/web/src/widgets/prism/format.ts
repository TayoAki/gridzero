// Number formatting from Prism BI.

export function fmtCompact(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return v == null ? '—' : String(v)
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K'
  if (a > 0 && a < 1) return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')
}

export function fmtFull(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return v == null ? '—' : String(v)
  const a = Math.abs(v)
  const digits = a >= 100 ? 0 : a >= 1 ? 2 : 4
  return v.toLocaleString(undefined, { maximumFractionDigits: digits })
}
