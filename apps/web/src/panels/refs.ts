// A1 references with optional sheet names ("Sales!B2:B20", "'Q1 data'!A1"), as typed in
// the chart and validation dialogs.

import { columnName, parseRef } from "../grid/grid";
import type { Range, SheetInfo } from "../sheet-socket";

export function formatRange(r: Range | null, sheets: SheetInfo[], current: number): string {
  if (!r) return "#REF!";
  const cells = `${columnName(r.c0)}${r.r0 + 1}` + (r.r0 === r.r1 && r.c0 === r.c1 ? "" : `:${columnName(r.c1)}${r.r1 + 1}`);
  if (r.sheet === current) return cells;
  const name = sheets[r.sheet]?.name ?? `Sheet${r.sheet + 1}`;
  return `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`}!${cells}`;
}

/** Parse "A1:B2" or "Sheet!A1:B2"; null when it is not a reference to a known sheet. */
export function parseRange(text: string, sheets: SheetInfo[], current: number): Range | null {
  const t = text.trim().replace(/^=/, "");
  if (!t) return null;
  const bang = t.lastIndexOf("!");
  let sheet = current;
  if (bang >= 0) {
    const name = t.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
    sheet = sheets.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (sheet < 0) return null;
  }
  const r = parseRef(t.slice(bang + 1));
  return r ? { sheet, ...r } : null;
}
