// Tables people type into, under a report's cards. Either free rows, or columns beside the rows of a
// table card, matched by a key column. A table takes entries only once the report's owner has approved it.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { api } from "../agents/catalog";
import type { Widget } from "./spec";

interface Col {
  name: string;
  kind: "text" | "number" | "date" | "choice";
  options?: string[];
}
interface Row {
  id: string;
  key: string | null;
  values: Record<string, string | number | null>;
  by: string;
  at: string;
}
interface Table {
  id: string;
  name: string;
  columns: Col[];
  widgetId: string | null;
  keyColumn: string | null;
  status: "draft" | "pending" | "live";
  rows: Row[];
}
const STATUS = { draft: "Draft: takes no entries yet", pending: "Waiting for the owner's approval", live: "Published" };

function Cell({ col, value, disabled, onSave }: { col: Col; value: string | number | null; disabled: boolean; onSave: (v: string) => void }) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  useEffect(() => setText(value === null || value === undefined ? "" : String(value)), [value]);
  const done = () => text !== (value === null || value === undefined ? "" : String(value)) && onSave(text);
  if (col.kind === "choice") return <select aria-label={col.name} disabled={disabled} value={text} onChange={(e) => { setText(e.target.value); onSave(e.target.value); }}><option value=""></option>{(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  return <input aria-label={col.name} disabled={disabled} type={col.kind === "date" ? "date" : "text"} inputMode={col.kind === "number" ? "decimal" : undefined} value={text} onChange={(e) => setText(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

function NewTable({ boardId, cards, onMade }: { boardId: string; cards: Widget[]; onMade: () => void }) {
  const [name, setName] = useState("");
  const [cols, setCols] = useState<{ name: string; kind: Col["kind"]; options: string }[]>([{ name: "Owner", kind: "text", options: "" }, { name: "Status", kind: "choice", options: "Open, Done" }]);
  const [card, setCard] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const columnsOf = (id: string) => { const w = cards.find((c) => c.id === id); return w?.data.kind === "table" ? w.data.columns : []; };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const columns = cols.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), kind: c.kind, ...(c.kind === "choice" ? { options: c.options.split(",").map((o) => o.trim()).filter(Boolean) } : {}) }));
    const r = await api<{ error?: string }>("POST", `/api/v1/dashboards/${boardId}/inputs`, { name, columns, ...(card ? { widgetId: card, keyColumn: key } : {}) });
    if (!r.ok) return setError(r.data?.error ?? "The table could not be added.");
    onMade();
  };
  return (
    <form className="report-form work-new" onSubmit={submit}>
      <div className="work-row">
        <label className="field work-grow">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Renewals" required maxLength={80} /></label>
        <label className="field">Beside the rows of<select value={card} onChange={(e) => { setCard(e.target.value); setKey(columnsOf(e.target.value)[0] ?? ""); }} aria-label="The card these columns sit beside"><option value="">No card: free rows</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
        {card && <label className="field">Rows are told apart by<select value={key} onChange={(e) => setKey(e.target.value)}>{columnsOf(card).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>}
      </div>
      {cols.map((c, i) => (
        <div className="work-row" key={i}>
          <label className="field work-grow">Column<input value={c.name} maxLength={40} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></label>
          <label className="field">Takes<select value={c.kind} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, kind: e.target.value as Col["kind"] } : x)))}><option value="text">Words</option><option value="number">A number</option><option value="date">A date</option><option value="choice">One of a list</option></select></label>
          {c.kind === "choice" && <label className="field work-grow">The list, comma separated<input value={c.options} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))} /></label>}
          <button type="button" className="link-button" aria-label="Remove this column" onClick={() => setCols(cols.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="insight-controls">
        {cols.length < 8 && <button type="button" className="link-button" onClick={() => setCols([...cols, { name: "", kind: "text", options: "" }])}>+ Add a column</button>}
        <button className="primary-inline">Add the table</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export function InputTables({ boardId, widgets, role }: { boardId: string; widgets: Widget[]; role: "owner" | "editor" | "viewer" }) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ tables: Table[] }>("GET", `/api/v1/dashboards/${boardId}/inputs`).then((r) => setTables(r.ok ? r.data.tables : []));
  useEffect(() => {
    void load();
  }, [boardId]);
  const cards = widgets.filter((w) => w.data.kind === "table");
  const save = async (t: Table, target: { id?: string; key?: string }, col: Col, value: string) => {
    const r = await api<{ error?: string }>("PUT", `/api/v1/inputs/${t.id}/rows`, { ...target, values: { [col.name]: value } });
    setError(r.ok ? null : (r.data?.error ?? "That entry could not be saved."));
    void load();
  };
  const step = async (t: Table, what: "submit" | "approve" | "withdraw") => {
    const r = await api<{ error?: string }>("POST", `/api/v1/inputs/${t.id}/${what}`);
    setError(r.ok ? null : (r.data?.error ?? "That could not be done."));
    void load();
  };
  if (tables === null || (tables.length === 0 && role === "viewer")) return null;
  return (
    <section className="inputs" aria-label="Tables to fill in">
      <div className="inputs-head">
        <h2>Tables to fill in</h2>
        {role !== "viewer" && <button className="secondary" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Add a table to fill in"}</button>}
      </div>
      {tables.length === 0 && !adding && <p className="collab-note">A table people type into: free rows, or an owner, a status and a date beside each row of a table card. Entries are kept here and nothing is written back to your database.</p>}
      {adding && <NewTable boardId={boardId} cards={cards} onMade={() => { setAdding(false); void load(); }} />}
      {error && <p className="error" role="alert">{error}</p>}
      {tables.map((t) => {
        const card = t.widgetId ? widgets.find((w) => w.id === t.widgetId) : null;
        const data = card?.data.kind === "table" ? card.data : null;
        const keyAt = data && t.keyColumn ? data.columns.indexOf(t.keyColumn) : -1;
        const shown = data ? data.columns.map((c, i) => ({ c, i })).filter((x) => x.i !== keyAt).slice(0, 3) : [];
        const off = t.status !== "live";
        return (
          <div key={t.id} className="input-table" data-testid="input-table">
            <div className="inputs-head">
              <h3>{t.name} <span className={`input-status input-${t.status}`}>{STATUS[t.status]}</span></h3>
              <span className="insight-controls">
                {t.status === "draft" && role === "editor" && <button className="secondary" onClick={() => void step(t, "submit")}>Ask the owner to publish it</button>}
                {t.status !== "live" && role === "owner" && <button className="primary-inline" onClick={() => void step(t, "approve")}>Publish: everyone who can open this report may add entries</button>}
                {t.status === "live" && role === "owner" && <button className="link-button" onClick={() => void step(t, "withdraw")}>Stop taking entries</button>}
                {role === "owner" && <button className="link-button danger" onClick={async () => { if (window.confirm(`Remove "${t.name}" and its ${t.rows.length} entries?`)) { await api("DELETE", `/api/v1/inputs/${t.id}`); void load(); } }}>Remove</button>}
              </span>
            </div>
            <div className="insight-scroll">
              <table className="insight-table input-grid">
                <thead><tr>{data && keyAt >= 0 && <th>{t.keyColumn}</th>}{shown.map((x) => <th key={x.c}>{x.c}</th>)}{t.columns.map((c) => <th key={c.name} className="input-col">{c.name}</th>)}<th>Last changed</th></tr></thead>
                <tbody>
                  {data && keyAt >= 0
                    ? data.rows.slice(0, 200).map((r, i) => {
                        const key = String(r[keyAt] ?? "");
                        const row = t.rows.find((x) => x.key === key);
                        return <tr key={i}><td>{key}</td>{shown.map((x) => <td key={x.c}>{r[x.i]}</td>)}{t.columns.map((c) => <td key={c.name}><Cell col={c} value={row?.values[c.name] ?? null} disabled={off || !key} onSave={(v) => void save(t, { key }, c, v)} /></td>)}<td className="muted">{row ? `${row.by}, ${new Date(row.at).toLocaleDateString()}` : ""}</td></tr>;
                      })
                    : t.rows.map((row) => <tr key={row.id}>{t.columns.map((c) => <td key={c.name}><Cell col={c} value={row.values[c.name] ?? null} disabled={off} onSave={(v) => void save(t, { id: row.id }, c, v)} /></td>)}<td className="muted">{row.by}, {new Date(row.at).toLocaleDateString()}</td></tr>)}
                  {!t.widgetId && !off && <tr className="input-new">{t.columns.map((c, i) => <td key={c.name}><Cell key={t.rows.length} col={c} value={null} disabled={false} onSave={(v) => void save(t, {}, c, v)} /></td>)}<td className="muted">New entry</td></tr>}
                </tbody>
              </table>
            </div>
            {t.widgetId && !data && <p className="collab-note">The card these columns sat beside is gone, or shows no table for you.</p>}
          </div>
        );
      })}
    </section>
  );
}
