// Dashboards: a grid of widgets an agent made (agent spec §8.6).

import { openPanel } from "../insight/open";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

import { useShell, useStatus, useTabTitle } from "../shell/context";
import { api } from "../agents/catalog";
import { SchedulesDialog } from "../agents/Schedules";
import { useEscape } from "../use-escape";
import { ReportGrid, TabStrip, UNITS, onTab, placed } from "./ReportGrid";
import type { Placed, ReportTab } from "./ReportGrid";
import { downloadExcel } from "./excel";
import { SLICER_UNITS, SlicerCard, startStyle } from "./Slicer";
import { BuilderDialog } from "./Builder";
import { FilterBar } from "./FilterBar";
import { grainOf } from "./prism/analytics";
import { AlertDialog, EmailDialog, ShareDialog } from "./ReportDialogs";
import { asRows, fieldNamed, keyOf } from "./slicing";
import type { SliceField } from "./slicing";
import { useReport } from "./useReport";
import type { Shown } from "./useReport";
import { FORMS, SIZES, THEMES, fits, sizeOf } from "./spec";
import type { ReportFilter, SlicerStyle, Widget, WidgetForm, WidgetSize, WidgetSource, WidgetTheme } from "./spec";
import { WidgetBody, WidgetFrame } from "./WidgetView";

interface Board {
  id: string;
  name: string;
  /** What the signed-in person may do here. A report shared with them also names its owner. */
  role: "owner" | "editor" | "viewer";
  owner: string | null;
}

const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

/** Where a widget's number comes from, in plain words, and whether it can update itself. */
export function sourceLine(source: WidgetSource): { text: string; live: boolean } {
  switch (source.kind) {
    case "definition":
      return { text: "From How we count", live: true };
    case "metric":
      return { text: `Metric: ${source.query.metric}`, live: true };
    case "table_query":
      return { text: "Query over a workbook table", live: true };
    case "sheet":
      return { text: `Sheet range ${source.range}`, live: true };
    case "snapshot":
      return { text: "A snapshot: it does not update", live: false };
  }
}

/** A live widget nobody has refreshed for a day and a half is probably out of date. */
const STALE_AFTER_MS = 36 * 3_600_000;
export const isOld = (w: Widget) => sourceLine(w.source).live && Date.now() - new Date(w.refreshedAt).getTime() > STALE_AFTER_MS;

/** What each chart form is called in the menu. */
const FORM_NAMES: Partial<Record<WidgetForm, string>> = { trend: "Line", bars: "Bars", hbar: "Bars across", pie: "Pie", donut: "Donut", funnel: "Funnel", treemap: "Treemap", waterfall: "Waterfall", radar: "Radar", histogram: "Histogram", table: "Table", stacked: "Stacked bars", heatmap: "Heatmap", combo: "Bars and line", scatter: "Scatter", bubble: "Bubble", sunburst: "Sunburst", sankey: "Flow", boxplot: "Box plot", number: "Number", gauge: "Gauge", list: "List", text: "Text" };

interface Notice {
  kind: string;
  text: string;
  note: string | null;
}

function CardMenu({ w, edit, own, tabs, onEditNote, onChange, onSize, onDelete, onRefresh, onSchedule, onFocus, onExcel, onAlert, onClose }: { w: Widget; edit: boolean; own: boolean; tabs: ReportTab[]; onEditNote: () => void; onChange: (p: Partial<Widget>) => void; onSize: (s: WidgetSize) => void; onDelete: () => void; onRefresh: () => void; onSchedule: () => void; onFocus: () => void; onExcel: () => void; onAlert: () => void; onClose: () => void }) {
  useEscape(onClose);
  // Only the forms this card's data can be drawn as.
  const forms = FORMS.filter((f) => fits(f, w.data) === null);
  return (
    <div className="widget-menu" role="menu" onMouseLeave={onClose}>
      {edit && (
        <>
      <div className="widget-menu-row">
        Size
        {SIZES.map((s) => <button key={s} className={w.size === s ? "selected" : ""} onClick={() => onSize(s as WidgetSize)}>{s.toUpperCase()}</button>)}
      </div>
      <div className="widget-menu-row">
        Theme
        {THEMES.map((t) => <button key={t} aria-label={t} className={`theme-dot theme-${t}${w.theme === t ? " selected" : ""}`} onClick={() => onChange({ theme: t as WidgetTheme })} />)}
      </div>
      {forms.length > 1 && (
        <div className="widget-menu-row">
          Form
          {forms.map((f) => <button key={f} className={w.form === f ? "selected" : ""} onClick={() => onChange({ form: f as WidgetForm })}>{FORM_NAMES[f] ?? f}</button>)}
        </div>
      )}
        </>
      )}
      {edit && tabs.length > 1 && (
        <div className="widget-menu-row">
          Tab
          {tabs.map((t, i) => <button key={t.id} className={(w.tab ?? tabs[0]!.id) === t.id || (i === 0 && !tabs.some((x) => x.id === w.tab)) ? "selected" : ""} onClick={() => onChange({ tab: t.id })}>{t.name}</button>)}
        </div>
      )}
      {edit && w.data.kind === "text" && w.agentId === null && <button className="widget-menu-item" onClick={onEditNote}>Edit text…</button>}
      <button className="widget-menu-item" onClick={onFocus}>Open large</button>
      {edit && w.source.kind === "table_query" && <Link className="widget-menu-item" to={`/sql?wb=${w.source.workbookId}&q=${encodeURIComponent(w.source.sql)}`}>See the SQL</Link>}
      <button className="widget-menu-item" onClick={onExcel}>Download as Excel</button>
      {edit && w.data.kind === "series" && (w.form === "trend" || w.form === "bars") && (
        <div className="widget-menu-row" title="Quick calculations from the card's own points: a guide, not a prediction to rely on.">
          Analysis
          <button className={w.options?.trend ? "selected" : ""} aria-pressed={!!w.options?.trend} onClick={() => onChange({ options: { ...w.options, trend: !w.options?.trend } })}>Trend line</button>
          <button className={w.options?.anomalies ? "selected" : ""} aria-pressed={!!w.options?.anomalies} onClick={() => onChange({ options: { ...w.options, anomalies: !w.options?.anomalies } })}>Flag unusual</button>
          {grainOf(w.data.points.map((p) => p.label)) && [3, 6, 12].map((h) => (
            <button key={h} className={w.options?.forecast === h ? "selected" : ""} aria-pressed={w.options?.forecast === h} onClick={() => onChange({ options: { ...w.options, forecast: w.options?.forecast === h ? undefined : h } })}>Forecast {h}</button>
          ))}
        </div>
      )}
      {w.data.kind === "number" && <button className="widget-menu-item" onClick={onAlert}>Alert me…</button>}
      {edit && w.data.kind === "number" && (
        <button className="widget-menu-item" onClick={() => {
          const said = window.prompt("The target for this figure. Leave empty to remove it. Put a minus sign after the number (for example 40-) when lower is better.", w.options?.target == null ? "" : `${w.options.target}${w.options.targetLow ? "-" : ""}`);
          if (said === null) return;
          const low = said.trim().endsWith("-");
          const value = Number(said.replace(/[-,\s]+$/, "").replace(/,/g, ""));
          const { target: _t, targetLow: _l, ...rest } = w.options ?? {};
          onChange({ options: said.trim() && Number.isFinite(value) ? { ...rest, target: value, ...(low ? { targetLow: true } : {}) } : rest });
          onClose();
        }}>{w.options?.target == null ? "Set a target…" : "Change the target…"}</button>
      )}
      <button className="widget-menu-item" onClick={() => { onClose(); openPanel({ kind: "card", id: w.id, label: w.title, tab: "work" }); }}>Raise an action or issue…</button>
      {edit && <button className="widget-menu-item" onClick={onRefresh}>Refresh now</button>}
      {own && <button className="widget-menu-item" onClick={onSchedule}>Schedule…</button>}
      {edit && <button className="widget-menu-item danger" onClick={onDelete}>Delete</button>}
    </div>
  );
}

const TEMPLATE_CHOICES = [
  { id: "blank", name: "Blank", text: "An empty report." },
  { id: "sales", name: "Sales", text: "Adds a Sales analyst agent that tracks revenue, pipeline and win rate." },
  { id: "ops", name: "Operations", text: "Adds an Ops monitor agent that watches orders, backlog and support volume." },
] as const;

function TemplateDialog({ onPick, onClose }: { onPick: (t: "blank" | "sales" | "ops") => void; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="template-title">
        <div className="dialog-head">
          <h2 id="template-title">New report</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="template-list">
          {TEMPLATE_CHOICES.map((t) => (
            <button key={t.id} className="template-choice" onClick={() => onPick(t.id)}>
              <strong>{t.name}</strong>
              <span>{t.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const NOTHING_LEFT = <p className="widget-nothing">Nothing matches the filters.</p>;

/** How a card answered the report's filters, said in a word. */
function FilterChip({ shown }: { shown: Shown }) {
  if (shown.error) return <span className="slice-chip off" title={shown.error}>Could not filter</span>;
  if (shown.busy) return <span className="slice-chip off">Filtering…</span>;
  if (shown.how === "live") return <span className="slice-chip" title="This card's query was run again with the filters applied, so its figures are for the filtered rows.">Filtered</span>;
  if (shown.how === "card") return <span className="slice-chip" title="This card holds a saved result, so the filters hid rows and bars on it. Totals on it were not worked out again.">Filtered on the card</span>;
  if (shown.how === "none") return <span className="slice-chip off" title="This card has none of the filtered fields, or holds a saved result that cannot be filtered.">Not filtered</span>;
  return null;
}

function DataTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
  return (
    <div className="widget-table focus-data">
      <table>
        <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((_, j) => <td key={j} className={typeof r[j] === "number" ? "num" : undefined}>{r[j] === null || r[j] === undefined ? "" : typeof r[j] === "number" ? (r[j] as number).toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(r[j])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One card filling the window, with its data, or the rows it was worked out from, underneath when asked for. */
function FocusDialog({ w, shown, filters, onExcel, onClose }: { w: Widget; shown: Shown; filters: ReportFilter[]; onExcel: () => void; onClose: () => void }) {
  useEscape(onClose);
  const [below, setBelow] = useState<"data" | "rows" | null>(null);
  const [behind, setBehind] = useState<{ table: string; columns: string[]; rows: (string | null)[][]; truncated: boolean; count: number; totals: { column: string; total: number | null }[] } | { error: string } | null>(null);
  const table = shown.data ? asRows(w, shown.data) : { columns: [], rows: [] };
  const hasRows = w.source.kind === "table_query";
  const key = JSON.stringify(filters);
  useEffect(() => {
    if (below !== "rows") return;
    let live = true;
    setBehind(null);
    api<{ table: string; columns: string[]; rows: (string | null)[][]; truncated: boolean; count: number; totals: { column: string; total: number | null }[]; error?: string }>("POST", `/api/v1/widgets/${w.id}/rows`, { filters }).then((r) => live && setBehind(r.ok ? r.data : { error: r.data?.error ?? "Could not read the rows." }));
    return () => {
      live = false;
    };
    // The filters are rebuilt on every render; their text says whether they changed.
  }, [below, w.id, key]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog focus-dialog" role="dialog" aria-modal="true" aria-labelledby="focus-title">
        <div className="dialog-head">
          <h2 id="focus-title">{w.title}</h2>
          <FilterChip shown={shown} />
          <span className="chat-head-spacer" />
          <button className="secondary" aria-pressed={below === "data"} onClick={() => setBelow(below === "data" ? null : "data")}>{below === "data" ? "Hide data" : "Show data"}</button>
          {hasRows && <button className="secondary" aria-pressed={below === "rows"} onClick={() => setBelow(below === "rows" ? null : "rows")}>{below === "rows" ? "Hide rows" : "Rows behind it"}</button>}
          <button className="secondary" onClick={onExcel}>Excel</button>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className={`focus-chart${below ? " with-data" : ""}`}>
          {shown.data ? <WidgetBody form={w.form} theme={w.theme} size="l" data={shown.data} title={w.title} options={w.options} /> : NOTHING_LEFT}
        </div>
        {below === "data" && <DataTable columns={table.columns} rows={table.rows} />}
        {below === "rows" && (behind === null ? (
          <div className="gz-skel"><span /><span /></div>
        ) : "error" in behind ? (
          <p className="error" role="alert">{behind.error}</p>
        ) : (
          <>
            <p className="collab-note">{behind.truncated ? `The first 200 of ${behind.count.toLocaleString()} rows` : `${behind.count.toLocaleString()} ${behind.count === 1 ? "row" : "rows"}`} of {behind.table}{filters.length ? ", with the report's filters applied" : ""}.</p>
            {behind.totals.length > 0 && (
              <div className="focus-totals">
                {behind.totals.map((t) => <div key={t.column}><span>Total {t.column}</span><strong>{t.total === null ? "none" : t.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>)}
              </div>
            )}
            <DataTable columns={behind.columns} rows={behind.rows} />
          </>
        ))}
        <p className="collab-note">{sourceLine(w.source).text} · refreshed {ago(w.refreshedAt)}</p>
      </div>
    </div>
  );
}

/** Write a note on the report, or reword one. */
function NoteDialog({ note, onSave, onClose }: { note: { title: string; text: string }; onSave: (title: string, text: string) => Promise<string | null>; onClose: () => void }) {
  useEscape(onClose);
  const [title, setTitle] = useState(note.title);
  const [text, setText] = useState(note.text);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog small-dialog report-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Text on the report"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const problem = await onSave(title.trim(), text);
          setBusy(false);
          if (problem) setError(problem);
        }}
      >
        <div className="dialog-head">
          <h2>Text on the report</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="report-form">
          <label className="field">Heading<input required maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: What changed this month" /></label>
          <label className="field">Text (leave empty for a heading alone)<textarea rows={5} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary-inline" type="submit" disabled={busy || !title.trim()}>Save</button>
        </div>
      </form>
    </div>
  );
}

/** The fields a report can still be sliced by: those no slicer on it uses yet. */
function SlicerMenu({ fields, onPick, onClose }: { fields: SliceField[]; onPick: (f: SliceField) => void; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="widget-menu slicer-menu" role="menu" onMouseLeave={onClose}>
      {fields.length === 0 ? (
        <p>Nothing to slice by yet. A slicer needs a card with a table, or a chart split by something, such as “Revenue by source”.</p>
      ) : (
        <>
          <p>Filter this report's cards by</p>
          {fields.map((f) => (
            <button key={f.name} className="widget-menu-item" onClick={() => onPick(f)}>{f.name}<span>{f.type === "number" ? "range" : `${f.values.length} values`}</span></button>
          ))}
          <p>Cards that read a table are worked out again for what you choose, totals included. A card holding a saved result only hides its rows and bars.</p>
        </>
      )}
    </div>
  );
}

/**
 * A report on a wall screen: full window, large type, no controls. It reloads every minute and
 * refreshes its live widgets every fifteen. Escape goes back.
 */
export function PresentPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [widgets, setWidgets] = useState<Widget[] | null>(null);
  const [tabs, setTabs] = useState<ReportTab[]>([]);
  const [tab, setTab] = useState<string | null>(null);
  const [at, setAt] = useState(() => new Date());
  const report = useReport(id, widgets);
  const { fields } = report;
  useEscape(() => navigate(`/dashboards/${id}`));
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ widgets: Widget[]; tabs: ReportTab[] }>("GET", `/api/v1/dashboards/${id}/widgets`).then((r) => {
        if (live && r.ok) {
          setWidgets(r.data.widgets);
          setTabs(r.data.tabs ?? []);
          setAt(new Date());
        }
        return r.ok ? r.data.widgets : [];
      });
    const refreshLive = async () => {
      for (const w of await load()) if (sourceLine(w.source).live) await api("POST", `/api/v1/widgets/${w.id}/refresh`);
      await load();
    };
    void load();
    api<{ dashboards: Board[] }>("GET", "/api/v1/dashboards").then((r) => live && r.ok && setName(r.data.dashboards.find((b) => b.id === id)?.name ?? ""));
    const reload = window.setInterval(load, 60_000);
    const refresh = window.setInterval(refreshLive, 15 * 60_000);
    return () => {
      live = false;
      window.clearInterval(reload);
      window.clearInterval(refresh);
    };
  }, [id]);
  return (
    <div className="present" data-theme="dark">
      <header className="present-head">
        <strong>{name}</strong>
        <span className="chat-head-spacer" />
        <span>Updated {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <Link to={`/dashboards/${id}`}>Exit (Esc)</Link>
      </header>
      {widgets === null ? null : widgets.length === 0 ? (
        <p className="present-empty">This report has no widgets yet.</p>
      ) : (
        <>
        <TabStrip tabs={tabs} current={tab} onPick={setTab} />
        <FilterBar report={report} stuck={0} />
        <div className="widget-grid present-grid">
          {onTab(widgets, tabs, tab).map((w) => {
            const at = placed(onTab(widgets, tabs, tab)).find((p) => p.id === w.id)!;
            const shown = report.show(w);
            return (
            <div key={w.id} className="widget-slot" style={{ gridColumn: `${at.x + 1} / span ${at.w}`, gridRow: `${at.y + 1} / span ${at.h}` }}>
              {w.data.kind === "slicer" ? (
                <SlicerCard title={w.title} style={w.data.style} field={fieldNamed(fields, w.data.field)} pick={report.state.picks[keyOf(w.data.field)]} onPick={(p) => report.setPick((w.data as { field: string }).field, p)} />
              ) : (
                <WidgetFrame title={w.title} theme={w.theme} size={w.size} state={isOld(w) ? "stale" : undefined} foot={isOld(w) ? <span className="widget-warn">Last refreshed {ago(w.refreshedAt)}</span> : shown.how || shown.busy ? <FilterChip shown={shown} /> : undefined}>
                  {shown.data ? <WidgetBody form={w.form} theme={w.theme} size={w.size} data={shown.data} title={w.title} onPick={report.clickFilter(w)} options={w.options} /> : NOTHING_LEFT}
                </WidgetFrame>
              )}
            </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}

function Board({ board, boards, onBoards }: { board: Board; boards: Board[]; onBoards: () => void }) {
  const navigate = useNavigate();
  const [widgets, setWidgets] = useState<Widget[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<Widget | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(board.name);
  // Refreshes that failed this visit: the card keeps its last value and says why it is old.
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const report = useReport(board.id, widgets);
  const { fields } = report;
  const [addingSlicer, setAddingSlicer] = useState(false);
  const [building, setBuilding] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"share" | "email" | null>(null);
  const [alerting, setAlerting] = useState<Widget | null>(null);
  const [tabs, setTabs] = useState<ReportTab[]>([]);
  const [tab, setTab] = useState<string | null>(null);
  // Set when the owner has limited this person to certain rows.
  const [limited, setLimited] = useState<{ field: string; values: string[] }[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [arrived, setArrived] = useState<string | null>(null);
  // The note being written (id null) or reworded.
  const [noting, setNoting] = useState<{ id: string | null; title: string; text: string } | null>(null);
  const own = board.role === "owner";
  const edit = board.role !== "viewer";
  const shell = useShell();

  useEffect(() => {
    setName(board.name);
    setWidgets(null);
    setTab(null);
    api<{ widgets: Widget[]; tabs: ReportTab[]; limited?: { field: string; values: string[] }[]; notices?: Notice[]; arrived?: string | null }>("GET", `/api/v1/dashboards/${board.id}/widgets`).then((r) => {
      setNotices(r.ok ? (r.data.notices ?? []) : []);
      setArrived(r.ok ? (r.data.arrived ?? null) : null);
      setWidgets(r.ok ? r.data.widgets : []);
      setTabs(r.ok ? (r.data.tabs ?? []) : []);
      setLimited(r.ok ? (r.data.limited ?? []) : []);
    });
  }, [board.id, board.name]);

  const replace = (w: Widget) => setWidgets((ws) => ws?.map((x) => (x.id === w.id ? w : x)) ?? null);

  async function change(w: Widget, patch: Partial<Widget>) {
    const r = await api<{ widget: Widget; error?: string }>("PATCH", `/api/v1/widgets/${w.id}`, patch);
    if (r.ok) replace(r.data.widget);
    else setError(r.data?.error ?? "Could not change the widget.");
  }

  async function refresh(w: Widget) {
    setMenu(null);
    setBusy(w.id);
    setError(null);
    const r = await api<{ widget: Widget; error?: string }>("POST", `/api/v1/widgets/${w.id}/refresh`);
    setBusy(null);
    setFailed((f) => {
      const next = { ...f };
      if (r.ok) delete next[w.id];
      else next[w.id] = r.data?.error ?? "Could not refresh.";
      return next;
    });
    if (r.ok) replace(r.data.widget);
    return r.ok;
  }

  /** One after the other, so a report never runs a batch of queries at once. */
  async function refreshAll() {
    setRefreshingAll(true);
    for (const w of widgets ?? []) if (sourceLine(w.source).live) await refresh(w);
    setRefreshingAll(false);
  }

  async function remove(w: Widget) {
    setMenu(null);
    if (!window.confirm(`Delete the widget "${w.title}"?`)) return;
    if ((await api("DELETE", `/api/v1/widgets/${w.id}`)).ok) setWidgets((ws) => ws?.filter((x) => x.id !== w.id) ?? null);
  }

  /** Add a slicer for a field, at the top of the report: beside the slicers already there when it fits. */
  async function addSlicer(field: SliceField) {
    setAddingSlicer(false);
    const style = startStyle(field);
    const r = await api<{ widget: Widget; error?: string }>("POST", `/api/v1/dashboards/${board.id}/slicers`, { field: field.name, style });
    if (!r.ok) return setError(r.data?.error ?? "Could not add the slicer.");
    const [cols, rows] = SLICER_UNITS[style];
    const now = placed(onTab(widgets ?? [], tabs, tab));
    const slicers = new Set((widgets ?? []).filter((w) => w.data.kind === "slicer").map((w) => w.id));
    const x = now.filter((i) => slicers.has(i.id) && i.y === 0).reduce((m, i) => Math.max(m, i.x + i.w), 0);
    const fits = x + cols <= 12 && !now.some((i) => i.x < x + cols && i.x + i.w > x && i.y < rows);
    setWidgets((ws) => [...(ws ?? []), r.data.widget]);
    await saveLayout(fits ? [...now, { id: r.data.widget.id, x, y: 0, w: cols, h: rows }] : [{ id: r.data.widget.id, x: 0, y: 0, w: cols, h: rows }, ...now.map((i) => ({ ...i, y: i.y + rows }))]);
  }

  async function removeSlicer(w: Widget) {
    if (!(await api("DELETE", `/api/v1/widgets/${w.id}`)).ok) return setError("Could not remove the slicer.");
    if (w.data.kind === "slicer") report.setPick(w.data.field, null);
    setWidgets((ws) => ws?.filter((x) => x.id !== w.id) ?? null);
  }

  async function restyle(w: Widget, style: SlicerStyle) {
    const r = await api<{ widget: Widget; error?: string }>("PATCH", `/api/v1/widgets/${w.id}`, { style });
    if (r.ok) replace(r.data.widget);
    else setError(r.data?.error ?? "Could not change the slicer.");
  }

  const view = (w: Widget) => report.show(w);

  /** One card, or every card on the report with a summary sheet first, as an Excel workbook. */
  async function excel(only?: Widget) {
    setMenu(null);
    const cards = (only ? [only] : widgets ?? []).filter((w) => w.data.kind !== "slicer");
    const sheets = cards.map((w) => ({ name: w.title, ...asRows(w, view(w).data ?? w.data) }));
    const inForce = report.filtersFor({ id: "" } as Widget).map((f) => `${f.field}: ${f.values ? f.values.join(", ") : f.range ? f.range.join(" to ") : `${f.from} up to ${f.to}`}`);
    const summary = { name: "Summary", columns: ["Item", "Value"], rows: [["Report", board.name], ["Downloaded", new Date().toLocaleString()], ["Filters", inForce.length ? inForce.join("; ") : "None"], ...cards.map((w, i): [string, string] => [`Card ${i + 1}`, `${w.title} (${sourceLine(w.source).text}, refreshed ${ago(w.refreshedAt)})`])] };
    try {
      await downloadExcel(only ? only.title : board.name, only ? sheets : [summary, ...sheets]);
    } catch {
      setError("Could not make the Excel file.");
    }
  }

  /** Save where every card is after a drag or a resize. */
  async function saveLayout(items: Placed[]) {
    // Show it at once; the server's answer follows.
    setWidgets((ws) => ws?.map((w) => { const it = items.find((i) => i.id === w.id); return it ? { ...w, layout: { x: it.x, y: it.y, w: it.w, h: it.h }, size: sizeOf(it) } : w; }) ?? null);
    const r = await api<{ widgets: Widget[] }>("PUT", `/api/v1/dashboards/${board.id}/layout`, { items });
    if (r.ok) setWidgets(r.data.widgets);
    else setError("Could not save the new layout.");
  }

  /** The menu's small, medium and large: the same as resizing the card by hand. */
  function resizeTo(w: Widget, size: WidgetSize) {
    const [cols, rows] = UNITS[size];
    void saveLayout(placed(onTab(widgets ?? [], tabs, tab)).map((it) => (it.id === w.id ? { ...it, x: Math.min(it.x, 12 - cols), w: cols, h: rows } : it)));
  }

  async function saveTabs(next: ReportTab[]) {
    const r = await api<{ tabs: ReportTab[]; error?: string }>("PUT", `/api/v1/dashboards/${board.id}/tabs`, { tabs: next });
    if (!r.ok) return setError(r.data?.error ?? "Could not change the tabs.");
    setTabs(r.data.tabs);
    // Cards on a removed tab went to the first: read them again.
    const again = await api<{ widgets: Widget[] }>("GET", `/api/v1/dashboards/${board.id}/widgets`);
    if (again.ok) setWidgets(again.data.widgets);
  }

  /** Save a note: a new one goes on the tab that is open. Gives the reason it failed, or null. */
  async function saveNote(title: string, text: string): Promise<string | null> {
    if (!noting) return null;
    const r = noting.id
      ? await api<{ widget: Widget; error?: string }>("PATCH", `/api/v1/widgets/${noting.id}`, { title, text })
      : await api<{ widget: Widget; error?: string }>("POST", `/api/v1/dashboards/${board.id}/notes`, { title, text, tab: tabs.length ? (tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id) : null });
    if (!r.ok) return r.data?.error ?? "Could not save the text.";
    setWidgets((ws) => (noting.id ? (ws?.map((x) => (x.id === noting.id ? r.data.widget : x)) ?? null) : [...(ws ?? []), r.data.widget]));
    setNoting(null);
    return null;
  }

  async function duplicate() {
    const r = await api<{ dashboard: Board }>("POST", `/api/v1/dashboards/${board.id}/duplicate`);
    if (!r.ok) return setError("Could not copy the report.");
    onBoards();
    navigate(`/dashboards/${r.data.dashboard.id}`);
  }

  async function rename() {
    const n = name.trim();
    if (!n || n === board.name) return setName(board.name);
    if ((await api("PATCH", `/api/v1/dashboards/${board.id}`, { name: n })).ok) onBoards();
  }

  async function newBoard(template: "blank" | "sales" | "ops") {
    setChoosing(false);
    const r = await api<{ dashboard: Board; agent: { id: string; name: string } | null }>("POST", "/api/v1/dashboards", template === "blank" ? { name: "New report" } : { template });
    if (r.ok) {
      onBoards();
      navigate(`/dashboards/${r.data.dashboard.id}`);
      if (r.data.agent) setNote(`Made the agent "${r.data.agent.name}". Ask it for numbers and it will offer widgets for this report.`);
    }
  }

  async function deleteBoard() {
    if (!window.confirm(`Delete the report "${board.name}" and its widgets?`)) return;
    if ((await api("DELETE", `/api/v1/dashboards/${board.id}`)).ok) {
      onBoards();
      navigate("/dashboards");
    }
  }

  const here = onTab(widgets ?? [], tabs, tab);
  const spots = placed(here);
  const live = (widgets ?? []).filter((w) => sourceLine(w.source).live).length;
  // Cards that cannot answer the filters in force: shown as they were, and counted in the filter bar.
  const stuck = (widgets ?? []).filter((w) => w.data.kind !== "slicer" && view(w).how === "none").length;
  // Dates are filtered from the bar above the cards, so a slicer is for text and numbers.
  const unused = fields.filter((f) => f.type !== "date" && !(widgets ?? []).some((w) => w.data.kind === "slicer" && fieldNamed([f], w.data.field)));
  const focused = (widgets ?? []).find((w) => w.id === focus);
  const attention = (widgets ?? []).filter((w) => failed[w.id] || isOld(w)).length;
  const oldest = (widgets ?? []).filter((w) => sourceLine(w.source).live).map((w) => w.refreshedAt).sort()[0];
  useStatus(
    "report",
    widgets === null
      ? { left: "Opening…", tone: "busy" }
      : widgets.length === 0
        ? { left: board.name, right: "No widgets yet" }
        : {
            left: `${board.name} · ${widgets.length} ${widgets.length === 1 ? "widget" : "widgets"}${oldest ? ` · oldest refresh ${ago(oldest)}` : ""}`,
            right: attention ? `${attention} ${attention === 1 ? "widget needs" : "widgets need"} a look` : live ? "Up to date" : "Snapshots only",
            tone: attention ? "warn" : live ? "good" : undefined,
          },
  );

  return (
    <main className="main dashboard-page">
      <div className="main-head dashboard-head">
        <input className="dashboard-name" value={name} aria-label="Report name" maxLength={60} readOnly={!own} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        {!own && <span className="slice-chip off" title={board.role === "viewer" ? "You can look and filter. Ask the owner to make you an editor to change it." : "You can arrange and restyle the cards."}>Shared by {board.owner} · {board.role === "viewer" ? "view only" : "you can edit"}</span>}
        <span className="chat-head-spacer" />
        {edit && <button className="secondary" onClick={() => setBuilding(true)}>Add a card</button>}
        {edit && <button className="secondary" onClick={() => setNoting({ id: null, title: "", text: "" })}>Add text</button>}
        {edit && live > 0 && <button className="secondary" onClick={refreshAll} disabled={refreshingAll}>{refreshingAll ? "Refreshing…" : "Refresh all"}</button>}
        {edit && (widgets?.length ?? 0) > 0 && (
          <span className="slicer-add">
            <button className="secondary" aria-expanded={addingSlicer} onClick={() => setAddingSlicer(!addingSlicer)}>Slicer</button>
            {addingSlicer && <SlicerMenu fields={unused} onPick={addSlicer} onClose={() => setAddingSlicer(false)} />}
          </span>
        )}
        {(widgets ?? []).some((w) => w.data.kind !== "slicer") && <button className="secondary" onClick={() => excel()}>Excel</button>}
        {(widgets?.length ?? 0) > 0 && <Link className="secondary" to={`/dashboards/${board.id}/present`}>Present</Link>}
        {own && <button className="secondary" onClick={() => setDialog("share")}>Share</button>}
        {edit && <button className="secondary" title="Who sees this report, and what has happened to it" onClick={() => openPanel({ kind: "report", id: board.id, label: board.name })}>Who sees it</button>}
        {limited.length === 0 && <button className="secondary" title="The report as it stood on earlier dates" onClick={() => openPanel({ kind: "report", id: board.id, label: board.name, tab: "history" })}>History</button>}
        {own && (widgets?.length ?? 0) > 0 && <button className="secondary" onClick={duplicate} title="A copy of this report, with its cards and tabs">Duplicate</button>}
        {own && (widgets?.length ?? 0) > 0 && <button className="secondary" onClick={() => setDialog("email")}>Email</button>}
        <button className="secondary" onClick={() => setChoosing(true)}>New report</button>
        {own && boards.filter((b) => b.role === "owner").length > 1 && <button className="link-button danger" onClick={deleteBoard}>Delete</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ok-note" role="status">{note}</p>}
      {notices.map((n, i) => <p key={i} className="report-notice" role="status">{n.text}{n.note ? ` ${n.note}` : ""}</p>)}
      {arrived && <p className="report-arrived">Data last arrived {new Date(arrived).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>}
      {limited.length > 0 && <p className="slice-bar" role="status"><span className="slice-chip">Your view</span>You see this report for {limited.map((l) => `${l.field}: ${l.values.join(", ")}`).join("; ")}. Every figure is worked out for those rows only.</p>}
      {widgets !== null && widgets.length > 0 && <TabStrip tabs={tabs} current={tab} onPick={setTab} onChange={edit ? saveTabs : undefined} />}
      {widgets !== null && widgets.length > 0 && <FilterBar report={report} stuck={stuck} />}
      {widgets === null ? (
        <div className="gz-skel"><span /><span /><span /></div>
      ) : widgets.length === 0 ? (
        <section className="report-empty">
          <h2>Start this report</h2>
          <p>Add a card from one of your tables, or ask the agent in the panel on the right and it offers a design to add here.</p>
          {edit && <p><button className="primary-inline" onClick={() => setBuilding(true)}>Add a card from a table</button></p>}
          <div className="report-asks">
            {["What was revenue last month, and what changed?", "Show orders by source as bars", "Which products had the most refunds?"].map((q) => (
              <button key={q} className="home-tile" onClick={() => shell?.openAgent()}><strong>{q}</strong><span>Ask the agent, then add its answer.</span></button>
            ))}
          </div>
          <p className="collab-note">The agent needs data to work from: a table in a workbook, or a source under How we count.</p>
        </section>
      ) : (
        <ReportGrid
          key={tab ?? "all"}
          widgets={here}
          locked={!edit}
          onChange={saveLayout}
          render={(w) => {
            if (w.data.kind === "slicer") return <SlicerCard title={w.title} style={w.data.style} field={fieldNamed(fields, w.data.field)} pick={report.state.picks[keyOf(w.data.field)]} onPick={(p) => report.setPick((w.data as { field: string }).field, p)} onStyle={edit ? (st) => restyle(w, st) : undefined} onRemove={edit ? () => removeSlicer(w) : undefined} />;
            const shown = view(w);
            return (
              <WidgetFrame
                title={w.title}
                theme={w.theme}
                size={w.size}
                state={failed[w.id] || isOld(w) ? "stale" : undefined}
                foot={
                  failed[w.id] ? (
                    <><span className="widget-warn">Could not refresh: {failed[w.id]}</span>{edit && <button className="link-button" onClick={() => refresh(w)}>Try again</button>}</>
                  ) : isOld(w) ? (
                    <><span className="widget-warn">Last refreshed {ago(w.refreshedAt)}. It may be out of date.</span>{edit && <button className="link-button" onClick={() => refresh(w)}>Refresh</button>}</>
                  ) : (
                    <><FilterChip shown={shown} /><span>{sourceLine(w.source).text}</span></>
                  )
                }
                head={
                  <>
                    <span className="widget-age" title={new Date(w.refreshedAt).toLocaleString()}>{busy === w.id ? "Refreshing…" : ago(w.refreshedAt)}</span>
                    {edit && <span className="widget-grip" title="Drag to move" aria-hidden="true">⠿</span>}
                    <button className="widget-menu-button" aria-label={`Options for ${w.title}`} onClick={() => setMenu(menu === w.id ? null : w.id)}>⋯</button>
                    {menu === w.id && <CardMenu w={w} edit={edit} own={own} tabs={tabs} onEditNote={() => { setMenu(null); setNoting({ id: w.id, title: w.title, text: w.data.kind === "text" ? w.data.text : "" }); }} onAlert={() => { setMenu(null); setAlerting(w); }} onClose={() => setMenu(null)} onChange={(p) => change(w, p)} onSize={(size) => { setMenu(null); resizeTo(w, size); }} onRefresh={() => refresh(w)} onDelete={() => remove(w)} onSchedule={() => { setMenu(null); setScheduling(w); }} onFocus={() => { setMenu(null); setFocus(w.id); }} onExcel={() => excel(w)} />}
                  </>
                }
              >
                {shown.data ? <WidgetBody form={w.form} theme={w.theme} size={spots.find((p) => p.id === w.id)?.h === 1 && w.data.kind !== "number" ? "s" : w.size} data={shown.data} title={w.title} onPick={report.clickFilter(w)} options={w.options} /> : NOTHING_LEFT}
              </WidgetFrame>
            );
          }}
        />
      )}
      {focused && <FocusDialog w={focused} shown={view(focused)} filters={report.filtersFor(focused)} onExcel={() => excel(focused)} onClose={() => setFocus(null)} />}
      {building && <BuilderDialog boardId={board.id} onClose={() => setBuilding(false)} onAdded={(w) => { setBuilding(false); setWidgets((ws) => [...(ws ?? []), w]); }} />}
      {dialog === "share" && <ShareDialog boardId={board.id} name={board.name} onClose={() => setDialog(null)} />}
      {dialog === "email" && <EmailDialog boardId={board.id} name={board.name} onClose={() => setDialog(null)} />}
      {alerting && <AlertDialog w={alerting} onClose={() => setAlerting(null)} />}
      {noting && <NoteDialog note={noting} onSave={saveNote} onClose={() => setNoting(null)} />}
      {choosing && <TemplateDialog onPick={newBoard} onClose={() => setChoosing(false)} />}
      {scheduling && <SchedulesDialog title={`Refresh "${scheduling.title}"`} widgetId={scheduling.id} onClose={() => setScheduling(null)} />}
    </main>
  );
}

export function DashboardPage() {
  const { id } = useParams();
  const [boards, setBoards] = useState<Board[] | null>(null);
  const load = () => api<{ dashboards: Board[] }>("GET", "/api/v1/dashboards").then((r) => setBoards(r.ok ? r.data.dashboards : []));
  useEffect(() => {
    load();
  }, []);
  useTabTitle(boards?.find((b) => b.id === id)?.name ?? null);
  if (!boards) return <main className="main"><div className="gz-skel"><span /><span /><span /></div></main>;
  const board = boards.find((b) => b.id === id);
  if (!board) return boards[0] ? <Navigate to={`/dashboards/${boards[0].id}`} replace /> : <main className="main"><p>No reports.</p></main>;
  return <Board board={board} boards={boards} onBoards={load} />;
}
