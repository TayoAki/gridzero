// Tabs in a workbook's panel: the map of what is built on it, the history of a table record by
// record, the events and other named things with every wording kept, and the quality of its checks over time.

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { api } from "../agents/catalog";

const when = (v: string | number) => new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

interface MapData {
  workbook: string;
  generatedAt: string;
  nodes: { id: string; kind: string; label: string; note?: string }[];
  edges: { from: string; to: string }[];
}
const COLS = ["origin", "table", "definition", "card", "report"];
const TITLES: Record<string, string> = { origin: "Comes from", table: "Tables", definition: "Definitions", card: "Cards", report: "Reports" };

/** Hand a file to the person: the map as a picture or as data. */
function save(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function WorkbookMap({ workbookId }: { workbookId: string }) {
  const [map, setMap] = useState<MapData | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    api<MapData>("GET", `/api/v1/workbooks/${workbookId}/map`).then((r) => r.ok && setMap(r.data));
  }, [workbookId]);
  const layout = useMemo(() => {
    if (!map) return null;
    const W = 190, H = 34, GAP = 10, PAD = 64;
    const cols = COLS.map((k) => map.nodes.filter((n) => n.kind === k || (k === "table" && n.kind === "model")));
    const at = new Map<string, { x: number; y: number }>();
    cols.forEach((list, c) => list.forEach((n, i) => at.set(n.id, { x: c * (W + PAD), y: 30 + i * (H + GAP) })));
    const height = 40 + Math.max(1, ...cols.map((l) => l.length)) * (H + GAP);
    return { W, H, at, cols, width: COLS.length * (W + PAD) - PAD, height };
  }, [map]);
  if (!map || !layout) return <p className="muted">Drawing the map…</p>;
  // Everything up or downstream of the picked node is lit; the rest is dimmed.
  const lit = new Set<string>();
  if (picked) {
    const walk = (id: string, dir: "from" | "to") => {
      if (lit.has(id + dir)) return;
      lit.add(id + dir);
      for (const e of map.edges) if (e[dir === "to" ? "from" : "to"] === id) walk(e[dir], dir);
    };
    walk(picked, "to");
    walk(picked, "from");
  }
  const on = (id: string) => !picked || lit.has(id + "to") || lit.has(id + "from");
  const svg = () => document.querySelector(".map-svg")?.outerHTML ?? "";
  return (
    <>
      <p className="muted">Where each table comes from, the definitions and cards built on it, and the reports those are on. Click anything to light up what it depends on and what depends on it. Links are found by name in each query.</p>
      <div className="insight-controls">
        <button className="secondary" onClick={() => save(`${map.workbook}-map.svg`, "image/svg+xml", svg())}>Download as a picture</button>
        <button className="secondary" onClick={() => save(`${map.workbook}-map.json`, "application/json", JSON.stringify(map, null, 1))}>Download as data</button>
        {picked && <button className="link-button" onClick={() => setPicked(null)}>Show everything</button>}
      </div>
      <div className="insight-scroll map-wrap">
        <svg className="map-svg" xmlns="http://www.w3.org/2000/svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`Map of ${map.workbook}`}>
          {COLS.map((k, c) => <text key={k} x={c * (layout.W + 64)} y={14} className="map-title">{TITLES[k]}</text>)}
          {map.edges.map((e, i) => {
            const a = layout.at.get(e.from), b = layout.at.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + layout.W, y1 = a.y + layout.H / 2, x2 = b.x, y2 = b.y + layout.H / 2, mid = (x1 + x2) / 2;
            return <path key={i} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} className={`map-edge${picked && on(e.from) && on(e.to) ? " lit" : ""}`} opacity={on(e.from) && on(e.to) ? 1 : 0.12} fill="none" />;
          })}
          {map.nodes.map((n) => {
            const p = layout.at.get(n.id);
            if (!p) return null;
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={on(n.id) ? 1 : 0.25} className={`map-node map-${n.kind}${picked === n.id ? " picked" : ""}`} onClick={() => setPicked(picked === n.id ? null : n.id)} tabIndex={0} role="button" aria-label={`${n.kind}: ${n.label}`} onKeyDown={(e) => e.key === "Enter" && setPicked(picked === n.id ? null : n.id)}>
                <rect width={layout.W} height={layout.H} rx={6} />
                <text x={10} y={n.note ? 14 : 21} className="map-label">{n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}</text>
                {n.note && <text x={10} y={27} className="map-note">{n.note}</text>}
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
}

interface Diff {
  key: string;
  rows_before: number;
  rows_after: number;
  counts: { added: number; removed: number; changed: number };
  added: Record<string, string | null>[];
  removed: Record<string, string | null>[];
  changed: { key: string; was: Record<string, string | null>; now: Record<string, string | null> }[];
}
export function RecordHistory({ workbookId }: { workbookId: string }) {
  const [tracked, setTracked] = useState<{ id: string; table: string; key: string; lastVersion: number | null; lastAt: string | null }[]>([]);
  const [tables, setTables] = useState<{ table: string; columns: { name: string }[] }[]>([]);
  const [form, setForm] = useState({ table: "", key: "", every: "168" });
  const [open, setOpen] = useState<{ id: string; versions: { version: number; at: number }[]; a: string; b: string; diff: Diff | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ tracked: typeof tracked }>("GET", `/api/v1/workbooks/${workbookId}/history`).then((r) => r.ok && setTracked(r.data.tracked));
  useEffect(() => {
    void load();
    api<{ tables: typeof tables }>("GET", `/api/v1/workbooks/${workbookId}/tables`).then((r) => { if (r.ok) { setTables(r.data.tables); setForm((f) => ({ ...f, table: r.data.tables[0]?.table ?? "", key: r.data.tables[0]?.columns[0]?.name ?? "" })); } });
  }, [workbookId]);
  const track = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("POST", `/api/v1/workbooks/${workbookId}/history`, { table: form.table, key: form.key, everyHours: form.every ? Number(form.every) : null });
    setError(r.ok ? null : (r.data?.error ?? "The table could not be tracked."));
    void load();
  };
  const show = async (id: string, a?: string, b?: string) => {
    const r = await api<{ versions: { version: number; at: number }[]; diff?: Diff; error?: string }>("GET", `/api/v1/history/${id}${a !== undefined && b !== undefined ? `?a=${a}&b=${b}` : ""}`);
    if (!r.ok) return setError(r.data?.error ?? "The history could not be read.");
    const vs = [...r.data.versions].sort((x, y) => x.version - y.version);
    setOpen({ id, versions: vs, a: a ?? String(vs.at(-2)?.version ?? vs[0]?.version ?? 0), b: b ?? String(vs.at(-1)?.version ?? 0), diff: r.data.diff ?? null });
  };
  return (
    <>
      <p className="muted">Keep a table's rows each time it is captured, as a Delta table, so two captures can be compared record by record: what was added, what went, and what changed in each row.</p>
      {tracked.map((t) => (
        <section key={t.id} className="check">
          <h3>{t.table} <span className="muted">told apart by {t.key} · {t.lastVersion === null ? "not captured" : `${t.lastVersion + 1} capture${t.lastVersion ? "s" : ""}, last ${t.lastAt ? when(t.lastAt) : ""}`}</span></h3>
          <div className="insight-controls">
            <button className="secondary" onClick={async () => { await api("POST", `/api/v1/history/${t.id}/capture`); void load(); }}>Capture now</button>
            <button className="secondary" onClick={() => void show(t.id)}>See what changed</button>
          </div>
          {open?.id === t.id && (
            <>
              <div className="insight-controls">
                From <select aria-label="Earlier capture" value={open.a} onChange={(e) => setOpen({ ...open, a: e.target.value })}>{open.versions.map((v) => <option key={v.version} value={v.version}>{when(v.at)}</option>)}</select>
                to <select aria-label="Later capture" value={open.b} onChange={(e) => setOpen({ ...open, b: e.target.value })}>{open.versions.map((v) => <option key={v.version} value={v.version}>{when(v.at)}</option>)}</select>
                <button className="primary-inline" disabled={open.a === open.b} onClick={() => void show(t.id, open.a, open.b)}>Compare</button>
              </div>
              {open.diff && (
                <>
                  <p>{open.diff.counts.added} added, {open.diff.counts.removed} removed, {open.diff.counts.changed} changed. {open.diff.rows_before} rows before, {open.diff.rows_after} after.</p>
                  {open.diff.changed.length > 0 && <div className="insight-scroll"><table className="insight-table"><thead><tr><th>{open.diff.key}</th><th>What changed</th></tr></thead><tbody>{open.diff.changed.slice(0, 50).map((c) => <tr key={c.key}><td>{c.key}</td><td>{Object.keys(c.now).map((col) => `${col}: ${c.was[col] ?? "empty"} → ${c.now[col] ?? "empty"}`).join("; ")}</td></tr>)}</tbody></table></div>}
                  {open.diff.added.length > 0 && <p className="muted">Added: {open.diff.added.slice(0, 30).map((r) => r[open.diff!.key]).join(", ")}</p>}
                  {open.diff.removed.length > 0 && <p className="muted">Removed: {open.diff.removed.slice(0, 30).map((r) => r[open.diff!.key]).join(", ")}</p>}
                </>
              )}
            </>
          )}
        </section>
      ))}
      <form className="report-form insight-announce" onSubmit={track}>
        <h3>Track a table</h3>
        <div className="work-row">
          <label className="field">Table<select value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value, key: tables.find((t) => t.table === e.target.value)?.columns[0]?.name ?? "" })}>{tables.map((t) => <option key={t.table} value={t.table}>{t.table}</option>)}</select></label>
          <label className="field">Rows are told apart by<select value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>{(tables.find((t) => t.table === form.table)?.columns ?? []).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
          <label className="field">Capture<select value={form.every} onChange={(e) => setForm({ ...form, every: e.target.value })}><option value="">Only when asked</option><option value="24">Every day</option><option value="168">Every week</option></select></label>
        </div>
        <div><button className="primary-inline" disabled={!form.table || !form.key}>Track it</button></div>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}

interface Term {
  id: string;
  name: string;
  meaning: string;
  table: string;
  condition: string;
  version: number;
  history: { version: number; meaning: string; condition: string; at: string; by: string }[];
}
export function Terms({ workbookId }: { workbookId: string }) {
  const [terms, setTerms] = useState<Term[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [form, setForm] = useState({ name: "", meaning: "", table: "", condition: "" });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ terms: Term[] }>("GET", `/api/v1/workbooks/${workbookId}/terms`).then((r) => r.ok && setTerms(r.data.terms));
  useEffect(() => {
    void load();
    api<{ tables: { table: string }[] }>("GET", `/api/v1/workbooks/${workbookId}/tables`).then((r) => { if (r.ok) { setTables(r.data.tables.map((t) => t.table)); setForm((f) => ({ ...f, table: r.data.tables[0]?.table ?? "" })); } });
  }, [workbookId]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ term: { version: number; rows: number; rowsBefore?: number | null }; error?: string }>("PUT", `/api/v1/workbooks/${workbookId}/terms`, { name: form.name, table: form.table, condition: form.condition, ...(form.meaning ? { meaning: form.meaning } : {}) });
    if (!r.ok) return setError(r.data?.error ?? "That could not be saved.");
    setError(null);
    setNote(r.data.term.version > 1 ? `${form.name} is now version ${r.data.term.version}: it picks out ${r.data.term.rows} rows; the wording before picked out ${r.data.term.rowsBefore ?? "an unknown number of"}.` : `${form.name} picks out ${r.data.term.rows} rows.`);
    void load();
  };
  return (
    <>
      <p className="muted">An event, a segment or a status that people count: what it means and the rows that are it. Rewording one makes a new version; every earlier wording is kept with who wrote it and when.</p>
      {terms.map((t) => (
        <section key={t.id} className="check" data-testid="term">
          <h3>{t.name} <span className="muted">version {t.version} · in {t.table}</span> <button className="link-button" onClick={() => setForm({ name: t.name, meaning: t.meaning, table: t.table, condition: t.condition })}>Reword</button></h3>
          {t.meaning && <p>{t.meaning}</p>}
          <code className="def-summary">{t.condition}</code>
          {t.history.length > 0 && <details><summary>{t.history.length} earlier wording{t.history.length === 1 ? "" : "s"}</summary><ul className="insight-list">{[...t.history].reverse().map((h) => <li key={h.version}>Version {h.version}: <code>{h.condition}</code> <span className="muted">{h.by}, {when(h.at)}</span></li>)}</ul></details>}
        </section>
      ))}
      <form className="report-form insight-announce" onSubmit={save}>
        <h3>{terms.some((t) => t.name === form.name) ? `Reword ${form.name}` : "Define one"}</h3>
        <div className="work-row">
          <label className="field work-grow">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={80} placeholder="Converted" /></label>
          <label className="field">Table<select value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })}>{tables.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        </div>
        <label className="field">What it means<input value={form.meaning} onChange={(e) => setForm({ ...form, meaning: e.target.value })} maxLength={500} placeholder="Finished checkout" /></label>
        <label className="field">The rows that are it (what goes after WHERE)<input value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} required maxLength={1000} placeholder={'"step" = \'paid\''} /></label>
        <div><button className="primary-inline">Save</button></div>
        {note && <p className="ok-note" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}

interface Quality {
  days: number;
  score: number | null;
  runs: number;
  checks: { id: string; name: string; runs: number; passRate: number | null; last: { at: string; status: string; count: number }[] }[];
  byDay: { day: string; runs: number; passed: number; score: number }[];
}
export function QualityOverTime({ workbookId }: { workbookId: string }) {
  const [q, setQ] = useState<Quality | null>(null);
  const [days, setDays] = useState(30);
  useEffect(() => {
    api<Quality>("GET", `/api/v1/workbooks/${workbookId}/quality?days=${days}`).then((r) => r.ok && setQ(r.data));
  }, [workbookId, days]);
  if (!q) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="insight-controls">
        <strong className="lens-big">{q.score === null ? "No runs yet" : `${q.score}%`}</strong>
        <span className="muted">{q.score === null ? "Add a check and let it run." : `of ${q.runs} check runs passed`}</span>
        <label>Period <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
      </div>
      {q.byDay.length > 0 && (
        <div className="quality-days" role="img" aria-label="Share of check runs that passed, by day">
          {q.byDay.map((d) => <span key={d.day} title={`${d.day}: ${d.passed} of ${d.runs} passed`} className={d.score === 100 ? "good" : d.score >= 80 ? "fair" : "poor"} style={{ height: `${Math.max(8, d.score * 0.5)}px` }} />)}
        </div>
      )}
      <div className="insight-scroll">
        <table className="insight-table">
          <thead><tr><th>Check</th><th className="num">Runs</th><th className="num">Passed</th><th>Latest runs, oldest first</th></tr></thead>
          <tbody>{q.checks.map((k) => <tr key={k.id}><td>{k.name}</td><td className="num">{k.runs}</td><td className="num">{k.passRate === null ? "" : `${k.passRate}%`}</td><td><span className="quality-dots">{k.last.map((r, i) => <i key={i} className={r.status === "ok" ? "good" : "poor"} title={`${when(r.at)}: ${r.status === "ok" ? "passed" : r.status === "failing" ? `${r.count} rows wrong` : "could not run"}`} />)}</span></td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
