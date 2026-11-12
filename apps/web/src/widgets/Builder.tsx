// Add a card by hand: pick a table, what to total and what to split it by. No agent involved.
// The card keeps the query, so it refreshes and follows the report's filters like any live card.

import { useEffect, useMemo, useState } from "react";

import { api } from "../agents/catalog";
import { useEscape } from "../use-escape";
import { DESIGN_FORMS, THEMES, fits } from "./spec";
import type { Widget, WidgetData, WidgetForm, WidgetTheme } from "./spec";
import { WidgetBody, WidgetFrame } from "./WidgetView";

interface Column {
  name: string;
  kind: "text" | "number" | "date";
}
interface Table {
  table: string;
  title: string;
  rows: number;
  columns: Column[];
}

const MEASURES = ["count", "sum", "avg", "min", "max"] as const;
type Measure = (typeof MEASURES)[number];
const MEASURE_NAMES: Record<Measure, string> = { count: "Number of rows", sum: "Total of", avg: "Average of", min: "Lowest", max: "Highest" };
const BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
type Bucket = (typeof BUCKETS)[number];
const BUCKET_FORMAT: Record<Bucket, string> = { day: "%Y-%m-%d", week: "%Y-%m-%d", month: "%Y-%m", quarter: "%Y-%m", year: "%Y" };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

const OPS = ["is", "is not", "contains", ">", ">=", "<", "<="] as const;
type Op = (typeof OPS)[number];
export interface Keep {
  column: string;
  op: Op;
  value: string;
}

export interface Choice {
  table: string;
  measure: Measure;
  column: string;
  split: string;
  bucket: Bucket;
  second: string;
  /** Rows to keep: every condition must hold. */
  keep: Keep[];
}

/** One condition as SQL. A value is always written as a literal: quotes doubled, numbers only when they are numbers. */
function condition(k: Keep, columns: Column[]): string | null {
  const col = columns.find((c) => c.name === k.column);
  if (!col || k.value.trim() === "") return null;
  const text = `'${k.value.replace(/'/g, "''")}'`;
  const value = col.kind === "number" && Number.isFinite(Number(k.value)) ? String(Number(k.value)) : text;
  if (k.op === "contains") return `CAST(${q(k.column)} AS VARCHAR) ILIKE '%${k.value.replace(/[\\%_]/g, "\\$&").replace(/'/g, "''")}%' ESCAPE '\\'`;
  const left = col.kind === "text" ? q(k.column) : col.kind === "date" ? q(k.column) : q(k.column);
  return `${left} ${k.op === "is" ? "=" : k.op === "is not" ? "<>" : k.op} ${value}`;
}

/** The query for a choice, and the kind of data it gives. Every name is quoted; nothing else is typed in. */
export function buildSql(c: Choice, columns: Column[]): { sql: string; shape: "number" | "series" | "table"; title: string } {
  const value = c.measure === "count" ? "COUNT(*)" : `${c.measure.toUpperCase()}(${q(c.column)})`;
  const what = c.measure === "count" ? "Rows" : `${{ sum: "Total", avg: "Average", min: "Lowest", max: "Highest" }[c.measure]} ${c.column}`;
  const dim = (name: string) => (columns.find((x) => x.name === name)?.kind === "date" ? `strftime(date_trunc('${c.bucket}', ${q(name)}), '${BUCKET_FORMAT[c.bucket]}')` : q(name));
  const isDate = (name: string) => columns.find((x) => x.name === name)?.kind === "date";
  const kept = (c.keep ?? []).flatMap((k) => condition(k, columns) ?? []);
  const where = (...more: string[]) => ([...more, ...kept].length ? ` WHERE ${[...more, ...kept].join(" AND ")}` : "");
  if (!c.split) return { sql: `SELECT ${value} AS ${q(what)} FROM ${q(c.table)}${where()}`, shape: "number", title: what };
  const by = isDate(c.split) ? `${c.split} (${c.bucket})` : c.split;
  if (!c.second) {
    // Dates read left to right in order; anything else, largest first.
    const order = isDate(c.split) ? "1 LIMIT 60" : "2 DESC LIMIT 25";
    return { sql: `SELECT ${dim(c.split)} AS ${q(c.split)}, ${value} AS ${q(what)} FROM ${q(c.table)}${where(`${q(c.split)} IS NOT NULL`)} GROUP BY 1 ORDER BY ${order}`, shape: "series", title: `${what} by ${by}` };
  }
  return {
    sql: `SELECT ${dim(c.split)} AS ${q(c.split)}, ${dim(c.second)} AS ${q(c.second)}, ${value} AS ${q(what)} FROM ${q(c.table)}${where(`${q(c.split)} IS NOT NULL`, `${q(c.second)} IS NOT NULL`)} GROUP BY 1, 2 ORDER BY ${isDate(c.split) ? "1, 2" : "3 DESC"} LIMIT 50`,
    shape: "table",
    title: `${what} by ${by} and ${c.second}`,
  };
}

const FORM_NAMES: Partial<Record<WidgetForm, string>> = { trend: "Line", bars: "Bars", hbar: "Bars across", pie: "Pie", donut: "Donut", funnel: "Funnel", treemap: "Treemap", waterfall: "Waterfall", radar: "Radar", histogram: "Histogram", table: "Table", stacked: "Stacked bars", heatmap: "Heatmap", combo: "Bars and line", scatter: "Scatter", bubble: "Bubble", sunburst: "Sunburst", sankey: "Flow", boxplot: "Box plot", number: "Number", gauge: "Gauge" };

/** The form a card starts in: a line over time, bars for anything else split, stacked bars for two splits. */
const startForm = (shape: "number" | "series" | "table", overTime: boolean): WidgetForm => (shape === "number" ? "number" : shape === "table" ? "stacked" : overTime ? "trend" : "bars");

export function BuilderDialog({ boardId, onAdded, onClose }: { boardId: string; onAdded: (w: Widget) => void; onClose: () => void }) {
  useEscape(onClose);
  const [books, setBooks] = useState<{ id: string; title: string }[] | null>(null);
  const [book, setBook] = useState("");
  const [tables, setTables] = useState<Table[] | null>(null);
  const [choice, setChoice] = useState<Choice>({ table: "", measure: "count", column: "", split: "", bucket: "month", second: "", keep: [] });
  const [form, setForm] = useState<WidgetForm | null>(null);
  const [theme, setTheme] = useState<WidgetTheme>("blue");
  const [title, setTitle] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ data?: WidgetData; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks").then((r) => {
      const list = r.ok ? r.data.workbooks : [];
      setBooks(list);
      if (list[0]) setBook(list[0].id);
    });
  }, []);
  useEffect(() => {
    if (!book) return;
    setTables(null);
    api<{ tables: Table[] }>("GET", `/api/v1/workbooks/${book}/tables`).then((r) => {
      const list = r.ok ? r.data.tables : [];
      setTables(list);
      setChoice({ table: list[0]?.table ?? "", measure: "count", column: "", split: "", bucket: "month", second: "", keep: [] });
      setForm(null);
      setTitle(null);
    });
  }, [book]);

  const table = tables?.find((t) => t.table === choice.table);
  const columns = table?.columns ?? [];
  const numbers = columns.filter((c) => c.kind === "number");
  const built = useMemo(() => (table && (choice.measure === "count" || choice.column) ? buildSql(choice, columns) : null), [table, choice, columns]);
  const overTime = columns.find((c) => c.name === choice.split)?.kind === "date";
  const source = built ? { kind: "table_query" as const, workbookId: book, sql: built.sql, shape: built.shape } : null;
  const wanted = form ?? (built ? startForm(built.shape, overTime) : "number");

  // Run the query whenever the choice changes, to show what the card will hold.
  useEffect(() => {
    if (!source) return void setPreview(null);
    let live = true;
    setPreview(null);
    const timer = window.setTimeout(() => {
      api<{ data: WidgetData; error?: string }>("POST", "/api/v1/widgets/preview", { title: "Preview", form: source.shape === "number" ? "number" : source.shape === "series" ? "bars" : "table", theme, source }).then((r) => live && setPreview(r.ok ? { data: r.data.data } : { error: r.data?.error ?? "Could not run this." }));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // The source is rebuilt on every render; its SQL says whether it changed.
  }, [source?.sql, book]);

  const forms: WidgetForm[] = preview?.data ? DESIGN_FORMS.filter((f) => fits(f, preview.data!) === null) : [];
  const shownForm = forms.includes(wanted) ? wanted : (forms[0] ?? wanted);
  const name = (title ?? built?.title ?? "").slice(0, 60);
  const set = (patch: Partial<Choice>) => {
    setChoice({ ...choice, ...patch });
    setForm(null);
  };

  async function add() {
    if (!source || !preview?.data || !name.trim()) return;
    setSaving(true);
    const r = await api<{ widget: Widget; error?: string }>("POST", `/api/v1/dashboards/${boardId}/widgets`, { title: name.trim(), form: shownForm, theme, source });
    setSaving(false);
    if (r.ok) onAdded(r.data.widget);
    else setPreview({ error: r.data?.error ?? "Could not add the card." });
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog builder-dialog" role="dialog" aria-modal="true" aria-labelledby="builder-title">
        <div className="dialog-head">
          <h2 id="builder-title">Add a card</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {books === null ? (
          <div className="gz-skel"><span /><span /></div>
        ) : books.length === 0 ? (
          <p>You have no workbooks yet. Upload a file on Home first; its table can then be charted here.</p>
        ) : (
          <div className="builder">
            <div className="builder-form">
              <label>Workbook<select value={book} onChange={(e) => setBook(e.target.value)}>{books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
              {tables === null ? (
                <div className="gz-skel"><span /></div>
              ) : tables.length === 0 ? (
                <p className="collab-note">This workbook has no data table. Import a file as a table, or pick another workbook.</p>
              ) : (
                <>
                  <label>Table<select value={choice.table} onChange={(e) => set({ table: e.target.value, column: "", split: "", second: "" })}>{tables.map((t) => <option key={t.table} value={t.table}>{t.title} ({t.rows.toLocaleString()} rows)</option>)}</select></label>
                  <label>Show<select value={choice.measure} onChange={(e) => set({ measure: e.target.value as Measure, column: e.target.value === "count" ? "" : choice.column || (numbers[0]?.name ?? "") })}>{MEASURES.map((m) => <option key={m} value={m} disabled={m !== "count" && numbers.length === 0}>{MEASURE_NAMES[m]}</option>)}</select></label>
                  {choice.measure !== "count" && <label>Column<select value={choice.column} onChange={(e) => set({ column: e.target.value })}>{numbers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
                  <label>Split by<select value={choice.split} onChange={(e) => set({ split: e.target.value, second: e.target.value ? choice.second : "" })}><option value="">Nothing: one figure</option>{columns.map((c) => <option key={c.name} value={c.name}>{c.name}{c.kind === "date" ? " (date)" : ""}</option>)}</select></label>
                  {overTime && <label>Each<select value={choice.bucket} onChange={(e) => set({ bucket: e.target.value as Bucket })}>{BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
                  {choice.split && <label>Then by<select value={choice.second} onChange={(e) => set({ second: e.target.value })}><option value="">Nothing</option>{columns.filter((c) => c.name !== choice.split && c.kind === "text").map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
                  <div className="builder-keep" role="group" aria-label="Only rows where">
                    <span>Only rows where</span>
                    {choice.keep.map((k, i) => (
                      <div key={i} className="builder-keep-row">
                        <select aria-label="Column" value={k.column} onChange={(e) => set({ keep: choice.keep.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>{columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>
                        <select aria-label="Condition" value={k.op} onChange={(e) => set({ keep: choice.keep.map((x, j) => (j === i ? { ...x, op: e.target.value as Op } : x)) })}>{OPS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                        <input aria-label="Value" value={k.value} placeholder={columns.find((c) => c.name === k.column)?.kind === "date" ? "2026-01-31" : "value"} onChange={(e) => set({ keep: choice.keep.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                        <button type="button" className="link-button" aria-label="Remove this condition" onClick={() => set({ keep: choice.keep.filter((_, j) => j !== i) })}>✕</button>
                      </div>
                    ))}
                    {choice.keep.length < 5 && <button type="button" className="link-button" onClick={() => set({ keep: [...choice.keep, { column: columns[0]?.name ?? "", op: "is", value: "" }] })}>+ Add a condition</button>}
                  </div>
                  <label>Title<input value={name} maxLength={60} onChange={(e) => setTitle(e.target.value)} /></label>
                  {forms.length > 1 && (
                    <div className="builder-forms" role="group" aria-label="Chart type">
                      {forms.map((f) => <button key={f} aria-pressed={shownForm === f} className={shownForm === f ? "selected" : ""} onClick={() => setForm(f)}>{FORM_NAMES[f] ?? f}</button>)}
                    </div>
                  )}
                  <div className="builder-themes" role="group" aria-label="Colour">
                    {THEMES.map((t) => <button key={t} aria-label={t} aria-pressed={theme === t} className={`theme-dot theme-${t}${theme === t ? " selected" : ""}`} onClick={() => setTheme(t)} />)}
                  </div>
                </>
              )}
            </div>
            <div className="builder-preview">
              {preview?.error ? (
                <p className="error" role="alert">{preview.error}</p>
              ) : preview?.data ? (
                <WidgetFrame title={name || "Untitled"} theme={theme} size="l">
                  <WidgetBody form={shownForm} theme={theme} size="l" data={preview.data} title={name} />
                </WidgetFrame>
              ) : (
                <div className="gz-skel"><span /><span /><span /></div>
              )}
              <p className="collab-note">The card keeps this query. It refreshes from the table and follows the report's filters and date range.</p>
              {built && <details className="builder-sql"><summary>See the SQL</summary><pre>{built.sql}</pre><a href={`/sql?wb=${book}&q=${encodeURIComponent(built.sql)}`}>Open it in the SQL editor</a> to add joins or anything this form cannot do.</details>}
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary-inline" disabled={!preview?.data || !name.trim() || saving} onClick={add}>{saving ? "Adding…" : "Add to report"}</button>
        </div>
      </div>
    </div>
  );
}
