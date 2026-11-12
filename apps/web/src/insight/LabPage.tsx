// Notebooks: cells of SQL and of words over one workbook's tables, run in order or one at a time.
// Beside them, the experiment runs recorded against that workbook, each tied to the version of the
// data it used.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { api } from "../agents/catalog";
import { useTabTitle } from "../shell/context";

interface Cell {
  id: string;
  kind: "sql" | "note";
  text: string;
}
interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  mine: boolean;
}
interface Result {
  columns?: string[];
  rows?: (string | null)[][];
  truncated?: boolean;
  ms?: number;
  error?: string;
}
interface Run {
  id: string;
  name: string;
  data: { table: string; version: number | null } | null;
  params: Record<string, string | number | boolean>;
  metrics: Record<string, number>;
  notes: string;
  at: string;
}
const newId = () => Math.random().toString(36).slice(2, 10);

export function LabPage() {
  useTabTitle("Notebooks");
  const [params, setParams] = useSearchParams();
  const [books, setBooks] = useState<{ id: string; title: string }[] | null>(null);
  const book = params.get("wb") ?? "";
  const [list, setList] = useState<Notebook[]>([]);
  const [open, setOpen] = useState<Notebook | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [saved, setSaved] = useState(true);
  const [tab, setTab] = useState<"notebook" | "runs">("notebook");

  useEffect(() => {
    api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks").then((r) => {
      const all = r.ok ? r.data.workbooks : [];
      setBooks(all);
      if (!book && all[0]) setParams({ wb: all[0].id }, { replace: true });
    });
  }, []);
  const load = () => {
    if (!book) return;
    void api<{ notebooks: Notebook[] }>("GET", `/api/v1/workbooks/${book}/notebooks`).then((r) => setList(r.ok ? r.data.notebooks : []));
    void api<{ runs: Run[] }>("GET", `/api/v1/workbooks/${book}/experiments`).then((r) => setRuns(r.ok ? r.data.runs : []));
  };
  useEffect(() => {
    setOpen(null);
    setResults({});
    load();
  }, [book]);

  const change = (cells: Cell[]) => {
    if (!open) return;
    setOpen({ ...open, cells });
    setSaved(false);
  };
  const save = async () => {
    if (!open?.mine) return;
    const r = await api("PUT", `/api/v1/notebooks/${open.id}`, { title: open.title, cells: open.cells });
    if (r.ok) setSaved(true);
    load();
  };
  const run = async (cell: Cell) => {
    setResults((x) => ({ ...x, [cell.id]: {} }));
    const r = await api<Result>("POST", `/api/v1/workbooks/${book}/query`, { sql: cell.text });
    setResults((x) => ({ ...x, [cell.id]: r.ok ? r.data : { error: r.data?.error ?? "The query could not be run." } }));
  };
  const runAll = async () => {
    for (const c of open?.cells ?? []) if (c.kind === "sql" && c.text.trim()) await run(c);
  };
  const create = async () => {
    const title = window.prompt("A title for the notebook", "Untitled notebook");
    if (!title) return;
    const r = await api<{ notebook: Notebook }>("POST", `/api/v1/workbooks/${book}/notebooks`, { title, cells: [{ id: newId(), kind: "note", text: "What are we trying to find out?" }, { id: newId(), kind: "sql", text: "" }] });
    if (r.ok) {
      setOpen(r.data.notebook);
      setSaved(true);
      load();
    }
  };

  if (books === null) return <main className="main"><div className="gz-skel"><span /><span /></div></main>;
  if (books.length === 0) return <main className="main"><h1>Notebooks</h1><p>A notebook works over a workbook's tables. Upload a file on Home first.</p></main>;
  return (
    <main className="main insight-page lab">
      <div className="main-head">
        <h1>Notebooks</h1>
        <div className="insight-controls">
          <label>Workbook <select value={book} onChange={(e) => setParams({ wb: e.target.value })} aria-label="Workbook">{books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
          <button className="primary-inline" onClick={create}>New notebook</button>
        </div>
      </div>
      <div className="need-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "notebook"} className={tab === "notebook" ? "on" : ""} onClick={() => setTab("notebook")}>Notebooks ({list.length})</button>
        <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>Experiment runs ({runs.length})</button>
      </div>
      {tab === "runs" && (
        <>
          <p className="muted">Each run names the capture of the tracked table it used, so a result can be tied to exactly that data. Record one from a script with a personal token: <code>POST /api/v1/workbooks/{"{id}"}/experiments</code> with a name, the table, and metrics by name. Track the table first (SQL, then Checks, fresh data and owner, then Record history).</p>
          {runs.length === 0 ? <p>No runs recorded yet.</p> : (
            <div className="insight-scroll">
              <table className="insight-table">
                <thead><tr><th>Run</th><th>Data</th><th>Settings</th><th>Results</th><th>When</th></tr></thead>
                <tbody>{runs.map((r) => <tr key={r.id}><td>{r.name}{r.notes && <div className="muted">{r.notes}</div>}</td><td>{r.data ? `${r.data.table}, capture ${r.data.version}` : <span className="muted">not tied to a version</span>}</td><td>{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")}</td><td>{Object.entries(r.metrics).map(([k, v]) => `${k} ${v}`).join(", ")}</td><td>{new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
      {tab === "notebook" && !open && (
        list.length === 0 ? <p>No notebooks on this workbook yet. A notebook keeps your queries and your notes about them together, in order.</p> : (
          <ul className="insight-list lab-list">{list.map((n) => <li key={n.id} className="watch-row"><button className="link-button" onClick={() => { setOpen(n); setResults({}); setSaved(true); }}>{n.title}</button><span className="muted">{n.cells.length} cells{n.mine ? "" : " · someone else's: you can run it, not change it"}</span></li>)}</ul>
        )
      )}
      {tab === "notebook" && open && (
        <section className="notebook">
          <div className="insight-controls">
            <button className="link-button" onClick={() => { if (saved || window.confirm("Leave without saving your changes?")) setOpen(null); }}>All notebooks</button>
            <input className="notebook-title" value={open.title} readOnly={!open.mine} onChange={(e) => { setOpen({ ...open, title: e.target.value }); setSaved(false); }} aria-label="Title" maxLength={120} />
            <button className="secondary" onClick={runAll}>Run all</button>
            {open.mine && <button className="primary-inline" disabled={saved} onClick={save}>{saved ? "Saved" : "Save"}</button>}
            {open.mine && <button className="link-button danger" onClick={async () => { if (window.confirm(`Delete "${open.title}"?`)) { await api("DELETE", `/api/v1/notebooks/${open.id}`); setOpen(null); load(); } }}>Delete</button>}
          </div>
          {open.cells.map((c, i) => {
            const res = results[c.id];
            return (
              <div key={c.id} className={`cell cell-${c.kind}`} data-testid="cell">
                <div className="cell-bar">
                  <span className="muted">{c.kind === "sql" ? `Query ${open.cells.slice(0, i + 1).filter((x) => x.kind === "sql").length}` : "Note"}</span>
                  {c.kind === "sql" && <button className="secondary" onClick={() => void run(c)}>Run</button>}
                  {open.mine && <button className="link-button" disabled={i === 0} onClick={() => change(open.cells.map((x, j) => (j === i - 1 ? c : j === i ? open.cells[i - 1]! : x)))} aria-label="Move this cell up">↑</button>}
                  {open.mine && <button className="link-button" onClick={() => change(open.cells.filter((x) => x.id !== c.id))} aria-label="Remove this cell">✕</button>}
                </div>
                <textarea value={c.text} readOnly={!open.mine} rows={Math.min(14, Math.max(2, c.text.split("\n").length))} spellCheck={c.kind === "note"} onChange={(e) => change(open.cells.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)))} onKeyDown={(e) => { if (c.kind === "sql" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(c); } }} aria-label={c.kind === "sql" ? "Query" : "Note"} placeholder={c.kind === "sql" ? 'SELECT … FROM "orders"   (Ctrl+Enter runs it)' : "Write what this step is for, or what it showed."} />
                {res && (res.error ? <p className="error" role="alert">{res.error}</p> : !res.columns ? <p className="muted">Running…</p> : (
                  <div className="insight-scroll cell-result">
                    <table className="insight-table"><thead><tr>{res.columns.map((col, j) => <th key={j}>{col}</th>)}</tr></thead><tbody>{(res.rows ?? []).slice(0, 100).map((r, j) => <tr key={j}>{r.map((v, k) => <td key={k}>{v ?? <span className="muted">empty</span>}</td>)}</tr>)}</tbody></table>
                    <p className="muted">{(res.rows ?? []).length} row{(res.rows ?? []).length === 1 ? "" : "s"}{res.truncated ? ", cut off at 1,000" : ""}{(res.rows ?? []).length > 100 ? "; the first 100 are shown" : ""} · {((res.ms ?? 0) / 1000).toFixed(1)} s</p>
                  </div>
                ))}
              </div>
            );
          })}
          {open.mine && (
            <div className="insight-controls">
              <button className="secondary" onClick={() => change([...open.cells, { id: newId(), kind: "sql", text: "" }])}>Add a query</button>
              <button className="secondary" onClick={() => change([...open.cells, { id: newId(), kind: "note", text: "" }])}>Add a note</button>
            </div>
          )}
          <p className="muted">Queries read the workbook's tables and change nothing. Python is not available here: a notebook is SQL and words.</p>
        </section>
      )}
    </main>
  );
}
