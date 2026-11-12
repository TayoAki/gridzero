// More of what an administrator does: groups, the starter list for each kind of work, the questions
// people ask most, what the warehouse bills, and what a Unity Catalog server holds.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { api } from "../agents/catalog";
import { LENSES } from "./LensHome";

interface Group {
  id: string;
  name: string;
  members: { email: string; name: string }[];
}
export function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ groups: Group[] }>("GET", "/api/v1/groups").then((r) => r.ok && setGroups(r.data.groups));
  useEffect(() => {
    void load();
  }, []);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await api<{ error?: string }>(method, path, body);
    setError(r.ok ? null : (r.data?.error ?? "That could not be done."));
    void load();
  };
  return (
    <>
      <p className="muted">A group is a named set of people. The owner of a report can share it with a group: whoever joins later gets it, whoever leaves loses it.</p>
      <form className="insight-controls" onSubmit={(e: FormEvent) => { e.preventDefault(); void call("POST", "/api/v1/admin/groups", { name }).then(() => setName("")); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales leads" aria-label="Name of the new group" required minLength={2} maxLength={60} />
        <button className="primary-inline">Add a group</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {groups.map((g) => (
        <section key={g.id} className="check">
          <h3>{g.name} <span className="muted">{g.members.length} {g.members.length === 1 ? "person" : "people"}</span> <button className="link-button danger" onClick={() => { if (window.confirm(`Remove the group ${g.name}? Reports shared with it stop being shared with its members.`)) void call("DELETE", `/api/v1/admin/groups/${g.id}`); }}>Remove</button></h3>
          <ul className="insight-list">{g.members.map((m) => <li key={m.email} className="watch-row"><span>{m.name} <span className="muted">{m.email}</span></span><button className="link-button" onClick={() => void call("PUT", `/api/v1/admin/groups/${g.id}/members`, { email: m.email, on: false })}>Take out</button></li>)}</ul>
          <form className="insight-controls" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const input = e.currentTarget.elements.namedItem("email") as HTMLInputElement; void call("PUT", `/api/v1/admin/groups/${g.id}/members`, { email: input.value, on: true }).then(() => (input.value = "")); }}>
            <input name="email" type="email" placeholder="their email" aria-label={`Add someone to ${g.name}`} required />
            <button className="secondary">Add to the group</button>
          </form>
        </section>
      ))}
    </>
  );
}

export function StarterLists() {
  const [lens, setLens] = useState<string>("decide");
  const [text, setText] = useState("");
  const [progress, setProgress] = useState<{ lens: string; started: number; items: { text: string; people: number }[] }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const load = () => api<{ lists: typeof progress }>("GET", "/api/v1/admin/checklists").then((r) => r.ok && setProgress(r.data.lists));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    api<{ items: { text: string; link: string | null }[] }>("GET", `/api/v1/checklists/${lens}`).then((r) => setText(r.ok ? r.data.items.map((i) => (i.link ? `${i.text} | ${i.link}` : i.text)).join("\n") : ""));
    setNote(null);
  }, [lens]);
  const save = async () => {
    const items = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [t, link] = l.split("|").map((x) => x.trim()); return { text: t!, ...(link ? { link } : {}) }; });
    const r = await api<{ error?: string }>("PUT", `/api/v1/admin/checklists/${lens}`, { items });
    setNote(r.ok ? "Saved. People who chose this kind of work see it at the top of Home until they have ticked every step." : (r.data?.error ?? "That could not be saved."));
    void load();
  };
  const seen = progress.find((p) => p.lens === lens);
  return (
    <>
      <p className="muted">The first steps for each kind of work, shown at the top of Home. One step per line; to link a step to a page, add a bar and the page's address, such as <code>Open your report | /dashboards</code>.</p>
      <div className="lens-pick" role="radiogroup" aria-label="Kind of work">{LENSES.map(([id, label]) => <button key={id} role="radio" aria-checked={lens === id} className={lens === id ? "on" : ""} onClick={() => setLens(id)}>{label}</button>)}</div>
      <textarea className="admin-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} aria-label="Steps, one per line" placeholder={"Open the report your manager shared | /dashboards\nSet a target on your main figure"} />
      <div><button className="primary-inline" onClick={save}>Save the list</button></div>
      {note && <p className="ok-note" role="status">{note}</p>}
      {seen && seen.items.length > 0 && <div className="insight-scroll"><table className="insight-table"><thead><tr><th>Step</th><th className="num">People who have done it</th></tr></thead><tbody>{seen.items.map((i) => <tr key={i.text}><td>{i.text}</td><td className="num">{i.people}</td></tr>)}</tbody></table></div>}
    </>
  );
}

export function TopQuestions() {
  const [data, setData] = useState<{ days: number; read: number; questions: { text: string; times: number; people: number }[] } | null>(null);
  const [about, setAbout] = useState("");
  const load = () => api<NonNullable<typeof data>>("GET", `/api/v1/admin/questions?days=30${about.trim() ? `&about=${encodeURIComponent(about.trim())}` : ""}`).then((r) => r.ok && setData(r.data));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <p className="muted">Questions put to agents more than once in the last 30 days, counted across people. Names are not shown, and a question asked only once is left out.</p>
      <form className="insight-controls" onSubmit={(e: FormEvent) => { e.preventDefault(); void load(); }}>
        <input value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Only questions that mention…" aria-label="Only questions that mention a word" />
        <button className="secondary">Look</button>
      </form>
      {data && (data.questions.length === 0 ? <p>No question has been asked more than once{about ? " with that word" : ""}.</p> : (
        <div className="insight-scroll"><table className="insight-table"><thead><tr><th>Question</th><th className="num">Times</th><th className="num">People</th></tr></thead><tbody>{data.questions.map((x, i) => <tr key={i}><td>{x.text}</td><td className="num">{x.times}</td><td className="num">{x.people}</td></tr>)}</tbody></table></div>
      ))}
    </>
  );
}

interface Spend {
  table: string;
  total?: number;
  error?: string;
  byDay?: { day: string; cost: number }[];
  byOwner?: { owner: string; cost: number }[] | null;
}
export function WarehouseSpend() {
  const [spend, setSpend] = useState<Spend | null | undefined>(undefined);
  const [books, setBooks] = useState<{ id: string; title: string }[]>([]);
  const [form, setForm] = useState({ workbookId: "", table: "", date: "", cost: "", owner: "" });
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ warehouse: Spend | null }>("GET", "/api/v1/admin/spend?days=30").then((r) => setSpend(r.ok ? r.data.warehouse : null));
  useEffect(() => {
    void load();
    api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks").then((r) => { if (r.ok) { setBooks(r.data.workbooks); setForm((f) => ({ ...f, workbookId: r.data.workbooks[0]?.id ?? "" })); } });
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("PUT", "/api/v1/admin/billing", { workbookId: form.workbookId, table: form.table, date: form.date, cost: form.cost, ...(form.owner ? { owner: form.owner } : {}) });
    setError(r.ok ? null : (r.data?.error ?? "That could not be saved."));
    void load();
  };
  const top = Math.max(1, ...(spend?.byDay ?? []).map((d) => d.cost));
  return (
    <>
      <p className="muted">What the warehouse bills, read from a table you point to: any table with a date, a cost and, if there is one, who it is charged to. Bring it in as a connected table (Databricks and Snowflake both publish their billing as a table) and it stays up to date.</p>
      {spend && !spend.error && (
        <>
          <p><strong className="lens-big">{(spend.total ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> <span className="muted">in the last 30 days, from {spend.table}</span></p>
          <div className="quality-days" role="img" aria-label="Cost by day">{(spend.byDay ?? []).map((d) => <span key={d.day} className="fair" title={`${d.day}: ${d.cost}`} style={{ height: `${Math.max(4, (d.cost / top) * 52)}px` }} />)}</div>
          {spend.byOwner && <div className="insight-scroll"><table className="insight-table"><thead><tr><th>Charged to</th><th className="num">Cost</th></tr></thead><tbody>{spend.byOwner.map((o) => <tr key={o.owner}><td>{o.owner}</td><td className="num">{o.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td></tr>)}</tbody></table></div>}
        </>
      )}
      {spend?.error && <p className="error">{spend.error}</p>}
      <form className="report-form insight-announce" onSubmit={save}>
        <h3>{spend ? "Point at a different table" : "Point at the bill"}</h3>
        <div className="work-row">
          <label className="field">Workbook<select value={form.workbookId} onChange={(e) => setForm({ ...form, workbookId: e.target.value })}>{books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
          <label className="field">Table<input value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} required placeholder="billing" /></label>
          <label className="field">Date column<input value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required placeholder="usage_date" /></label>
          <label className="field">Cost column<input value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} required placeholder="cost" /></label>
          <label className="field">Charged-to column (optional)<input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="team" /></label>
        </div>
        <div><button className="primary-inline">Use this table</button></div>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}

interface Unity {
  on: boolean;
  url?: string;
  error?: string;
  catalogs: { name: string; schemas: { name: string; tables: { name: string; type: string; format: string; location: string }[] }[] }[];
}
export function UnityCatalog() {
  const [data, setData] = useState<Unity | null>(null);
  useEffect(() => {
    api<Unity>("GET", "/api/v1/admin/unity").then((r) => r.ok && setData(r.data));
  }, []);
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.on) return <p>No Unity Catalog server is set up. Set <code>UNITY_CATALOG_URL</code> (and a token if it needs one) on the server. Entries written out as Delta tables are then registered there, and its catalogs show here.</p>;
  return (
    <>
      <p className="muted">What the Unity Catalog server at {data.url} holds. Entries written out from a report are registered here as external Delta tables. Managing its workspaces and compute stays in the warehouse.</p>
      {data.error && <p className="error">{data.error}</p>}
      {data.catalogs.map((c) => (
        <section key={c.name} className="check">
          <h3>{c.name}</h3>
          {c.schemas.map((s) => (
            <div key={s.name}>
              <p><strong>{s.name}</strong> <span className="muted">{s.tables.length} table{s.tables.length === 1 ? "" : "s"}</span></p>
              {s.tables.length > 0 && <div className="insight-scroll"><table className="insight-table"><thead><tr><th>Table</th><th>Kind</th><th>Format</th><th>Where</th></tr></thead><tbody>{s.tables.map((t) => <tr key={t.name}><td>{t.name}</td><td>{t.type.toLowerCase()}</td><td>{t.format}</td><td><code>{t.location}</code></td></tr>)}</tbody></table></div>}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

interface Reliability {
  days: number;
  score: number | null;
  watched: number;
  tables: { name: string; refreshes: number; failed: number; onTime: number | null; incidents: number; lateHours: number; lateNow: boolean }[];
  weeks: { week: string; incidents: number; failed: number; refreshes: number }[];
}
export function ReliabilityView({ everyone, days }: { everyone: boolean; days: number }) {
  const [data, setData] = useState<Reliability | null>(null);
  useEffect(() => {
    api<Reliability>("GET", `/api/v1/activity/reliability?days=${days === 7 ? 30 : days}${everyone ? "&everyone=1" : ""}`).then((r) => r.ok && setData(r.data));
  }, [everyone, days]);
  if (!data) return <p className="muted">Loading…</p>;
  const top = Math.max(1, ...data.weeks.map((w) => w.refreshes));
  return (
    <>
      <p><strong className="lens-big">{data.score === null ? "No refreshes yet" : `${data.score}%`}</strong> <span className="muted">{data.score === null ? "" : `of refreshes worked in the last ${data.days} days · `}{data.watched} table{data.watched === 1 ? " is" : "s are"} watched for lateness</span></p>
      {data.weeks.length > 0 && (
        <>
          <h2>By week</h2>
          <div className="quality-days" role="img" aria-label="Refreshes by week; red where some failed">{data.weeks.map((w) => <span key={w.week} className={w.failed ? "poor" : "good"} title={`Week of ${w.week}: ${w.refreshes} refreshes, ${w.failed} failed, ${w.incidents} late`} style={{ height: `${Math.max(6, (w.refreshes / top) * 52)}px`, width: "18px" }} />)}</div>
        </>
      )}
      <div className="insight-scroll">
        <table className="insight-table">
          <thead><tr><th>Table</th><th className="num">Refreshes</th><th className="num">Failed</th><th className="num">Worked</th><th className="num">Times late</th><th className="num">Hours late</th></tr></thead>
          <tbody>{data.tables.map((t) => <tr key={t.name}><td>{t.name} {t.lateNow && <span className="insight-flag">late now</span>}</td><td className="num">{t.refreshes}</td><td className="num">{t.failed}</td><td className="num">{t.onTime === null ? "" : `${t.onTime}%`}</td><td className="num">{t.incidents}</td><td className="num">{t.lateHours}</td></tr>)}{data.tables.length === 0 && <tr><td colSpan={6} className="muted">No connected table has refreshed in this period.</td></tr>}</tbody>
        </table>
      </div>
    </>
  );
}
