// The parts of the panel that depend on what the thing is: a report's history, a source's releases,
// a workbook's checks and the fresh data it expects, and who answers for it.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";
import type { ObjectRef } from "./ObjectPanel";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function OwnerLine({ item, owner, onChanged }: { item: ObjectRef; owner: string | null; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("PUT", "/api/v1/owners", { kind: item.kind, id: item.id, email });
    if (!r.ok) return setError(r.data.error ?? "That could not be saved.");
    setEditing(false);
    setError(null);
    onChanged();
  };
  return (
    <div className="owner-line">
      <span className="muted">Owner: {owner ?? "nobody named"}</span>
      {!editing ? <button className="link-button" onClick={() => setEditing(true)}>Change</button> : (
        <form onSubmit={save} className="insight-controls">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their email" aria-label="The new owner's email" required />
          <button className="primary-inline">Name as owner</button>
          <button type="button" className="link-button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function History({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const [list, setList] = useState<{ id: string; label: string; takenAt: string; by: string }[] | null>(null);
  const [label, setLabel] = useState("");
  const [weekly, setWeekly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ snapshots: { id: string; label: string; takenAt: string; by: string }[] }>("GET", `/api/v1/dashboards/${boardId}/snapshots`).then((r) => (r.ok ? setList(r.data.snapshots) : (setList([]), setError("History is not available on a report you see part of."))));
  useEffect(() => {
    void load();
  }, [boardId]);
  const take = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("POST", `/api/v1/dashboards/${boardId}/snapshots`, { label });
    if (!r.ok) return setError(r.data.error ?? "The snapshot could not be taken.");
    setLabel("");
    setError(null);
    void load();
  };
  return (
    <>
      <p className="muted">A snapshot keeps every card as it stands now. Open one to see the report as it was, with each figure beside today's.</p>
      <form className="insight-controls" onSubmit={take}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="A name, such as Week 45 (optional)" aria-label="A name for the snapshot" maxLength={120} />
        <button className="primary-inline">Take a snapshot now</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {list && list.length > 0 && <ul className="insight-list">{list.map((s) => <li key={s.id}><Link to={`/snapshots/${s.id}`} onClick={onClose}>{when(s.takenAt)}</Link> <span className="muted">{s.label ? `${s.label} · ` : ""}by {s.by}</span></li>)}</ul>}
      {list && list.length === 0 && !error && <p className="muted">No snapshots yet.</p>}
      {!error && <div><button className="secondary" onClick={async () => { const r = await api<{ error?: string }>("POST", "/api/v1/schedules", { kind: "report_snapshot", dashboardId: boardId, cron: "0 6 * * 1", label: "Weekly snapshot" }); setError(r.ok ? null : (r.data.error ?? "That could not be scheduled.")); if (r.ok) setWeekly(true); }} disabled={weekly}>{weekly ? "A snapshot will be taken every Monday at 06:00 UTC" : "Take one every Monday"}</button></div>}
    </>
  );
}

interface Release {
  id: string;
  label: string;
  notes: string;
  at: string;
  by: string;
  results: { passed: boolean; changed: { label: string; what: string }[]; definitions: unknown[]; tests: { answers: { total: number; pass: number; fail: number; notRun: number }; checks: { total: number; pass: number; fail: number } } };
}
export function Releases({ sourceId }: { sourceId: string }) {
  const [list, setList] = useState<Release[] | null>(null);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failing, setFailing] = useState(false);
  const load = () => api<{ releases: Release[] }>("GET", `/api/v1/sources/${sourceId}/releases`).then((r) => setList(r.ok ? r.data.releases : []));
  useEffect(() => {
    void load();
  }, [sourceId]);
  const cut = async (e: FormEvent | null, evenIfFailing = false) => {
    e?.preventDefault();
    const r = await api<{ error?: string }>("POST", `/api/v1/sources/${sourceId}/releases`, { label, notes, ...(evenIfFailing ? { evenIfFailing: true } : {}) });
    if (!r.ok) {
      setFailing(r.status === 409);
      return setError(r.data.error ?? "The release could not be made.");
    }
    setLabel("");
    setNotes("");
    setError(null);
    setFailing(false);
    void load();
  };
  return (
    <>
      <p className="muted">A release records the definitions as they are, what changed since the last release, and how the checked answers and data checks stood.</p>
      <form className="report-form" onSubmit={cut}>
        <label className="field">Name<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="2026.11" required maxLength={80} /></label>
        <label className="field">Notes (optional)<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></label>
        <div className="insight-controls"><button className="primary-inline">Cut a release</button>{failing && <button type="button" className="secondary" onClick={() => void cut(null, true)}>Release anyway, recorded as failing</button>}</div>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      {list?.map((r) => (
        <section key={r.id} className="release">
          <h3>{r.label} <span className={r.results.passed ? "release-ok" : "insight-flag"}>{r.results.passed ? "tests passed" : "released with failures"}</span></h3>
          <p className="muted">{when(r.at)} by {r.by} · {r.results.definitions.length} definitions · checked answers {r.results.tests.answers.pass} of {r.results.tests.answers.total} passing{r.results.tests.answers.notRun ? `, ${r.results.tests.answers.notRun} not run` : ""} · data checks {r.results.tests.checks.pass} of {r.results.tests.checks.total} passing</p>
          {r.notes && <p>{r.notes}</p>}
          {r.results.changed.length > 0 ? <ul className="insight-list">{r.results.changed.slice(0, 30).map((ch, i) => <li key={i}>{ch.label} <span className="muted">{ch.what}</span></li>)}</ul> : <p className="muted">No definitions changed since the release before.</p>}
        </section>
      ))}
    </>
  );
}

interface Check {
  id: string;
  name: string;
  sql: string;
  everyMinutes: number | null;
  lastRunAt: string | null;
  status: "ok" | "failing" | "error" | "not_run";
  count: number | null;
  sample: { columns: string[]; rows: (string | null)[][] } | null;
  error: string | null;
}
interface Connected {
  id: string;
  name: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  expectEveryHours: number | null;
  lateSince: string | null;
  lateNote: string | null;
}
export function Checks({ workbookId }: { workbookId: string }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [tables, setTables] = useState<Connected[]>([]);
  const [name, setName] = useState("");
  const [sql, setSql] = useState("");
  const [every, setEvery] = useState("60");
  const [hook, setHook] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    void api<{ checks: Check[] }>("GET", `/api/v1/workbooks/${workbookId}/checks`).then((r) => setChecks(r.ok ? r.data.checks : []));
    void api<{ tables: Connected[] }>("GET", `/api/v1/workbooks/${workbookId}/connected-tables`).then((r) => setTables(r.ok ? r.data.tables : []));
  };
  useEffect(load, [workbookId]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("POST", `/api/v1/workbooks/${workbookId}/checks`, { name, sql, everyMinutes: every ? Number(every) : null, ...(hook.trim() ? { webhook: hook.trim() } : {}) });
    if (!r.ok) return setError(r.data.error ?? "The check could not be added.");
    setName("");
    setSql("");
    setError(null);
    load();
  };
  const watch = async (t: Connected, body: Record<string, unknown>) => {
    await api("PUT", `/api/v1/connected-tables/${t.id}/watch`, body);
    load();
  };
  return (
    <>
      <p className="muted">A check is a query that returns the rows that are wrong. When it starts returning rows, an issue is opened, the owners of the reports built here are told, and those reports carry a notice.</p>
      {checks?.map((k) => (
        <section key={k.id} className="check" data-testid="check">
          <h3>{k.name} <span className={k.status === "ok" ? "release-ok" : k.status === "not_run" ? "muted" : "insight-flag"}>{k.status === "ok" ? "passing" : k.status === "failing" ? `failing: ${k.count! > 20 ? "more than 20" : k.count} row${k.count === 1 ? "" : "s"}` : k.status === "error" ? "could not run" : "not run yet"}</span></h3>
          <p className="muted">{k.everyMinutes ? `Runs every ${k.everyMinutes} minutes` : "Runs when asked"}{k.lastRunAt ? ` · last ran ${when(k.lastRunAt)}` : ""}</p>
          {k.error && <p className="error">{k.error}</p>}
          {k.sample && (
            <div className="insight-scroll"><table className="insight-table"><thead><tr>{k.sample.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{k.sample.rows.slice(0, 5).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table></div>
          )}
          <div className="insight-controls">
            <button className="secondary" onClick={async () => { await api("POST", `/api/v1/checks/${k.id}/run`); load(); }}>Run now</button>
            <button className="link-button danger" onClick={async () => { await api("DELETE", `/api/v1/checks/${k.id}`); load(); }}>Remove</button>
          </div>
        </section>
      ))}
      <form className="report-form insight-announce" onSubmit={add}>
        <h3>Add a check</h3>
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="No orders without a customer" required minLength={2} maxLength={120} /></label>
        <label className="field">Query that returns the rows that are wrong<textarea rows={3} value={sql} onChange={(e) => setSql(e.target.value)} placeholder={'SELECT * FROM "orders" WHERE "customer" IS NULL'} required /></label>
        <div className="work-row">
          <label className="field">Run<select value={every} onChange={(e) => setEvery(e.target.value)}><option value="">Only when asked</option><option value="15">Every 15 minutes</option><option value="60">Every hour</option><option value="1440">Every day</option></select></label>
          <label className="field work-grow">Also post to (optional)<input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://hooks.slack.com/…" /></label>
        </div>
        <div><button className="primary-inline">Add the check</button></div>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      {tables.length > 0 && (
        <section className="insight-announce">
          <h3>Fresh data</h3>
          <p className="muted">Say how often each connected table should bring new data. If it is late or a refresh fails, the owners downstream are told once and the reports carry a notice until it recovers.</p>
          <ul className="insight-list">
            {tables.map((t) => (
              <li key={t.id} className="watch-row">
                <span><strong>{t.name}</strong> <span className="muted">{t.lastRunAt ? `arrived ${when(t.lastRunAt)}` : "never refreshed"}</span> {t.lateSince && <span className="insight-flag">late</span>}</span>
                <label>Expected every <select value={t.expectEveryHours ?? ""} onChange={(e) => void watch(t, { expectEveryHours: e.target.value ? Number(e.target.value) : null })} aria-label={`How often ${t.name} should arrive`}><option value="">not watched</option><option value="1">hour</option><option value="6">6 hours</option><option value="24">day</option><option value="168">week</option></select></label>
                {t.lateSince && <button className="link-button" onClick={() => { const note = window.prompt("What should people reading the affected reports know?", t.lateNote?.replace(/^[^:]+: /, "") ?? ""); if (note !== null) void watch(t, { note: note || null }); }}>{t.lateNote ? "Change the note" : "Say what is being done"}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

interface Sensitive {
  marked: { table: string; column: string; at: string; cards: { id: string; title: string; reportId: string }[]; approvals: { at: string; report: string; to: string }[] }[];
  suggested: { table: string; column: string; why: string }[];
  canMark: boolean;
}
export function SensitiveFields({ workbookId, onClose }: { workbookId: string; onClose: () => void }) {
  const [data, setData] = useState<Sensitive | null>(null);
  const load = () => api<Sensitive>("GET", `/api/v1/workbooks/${workbookId}/sensitive`).then((r) => r.ok && setData(r.data));
  useEffect(() => {
    void load();
  }, [workbookId]);
  const mark = async (table: string, column: string, on: boolean) => {
    await api("PUT", `/api/v1/workbooks/${workbookId}/sensitive`, { table, column, on });
    void load();
  };
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted">Marking a field does not hide it. It makes sharing deliberate: a report that reads it can only be shared by hiding the field from that person, or by saying yes, which is recorded here.</p>
      {data.marked.length === 0 && <p>No field is marked sensitive.</p>}
      {data.marked.map((m) => (
        <section key={m.table + m.column} className="check" data-testid="sensitive">
          <h3>{m.table}.{m.column} {data.canMark && <button className="link-button" onClick={() => void mark(m.table, m.column, false)}>Unmark</button>}</h3>
          {m.cards.length ? <p>Read by {m.cards.map((k, i) => <span key={k.id}>{i ? ", " : ""}<Link to={`/dashboards/${k.reportId}`} onClick={onClose}>{k.title}</Link></span>)}.</p> : <p className="muted">No card reads it.</p>}
          {m.approvals.length > 0 ? <ul className="insight-list">{m.approvals.map((a, i) => <li key={i}>Shared on purpose with {a.to} <span className="muted">in {a.report} · {when(a.at)}</span></li>)}</ul> : <p className="muted">Never shared on purpose.</p>}
        </section>
      ))}
      {data.suggested.length > 0 && (
        <section className="insight-announce">
          <h3>Suggested from the column names</h3>
          <ul className="insight-list">{data.suggested.map((x) => <li key={x.table + x.column} className="watch-row"><span>{x.table}.{x.column} <span className="muted">{x.why}</span></span>{data.canMark && <button className="secondary" onClick={() => void mark(x.table, x.column, true)}>Mark as sensitive</button>}</li>)}</ul>
        </section>
      )}
    </>
  );
}
