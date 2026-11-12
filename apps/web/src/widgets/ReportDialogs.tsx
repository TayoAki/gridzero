// Dialogs on a report: share it, email it on a schedule, and set an alert on a figure.

import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { api } from "../agents/catalog";
import { DAYS, describe, toUtcCron } from "../agents/schedule-time";
import { useEscape } from "../use-escape";
import type { Widget } from "./spec";

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog report-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true), () => {});
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

interface Share {
  id: string;
  email: string;
  role: "viewer" | "editor";
  /** The rows this person is held to. Empty means the whole report. */
  limits: { field: string; values: string[] }[];
  accepted: boolean;
  inviteUrl: string | null;
}

export function ShareDialog({ boardId, name, onClose }: { boardId: string; name: string; onClose: () => void }) {
  const [state, setState] = useState<{ shares: Share[]; link: string | null; mail: boolean } | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The text fields this report can be limited by, with their values.
  const [fields, setFields] = useState<{ name: string; values: string[] }[]>([]);
  const [limiting, setLimiting] = useState<{ id: string; field: string; values: string } | null>(null);
  useEffect(() => {
    api<{ fields: { name: string; kind: string; values: string[] | null }[] }>("GET", `/api/v1/dashboards/${boardId}/fields`).then((r) => r.ok && setFields(r.data.fields.filter((f) => f.kind === "text" && f.values).map((f) => ({ name: f.name, values: f.values! }))));
  }, [boardId]);
  const load = () => api<{ shares: Share[]; link: string | null; mail: boolean }>("GET", `/api/v1/dashboards/${boardId}/shares`).then((r) => r.ok && setState(r.data));
  useEffect(() => {
    void load();
  }, [boardId]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    const r = await api<{ share: Share; emailed: boolean; error?: string }>("PUT", `/api/v1/dashboards/${boardId}/shares`, { email, role });
    if (!r.ok) return setError(r.data?.error ?? "Could not share the report.");
    setEmail("");
    setNote(r.data.emailed ? `An invitation was emailed to ${r.data.share.email}.` : `Send ${r.data.share.email} the invitation link below: it was not emailed.`);
    await load();
  }
  const setRoleOf = async (s: Share, next: "viewer" | "editor") => {
    await api("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: s.email, role: next });
    await load();
  };
  const remove = async (s: Share) => {
    await api("DELETE", `/api/v1/dashboards/${boardId}/shares/${s.id}`);
    await load();
  };
  const setLimit = async (s: Share, limits: { field: string; values: string[] }[]) => {
    setError(null);
    const r = await api<{ error?: string }>("PUT", `/api/v1/dashboards/${boardId}/shares`, { email: s.email, role: "viewer", limits });
    if (!r.ok) setError(r.data?.error ?? "Could not change what they see.");
    setLimiting(null);
    await load();
  };
  const setLink = async (on: boolean) => {
    const r = await api<{ link: string | null }>("PUT", `/api/v1/dashboards/${boardId}/link`, { on });
    if (r.ok && state) setState({ ...state, link: r.data.link });
  };

  return (
    <Dialog title={`Share "${name}"`} onClose={onClose}>
      <form className="report-row" onSubmit={invite}>
        <input type="email" required placeholder="name@company.com" aria-label="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")}>
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
        </select>
        <button className="primary-inline" type="submit">Invite</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ok-note" role="status">{note}</p>}
      {state === null ? (
        <div className="gz-skel"><span /><span /></div>
      ) : (
        <>
          {state.shares.length > 0 && (
            <ul className="report-list">
              {state.shares.map((s) => (
                <li key={s.id}>
                  <span className="report-list-main">
                    <strong>{s.email}</strong>
                    <span>{s.accepted ? "Has opened it" : "Invited, not opened yet"}</span>
                    {s.limits.length > 0 && <span className="report-limit">Sees only {s.limits.map((l) => `${l.field}: ${l.values.join(", ")}`).join("; ")} <button className="link-button" onClick={() => setLimit(s, [])}>Show everything</button></span>}
                    {s.limits.length === 0 && s.role === "viewer" && fields.length > 0 && limiting?.id !== s.id && <button className="link-button report-limit-add" onClick={() => setLimiting({ id: s.id, field: fields[0]!.name, values: "" })}>Limit what they see…</button>}
                    {limiting?.id === s.id && (
                      <span className="report-limit-form">
                        Only rows where
                        <select aria-label="Field" value={limiting.field} onChange={(e) => setLimiting({ ...limiting, field: e.target.value, values: "" })}>{fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}</select>
                        is
                        <select aria-label="Value" value={limiting.values} onChange={(e) => setLimiting({ ...limiting, values: e.target.value })}>
                          <option value="">choose…</option>
                          {fields.find((f) => f.name === limiting.field)?.values.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                        <button className="secondary" disabled={!limiting.values} onClick={() => setLimit(s, [{ field: limiting.field, values: [limiting.values] }])}>Apply</button>
                        <button className="link-button" onClick={() => setLimiting(null)}>Cancel</button>
                      </span>
                    )}
                    {s.inviteUrl && <span className="report-link"><input readOnly value={s.inviteUrl} aria-label={`Invitation link for ${s.email}`} onFocus={(e) => e.target.select()} /><Copy text={s.inviteUrl} /></span>}
                  </span>
                  <select aria-label={`Role of ${s.email}`} value={s.role} onChange={(e) => setRoleOf(s, e.target.value as "viewer" | "editor")}>
                    <option value="viewer">Can view</option>
                    <option value="editor">Can edit</option>
                  </select>
                  <button className="link-button danger" onClick={() => remove(s)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <div className="report-section">
            <label className="report-check">
              <input type="checkbox" checked={!!state.link} onChange={(e) => setLink(e.target.checked)} /> Anyone with the link can view
            </label>
            {state.link ? (
              <>
                <span className="report-link"><input readOnly value={state.link} aria-label="View link" onFocus={(e) => e.target.select()} /><Copy text={state.link} /></span>
                <p className="collab-note">No sign-in needed. They see the cards and can filter them. Turn it off and on again to get a new address and stop the old one.</p>
              </>
            ) : (
              <p className="collab-note">Off. Only you and the people above can open this report.</p>
            )}
          </div>
          <p className="collab-note">People you share with see what is on the cards, worked out with your access to the data. They cannot open the tables or the queries behind them. A viewer can be limited to certain rows: every card is then worked out for those rows only, and a card that cannot be limited is not shown to them.</p>
        </>
      )}
    </Dialog>
  );
}

interface Schedule {
  id: string;
  kind: string;
  dashboardId: string | null;
  recipients: string[] | null;
  webhook: string | null;
  label: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
}

export function EmailDialog({ boardId, name, onClose }: { boardId: string; name: string; onClose: () => void }) {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [to, setTo] = useState("");
  const [hook, setHook] = useState("");
  const [day, setDay] = useState("1");
  const [time, setTime] = useState("08:00");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api<{ schedules: Schedule[] }>("GET", "/api/v1/schedules").then((r) => r.ok && setList(r.data.schedules.filter((s) => s.kind === "report_email" && s.dashboardId === boardId)));
  useEffect(() => {
    void load();
  }, [boardId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    const [hour, minute] = time.split(":").map(Number) as [number, number];
    const t = { day: day === "daily" ? null : Number(day), hour, minute };
    const recipients = to.split(/[\s,;]+/).filter(Boolean);
    const r = await api<{ mail: boolean; error?: string }>("POST", "/api/v1/schedules", { kind: "report_email", dashboardId: boardId, recipients, webhook: hook.trim() || undefined, cron: toUtcCron(t, new Date().getTimezoneOffset()), label: describe(t) });
    if (!r.ok) return setError(r.data?.error ?? "Could not set this up.");
    setTo("");
    setHook("");
    if (!r.data.mail && recipients.length) setNote("Saved, but email is not set up on this server yet, so nothing will be sent until it is.");
    await load();
  }
  async function sendNow(s: Schedule) {
    setBusy(s.id);
    setError(null);
    setNote(null);
    const r = await api<{ error?: string }>("POST", `/api/v1/schedules/${s.id}/run`);
    setBusy(null);
    if (r.ok) setNote(`Sent to ${[...(s.recipients ?? []), ...(s.webhook ? [new URL(s.webhook).hostname] : [])].join(", ")}.`);
    else setError(r.data?.error ?? "Could not send it.");
    await load();
  }
  const remove = async (s: Schedule) => {
    await api("DELETE", `/api/v1/schedules/${s.id}`);
    await load();
  };

  return (
    <Dialog title={`Email "${name}"`} onClose={onClose}>
      <form className="report-form" onSubmit={add}>
        <label className="field">
          Send to
          <input required={!hook.trim()} placeholder="client@company.com, boss@company.com" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          Also post to Slack or a webhook (optional)
          <input type="url" placeholder="https://hooks.slack.com/services/…" value={hook} onChange={(e) => setHook(e.target.value)} />
        </label>
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
          <button className="primary-inline" type="submit">Add</button>
        </div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ok-note" role="status">{note}</p>}
      {list === null ? (
        <div className="gz-skel"><span /></div>
      ) : list.length === 0 ? (
        <p className="collab-note">Not being emailed to anyone yet.</p>
      ) : (
        <ul className="report-list">
          {list.map((s) => (
            <li key={s.id}>
              <span className="report-list-main">
                <strong>{s.label}</strong>
                <span>To {[...(s.recipients ?? []), ...(s.webhook ? [`a webhook at ${new URL(s.webhook).hostname}`] : [])].join(", ")}</span>
                <span className={s.lastStatus === "error" ? "widget-warn" : undefined}>{s.lastStatus === "error" ? `Last send failed: ${s.lastError}` : s.lastRunAt ? `Last sent ${new Date(s.lastRunAt).toLocaleString()}` : s.nextRunAt ? `First send ${new Date(s.nextRunAt).toLocaleString()}` : ""}</span>
              </span>
              <button className="secondary" disabled={busy === s.id} onClick={() => sendNow(s)}>{busy === s.id ? "Sending…" : "Send now"}</button>
              <button className="link-button danger" onClick={() => remove(s)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <p className="collab-note">Each send refreshes the live cards first, then writes every card out as figures and small tables with a link to the report. Charts are not drawn in the email. A Slack incoming webhook gets the figures as a message.</p>
    </Dialog>
  );
}

interface Alert {
  id: string;
  op: "above" | "below";
  threshold: number;
  firing: boolean;
  lastFiredAt: string | null;
}

export function AlertDialog({ w, onClose }: { w: Widget; onClose: () => void }) {
  const [list, setList] = useState<Alert[] | null>(null);
  const [op, setOp] = useState<"above" | "below">("below");
  const [threshold, setThreshold] = useState("");
  const [hook, setHook] = useState("");
  const [error, setError] = useState<string | null>(null);
  const value = w.data.kind === "number" ? w.data.value : null;
  const unit = w.data.kind === "number" ? (w.data.unit ?? "") : "";
  const load = () => api<{ alerts: Alert[] }>("GET", `/api/v1/widgets/${w.id}/alerts`).then((r) => r.ok && setList(r.data.alerts));
  useEffect(() => {
    void load();
  }, [w.id]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await api<{ error?: string }>("POST", `/api/v1/widgets/${w.id}/alerts`, { op, threshold: Number(threshold), ...(hook.trim() ? { webhook: hook.trim() } : {}) });
    if (!r.ok) return setError(r.data?.error ?? "Could not add the alert.");
    setThreshold("");
    await load();
  }
  const remove = async (a: Alert) => {
    await api("DELETE", `/api/v1/alerts/${a.id}`);
    await load();
  };

  return (
    <Dialog title={`Alerts on "${w.title}"`} onClose={onClose}>
      {value !== null && <p className="collab-note">It is {value.toLocaleString()}{unit} now.</p>}
      <form className="report-row" onSubmit={add}>
        <span>Tell me when it goes</span>
        <select aria-label="Above or below" value={op} onChange={(e) => setOp(e.target.value as "above" | "below")}>
          <option value="below">below</option>
          <option value="above">above</option>
        </select>
        <input type="number" step="any" required aria-label="The line" placeholder="a number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        <button className="primary-inline" type="submit">Add</button>
      </form>
      <label className="field">Also post it to a chat webhook (optional)<input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://hooks.slack.com/…" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      {list === null ? (
        <div className="gz-skel"><span /></div>
      ) : list.length === 0 ? (
        <p className="collab-note">No alerts on this card.</p>
      ) : (
        <ul className="report-list">
          {list.map((a) => (
            <li key={a.id}>
              <span className="report-list-main">
                <strong>When it goes {a.op} {a.threshold.toLocaleString()}{unit}</strong>
                <span>{a.firing ? `Past the line now${a.lastFiredAt ? `, since ${new Date(a.lastFiredAt).toLocaleString()}` : ""}. You will be told again after it comes back and crosses once more.` : "Not past the line."}</span>
              </span>
              <button className="link-button danger" onClick={() => remove(a)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <p className="collab-note">An alert is checked each time the card refreshes, so give the card a refresh schedule. You are told in the bell, and by email when email is set up.</p>
    </Dialog>
  );
}
