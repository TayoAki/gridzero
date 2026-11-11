// Metric models in Apache Ossie format: upload, export, delete, and try a query.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { api } from "./catalog";

interface Model {
  id: string;
  name: string;
  connectionId: string;
  metrics: { name: string; description: string }[];
  fields: string[];
}
interface Conn {
  id: string;
  name: string;
  kind: string;
}

/** Simple CSV to rows (quotes and doubled quotes; enough for query results). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

function QueryForm({ model }: { model: Model }) {
  const [metric, setMetric] = useState(model.metrics[0]?.name ?? "");
  const [groups, setGroups] = useState<string[]>(["", "", ""]);
  const [result, setResult] = useState<{ sql: string; csv: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api<{ sql: string; csv: string; truncated: boolean; error?: string }>("POST", `/api/v1/metrics/${model.id}/query`, {
      metric,
      group_by: groups.filter(Boolean),
      order: "desc",
      limit: 50,
    });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.data?.error ?? `The query failed (${r.status}).`);
  }

  const rows = result ? parseCsv(result.csv) : [];
  return (
    <form className="metric-query" onSubmit={run}>
      <div className="metric-query-row">
        <label className="field">
          Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            {model.metrics.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        </label>
        {groups.map((g, i) => (
          <label className="field" key={i}>
            Group by {i + 1}
            <select value={g} onChange={(e) => setGroups(groups.map((x, j) => (j === i ? e.target.value : x)))}>
              <option value="">(none)</option>
              {model.fields.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        ))}
        <button className="primary-inline" type="submit" disabled={busy || !metric}>{busy ? "Running…" : "Run"}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {result && (
        <>
          <pre className="metric-sql">{result.sql}</pre>
          <div className="table-scroll">
            <table className="usage-table">
              <thead><tr>{rows[0]?.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{rows.slice(1, 51).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {result.truncated && <p className="collab-note">Showing the first 50 rows.</p>}
        </>
      )}
    </form>
  );
}

export function MetricsPage() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [connId, setConnId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function load() {
    const [m, c] = await Promise.all([api<{ models: Model[] }>("GET", "/api/v1/metrics"), api<{ connections: Conn[] }>("GET", "/api/v1/connections")]);
    setModels(m.ok ? m.data.models : []);
    if (c.ok) {
      setConns(c.data.connections);
      setConnId((cur) => cur || c.data.connections[0]?.id || "");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    const r = await api<{ error?: string }>("POST", "/api/v1/metrics", { connectionId: connId, yaml: await file.text() });
    if (!r.ok) return setError(r.data?.error ?? `Upload failed (${r.status}).`);
    setFile(null);
    (e.target as HTMLFormElement).reset();
    load();
  }

  async function remove(m: Model) {
    if (!window.confirm(`Delete the metric model "${m.name}"?`)) return;
    if ((await api("DELETE", `/api/v1/metrics/${m.id}`)).ok) load();
  }

  return (
    <main className="main metrics-page">
      <h1>Metrics</h1>
      <p className="collab-note">
        Define each number once as an Apache Ossie semantic model. Agents use these metrics before writing their own SQL, and you can export a model to use in other tools.
      </p>

      <form className="settings-card" onSubmit={upload}>
        <h2>Upload a model</h2>
        {conns.length === 0 ? (
          <p>Add a database connection from a workbook first; a model runs on one connection.</p>
        ) : (
          <>
            <label className="field">
              Connection
              <select value={connId} onChange={(e) => setConnId(e.target.value)}>
                {conns.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
              </select>
            </label>
            <label className="field">
              Ossie YAML file
              <input type="file" accept=".yaml,.yml" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary-inline" type="submit" disabled={!file || !connId}>Upload</button>
          </>
        )}
      </form>

      {models === null ? (
        <p>Loading…</p>
      ) : models.length === 0 ? (
        <div className="empty"><strong>No metric models yet</strong>Upload an Ossie YAML file to get started.</div>
      ) : (
        models.map((m) => (
          <section className="settings-card metric-model" key={m.id}>
            <div className="metric-head">
              <h2>{m.name}</h2>
              <span className="workbook-meta">{conns.find((c) => c.id === m.connectionId)?.name ?? "connection"}</span>
              <span className="chat-head-spacer" />
              <a className="secondary" href={`/api/v1/metrics/${m.id}/export`}>Export</a>
              <button className="secondary" onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? "Close" : "Try a query"}</button>
              <button className="link-button danger" onClick={() => remove(m)}>Delete</button>
            </div>
            <ul className="metric-list">
              {m.metrics.map((x) => <li key={x.name}><code>{x.name}</code>{x.description && ` — ${x.description}`}</li>)}
            </ul>
            {open === m.id && <QueryForm model={m} />}
          </section>
        ))
      )}
    </main>
  );
}
