// A report's filters and what each card shows under them.
//
// A live card (one that reads a workbook table, a definition on a workbook, or a metric model) is run
// again on the server with the filters applied to the rows underneath, so its totals follow. Any other
// card is filtered here, from the rows and bars already on it.

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../agents/catalog";
import { NO_FILTERS, chosen, decodeState, encodeState, fieldsOf, filtersFor, keyOf, loadState, saveState, sliceData, splitBy } from "./slicing";
import type { Period, Pick, ReportState, SliceField } from "./slicing";
import type { ReportFilter, Widget, WidgetData } from "./spec";

interface ServerField {
  name: string;
  kind: "text" | "number" | "date";
  values: string[] | null;
  min: string | number | null;
  max: string | number | null;
}
export interface CardInfo {
  live: boolean;
  /** The columns the card's query returns, when known. The first is what a chart is split by. */
  columns: string[] | null;
  /** The columns of the tables the card reads: the filters that can reach it. */
  fields: string[];
}
interface CardView {
  live: boolean;
  data: WidgetData | null;
  applied: string[];
  previous: WidgetData | null;
}

export interface Shown {
  /** Null when the filters leave this card nothing to show. */
  data: WidgetData | null;
  /** Waiting for the server to run the card again. */
  busy: boolean;
  /** "live": run again under the filters. "card": filtered from what was on it. "none": no filter reaches it. Null: no filters are on. */
  how: "live" | "card" | "none" | null;
  error: string | null;
}

const toField = (f: ServerField): SliceField | null => {
  if (f.kind === "text") return f.values && f.values.length >= 2 ? { name: f.name, type: "text", values: f.values, range: [0, 0] } : null;
  if (f.kind === "number") return typeof f.min === "number" && typeof f.max === "number" && f.max > f.min ? { name: f.name, type: "number", values: [], range: [f.min, f.max] } : null;
  return typeof f.min === "string" && typeof f.max === "string" ? { name: f.name, type: "date", values: [], range: [0, 0], days: [f.min.slice(0, 10), f.max.slice(0, 10)] } : null;
};

const MAX_AT_ONCE = 3;

/** Where to ask. The signed-in addresses by default; a view link passes its own. */
export interface ReportUrls {
  fields: string;
  view: (widgetId: string) => string;
}

export function useReport(boardId: string, widgets: Widget[] | null, urls?: ReportUrls) {
  const fieldsUrl = urls?.fields ?? `/api/v1/dashboards/${boardId}/fields`;
  const viewUrl = urls?.view ?? ((id: string) => `/api/v1/widgets/${id}/view`);
  // Filters in the link win over what this device remembers: a link someone sent opens as they saw it.
  const start = () => decodeState(window.location.search) ?? loadState(boardId);
  const [state, setStateRaw] = useState<ReportState>(start);
  useEffect(() => setStateRaw(start()), [boardId]);
  const setState = (next: ReportState) => {
    saveState(boardId, next);
    setStateRaw(next);
  };

  // What the server says the report can be filtered by. Asked again when a card is added, removed or refreshed.
  const [server, setServer] = useState<{ fields: ServerField[]; cards: Record<string, CardInfo> }>({ fields: [], cards: {} });
  const signature = (widgets ?? []).map((w) => `${w.id}:${w.refreshedAt}`).join(",");
  useEffect(() => {
    let live = true;
    if (!signature) return void setServer({ fields: [], cards: {} });
    api<{ fields: ServerField[]; cards: Record<string, CardInfo> }>("GET", fieldsUrl).then((r) => live && r.ok && setServer(r.data));
    return () => {
      live = false;
    };
  }, [fieldsUrl, signature]);

  const fields = useMemo(() => {
    const out = server.fields.flatMap((f) => toField(f) ?? []);
    // Cards the server cannot filter still offer what is on them.
    for (const f of fieldsOf((widgets ?? []).filter((w) => !server.cards[w.id]?.live))) if (!out.some((x) => keyOf(x.name) === keyOf(f.name))) out.push(f);
    return out;
  }, [server, widgets]);

  // Each live card's view under the current filters, fetched a few at a time.
  const cache = useRef(new Map<string, { key: string; view?: CardView; error?: string }>());
  const [, bump] = useState(0);
  const wanted = useMemo(() => {
    const out: { id: string; key: string; filters: ReportFilter[] }[] = [];
    for (const w of widgets ?? []) {
      if (!server.cards[w.id]?.live) continue;
      const filters = filtersFor(w.id, fields, state);
      if (filters.length) out.push({ id: w.id, key: JSON.stringify([filters, state.compare, w.refreshedAt]), filters });
    }
    return out;
  }, [widgets, server, fields, state]);
  useEffect(() => {
    let live = true;
    const todo = wanted.filter((x) => cache.current.get(x.id)?.key !== x.key);
    if (!todo.length) return;
    const next = async () => {
      for (let job = todo.shift(); job && live; job = todo.shift()) {
        const r = await api<CardView & { error?: string }>("POST", viewUrl(job.id), { filters: job.filters, compare: state.compare });
        if (!live) return;
        cache.current.set(job.id, r.ok ? { key: job.key, view: r.data } : { key: job.key, error: r.data?.error ?? "Could not apply the filters." });
        bump((n) => n + 1);
      }
    };
    for (let i = 0; i < MAX_AT_ONCE; i++) void next();
    return () => {
      live = false;
    };
  }, [wanted, state.compare]);

  /** What a card shows under the report's filters. */
  const show = (w: Widget): Shown => {
    const filters = filtersFor(w.id, fields, state);
    if (!filters.length) return { data: w.data, busy: false, how: null, error: null };
    const job = wanted.find((x) => x.id === w.id);
    if (job) {
      const hit = cache.current.get(w.id);
      if (!hit || hit.key !== job.key) return { data: hit?.view?.data ?? w.data, busy: true, how: null, error: null };
      if (hit.error) return { data: w.data, busy: false, how: "none", error: hit.error };
      if (hit.view!.live) {
        let data = hit.view!.data;
        const before = hit.view!.previous;
        // With compare on, a figure shows its change from the period before.
        if (data?.kind === "number" && before?.kind === "number") data = { ...data, delta: data.value - before.value };
        return { data, busy: false, how: hit.view!.applied.length ? "live" : "none", error: null };
      }
    }
    const { data, sliced } = sliceData(w, fields, state.picks);
    const nothing = (data.kind === "table" && data.rows.length === 0) || (data.kind === "series" && data.points.length === 0);
    return { data: nothing ? null : data, busy: false, how: sliced ? "card" : "none", error: null };
  };

  const setPick = (field: string, p: Pick | null) => {
    const picks = { ...state.picks };
    if (p && chosen(p)) picks[keyOf(field)] = p;
    else delete picks[keyOf(field)];
    setState({ ...state, picks });
  };

  /** What clicking a bar or slice on a card does: filter the rest of the report by it, or stop if it already does. */
  const clickFilter = (w: Widget): ((label: string) => void) | undefined => {
    const name = server.cards[w.id]?.columns?.[0] ?? splitBy(w.title);
    const field = name ? fields.find((f) => keyOf(f.name) === keyOf(name)) : undefined;
    if (!field || field.type !== "text") return undefined;
    return (label) => {
      const now = state.picks[keyOf(field.name)];
      const same = now?.origin === w.id && now.values?.length === 1 && now.values[0] === label;
      setPick(field.name, same ? null : { values: [label], origin: w.id });
    };
  };

  return {
    state,
    fields,
    cards: server.cards,
    show,
    setPick,
    clickFilter,
    filtersFor: (w: Widget) => filtersFor(w.id, fields, state),
    setPeriod: (period: Period | null) => setState({ ...state, period, compare: period && period.preset !== "all" ? state.compare : false }),
    setCompare: (compare: boolean) => setState({ ...state, compare }),
    clear: () => setState(NO_FILTERS),
    /** This page's address with the filters in force, to send to someone. Click choices lose the card they came from. */
    link: () => `${window.location.origin}${window.location.pathname}?f=${encodeState({ ...state, picks: Object.fromEntries(Object.entries(state.picks).filter(([, p]) => chosen(p)).map(([k, p]) => [k, p.range ? { range: p.range } : { values: p.values }])) })}`,
  };
}
export type Report = ReturnType<typeof useReport>;
