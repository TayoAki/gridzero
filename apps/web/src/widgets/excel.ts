// Download cards as an Excel workbook: one sheet per card. The writer is loaded only when asked for.

export interface Sheet {
  name: string;
  columns: string[];
  rows: (string | number | null | undefined)[][];
}

/** Excel sheet names: 31 characters at most, none of []:*?/\ and no two the same. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const base = n.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28) || "Sheet";
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export async function downloadExcel(fileName: string, sheets: Sheet[]) {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  const names = sheetNames(sheets.map((s) => s.name));
  const book = sheets.map((s, i) => ({
    sheet: names[i]!,
    stickyRowsCount: 1,
    columns: s.columns.map((c, j) => ({ width: Math.min(40, Math.max(10, c.length + 2, ...s.rows.slice(0, 50).map((r) => String(r[j] ?? "").length + 1))) })),
    data: [
      s.columns.map((c) => ({ value: c, fontWeight: "bold" as const })),
      ...s.rows.map((r) => s.columns.map((_, j) => (r[j] === null || r[j] === undefined ? null : typeof r[j] === "number" ? { value: r[j] as number, type: Number } : { value: String(r[j]), type: String }))),
    ],
  }));
  const safe = fileName.replace(/[\\/:*?"<>|]/g, " ").trim() || "Report";
  await writeExcelFile(book).toFile(`${safe}.xlsx`);
}
