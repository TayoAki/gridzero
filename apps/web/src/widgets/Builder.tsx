// Add a card by hand. Four kinds: totals from a table (optionally with a looked-up table, further
// totals and a custom column), two tables side by side such as actual against plan, a funnel, and
// retention by cohort. No agent involved. The card keeps the query, so it refreshes and follows the
// report's filters like any live card.

import { useEffect, useMemo, useState } from "react";

import { api } from "../agents/catalog";
import { useEscape } from "../use-escape";
import { BUCKETS, MEASURES, OPS, attributionSql, buildSql, cohortSql, columnsOf, compareSql, experimentSql, funnelSql } from "./builderSql";
import type { Bucket, Built, Choice, Column, Measure, Op, Side } from "./builderSql";
import { DESIGN_FORMS, THEMES, fits } from "./spec";
import type { Widget, WidgetData, WidgetForm, WidgetTheme } from "./spec";
import { WidgetBody, WidgetFrame } from "./WidgetView";

interface Table {
  table: string;
  title: string;
  rows: number;
  columns: Column[];
}
type Kind = "totals" | "compare" | "funnel" | "cohort" | "attribution" | "experiment";
const KINDS: [Kind, string][] = [["totals", "Totals from a table"], ["compare", "Two tables side by side (actual against plan)"], ["funnel", "A funnel: how many reach each step"], ["cohort", "Retention: who comes back"], ["attribution", "Credit for sales across several touches"], ["experiment", "An experiment: the difference and how sure"]];
const MEASURE_NAMES: Record<Measure, string> = { count: "Number of rows", sum: "Total of", avg: "Average of", min: "Lowest", max: "Highest" };
const EMPTY: Choice = { table: "", measure: "count", column: "", split: "", bucket: "month", second: "", keep: [], more: [], join: null, custom: null };

const FORM_NAMES: Partial<Record<WidgetForm, string>> = { trend: "Line", bars: "Bars", hbar: "Bars across", pie: "Pie", donut: "Donut", funnel: "Funnel", treemap: "Treemap", waterfall: "Waterfall", radar: "Radar", histogram: "Histogram", table: "Table", stacked: "Stacked bars", heatmap: "Heatmap", combo: "Bars and line", scatter: "Scatter", bubble: "Bubble", sunburst: "Sunburst", sankey: "Flow", boxplot: "Box plot", number: "Number", gauge: "Gauge" };

/** The form a card starts in: a line over time, bars for anything else split, stacked bars for two splits. */
const startForm = (shape: "number" | "series" | "table", overTime: boolean): WidgetForm => (shape === "number" ? "number" : shape === "table" ? "stacked" : overTime ? "trend" : "bars");

export function BuilderDialog({ boardId, onAdded, onClose }: { boardId: string; onAdded: (w: Widget) => void; onClose: () => void }) {
  useEscape(onClose);
  const [books, setBooks] = useState<{ id: string; title: string }[] | null>(null);
  const [book, setBook] = useState("");
  const [tables, setTables] = useState<Table[] | null>(null);
  const [kind, setKind] = useState<Kind>("totals");
  const [choice, setChoice] = useState<Choice>(EMPTY);
  // Two tables side by side.
  const [sideA, setSideA] = useState<Side>({ table: "", measure: "sum", column: "", by: "", name: "Actual" });
  const [sideB, setSideB] = useState<Side>({ table: "", measure: "sum", column: "", by: "", name: "Plan" });
  // Funnel and retention.
  const [steps, setSteps] = useState<{ column: string; id: string; picked: string[]; values: string[] }>({ column: "", id: "", picked: [], values: [] });
  const [cohort, setCohort] = useState<{ id: string; date: string; bucket: Bucket }>({ id: "", date: "", bucket: "month" });
  // Attribution: touches in one table, sales in another, matched on a key. And an experiment's two groups.
  const [attr, setAttr] = useState({ touches: "", key: "", channel: "", time: "", sales: "", salesKey: "", amount: "", model: "linear" as "first" | "last" | "linear" });
  const [trial, setTrial] = useState({ group: "", a: "", b: "", metric: "", values: [] as string[] });
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
      setChoice({ ...EMPTY, table: list[0]?.table ?? "" });
      // The first number that is not an identifier: totalling ids is never what is meant.
      const num = (t?: Table) => (t?.columns.find((c) => c.kind === "number" && !/(^|_)id$/i.test(c.name)) ?? t?.columns.find((c) => c.kind === "number"))?.name ?? "";
      const date = (t?: Table) => (t?.columns.find((c) => c.kind === "date") ?? t?.columns.find((c) => c.kind === "text"))?.name ?? "";
      setSideA({ table: list[0]?.table ?? "", measure: "sum", column: num(list[0]), by: date(list[0]), name: "Actual" });
      setSideB({ table: (list[1] ?? list[0])?.table ?? "", measure: "sum", column: num(list[1] ?? list[0]), by: date(list[1] ?? list[0]), name: "Plan" });
      setSteps({ column: "", id: "", picked: [], values: [] });
      setCohort({ id: list[0]?.columns.find((c) => c.kind !== "date")?.name ?? "", date: list[0]?.columns.find((c) => c.kind === "date")?.name ?? "", bucket: "month" });
      setForm(null);
      setTitle(null);
    });
  }, [book]);

  const table = tables?.find((t) => t.table === choice.table);
  const own = table?.columns ?? [];
  const joined = tables?.find((t) => t.table === choice.join?.table)?.columns ?? [];
  const columns = useMemo(() => columnsOf(choice, own, joined), [choice.join, choice.custom, own, joined]);
  const numbers = columns.filter((c) => c.kind === "number");
  const colsOf = (name: string) => tables?.find((t) => t.table === name)?.columns ?? [];
  const built: Built | null = useMemo(() => {
    if (!table) return null;
    if (kind === "totals") return choice.measure === "count" || choice.column ? buildSql(choice, columns) : null;
    if (kind === "compare") {
      const ok = (s: Side) => s.table && s.by && (s.measure === "count" || s.column);
      return ok(sideA) && ok(sideB) ? compareSql(sideA, sideB, { isDate: colsOf(sideA.table).find((c) => c.name === sideA.by)?.kind === "date", bucket: choice.bucket }) : null;
    }
    if (kind === "funnel") return steps.column && steps.picked.length >= 2 ? funnelSql(choice.table, steps.column, steps.picked, steps.id) : null;
    if (kind === "attribution") return attr.touches && attr.key && attr.channel && attr.time && attr.sales && attr.salesKey && attr.amount ? attributionSql({ table: attr.touches, key: attr.key, channel: attr.channel, time: attr.time }, { table: attr.sales, key: attr.salesKey, amount: attr.amount }, attr.model) : null;
    if (kind === "experiment") return trial.group && trial.a && trial.b && trial.a !== trial.b && trial.metric ? experimentSql(choice.table, trial.group, trial.a, trial.b, trial.metric) : null;
    return cohort.id && cohort.date ? cohortSql(choice.table, cohort.id, cohort.date, cohort.bucket) : null;
  }, [table, kind, choice, columns, sideA, sideB, steps, cohort, attr, trial]);
  // The values of the column that names the experiment's groups.
  useEffect(() => {
    if (kind !== "experiment" || !trial.group || !book) return;
    const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;
    api<{ rows: (string | null)[][] }>("POST", `/api/v1/workbooks/${book}/query`, { sql: `SELECT CAST(${quoted(trial.group)} AS VARCHAR), COUNT(*) FROM ${quoted(choice.table)} WHERE ${quoted(trial.group)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 12` }).then((r) => { const values = r.ok ? r.data.rows.map((x) => String(x[0])) : []; setTrial((t) => ({ ...t, values, a: values[0] ?? "", b: values[1] ?? "" })); });
  }, [kind, trial.group, choice.table, book]);
  // The values of the step column, for choosing the funnel's steps in order.
  useEffect(() => {
    if (kind !== "funnel" || !steps.column || !book) return;
    const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;
    api<{ rows: (string | null)[][] }>("POST", `/api/v1/workbooks/${book}/query`, { sql: `SELECT ${quoted(steps.column)}, COUNT(*) FROM ${quoted(choice.table)} WHERE ${quoted(steps.column)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 30` }).then((r) => setSteps((s) => ({ ...s, values: r.ok ? r.data.rows.map((x) => String(x[0])) : [] })));
  }, [kind, steps.column, choice.table, book]);
  const overTime = kind === "totals" && columns.find((c) => c.name === choice.split)?.kind === "date";
  const source = built ? { kind: "table_query" as const, workbookId: book, sql: built.sql, shape: built.shape } : null;
  const wanted = form ?? (kind === "attribution" ? "bars" : kind === "experiment" ? "table" : kind === "funnel" ? "funnel" : kind === "cohort" ? "heatmap" : kind === "compare" ? "combo" : built ? startForm(built.shape, overTime) : "number");

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

  const sideForm = (side: Side, setSide: (s: Side) => void, label: string) => (
    <fieldset className="builder-side">
      <legend>{label}</legend>
      <label>Called<input value={side.name} maxLength={30} onChange={(e) => setSide({ ...side, name: e.target.value })} /></label>
      <label>Table<select value={side.table} onChange={(e) => { const cols = colsOf(e.target.value); setSide({ ...side, table: e.target.value, column: cols.find((c) => c.kind === "number")?.name ?? "", by: (cols.find((c) => c.kind === "date") ?? cols[0])?.name ?? "" }); }}>{(tables ?? []).map((t) => <option key={t.table} value={t.table}>{t.title}</option>)}</select></label>
      <label>Show<select value={side.measure} onChange={(e) => setSide({ ...side, measure: e.target.value as Measure })}>{MEASURES.map((m) => <option key={m} value={m}>{MEASURE_NAMES[m]}</option>)}</select></label>
      {side.measure !== "count" && <label>Column<select value={side.column} onChange={(e) => setSide({ ...side, column: e.target.value })}>{colsOf(side.table).filter((c) => c.kind === "number").map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
      <label>Lined up on<select value={side.by} onChange={(e) => setSide({ ...side, by: e.target.value })}>{colsOf(side.table).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
    </fieldset>
  );

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
                  <label>Kind of card<select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setForm(null); setTitle(null); }}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                  {kind === "totals" && (
                    <>
                  <label>Table<select value={choice.table} onChange={(e) => set({ table: e.target.value, column: "", split: "", second: "", join: null, more: [], keep: [] })}>{tables.map((t) => <option key={t.table} value={t.table}>{t.title} ({t.rows.toLocaleString()} rows)</option>)}</select></label>
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
                      <details className="builder-more">
                        <summary>More: another table, further totals, a column of your own</summary>
                        <label>Look up from<select value={choice.join?.table ?? ""} onChange={(e) => { const other = colsOf(e.target.value); const shared = own.find((c) => other.some((o) => o.name === c.name)); set({ join: e.target.value ? { table: e.target.value, left: shared?.name ?? own[0]?.name ?? "", right: shared?.name ?? other[0]?.name ?? "" } : null, column: "", split: "", second: "", more: [], keep: [] }); }}><option value="">No other table</option>{(tables ?? []).filter((t) => t.table !== choice.table).map((t) => <option key={t.table} value={t.table}>{t.title}</option>)}</select></label>
                        {choice.join && (
                          <>
                            <div className="builder-keep-row">
                              <select aria-label="Matching column in the first table" value={choice.join.left} onChange={(e) => set({ join: { ...choice.join!, left: e.target.value } })}>{own.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>
                              <span>matches</span>
                              <select aria-label="Matching column in the other table" value={choice.join.right} onChange={(e) => set({ join: { ...choice.join!, right: e.target.value } })}>{joined.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>
                            </div>
                            <p className="collab-note">Use this when each row of {choice.table} matches at most one row of {choice.join.table}, such as an order and its customer. Otherwise rows are counted more than once: for two sets of totals, use "Two tables side by side".</p>
                          </>
                        )}
                        {(choice.more ?? []).map((m, i) => (
                          <div key={i} className="builder-keep-row">
                            <select aria-label="Another total" value={m.measure} onChange={(e) => set({ more: choice.more!.map((x, j) => (j === i ? { measure: e.target.value as Measure, column: e.target.value === "count" ? "" : x.column || (numbers[0]?.name ?? "") } : x)) })}>{MEASURES.map((x) => <option key={x} value={x}>{MEASURE_NAMES[x]}</option>)}</select>
                            {m.measure !== "count" && <select aria-label="Column for the other total" value={m.column} onChange={(e) => set({ more: choice.more!.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>{numbers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>}
                            <button type="button" className="link-button" aria-label="Remove this total" onClick={() => set({ more: choice.more!.filter((_, j) => j !== i) })}>✕</button>
                          </div>
                        ))}
                        {(choice.more ?? []).length < 3 && <button type="button" className="link-button" onClick={() => set({ more: [...(choice.more ?? []), { measure: "count", column: "" }], second: "" })}>+ Add another total</button>}
                        <div className="builder-keep-row">
                          <input aria-label="Name of your own column" placeholder="Your column, e.g. tax" value={choice.custom?.name ?? ""} maxLength={40} onChange={(e) => set({ custom: { name: e.target.value, expr: choice.custom?.expr ?? "" } })} />
                          <span>=</span>
                          <input aria-label="How your column is worked out" placeholder={'"amount" * 0.2'} value={choice.custom?.expr ?? ""} maxLength={300} onChange={(e) => set({ custom: { name: choice.custom?.name ?? "", expr: e.target.value } })} />
                        </div>
                        <p className="collab-note">Your own column is worked out for every row and can then be totalled. Write column names in double quotes.</p>
                      </details>
                    </>
                  )}
                  {kind === "compare" && (
                    <>
                      {sideForm(sideA, setSideA, "First")}
                      {sideForm(sideB, setSideB, "Second")}
                      {colsOf(sideA.table).find((c) => c.name === sideA.by)?.kind === "date" && <label>Each<select value={choice.bucket} onChange={(e) => set({ bucket: e.target.value as Bucket })}>{BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
                      <p className="collab-note">Each table is totalled first, then the two are lined up, so nothing is counted twice. A line with only one side still shows.</p>
                    </>
                  )}
                  {(kind === "funnel" || kind === "cohort") && <label>Table<select value={choice.table} onChange={(e) => { set({ table: e.target.value }); setSteps({ column: "", id: "", picked: [], values: [] }); const cols = colsOf(e.target.value); setCohort({ ...cohort, id: cols.find((c) => c.kind !== "date")?.name ?? "", date: cols.find((c) => c.kind === "date")?.name ?? "" }); }}>{(tables ?? []).map((t) => <option key={t.table} value={t.table}>{t.title} ({t.rows.toLocaleString()} rows)</option>)}</select></label>}
                  {kind === "funnel" && (
                    <>
                      <label>The column that names the step<select value={steps.column} onChange={(e) => setSteps({ ...steps, column: e.target.value, picked: [], values: [] })}><option value="">choose…</option>{own.filter((c) => c.kind === "text").map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
                      <label>Count each of these once<select value={steps.id} onChange={(e) => setSteps({ ...steps, id: e.target.value })}><option value="">Every row</option>{own.filter((c) => c.name !== steps.column).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
                      {steps.values.length > 0 && (
                        <div className="builder-keep" role="group" aria-label="Steps, in order">
                          <span>Steps, in the order you pick them</span>
                          <div className="builder-forms">{steps.values.map((v) => { const at = steps.picked.indexOf(v); return <button key={v} type="button" aria-pressed={at >= 0} className={at >= 0 ? "selected" : ""} onClick={() => setSteps({ ...steps, picked: at >= 0 ? steps.picked.filter((x) => x !== v) : [...steps.picked, v].slice(0, 8) })}>{at >= 0 ? `${at + 1}. ` : ""}{v}</button>; })}</div>
                        </div>
                      )}
                    </>
                  )}
                  {kind === "attribution" && (
                    <>
                      <fieldset className="builder-side">
                        <legend>Touches</legend>
                        <label>Table<select value={attr.touches} onChange={(e) => { const cols = colsOf(e.target.value); setAttr({ ...attr, touches: e.target.value, key: cols[0]?.name ?? "", channel: cols.find((x) => x.kind === "text" && x.name !== cols[0]?.name)?.name ?? "", time: cols.find((x) => x.kind === "date")?.name ?? "" }); }}><option value="">choose…</option>{(tables ?? []).map((t) => <option key={t.table} value={t.table}>{t.title}</option>)}</select></label>
                        <label>Whose touch<select value={attr.key} onChange={(e) => setAttr({ ...attr, key: e.target.value })}>{colsOf(attr.touches).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                        <label>Channel<select value={attr.channel} onChange={(e) => setAttr({ ...attr, channel: e.target.value })}>{colsOf(attr.touches).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                        <label>When<select value={attr.time} onChange={(e) => setAttr({ ...attr, time: e.target.value })}>{colsOf(attr.touches).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                      </fieldset>
                      <fieldset className="builder-side">
                        <legend>Sales</legend>
                        <label>Table<select value={attr.sales} onChange={(e) => { const cols = colsOf(e.target.value); setAttr({ ...attr, sales: e.target.value, salesKey: cols.find((x) => x.name === attr.key)?.name ?? cols[0]?.name ?? "", amount: cols.find((x) => x.kind === "number" && !/(^|_)id$/i.test(x.name))?.name ?? "" }); }}><option value="">choose…</option>{(tables ?? []).map((t) => <option key={t.table} value={t.table}>{t.title}</option>)}</select></label>
                        <label>Whose sale<select value={attr.salesKey} onChange={(e) => setAttr({ ...attr, salesKey: e.target.value })}>{colsOf(attr.sales).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                        <label>Amount<select value={attr.amount} onChange={(e) => setAttr({ ...attr, amount: e.target.value })}>{colsOf(attr.sales).filter((x) => x.kind === "number").map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                      </fieldset>
                      <label>Credit goes to<select value={attr.model} onChange={(e) => setAttr({ ...attr, model: e.target.value as "first" | "last" | "linear" })}><option value="linear">Every touch, shared equally</option><option value="first">The first touch</option><option value="last">The last touch</option></select></label>
                      <p className="collab-note">A sale with no touch is shown as "(no touch)", so the channels always add up to the sales. Every touch for the same key counts, whenever it happened.</p>
                    </>
                  )}
                  {kind === "experiment" && (
                    <>
                      <label>Table<select value={choice.table} onChange={(e) => { set({ table: e.target.value }); setTrial({ group: "", a: "", b: "", metric: "", values: [] }); }}>{(tables ?? []).map((t) => <option key={t.table} value={t.table}>{t.title} ({t.rows.toLocaleString()} rows)</option>)}</select></label>
                      <label>The column that names the group<select value={trial.group} onChange={(e) => setTrial({ ...trial, group: e.target.value, values: [] })}><option value="">choose…</option>{own.filter((x) => x.kind !== "date").map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                      {trial.values.length > 1 && (
                        <div className="builder-keep-row">
                          <select aria-label="Group A" value={trial.a} onChange={(e) => setTrial({ ...trial, a: e.target.value })}>{trial.values.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                          <span>against</span>
                          <select aria-label="Group B" value={trial.b} onChange={(e) => setTrial({ ...trial, b: e.target.value })}>{trial.values.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                        </div>
                      )}
                      <label>The number to compare<select value={trial.metric} onChange={(e) => setTrial({ ...trial, metric: e.target.value })}><option value="">choose…</option>{own.filter((x) => x.kind === "number").map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
                      <p className="collab-note">Shows each group's average, the difference, and the range the true difference is likely to lie in (95 times in 100). With fewer than 30 rows in a group it says it cannot tell.</p>
                    </>
                  )}
                  {kind === "cohort" && (
                    <>
                      <label>Who (a person or account)<select value={cohort.id} onChange={(e) => setCohort({ ...cohort, id: e.target.value })}>{own.filter((c) => c.kind !== "date").map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
                      <label>When<select value={cohort.date} onChange={(e) => setCohort({ ...cohort, date: e.target.value })}><option value="">choose…</option>{own.filter((c) => c.kind === "date").map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
                      <label>Each<select value={cohort.bucket} onChange={(e) => setCohort({ ...cohort, bucket: e.target.value as Bucket })}>{(["week", "month", "quarter"] as const).map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
                      <p className="collab-note">People are grouped by the {cohort.bucket} they first appear in, then counted in each {cohort.bucket} after.</p>
                    </>
                  )}
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
