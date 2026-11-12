// A SQL editor for people: write a query over a workbook's tables, run it, and put the result on a
// report. The editor, statement splitting and formatter come from DataDungeon; the queries run on the
// server with DuckDB, read-only, the same way an agent's do.

import { openPanel } from "../insight/open";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { api } from "../agents/catalog";
import { useStatus, useTabTitle } from "../shell/context";
import { DESIGN_FORMS, THEMES, fits } from "../widgets/spec";
import type { Widget, WidgetData, WidgetForm } from "../widgets/spec";
import { WidgetBody, WidgetFrame } from "../widgets/WidgetView";
import { CodeEditor } from "./CodeEditor";
import type { CodeEditorHandle } from "./CodeEditor";
import { formatSql, lineOf, statementAt } from "./statements";

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
interface Result {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  ms: number;
}

const draftKey = (book: string) => `gz_sql_${book}`;
const numeric = (v: string | null) => v !== null && v.trim() !== "" && Number.isFinite(Number(v));
const quote = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** A result as card data: one cell is a figure, label and number columns a series, anything else a table. */
export function resultData(r: Result): WidgetData | null {
  if (r.rows.length === 0 || r.columns.length === 0) return null;
  const last = r.columns.length - 1;
  if (r.rows.length === 1 && r.columns.length === 1 && numeric(r.rows[0]![0] ?? null)) return { kind: "number", value: Number(r.rows[0]![0]), unit: null, delta: null, label: r.columns[0]!.slice(0, 200) };
  if (r.columns.length === 2 && r.rows.length >= 2 && r.rows.length <= 60 && r.rows.every((row) => numeric(row[last] ?? null))) {
    return { kind: "series", points: r.rows.map((row) => ({ label: String(row[0] ?? "").slice(0, 200), value: Number(row[last]) })) };
  }
  if (r.columns.length > 6) return null;
  return { kind: "table", columns: r.columns.map((c) => c.slice(0, 200)), rows: r.rows.slice(0, 50).map((row) => row.map((v) => (v === null ? null : numeric(v) ? Number(v) : v.slice(0, 500)))) };
}

function ResultTable({ result }: { result: Result }) {
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return result.rows;
    const all = result.rows.every((r) => r[sort.col] === null || numeric(r[sort.col] ?? null));
    return [...result.rows].sort((a, b) => {
      const x = a[sort.col] ?? null;
      const y = b[sort.col] ?? null;
      // Empty cells go last whichever way the column is sorted.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      const d = all ? Number(x) - Number(y) : x.localeCompare(y);
      return sort.desc ? -d : d;
    });
  }, [result, sort]);
  return (
    <div className="sql-result-table widget-table">
      <table>
        <thead>
          <tr>
            {result.columns.map((c, i) => (
              <th key={i} aria-sort={sort?.col === i ? (sort.desc ? "descending" : "ascending") : "none"}>
                <button onClick={() => setSort(sort?.col === i ? (sort.desc ? null : { col: i, desc: true }) : { col: i, desc: false })} title="Sort by this column">{c}{sort?.col === i ? (sort.desc ? " ↓" : " ↑") : ""}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 500).map((r, i) => (
            <tr key={i}>{result.columns.map((_, j) => <td key={j} className={numeric(r[j] ?? null) ? "num" : undefined}>{r[j] === null ? <span className="sql-null">null</span> : r[j]}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const toCsv = (r: Result) => [r.columns, ...r.rows].map((row) => row.map((v) => (v === null ? "" : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";

export function SqlPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [books, setBooks] = useState<{ id: string; title: string }[] | null>(null);
  const [book, setBook] = useState(params.get("wb") ?? "");
  const [tables, setTables] = useState<Table[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [ran, setRan] = useState("");
  const [error, setError] = useState<{ message: string; line: number | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const editor = useRef<CodeEditorHandle | null>(null);
  useTabTitle("SQL");

  useEffect(() => {
    api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks").then((r) => {
      const list = r.ok ? r.data.workbooks : [];
      setBooks(list);
      setBook((b) => (list.some((x) => x.id === b) ? b : (list[0]?.id ?? "")));
    });
  }, []);
  useEffect(() => {
    if (!book) return;
    setTables(null);
    setResult(null);
    setError(null);
    // A query handed over in the link (from a card, or the card builder) comes first; then the draft kept here.
    const handed = params.get("wb") === book ? params.get("q") : null;
    let draft = "";
    try {
      draft = localStorage.getItem(draftKey(book)) ?? "";
    } catch {
      // No storage: start empty.
    }
    setSql(handed ?? draft);
    if (handed !== null) setParams({}, { replace: true });
    api<{ tables: Table[] }>("GET", `/api/v1/workbooks/${book}/tables`).then((r) => {
      const list = r.ok ? (r.data.tables ?? []) : [];
      setTables(list);
      setOpen(list.length === 1 ? { [list[0]!.table]: true } : {});
      if (!(handed ?? draft) && list[0]) setSql(`SELECT *\nFROM ${quote(list[0].table)}\nLIMIT 100`);
    });
  }, [book]);
  useEffect(() => {
    if (!book) return;
    try {
      localStorage.setItem(draftKey(book), sql);
    } catch {
      // Not kept; nothing else depends on it.
    }
  }, [sql, book]);

  // Tables and their columns, for the editor's completion list.
  const schema = useMemo(() => Object.fromEntries((tables ?? []).map((t) => [t.table, t.columns.map((c) => c.name)])), [tables]);

  /** Run what is selected; with nothing selected, the statement the cursor is in. */
  async function run() {
    if (!book || running) return;
    const st = editor.current?.getState?.();
    const doc = st?.doc ?? sql;
    const picked = st && st.from !== st.to ? { text: doc.slice(st.from, st.to), from: st.from } : (statementAt(doc, st?.head ?? 0) ?? { text: doc, from: 0 });
    const text = picked.text.trim();
    if (!text) return setError({ message: "Write a query first.", line: null });
    setRunning(true);
    setError(null);
    const r = await api<Result & { error?: string; line?: number | null }>("POST", `/api/v1/workbooks/${book}/query`, { sql: text });
    setRunning(false);
    if (r.ok) {
      setResult(r.data);
      setRan(text);
    } else {
      // The engine counts lines within the statement it was given; the editor shows the whole script.
      const line = r.data?.line ? lineOf(doc, picked.from) + r.data.line - 1 : null;
      setError({ message: r.data?.error ?? "The query could not be run.", line });
      setResult(null);
    }
  }

  const data = result ? resultData(result) : null;
  useStatus("sql", running ? { left: "Running…", tone: "busy" } : error ? { left: "The query did not run", tone: "warn" } : result ? { left: `${result.rows.length.toLocaleString()}${result.truncated ? "+" : ""} ${result.rows.length === 1 ? "row" : "rows"} in ${result.ms.toLocaleString()} ms`, right: result.truncated ? "Showing the first 1,000 rows" : undefined, tone: "good" } : { left: "Ctrl+Enter runs the statement the cursor is in" });

  if (books === null) return <main className="main"><div className="gz-skel"><span /><span /><span /></div></main>;
  if (books.length === 0) {
    return (
      <main className="main">
        <h1>SQL</h1>
        <p>You have no workbooks yet. Upload a file on <Link to="/">Home</Link>; its table can then be queried here.</p>
      </main>
    );
  }
  return (
    <main className="main sql-page">
      <aside className="sql-side" aria-label="Tables">
        <label className="sql-book">
          Workbook
          <select value={book} onChange={(e) => setBook(e.target.value)}>{books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select>
        </label>
        {tables === null ? (
          <div className="gz-skel"><span /><span /></div>
        ) : tables.length === 0 ? (
          <p className="collab-note">This workbook has no data table. Import a file as a table, or connect one.</p>
        ) : (
          <ul className="sql-tree" role="tree" aria-label="Tables and columns">
            {tables.map((t) => (
              <li key={t.table} role="treeitem" aria-expanded={!!open[t.table]}>
                <span className="sql-tree-row">
                  <button className="sql-tree-toggle" aria-label={`${open[t.table] ? "Hide" : "Show"} the columns of ${t.table}`} onClick={() => setOpen({ ...open, [t.table]: !open[t.table] })}>{open[t.table] ? "▾" : "▸"}</button>
                  <button className="sql-tree-name" title="Put this name in the query" onClick={() => editor.current?.insertText?.(quote(t.table))}>{t.table}</button>
                  <small>{t.rows.toLocaleString()}</small>
                  <button className="sql-tree-info" title="What is built on this table, and who sees it" aria-label={`What uses ${t.table}`} onClick={() => openPanel({ kind: "table", id: `${book}:${t.table}`, label: t.table })}>Used by</button>
                </span>
                {open[t.table] && (
                  <ul role="group">
                    {t.columns.map((c) => (
                      <li key={c.name} role="treeitem">
                        <button className="sql-tree-name" title="Put this name in the query" onClick={() => editor.current?.insertText?.(quote(c.name))}>{c.name}</button>
                        <small>{c.kind}</small>
                        <button className="sql-tree-info" title="What is built on this field, and who sees it" aria-label={`What uses ${t.table}.${c.name}`} onClick={() => openPanel({ kind: "field", id: `${book}:${t.table}:${c.name}`, label: `${t.table}.${c.name}` })}>Used by</button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="collab-note">Queries are read-only and run over the whole of each table (DuckDB SQL).</p>
      </aside>
      <section className="sql-main">
        <div className="sql-bar">
          <button className="primary-inline" onClick={run} disabled={running || !tables?.length}>{running ? "Running…" : "Run"}</button>
          <button className="secondary" onClick={() => setSql(formatSql(sql))} disabled={!sql.trim()}>Format</button>
          <span className="chat-head-spacer" />
          {result && <button className="secondary" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([toCsv(result)], { type: "text/csv" })); a.download = "result.csv"; a.click(); window.setTimeout(() => URL.revokeObjectURL(a.href), 2000); }}>Download CSV</button>}
          {result && <button className="secondary" onClick={() => setAdding(true)} disabled={!data} title={data ? "Make a report card that keeps this query" : "A card holds one figure, a label and a number per row, or up to 6 columns"}>Add to a report</button>}
        </div>
        <div className="sql-editor-box">
          <CodeEditor value={sql} onChange={setSql} lang="sql" lineNumbers schema={schema} errorLine={error?.line ?? null} onRun={run} onReady={(h) => (editor.current = h)} ariaLabel="SQL query" placeholder="SELECT …" autoFocus />
        </div>
        {error && <p className="error sql-error" role="alert">{error.message}{error.line ? ` (line ${error.line})` : ""}</p>}
        <div className="sql-results" aria-live="polite">
          {result ? (
            result.rows.length === 0 ? <p className="collab-note">The query ran and returned no rows.</p> : <ResultTable result={result} />
          ) : !error ? (
            <p className="collab-note">Results show here. Select part of the query to run only that part.</p>
          ) : null}
        </div>
      </section>
      {adding && result && data && <AddCard book={book} sql={ran} data={data} onClose={() => setAdding(false)} onAdded={(boardId) => navigate(`/dashboards/${boardId}`)} />}
    </main>
  );
}

const FORM_NAMES: Partial<Record<WidgetForm, string>> = { trend: "Line", bars: "Bars", hbar: "Bars across", pie: "Pie", donut: "Donut", funnel: "Funnel", treemap: "Treemap", waterfall: "Waterfall", radar: "Radar", histogram: "Histogram", table: "Table", stacked: "Stacked bars", heatmap: "Heatmap", combo: "Bars and line", scatter: "Scatter", bubble: "Bubble", sunburst: "Sunburst", sankey: "Flow", boxplot: "Box plot", number: "Number", gauge: "Gauge" };

function AddCard({ book, sql, data, onClose, onAdded }: { book: string; sql: string; data: WidgetData; onClose: () => void; onAdded: (boardId: string) => void }) {
  const [boards, setBoards] = useState<{ id: string; name: string; role: string }[]>([]);
  const [board, setBoard] = useState("");
  const [title, setTitle] = useState("");
  const forms = DESIGN_FORMS.filter((f) => fits(f, data) === null) as WidgetForm[];
  const [form, setForm] = useState<WidgetForm>(forms[0] ?? "table");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ dashboards: { id: string; name: string; role: string }[] }>("GET", "/api/v1/dashboards").then((r) => {
      const list = (r.ok ? r.data.dashboards : []).filter((d) => d.role !== "viewer");
      setBoards(list);
      setBoard(list[0]?.id ?? "");
    });
  }, []);
  async function add() {
    setBusy(true);
    setError(null);
    const shape = data.kind === "number" ? "number" : data.kind === "series" ? "series" : "table";
    const r = await api<{ widget: Widget; error?: string }>("POST", `/api/v1/dashboards/${board}/widgets`, { title: title.trim(), form, theme: THEMES[0], source: { kind: "table_query", workbookId: book, sql, shape } });
    setBusy(false);
    if (r.ok) onAdded(board);
    else setError(r.data?.error ?? "Could not add the card.");
  }
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog report-dialog" role="dialog" aria-modal="true" aria-label="Add to a report">
        <div className="dialog-head">
          <h2>Add to a report</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="report-form">
          <label className="field">Title<input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="What this card shows" autoFocus /></label>
          <label className="field">Report<select value={board} onChange={(e) => setBoard(e.target.value)}>{boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          {forms.length > 1 && <label className="field">Shown as<select value={form} onChange={(e) => setForm(e.target.value as WidgetForm)}>{forms.map((f) => <option key={f} value={f}>{FORM_NAMES[f] ?? f}</option>)}</select></label>}
        </div>
        <div className="sql-preview"><WidgetFrame title={title || "Untitled"} theme="blue" size="l"><WidgetBody form={form} theme="blue" size="l" data={data} title={title} /></WidgetFrame></div>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="collab-note">The card keeps this query: it refreshes from the table and follows the report's filters.</p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary-inline" disabled={busy || !board || !title.trim()} onClick={add}>{busy ? "Adding…" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
