// Dashboards: a grid of widgets an agent made (agent spec §8.6).

import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

import { useTabTitle } from "../shell/context";
import { api } from "../agents/catalog";
import { SchedulesDialog } from "../agents/Schedules";
import { useEscape } from "../use-escape";
import { FORMS, FORM_DATA, SIZES, THEMES } from "./spec";
import type { Widget, WidgetForm, WidgetSize, WidgetTheme } from "./spec";
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
          {forms.map((f) => <button key={f} className={w.form === f ? "selected" : ""} onClick={() => onChange({ form: f as WidgetForm })}>{f}</button>)}
        </div>
      )}
      <button className="widget-menu-item" onClick={onRefresh}>Refresh now</button>
      <button className="widget-menu-item" onClick={onSchedule}>Schedule…</button>
      <button className="widget-menu-item danger" onClick={onDelete}>Delete</button>
    </div>
  );
}

const TEMPLATE_CHOICES = [
  { id: "blank", name: "Blank", text: "An empty dashboard." },
  { id: "sales", name: "Sales", text: "Adds a Sales analyst agent that tracks revenue, pipeline and win rate." },
  { id: "ops", name: "Operations", text: "Adds an Ops monitor agent that watches orders, backlog and support volume." },
] as const;

function TemplateDialog({ onPick, onClose }: { onPick: (t: "blank" | "sales" | "ops") => void; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="template-title">
        <div className="dialog-head">
          <h2 id="template-title">New dashboard</h2>
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
    if (r.ok) replace(r.data.widget);
    else setError(`${w.title}: ${r.data?.error ?? "Could not refresh."}`);
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
    const r = await api<{ dashboard: Board; agent: { id: string; name: string } | null }>("POST", "/api/v1/dashboards", template === "blank" ? { name: "New dashboard" } : { template });
    if (r.ok) {
      onBoards();
      navigate(`/dashboards/${r.data.dashboard.id}`);
      if (r.data.agent) setNote(`Made the agent "${r.data.agent.name}". Ask it for numbers and it will offer widgets for this dashboard.`);
    }
  }

  async function deleteBoard() {
    if (!window.confirm(`Delete the dashboard "${board.name}" and its widgets?`)) return;
    if ((await api("DELETE", `/api/v1/dashboards/${board.id}`)).ok) {
      onBoards();
      navigate("/dashboards");
    }
  }

  return (
    <main className="main dashboard-page">
      <div className="main-head dashboard-head">
        <input className="dashboard-name" value={name} aria-label="Dashboard name" maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <select aria-label="Switch dashboard" value={board.id} onChange={(e) => navigate(`/dashboards/${e.target.value}`)}>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <span className="chat-head-spacer" />
        <button className="secondary" onClick={() => setChoosing(true)}>New dashboard</button>
        {boards.length > 1 && <button className="link-button danger" onClick={deleteBoard}>Delete</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ok-note" role="status">{note}</p>}
      {widgets === null ? (
        <p>Loading…</p>
      ) : widgets.length === 0 ? (
        <div className="empty"><strong>No widgets yet</strong>Ask an agent to make one. <Link to="/agents">Open agents</Link></div>
      ) : (
        <div className="widget-grid">
          {widgets.map((w) => (
            <div key={w.id} className={`widget-slot size-${w.size}`} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(w.id)}>
              <WidgetFrame
                title={w.title}
                theme={w.theme}
                size={w.size}
                head={
                  <>
                    <span className="widget-age" title={new Date(w.refreshedAt).toLocaleString()}>{busy === w.id ? "Refreshing…" : ago(w.refreshedAt)}</span>
                    <span className="widget-grip" draggable onDragStart={() => (dragging.current = w.id)} title="Drag to reorder" aria-hidden="true">⠿</span>
                    <button className="widget-menu-button" aria-label={`Options for ${w.title}`} onClick={() => setMenu(menu === w.id ? null : w.id)}>⋯</button>
                    {menu === w.id && <CardMenu w={w} onClose={() => setMenu(null)} onChange={(p) => change(w, p)} onRefresh={() => refresh(w)} onDelete={() => remove(w)} onSchedule={() => { setMenu(null); setScheduling(w); }} />}
                  </>
                }
              >
                <WidgetBody form={w.form} theme={w.theme} size={w.size} data={w.data} />
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
  if (!boards) return <main className="main"><p>Loading…</p></main>;
  const board = boards.find((b) => b.id === id);
  if (!board) return boards[0] ? <Navigate to={`/dashboards/${boards[0].id}`} replace /> : <main className="main"><p>No dashboards.</p></main>;
  return <Board board={board} boards={boards} onBoards={load} />;
}
