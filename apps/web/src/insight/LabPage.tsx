// Notebooks: cells of SQL and of words over one workbook's tables, run in order or one at a time.
// Beside them, the experiment runs recorded against that workbook, each tied to the version of the
// data it used.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { api } from "../agents/catalog";
import { useTabTitle } from "../shell/context";

interface Cell {
  id: string;
  kind: "sql" | "note" | "python";
  text: string;
}
interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  mine: boolean;
  everyHours?: number | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: "ok" | "error" | null;
  lastOutput?: string | null;
  modelId?: string | null;
  writes?: string[];
}
interface Result {
  columns?: string[];
  rows?: (string | null)[][];
  truncated?: boolean;
  ms?: number;
  error?: string | null;
  /** What a Python cell printed, and the tables it saved. */
  output?: string;
  saved?: { name: string; columns: string[]; rows: string[][]; count: number }[];
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
  const [python, setPython] = useState(true);
  const [models, setModels] = useState<{ id: string; name: string; workbookId: string; table: string }[]>([]);
  const [ran, setRan] = useState<string | null>(null);

  useEffect(() => {
    api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks").then((r) => {
      const all = r.ok ? r.data.workbooks : [];
      setBooks(all);
      if (!book && all[0]) setParams({ wb: all[0].id }, { replace: true });
    });
  }, []);
  const load = () => {
    if (!book) return;
    void api<{ notebooks: Notebook[]; python: boolean }>("GET", `/api/v1/workbooks/${book}/notebooks`).then((r) => { setList(r.ok ? r.data.notebooks : []); if (r.ok) { setPython(r.data.python); setOpen((o) => (o ? (r.data.notebooks.find((n) => n.id === o.id) ? { ...r.data.notebooks.find((n) => n.id === o.id)!, cells: o.cells, title: o.title } : o) : o)); } });
    void api<{ models: { id: string; name: string; workbookId: string; table: string }[] }>("GET", "/api/v1/models").then((r) => setModels(r.ok ? r.data.models.filter((m) => m.workbookId === book) : []));
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
    if (cell.kind === "python") {
      // Python cells share what they make: this one runs after every Python cell above it, in one go.
      const upTo = open!.cells.slice(0, open!.cells.findIndex((c) => c.id === cell.id) + 1).filter((c) => c.kind === "python" && c.text.trim()).map((c) => c.text).join("\n\n");
      const r = await api<Result>("POST", `/api/v1/workbooks/${book}/python`, { source: upTo });
      return setResults((x) => ({ ...x, [cell.id]: r.ok ? { ...r.data, columns: [] } : { error: r.data?.error ?? "The cell could not be run." } }));
    }
    const r = await api<Result>("POST", `/api/v1/workbooks/${book}/query`, { sql: cell.text });
    setResults((x) => ({ ...x, [cell.id]: r.ok ? r.data : { error: r.data?.error ?? "The query could not be run." } }));
  };
  const runAll = async () => {
    const cells = open?.cells ?? [];
    // The last Python cell runs all of them; the ones above it need not run twice.
    const lastPython = [...cells].reverse().find((c) => c.kind === "python" && c.text.trim());
    for (const c of cells) if ((c.kind === "sql" && c.text.trim()) || c === lastPython) await run(c);
  };
  const write = async () => {
    if (!open) return;
    if (!saved) await save();
    setRan("Running…");
    const r = await api<{ status: string; output: string; landed: { name: string; rows: number }[]; version: string | null }>("POST", `/api/v1/notebooks/${open.id}/run`);
    setRan(!r.ok ? "The notebook could not be run." : r.data.status === "ok" ? `${r.data.landed.length ? `Wrote ${r.data.landed.map((l) => `${l.name} (${l.rows} rows)`).join(", ")} into the workbook.` : "It ran. Nothing was saved, so nothing was written: call save(name, data) in a cell."}${r.data.version ? ` The model is now version "${r.data.version}".` : ""}` : `It failed: ${r.data.output.slice(-400)}`);
    load();
  };
  const schedule = async (body: Record<string, unknown>) => {
    if (!open) return;
    const r = await api<{ error?: string }>("PUT", `/api/v1/notebooks/${open.id}/schedule`, body);
    setRan(r.ok ? null : (r.data?.error ?? "That could not be saved."));
    load();
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
                  <span className="muted">{c.kind === "sql" ? `Query ${open.cells.slice(0, i + 1).filter((x) => x.kind === "sql").length}` : c.kind === "python" ? `Python ${open.cells.slice(0, i + 1).filter((x) => x.kind === "python").length}` : "Note"}</span>
                  {c.kind !== "note" && <button className="secondary" disabled={c.kind === "python" && !python} onClick={() => void run(c)}>Run</button>}
                  {open.mine && <button className="link-button" disabled={i === 0} onClick={() => change(open.cells.map((x, j) => (j === i - 1 ? c : j === i ? open.cells[i - 1]! : x)))} aria-label="Move this cell up">↑</button>}
                  {open.mine && <button className="link-button" onClick={() => change(open.cells.filter((x) => x.id !== c.id))} aria-label="Remove this cell">✕</button>}
                </div>
                <textarea value={c.text} readOnly={!open.mine} rows={Math.min(14, Math.max(2, c.text.split("\n").length))} spellCheck={c.kind === "note"} onChange={(e) => change(open.cells.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)))} onKeyDown={(e) => { if (c.kind !== "note" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(c); } }} aria-label={c.kind === "sql" ? "Query" : c.kind === "python" ? "Python" : "Note"} placeholder={c.kind === "sql" ? 'SELECT … FROM "orders"   (Ctrl+Enter runs it)' : c.kind === "python" ? 'df = table("orders").df()\nsave("scores", df)   # table(), sql(), tables() and save() are ready to use' : "Write what this step is for, or what it showed."} />
                {res && c.kind === "python" && res.columns && (
                  <div className="cell-result">
                    {res.output && <pre className="cell-out">{res.output}</pre>}
                    {res.error && <pre className="cell-out cell-err" role="alert">{res.error}</pre>}
                    {(res.saved ?? []).map((s) => (
                      <div key={s.name} className="insight-scroll">
                        <table className="insight-table"><caption>{s.name}: {s.count.toLocaleString()} rows{s.count > s.rows.length ? `, the first ${s.rows.length} shown` : ""}</caption><thead><tr>{s.columns.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>{s.rows.slice(0, 20).map((r, j) => <tr key={j}>{r.map((v, k) => <td key={k}>{v}</td>)}</tr>)}</tbody></table>
                      </div>
                    ))}
                    <p className="muted">{((res.ms ?? 0) / 1000).toFixed(1)} s</p>
                  </div>
                )}
                {res && c.kind === "python" && !res.columns && (res.error ? <p className="error" role="alert">{res.error}</p> : <p className="muted">Running…</p>)}
                {res && c.kind !== "python" && (res.error ? <p className="error" role="alert">{res.error}</p> : !res.columns ? <p className="muted">Running…</p> : (
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
              <button className="secondary" onClick={() => change([...open.cells, { id: newId(), kind: "python", text: "" }])}>Add Python</button>
              <button className="secondary" onClick={() => change([...open.cells, { id: newId(), kind: "note", text: "" }])}>Add a note</button>
            </div>
          )}
          {open.mine && open.cells.some((c) => c.kind === "python") && (
            <div className="notebook-run">
              <strong>Run it for real</strong>
              <p className="muted">Running a cell shows what it would save. This runs every Python cell from the top as you and writes each saved table into the workbook, over the table an earlier run made.</p>
              <div className="insight-controls">
                <button className="primary-inline" disabled={!python} onClick={write}>Run and write to the workbook</button>
                <label>Repeat <select value={open.everyHours ?? ""} onChange={(e) => void schedule({ everyHours: e.target.value ? Number(e.target.value) : null })} aria-label="How often the notebook runs"><option value="">only when asked</option><option value="1">every hour</option><option value="24">every day</option><option value="168">every week</option></select></label>
                {models.length > 0 && <label>These are the predictions of <select value={open.modelId ?? ""} onChange={(e) => void schedule({ modelId: e.target.value || null })} aria-label="The model this notebook writes predictions for"><option value="">no model</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name} (writes {m.table})</option>)}</select></label>}
              </div>
              {open.modelId && <p className="muted">Each run that saves the model's table is a new version of the model. Its predictions are kept, so going back a version puts them back.</p>}
              {ran && <p className={/failed|could not/.test(ran) ? "error" : "ok-note"} role="status">{ran}</p>}
              {open.lastRunAt && <p className="muted">Last run {new Date(open.lastRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}: {open.lastStatus === "ok" ? "worked" : "failed"}{open.writes?.length ? `; writes ${open.writes.join(", ")}` : ""}{open.nextRunAt ? `; next ${new Date(open.nextRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}.</p>}
            </div>
          )}
          <p className="muted">{python ? "Queries and Python read copies of the workbook's tables. Python has no network, cannot see any other file, and is stopped after two minutes. pandas, numpy and DuckDB are there; there is no machine-learning library." : "Python cells cannot run on this server: it needs Linux on x86-64, where a cell can be confined. SQL cells work."}</p>
        </section>
      )}
    </main>
  );
}
