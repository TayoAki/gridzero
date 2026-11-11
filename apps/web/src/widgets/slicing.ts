// Slicers: which fields a report can be filtered by, and what each card shows once it is.
//
// A slicer filters what is already on the cards. It does not run the cards' queries again, so a
// card that holds one figure (a number or a gauge) stays as it is.

import type { Widget, WidgetData } from "./spec";

export interface SliceField {
  name: string;
  type: "text" | "number";
  /** Every value seen on the report, for a text field. */
  values: string[];
  /** Lowest and highest value seen, for a number field. */
  range: [number, number];
}

/** What someone has chosen on one slicer. Nothing chosen means everything shows. */
export interface Pick {
  values?: string[];
  range?: [number, number];
}
export type Picks = Record<string, Pick>;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What a series is split by, read from its title: "Revenue by source" is split by Source. */
export function splitBy(title: string): string | null {
  const m = /\bby\s+(.+?)\s*$/i.exec(title);
  if (!m) return null;
  const name = m[1]!.replace(/[.:]+$/, "");
  return name ? name[0]!.toUpperCase() + name.slice(1) : null;
}

const isNumberColumn = (rows: (string | number | null)[][], j: number) => rows.some((r) => typeof r[j] === "number") && rows.every((r) => r[j] === null || r[j] === undefined || typeof r[j] === "number");

/** Every field the report's cards could be sliced by: table columns, and what each series is split by. */
export function fieldsOf(widgets: Widget[]): SliceField[] {
  const found = new Map<string, { name: string; text: Set<string>; numbers: number[]; anyText: boolean }>();
  const entry = (name: string) => {
    const key = name.trim().toLowerCase();
    let e = found.get(key);
    if (!e) found.set(key, (e = { name: name.trim(), text: new Set(), numbers: [], anyText: false }));
    return e;
  };
  for (const w of widgets) {
    if (w.data.kind === "table") {
      const { columns, rows } = w.data;
      columns.forEach((c, j) => {
        if (!c.trim()) return;
        const e = entry(c);
        if (isNumberColumn(rows, j)) for (const r of rows) typeof r[j] === "number" && e.numbers.push(r[j] as number);
        else {
          e.anyText = true;
          for (const r of rows) r[j] !== null && r[j] !== undefined && e.text.add(String(r[j]));
        }
      });
    } else if (w.data.kind === "series") {
      const e = entry(splitBy(w.title) ?? w.title);
      e.anyText = true;
      for (const p of w.data.points) e.text.add(p.label);
    }
  }
  const out: SliceField[] = [];
  for (const e of found.values()) {
    if (e.anyText) {
      if (e.text.size >= 2) out.push({ name: e.name, type: "text", values: [...e.text], range: [0, 0] });
    } else if (e.numbers.length >= 2) {
      const lo = Math.min(...e.numbers);
      const hi = Math.max(...e.numbers);
      if (hi > lo) out.push({ name: e.name, type: "number", values: [], range: [lo, hi] });
    }
  }
  return out;
}

export const fieldNamed = (fields: SliceField[], name: string) => fields.find((f) => same(f.name, name));

const chosen = (p: Pick | undefined) => !!p && ((p.values?.length ?? 0) > 0 || !!p.range);

/** How many slicers have something chosen. */
export const activeCount = (widgets: Widget[], picks: Picks) => widgets.filter((w) => w.data.kind === "slicer" && chosen(picks[w.id])).length;

/**
 * A card's data with the report's slicers applied. `sliced` says whether any slicer touched it, so
 * the card can say it is showing part of its data.
 */
export function sliceData(w: Widget, widgets: Widget[], fields: SliceField[], picks: Picks): { data: WidgetData; sliced: boolean } {
  let data = w.data;
  let sliced = false;
  if (data.kind !== "table" && data.kind !== "series") return { data, sliced };
  for (const s of widgets) {
    if (s.data.kind !== "slicer") continue;
    const pick = picks[s.id];
    if (!chosen(pick)) continue;
    const field = fieldNamed(fields, s.data.field);
    if (!field) continue;
    if (data.kind === "table") {
      const j = data.columns.findIndex((c) => same(c, field.name));
      if (j < 0) continue;
      const keep = (v: string | number | null | undefined) =>
        pick!.range ? typeof v === "number" && v >= pick!.range[0] && v <= pick!.range[1] : v !== null && v !== undefined && pick!.values!.includes(String(v));
      data = { ...data, rows: data.rows.filter((r) => keep(r[j])) };
      sliced = true;
    } else if (field.type === "text" && pick!.values) {
      const named = same(splitBy(w.title) ?? w.title, field.name);
      // A series with another name still answers when most of its labels are this field's values.
      const known = new Set(field.values);
      const shared = data.points.filter((p) => known.has(p.label)).length;
      if (!named && shared * 2 < data.points.length) continue;
      data = { ...data, points: data.points.filter((p) => pick!.values!.includes(p.label)) };
      sliced = true;
    }
  }
  return { data, sliced };
}

/** Whether a card has nothing left to show after slicing. */
export const emptied = (data: WidgetData) => (data.kind === "table" && data.rows.length === 0) || (data.kind === "series" && data.points.length === 0);

/** A card's data as plain columns and rows, for the data view and for Excel. */
export function asRows(w: Pick_<Widget, "title">, data: WidgetData): { columns: string[]; rows: (string | number | null)[][] } {
  switch (data.kind) {
    case "table":
      return { columns: data.columns, rows: data.rows };
    case "series":
      return { columns: [splitBy(w.title) ?? "Label", "Value"], rows: data.points.map((p) => [p.label, p.value]) };
    case "number":
      return { columns: ["Figure", "Value", "Unit", "Change"], rows: [[data.label ?? w.title, data.value, data.unit, data.delta]] };
    case "list":
      return { columns: ["Item", "Detail", "Link"], rows: data.items.map((i) => [i.title, i.detail, i.url]) };
    case "text":
      return { columns: ["Text"], rows: [[data.text]] };
    case "slicer":
      return { columns: [], rows: [] };
  }
}
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

const key = (boardId: string) => `gz_slices_${boardId}`;

/** What was chosen on this report last time, on this device. */
export function loadPicks(boardId: string): Picks {
  try {
    const raw = JSON.parse(localStorage.getItem(key(boardId)) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Picks) : {};
  } catch {
    return {};
  }
}

export function savePicks(boardId: string, picks: Picks) {
  try {
    localStorage.setItem(key(boardId), JSON.stringify(picks));
  } catch {
    // Private windows may refuse storage; the choice then lasts for this visit only.
  }
}
