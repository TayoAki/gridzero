// On the account page: personal tokens for reading from outside the app, and the models whose
// predictions land in a workbook table.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { api } from "../agents/catalog";

interface Token {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
interface Model {
  id: string;
  name: string;
  version: string;
  workbookId: string;
  table: string;
  notes: string;
  history: { version: string; at: string }[];
}

export function Tokens() {
  const [list, setList] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ tokens: Token[] }>("GET", "/api/v1/tokens").then((r) => r.ok && setList(r.data.tokens));
  useEffect(() => {
    void load();
  }, []);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ token: string; error?: string }>("POST", "/api/v1/tokens", { name });
    if (!r.ok) return setError(r.data?.error ?? "The token could not be made.");
    setMade(r.data.token);
    setName("");
    setError(null);
    void load();
  };
  return (
    <section className="account-section" aria-labelledby="tokens-title">
      <h2 id="tokens-title">Tokens for reading from outside</h2>
      <p className="collab-note">For a notebook, a script or a pipeline. A token reads what you can see and changes nothing: the catalog of definitions with their versions (<code>GET /api/v1/catalog</code>) and the read-only query over a workbook's tables. Send it as <code>Authorization: Bearer …</code>.</p>
      <form className="insight-controls" onSubmit={make}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What will use it, e.g. Churn notebook" aria-label="A name for the token" required maxLength={60} />
        <button className="primary-inline">Make a token</button>
      </form>
      {made && <p className="token-once" role="status">Copy it now: it is not shown again. <input readOnly value={made} aria-label="The new token" onFocus={(e) => e.target.select()} /></p>}
      {error && <p className="error" role="alert">{error}</p>}
      {list.length > 0 && <ul className="insight-list">{list.map((t) => <li key={t.id} className="watch-row"><span>{t.name} <span className="muted">made {new Date(t.createdAt).toLocaleDateString()} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}</span></span><button className="link-button danger" onClick={async () => { await api("DELETE", `/api/v1/tokens/${t.id}`); void load(); }}>Remove</button></li>)}</ul>}
    </section>
  );
}

export function Models() {
  const [list, setList] = useState<Model[]>([]);
  const [books, setBooks] = useState<{ id: string; title: string }[]>([]);
  const [form, setForm] = useState({ name: "", version: "1", workbookId: "", table: "" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = () => api<{ models: Model[] }>("GET", "/api/v1/models").then((r) => r.ok && setList(r.data.models));
  useEffect(() => {
    void load();
    api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks").then((r) => { if (r.ok) { setBooks(r.data.workbooks); setForm((f) => ({ ...f, workbookId: r.data.workbooks[0]?.id ?? "" })); } });
  }, []);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("POST", "/api/v1/models", form);
    if (!r.ok) return setError(r.data?.error === "not found" ? "You cannot change that workbook." : (r.data?.error ?? "The model could not be registered."));
    setForm({ ...form, name: "", table: "" });
    setError(null);
    void load();
  };
  const bump = async (m: Model) => {
    const version = window.prompt(`${m.name} is version ${m.version}. What is the new version?`);
    if (!version) return;
    const notes = window.prompt("What changed? The owners of the reports that read it are told this.") ?? "";
    const r = await api<{ told: number; error?: string }>("PATCH", `/api/v1/models/${m.id}`, { version, ...(notes ? { notes } : {}) });
    if (!r.ok) return setError(r.data?.error ?? "The version could not be changed.");
    setNote(r.data.told ? `${r.data.told} owner${r.data.told === 1 ? "" : "s"} of reports that read ${m.table} told.` : "Recorded. Nobody else owns a report that reads it.");
    void load();
  };
  return (
    <section className="account-section" aria-labelledby="models-title">
      <h2 id="models-title">Models</h2>
      <p className="collab-note">Register a model whose predictions land in a workbook table. Reports that read that table say which version they rest on, and their owners are told when it changes. The model itself runs elsewhere.</p>
      {list.length > 0 && <ul className="insight-list">{list.map((m) => <li key={m.id} className="watch-row"><span><strong>{m.name}</strong> version {m.version} <span className="muted">predictions in {m.table}{m.history.length ? ` · earlier: ${m.history.map((h) => h.version).join(", ")}` : ""}</span></span><span className="insight-controls"><button className="secondary" onClick={() => void bump(m)}>New version…</button><button className="link-button danger" onClick={async () => { await api("DELETE", `/api/v1/models/${m.id}`); void load(); }}>Remove</button></span></li>)}</ul>}
      {note && <p className="ok-note" role="status">{note}</p>}
      <form className="work-row" onSubmit={add}>
        <label className="field work-grow">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} placeholder="Churn model" /></label>
        <label className="field">Version<input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} required maxLength={40} className="report-small" /></label>
        <label className="field">Workbook<select value={form.workbookId} onChange={(e) => setForm({ ...form, workbookId: e.target.value })}>{books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
        <label className="field">Table with its predictions<input value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} required maxLength={200} placeholder="scores" /></label>
        <button className="primary-inline">Register</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
