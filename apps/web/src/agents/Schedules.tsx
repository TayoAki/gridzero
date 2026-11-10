// Schedules for a widget (refresh) or an agent (a read-only task) (agent spec §9.4).

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useEscape } from "../use-escape";
import { api } from "./catalog";
import { DAYS, describe, toUtcCron } from "./schedule-time";

interface Schedule {
  id: string;
  kind: "widget_refresh" | "task";
  agentId: string | null;
  widgetId: string | null;
  prompt: string | null;
  label: string;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
}

export function SchedulesList({ widgetId, agentId }: { widgetId?: string; agentId?: string }) {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [day, setDay] = useState<string>("daily");
  const [time, setTime] = useState("08:00");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await api<{ schedules: Schedule[] }>("GET", "/api/v1/schedules");
    if (r.ok) setList(r.data.schedules.filter((s) => (widgetId ? s.widgetId === widgetId : s.agentId === agentId)));
  }
  useEffect(() => {
    load();
  }, [widgetId, agentId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const [hour, minute] = time.split(":").map(Number) as [number, number];
    const t = { day: day === "daily" ? null : Number(day), hour, minute };
    setBusy(true);
    setError(null);
    const body = widgetId
      ? { kind: "widget_refresh", widgetId, cron: toUtcCron(t, new Date().getTimezoneOffset()), label: describe(t) }
      : { kind: "task", agentId, prompt, cron: toUtcCron(t, new Date().getTimezoneOffset()), label: describe(t) };
    const r = await api<{ error?: string }>("POST", "/api/v1/schedules", body);
    setBusy(false);
    if (!r.ok) return setError(r.data?.error ?? `Could not save (${r.status}).`);
    setPrompt("");
    load();
  }

  async function toggle(s: Schedule) {
    if ((await api("PATCH", `/api/v1/schedules/${s.id}`, { paused: !s.paused })).ok) load();
  }

  async function remove(s: Schedule) {
    if ((await api("DELETE", `/api/v1/schedules/${s.id}`)).ok) load();
  }

  return (
    <div className="schedules">
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="collab-note">No schedules yet.</p>
      ) : (
        <ul className="schedule-list">
          {list.map((s) => (
            <li key={s.id} className={s.paused ? "paused" : ""}>
              <div className="schedule-main">
                <strong>{s.label}</strong>
                {s.prompt && <span className="schedule-prompt">{s.prompt}</span>}
                <span className="schedule-status">
                  {s.paused ? "Paused" : s.nextRunAt ? `Next: ${new Date(s.nextRunAt).toLocaleString()}` : ""}
                  {s.lastRunAt && (
                    <>
                      {" · "}Last: {new Date(s.lastRunAt).toLocaleString()}{" "}
                      {s.lastStatus === "ok" ? <span className="ok-note">✓</span> : <span className="error-inline" title={s.lastError ?? ""}>✕ {s.lastError}</span>}
                    </>
                  )}
                </span>
              </div>
              <button className="link-button" onClick={() => toggle(s)}>{s.paused ? "Resume" : "Pause"}</button>
              <button className="link-button danger" onClick={() => remove(s)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      <form className="schedule-add" onSubmit={add}>
        {agentId && (
          <label className="field">
            Task
            <textarea rows={3} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="For example: Check competitor prices and summarize any changes." required />
          </label>
        )}
        <div className="schedule-when">
          <label className="field">
            Repeat
            <select value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="daily">Every day</option>
              {DAYS.map((d, i) => <option key={d} value={String(i)}>Every {d}</option>)}
            </select>
          </label>
          <label className="field">
            At
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </label>
          <button className="primary-inline" type="submit" disabled={busy || (!!agentId && !prompt.trim())}>Add</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="collab-note">
          {agentId ? "Scheduled tasks can read and search, but never change anything. Answers appear in this chat. " : ""}
          Times follow UTC, so they may move by an hour when clocks change.
        </p>
      </form>
    </div>
  );
}

export function SchedulesDialog({ title, widgetId, agentId, onClose }: { title: string; widgetId?: string; agentId?: string; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="schedules-title">
        <div className="dialog-head">
          <h2 id="schedules-title">{title}</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <SchedulesList widgetId={widgetId} agentId={agentId} />
      </div>
    </div>
  );
}
