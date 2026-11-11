// Slicers: which fields a report can be filtered by, and what each card shows once it is.
//
// A slicer filters what is already on the cards. It does not run the cards' queries again, so a
// card that holds one figure (a number or a gauge) stays as it is.

import type { ReportFilter, Widget, WidgetData } from "./spec";

export interface SliceField {
  name: string;
  type: "text" | "number" | "date";
  /** Every value seen on the report, for a text field. */
  values: string[];
  /** Lowest and highest value seen, for a number field. */
  range: [number, number];
  /** First and last day, for a date field. */
  days?: [string, string];
}

/** What someone has chosen for one field. Nothing chosen means everything shows. */
export interface Pick {
  values?: string[];
  range?: [number, number];
  /** The card whose bar was clicked to choose this. That card keeps all its bars, so another can be clicked. */
  origin?: string;
}
/** Choices by field, keyed by the field's name in lower case. */
export type Picks = Record<string, Pick>;
export const keyOf = (field: string) => field.trim().toLowerCase();

export const PRESETS = ["all", "7d", "30d", "90d", "month", "last_month", "year", "custom"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_NAMES: Record<Preset, string> = { all: "All time", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", month: "This month", last_month: "Last month", year: "This year", custom: "Custom" };

/** The report's date range: which date field, and a named range or two chosen days. */
export interface Period {
  field: string;
  preset: Preset;
  from?: string;
  to?: string;
}

/** Everything chosen on a report's filters, kept on this device. */
export interface ReportState {
  picks: Picks;
  period: Period | null;
  compare: boolean;
}
export const NO_FILTERS: ReportState = { picks: {}, period: null, compare: false };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A period as first day and the day after the last, or null for all time. Days are UTC, like the data's. */
export function periodDays(p: Period | null, today = new Date()): { from: string; to: string } | null {
  if (!p || p.preset === "all") return null;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const at = (yy: number, mm: number, dd: number) => iso(new Date(Date.UTC(yy, mm, dd)));
  const tomorrow = at(y, m, today.getUTCDate() + 1);
  switch (p.preset) {
    case "7d":
    case "30d":
    case "90d":
      return { from: at(y, m, today.getUTCDate() + 1 - Number(p.preset.slice(0, -1))), to: tomorrow };
    case "month":
      return { from: at(y, m, 1), to: tomorrow };
    case "last_month":
      return { from: at(y, m - 1, 1), to: at(y, m, 1) };
    case "year":
      return { from: at(y, 0, 1), to: tomorrow };
    case "custom": {
      if (!p.from || !p.to || p.to < p.from) return null;
      // The second day is the last one included.
      const end = new Date(p.to + "T00:00:00Z");
      return { from: p.from, to: at(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1) };
    }
  }
}

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

export const chosen = (p: Pick | undefined) => !!p && ((p.values?.length ?? 0) > 0 || !!p.range);

/** How many fields have something chosen. */
export const activeCount = (picks: Picks) => Object.values(picks).filter(chosen).length;

/**
 * The filters to send for one card: every choice except the one made by clicking this card, plus the
 * report's date range.
 */
export function filtersFor(widgetId: string, fields: SliceField[], state: ReportState): ReportFilter[] {
  const out: ReportFilter[] = [];
  for (const [key, pick] of Object.entries(state.picks)) {
    if (!chosen(pick) || pick.origin === widgetId) continue;
    const field = fields.find((f) => keyOf(f.name) === key)?.name ?? key;
    out.push(pick.range ? { field, range: pick.range } : { field, values: pick.values! });
  }
  const days = periodDays(state.period);
  if (days && state.period) out.push({ field: state.period.field, ...days });
  return out;
}

/**
 * A card's data with the report's slicers applied. `sliced` says whether any slicer touched it, so
 * the card can say it is showing part of its data.
 */
export function sliceData(w: Widget, fields: SliceField[], picks: Picks): { data: WidgetData; sliced: boolean } {
  let data = w.data;
  let sliced = false;
  if (data.kind !== "table" && data.kind !== "series") return { data, sliced };
  for (const [key, pick] of Object.entries(picks)) {
    if (!chosen(pick) || pick.origin === w.id) continue;
    const field = fields.find((f) => keyOf(f.name) === key);
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

const key = (boardId: string) => `gz_filters_${boardId}`;

/** What was chosen on this report last time, on this device. */
export function loadState(boardId: string): ReportState {
  try {
    const raw = JSON.parse(localStorage.getItem(key(boardId)) ?? "null");
    if (!raw || typeof raw !== "object" || typeof raw.picks !== "object" || raw.picks === null) return NO_FILTERS;
    return { picks: raw.picks as Picks, period: raw.period && typeof raw.period.field === "string" && PRESETS.includes(raw.period.preset) ? (raw.period as Period) : null, compare: raw.compare === true };
  } catch {
    return NO_FILTERS;
  }
}

export function saveState(boardId: string, state: ReportState) {
  try {
    localStorage.setItem(key(boardId), JSON.stringify(state));
  } catch {
    // Private windows may refuse storage; the choice then lasts for this visit only.
  }
}
