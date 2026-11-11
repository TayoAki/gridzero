// Dashboards: a grid of widgets an agent made (agent spec §8.6).

import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

import { useShell, useStatus, useTabTitle } from "../shell/context";
import { api } from "../agents/catalog";
import { SchedulesDialog } from "../agents/Schedules";
import { useEscape } from "../use-escape";
import { FORMS, FORM_DATA, SIZES, THEMES } from "./spec";
import type { Widget, WidgetForm, WidgetSize, WidgetSource, WidgetTheme } from "./spec";
import { WidgetBody, WidgetFrame } from "./WidgetView";

interface Board {
  id: string;
  name: string;
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
const FORM_NAMES: Partial<Record<WidgetForm, string>> = { trend: "Line", bars: "Bars", hbar: "Bars across", pie: "Pie", donut: "Donut", funnel: "Funnel", treemap: "Treemap", waterfall: "Waterfall", table: "Table", stacked: "Stacked bars", heatmap: "Heatmap", number: "Number", list: "List", text: "Text" };

function CardMenu({ w, onChange, onDelete, onRefresh, onSchedule, onClose }: { w: Widget; onChange: (p: Partial<Widget>) => void; onDelete: () => void; onRefresh: () => void; onSchedule: () => void; onClose: () => void }) {
  useEscape(onClose);
  const forms = FORMS.filter((f) => FORM_DATA[f] === w.data.kind);
  return (
    <div className="widget-menu" role="menu" onMouseLeave={onClose}>
      <div className="widget-menu-row">
        Size
        {SIZES.map((s) => <button key={s} className={w.size === s ? "selected" : ""} onClick={() => onChange({ size: s as WidgetSize })}>{s.toUpperCase()}</button>)}
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
      <button className="widget-menu-item" onClick={onRefresh}>Refresh now</button>
      <button className="widget-menu-item" onClick={onSchedule}>Schedule…</button>
      <button className="widget-menu-item danger" onClick={onDelete}>Delete</button>
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

/**
 * A report on a wall screen: full window, large type, no controls. It reloads every minute and
 * refreshes its live widgets every fifteen. Escape goes back.
 */
export function PresentPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [widgets, setWidgets] = useState<Widget[] | null>(null);
  const [at, setAt] = useState(() => new Date());
  useEscape(() => navigate(`/dashboards/${id}`));
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ widgets: Widget[] }>("GET", `/api/v1/dashboards/${id}/widgets`).then((r) => {
        if (live && r.ok) {
          setWidgets(r.data.widgets);
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
        <div className="widget-grid present-grid">
          {widgets.map((w) => (
            <div key={w.id} className={`widget-slot size-${w.size}`}>
              <WidgetFrame title={w.title} theme={w.theme} size={w.size} state={isOld(w) ? "stale" : undefined} foot={isOld(w) ? <span className="widget-warn">Last refreshed {ago(w.refreshedAt)}</span> : undefined}>
                <WidgetBody form={w.form} theme={w.theme} size={w.size} data={w.data} title={w.title} />
              </WidgetFrame>
            </div>
          ))}
        </div>
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
  const dragging = useRef<string | null>(null);
  // Refreshes that failed this visit: the card keeps its last value and says why it is old.
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const shell = useShell();

  useEffect(() => {
    setName(board.name);
    setWidgets(null);
    api<{ widgets: Widget[] }>("GET", `/api/v1/dashboards/${board.id}/widgets`).then((r) => setWidgets(r.ok ? r.data.widgets : []));
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

  async function drop(targetId: string) {
    const from = dragging.current;
    dragging.current = null;
    if (!widgets || !from || from === targetId) return;
    const moved = widgets.find((w) => w.id === from)!;
    const rest = widgets.filter((w) => w.id !== from);
    rest.splice(rest.findIndex((w) => w.id === targetId), 0, moved);
    setWidgets(rest);
    const r = await api("PUT", `/api/v1/dashboards/${board.id}/order`, { widgetIds: rest.map((w) => w.id) });
    if (!r.ok) setError("Could not save the new order.");
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

  const live = (widgets ?? []).filter((w) => sourceLine(w.source).live).length;
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
        <input className="dashboard-name" value={name} aria-label="Report name" maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <span className="chat-head-spacer" />
        {live > 0 && <button className="secondary" onClick={refreshAll} disabled={refreshingAll}>{refreshingAll ? "Refreshing…" : "Refresh all"}</button>}
        {(widgets?.length ?? 0) > 0 && <Link className="secondary" to={`/dashboards/${board.id}/present`}>Present</Link>}
        <button className="secondary" onClick={() => setChoosing(true)}>New report</button>
        {boards.length > 1 && <button className="link-button danger" onClick={deleteBoard}>Delete</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ok-note" role="status">{note}</p>}
      {widgets === null ? (
        <div className="gz-skel"><span /><span /><span /></div>
      ) : widgets.length === 0 ? (
        <section className="report-empty">
          <h2>Start this report</h2>
          <p>A report is made of numbers an agent has worked out. Ask in the panel on the right and it offers a design to add here.</p>
          <div className="report-asks">
            {["What was revenue last month, and what changed?", "Show orders by source as bars", "Which products had the most refunds?"].map((q) => (
              <button key={q} className="home-tile" onClick={() => shell?.openAgent()}><strong>{q}</strong><span>Ask the agent, then add its answer.</span></button>
            ))}
          </div>
          <p className="collab-note">The agent needs data to work from: a table in a workbook, or a source under How we count.</p>
        </section>
      ) : (
        <div className="widget-grid">
          {widgets.map((w) => (
            <div key={w.id} className={`widget-slot size-${w.size}`} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(w.id)}>
              <WidgetFrame
                title={w.title}
                theme={w.theme}
                size={w.size}
                state={failed[w.id] || isOld(w) ? "stale" : undefined}
                foot={
                  failed[w.id] ? (
                    <><span className="widget-warn">Could not refresh: {failed[w.id]}</span><button className="link-button" onClick={() => refresh(w)}>Try again</button></>
                  ) : isOld(w) ? (
                    <><span className="widget-warn">Last refreshed {ago(w.refreshedAt)}. It may be out of date.</span><button className="link-button" onClick={() => refresh(w)}>Refresh</button></>
                  ) : (
                    <span>{sourceLine(w.source).text}</span>
                  )
                }
                head={
                  <>
                    <span className="widget-age" title={new Date(w.refreshedAt).toLocaleString()}>{busy === w.id ? "Refreshing…" : ago(w.refreshedAt)}</span>
                    <span className="widget-grip" draggable onDragStart={() => (dragging.current = w.id)} title="Drag to reorder" aria-hidden="true">⠿</span>
                    <button className="widget-menu-button" aria-label={`Options for ${w.title}`} onClick={() => setMenu(menu === w.id ? null : w.id)}>⋯</button>
                    {menu === w.id && <CardMenu w={w} onClose={() => setMenu(null)} onChange={(p) => change(w, p)} onRefresh={() => refresh(w)} onDelete={() => remove(w)} onSchedule={() => { setMenu(null); setScheduling(w); }} />}
                  </>
                }
              >
                <WidgetBody form={w.form} theme={w.theme} size={w.size} data={w.data} title={w.title} />
              </WidgetFrame>
            </div>
          ))}
        </div>
      )}
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
