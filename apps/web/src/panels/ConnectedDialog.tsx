// M6: database connections and connected tables (Data → Connected tables…).

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useEscape } from "../use-escape";

interface Connection {
  id: string;
  kind: "postgres" | "snowflake";
  name: string;
}

interface Connected {
  id: string;
  name: string;
  sql: string;
  schedule: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  rowCount: number | null;
}

const SCHEDULES: [string, string][] = [
  ["", "Manual only"],
  ["0 * * * *", "Every hour"],
  ["0 6 * * *", "Every day at 06:00 UTC"],
  ["0 6 * * 1", "Every Monday at 06:00 UTC"],
];

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

const EMPTY = { kind: "postgres" as Connection["kind"], name: "", host: "", port: "5432", database: "", user: "", ssl: "verify", secret: "", account: "", warehouse: "", schema: "", role: "", auth: "password" };

export function ConnectedDialog({ id, readOnly, onClose }: { id: string; readOnly: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tables, setTables] = useState<Connected[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [table, setTable] = useState({ connectionId: "", name: "", sql: "", schedule: "" });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [c, t] = await Promise.all([api("/api/v1/connections"), api(`/api/v1/workbooks/${id}/connected-tables`)]);
    setConnections(c.connections);
    setTables(t.tables);
    setTable((x) => (x.connectionId || !c.connections[0] ? x : { ...x, connectionId: c.connections[0].id }));
  };
  useEffect(() => void load().catch((e: Error) => setError(e.message)), [id]);

  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const payload = () => ({
    kind: form.kind,
    name: form.name,
    secret: form.secret,
    config: form.kind === "postgres"
      ? { host: form.host, port: form.port, database: form.database, user: form.user, ssl: form.ssl }
      : { account: form.account, warehouse: form.warehouse, database: form.database, schema: form.schema, role: form.role, user: form.user, auth: form.auth },
  });

  const field = (key: keyof typeof EMPTY, label: string, type = "text") => (
    <label>{label} <input type={type} aria-label={label} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>
  );

  function testIt() {
    void work(async () => {
      const r = await api("/api/v1/connections/test", "POST", payload());
      if (!r.ok) throw new Error(r.error);
      setNote("Connected.");
    });
  }

  function saveConnection(e: FormEvent) {
    e.preventDefault();
    void work(async () => {
      const c = await api("/api/v1/connections", "POST", payload());
      setForm(EMPTY);
      setAdding(false);
      setTable((x) => ({ ...x, connectionId: c.id }));
      await load();
    });
  }

  function addTable(e: FormEvent) {
    e.preventDefault();
    void work(async () => {
      const r = await api(`/api/v1/workbooks/${id}/connected-tables`, "POST", table);
      if (r.error) throw new Error(r.error);
      setNote(`Loaded ${Number(r.rows).toLocaleString()} rows.`);
      setTable((x) => ({ ...x, name: "", sql: "", schedule: "" }));
      await load();
    });
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog" role="dialog" aria-label="Connected tables">
        <div className="dialog-head">
          <h2>Connected tables</h2>
          <button className="link-button" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {note && <p className="collab-note" role="status">{note}</p>}

        <ul className="share-list">
          {tables.map((t) => (
            <li key={t.id}>
              <span className="share-email">
                {t.name}
                <span className="comment-meta">
                  {" · "}{t.lastStatus === "error" ? `Failed: ${t.lastError}` : t.lastRunAt ? `${(t.rowCount ?? 0).toLocaleString()} rows, ${new Date(t.lastRunAt).toLocaleString()}` : "Not run yet"}
                  {t.schedule ? ` · ${t.schedule}` : ""}
                </span>
              </span>
              {!readOnly && (
                <>
                  <button className="link-button" disabled={busy} onClick={() => void work(async () => { await api(`/api/v1/workbooks/${id}/connected-tables/${t.id}/refresh`, "POST").finally(load); setNote("Refreshed."); })}>Refresh</button>
                  <button className="link-button danger" disabled={busy} onClick={() => void work(async () => { await api(`/api/v1/workbooks/${id}/connected-tables/${t.id}`, "DELETE"); await load(); })} aria-label={`Disconnect ${t.name}`}>Disconnect</button>
                </>
              )}
            </li>
          ))}
        </ul>

        {!readOnly && !adding && (
          <form onSubmit={addTable}>
            <h3 className="share-sub">New connected table</h3>
            <div className="share-row">
              <select aria-label="Connection" value={table.connectionId} onChange={(e) => setTable({ ...table, connectionId: e.target.value })}>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
              </select>
              <button type="button" className="link-button" onClick={() => setAdding(true)}>Add connection</button>
            </div>
            <div className="share-row">
              <input required aria-label="Table name" placeholder="Table name" value={table.name} onChange={(e) => setTable({ ...table, name: e.target.value })} />
              <select aria-label="Refresh schedule" value={table.schedule} onChange={(e) => setTable({ ...table, schedule: e.target.value })}>
                {SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <textarea className="sql-editor" required aria-label="SQL query" placeholder="select * from orders" spellCheck={false} value={table.sql} onChange={(e) => setTable({ ...table, sql: e.target.value })} />
            <div className="dialog-foot">
              <button className="primary share-send" type="submit" disabled={busy || !table.connectionId}>{busy ? "Running…" : "Run and add"}</button>
            </div>
          </form>
        )}

        {!readOnly && adding && (
          <form onSubmit={saveConnection}>
            <h3 className="share-sub">New connection</h3>
            <div className="form-grid">
              <label>Type
                <select aria-label="Type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Connection["kind"] })}>
                  <option value="postgres">Postgres</option>
                  <option value="snowflake">Snowflake</option>
                </select>
              </label>
              {field("name", "Name")}
              {form.kind === "postgres" ? (
                <>
                  {field("host", "Host")}
                  {field("port", "Port")}
                  {field("database", "Database")}
                  {field("user", "User")}
                  {field("secret", "Password", "password")}
                  <label>Encryption
                    <select aria-label="Encryption" value={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.value })}>
                      <option value="verify">TLS, verify certificate</option>
                      <option value="require">TLS, any certificate</option>
                      <option value="disable">No TLS</option>
                    </select>
                  </label>
                </>
              ) : (
                <>
                  {field("account", "Account")}
                  {field("warehouse", "Warehouse")}
                  {field("database", "Database")}
                  {field("schema", "Schema")}
                  {field("role", "Role")}
                  {field("user", "User")}
                  <label>Sign in with
                    <select aria-label="Sign in with" value={form.auth} onChange={(e) => setForm({ ...form, auth: e.target.value })}>
                      <option value="password">Password</option>
                      <option value="key_pair">Key pair</option>
                    </select>
                  </label>
                  {form.auth === "password" ? field("secret", "Password", "password") : (
                    <label>Private key (PEM) <textarea aria-label="Private key" className="sql-editor" spellCheck={false} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} /></label>
                  )}
                </>
              )}
            </div>
            <div className="dialog-foot">
              <button type="button" className="link-button" onClick={() => setAdding(false)}>Cancel</button>
              <button type="button" className="link-button" disabled={busy} onClick={testIt}>Test</button>
              <button className="primary share-send" type="submit" disabled={busy}>Save</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
