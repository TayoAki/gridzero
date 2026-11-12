// Work on a thing: actions, decisions, requests and issues, each with its trail. Used in the inbox
// (what is waiting on me) and in the panel for any one thing (everything raised on it).

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";
import type { ObjectRef } from "./ObjectPanel";

export interface WorkItem {
  id: string;
  kind: "action" | "decision" | "request" | "issue";
  title: string;
  body: string;
  status: string;
  due: string | null;
  overdue: boolean;
  closed: boolean;
  createdBy: string | null;
  assignee: string | null;
  mine: boolean;
  made: boolean;
  object: { kind: string; id: string; label: string } | null;
  acceptance: { text: string; done: boolean }[];
  links: { kind: string; id: string; label: string }[];
  events: { at: string; by: string; text: string }[];
  priority: "low" | "normal" | "high" | "urgent";
  requester: string | null;
  examples: { columns: string[]; rows: (string | null)[][] } | null;
  createdAt: string;
  moves: string[];
}

const KIND: Record<WorkItem["kind"], string> = { action: "Action", decision: "Decision", request: "Request", issue: "Issue" };
const MOVE: Record<string, string> = { done: "Mark done", escalated: "Escalate", open: "Reopen", accepted: "Accept", declined: "Decline", built: "It is built", signed_off: "Sign off", fixing: "Start on it", fixed: "It is fixed", verified: "Verify the fix" };
const STATUS: Record<string, string> = { open: "Open", done: "Done", escalated: "Escalated", recorded: "Recorded", new: "New", accepted: "Accepted", declined: "Declined", built: "Built, awaiting sign-off", signed_off: "Signed off", fixing: "Being fixed", fixed: "Fixed, awaiting a check", verified: "Verified" };
const linkOf = (o: { kind: string; id: string }) => (o.kind === "report" ? `/dashboards/${o.id}` : o.kind === "workbook" || o.kind === "table" || o.kind === "field" ? `/workbook/${o.id.split(":")[0]}` : o.kind === "source" ? `/definitions/${o.id}` : null);

function Item({ item, onChanged }: { item: WorkItem; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const send = async (body: Record<string, unknown>) => {
    const r = await api<{ error?: string }>("PATCH", `/api/v1/work/${item.id}`, { ...body, ...(note.trim() ? { note: note.trim() } : {}) });
    if (!r.ok) return setError(r.data.error ?? "That could not be saved.");
    setError(null);
    setNote("");
    onChanged();
  };
  const to = item.object ? linkOf(item.object) : null;
  return (
    <li className={`work-item${item.closed ? " closed" : ""}`} data-testid="work-item">
      <div className="work-head">
        <span className={`work-kind work-${item.kind}`}>{KIND[item.kind]}</span>
        {item.priority !== "normal" && <span className={`work-pri work-pri-${item.priority}`}>{item.priority}</span>}
        <strong>{item.title}</strong>
        <span className={`work-status${item.status === "escalated" ? " hot" : ""}`}>{STATUS[item.status] ?? item.status}</span>
      </div>
      <p className="muted">
        {item.object && <>On {to ? <Link to={to}>{item.object.label}</Link> : item.object.label} · </>}
        {item.requester ? `Asked by ${item.requester} through a form` : item.kind === "request" ? `Asked by ${item.createdBy}` : `From ${item.createdBy}`}{item.assignee ? ` · ${item.kind === "decision" ? "by" : "for"} ${item.assignee}` : ""}
        {item.due && <> · <span className={item.overdue ? "insight-flag" : ""}>due {item.due}{item.overdue ? " (overdue)" : ""}</span></>}
      </p>
      {item.body && <p>{item.body}</p>}
      {item.examples && (
        <div className="insight-scroll"><table className="insight-table"><caption>Example rows</caption><thead><tr>{item.examples.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{item.examples.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table></div>
      )}
      {item.acceptance.length > 0 && (
        <ul className="work-checks">
          {item.acceptance.map((a, i) => (
            <li key={i}><label><input type="checkbox" checked={a.done} disabled={item.closed || !(item.made || item.mine)} onChange={(e) => void send({ acceptance: item.acceptance.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)) })} /> {a.text}</label></li>
          ))}
        </ul>
      )}
      {item.links.length > 0 && <p className="muted">Attached: {item.links.map((l, i) => { const t = linkOf(l); return <span key={i}>{i ? ", " : ""}{t ? <Link to={t}>{l.label}</Link> : l.label}</span>; })}</p>}
      {!item.closed && (item.mine || item.made) && (
        <div className="work-act">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" aria-label={`A note on ${item.title}`} maxLength={1000} />
          {(item.mine || item.made) && <select aria-label={`Priority of ${item.title}`} value={item.priority} onChange={(e) => void send({ priority: e.target.value })}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>}
          {item.moves.map((m) => <button key={m} className={m === "done" || m === "signed_off" || m === "verified" || m === "accepted" ? "primary-inline" : "secondary"} onClick={() => void send({ status: m })}>{MOVE[m] ?? m}</button>)}
          {note.trim() && <button className="secondary" onClick={() => void send({})}>Add note</button>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} what happened ({item.events.length})</button>
      {open && <ul className="insight-log">{item.events.map((e, i) => <li key={i}><time dateTime={e.at}>{new Date(e.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time><span><strong>{e.by}</strong> {e.text}</span></li>)}</ul>}
    </li>
  );
}

function NewWork({ object, onMade }: { object?: ObjectRef; onMade: () => void }) {
  const [kind, setKind] = useState<WorkItem["kind"]>(object ? "action" : "request");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [checks, setChecks] = useState("");
  const [priority, setPriority] = useState("normal");
  const [rows, setRows] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const acceptance = checks.split("\n").map((s) => s.trim()).filter(Boolean);
    // Example rows are pasted as comma-separated lines; the first line names the columns.
    const lines = rows.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(",").map((x) => x.trim()));
    const examples = lines.length > 1 ? { columns: lines[0]!, rows: lines.slice(1, 21).map((l) => lines[0]!.map((_, i) => l[i] ?? null)) } : null;
    const r = await api<{ error?: string }>("POST", "/api/v1/work", { ...(priority !== "normal" && kind !== "decision" ? { priority } : {}), ...(examples && kind !== "decision" ? { examples } : {}), kind, title, ...(body.trim() ? { body } : {}), ...(due ? { due } : {}), ...(assignee.trim() ? { assignee: assignee.trim() } : {}), ...(object ? { object: { kind: object.kind, id: object.id } } : {}), ...(kind === "request" && acceptance.length ? { acceptance } : {}) });
    if (!r.ok) return setError(r.data.error ?? "That could not be saved.");
    setError(null);
    setTitle("");
    setBody("");
    setDue("");
    setChecks("");
    onMade();
  };
  return (
    <form className="report-form work-new" onSubmit={submit}>
      <div className="work-row">
        <label className="field">What<select value={kind} onChange={(e) => setKind(e.target.value as WorkItem["kind"])} aria-label="What to raise"><option value="action">An action for someone</option><option value="decision">A decision that was made</option><option value="request">A request for a report or data</option><option value="issue">An issue with the data</option></select></label>
        <label className="field work-grow">{kind === "decision" ? "What was decided" : "Title"}<input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} /></label>
      </div>
      {kind !== "decision" && (
        <div className="work-row">
          <label className="field work-grow">{kind === "request" ? "Who it is for (email)" : "Who (email; blank for the owner)"}<input type="email" value={assignee} onChange={(e) => setAssignee(e.target.value)} required={kind === "request" && !object} /></label>
          <label className="field">Due<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="field">Priority<select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
        </div>
      )}
      <label className="field">Detail (optional)<textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></label>
      {(kind === "request" || kind === "issue") && <label className="field">Example rows (optional): paste lines of comma-separated values, column names first<textarea rows={3} value={rows} onChange={(e) => setRows(e.target.value)} placeholder={"order_id,status,counts\n12,paid,yes\n10,cancelled,no"} /></label>}
      {kind === "request" && <label className="field">Done when (one check per line)<textarea rows={2} value={checks} onChange={(e) => setChecks(e.target.value)} placeholder={"Splits by region\nMatches the finance sheet"} /></label>}
      <div><button className="primary-inline">{kind === "decision" ? "Record it" : "Raise it"}</button></div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export function WorkList({ scope, object, onCount }: { scope: "mine" | "made" | "all" | "object"; object?: ObjectRef; onCount?: (n: number) => void }) {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api<{ items: WorkItem[] }>("GET", `/api/v1/work?scope=${scope}${object ? `&kind=${object.kind}&id=${encodeURIComponent(object.id)}` : ""}`).then((r) => {
      setItems(r.ok ? r.data.items : []);
      if (r.ok) onCount?.(r.data.items.filter((i) => !i.closed).length);
    });
  useEffect(() => {
    void load();
  }, [scope, object?.id]);
  return (
    <div className="work">
      <div className="work-top">
        <button className="secondary" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? "Cancel" : object ? "Raise something on this" : "New request, action or issue"}</button>
      </div>
      {adding && <NewWork object={object} onMade={() => { setAdding(false); void load(); }} />}
      {items === null ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted">{scope === "mine" ? "Nothing is waiting on you." : scope === "object" ? "Nothing has been raised on this." : "Nothing yet."}</p> : <ul className="work-list">{items.map((i) => <Item key={i.id} item={i} onChanged={load} />)}</ul>}
    </div>
  );
}

/** Changes announced to this person that they have not yet said they have seen. */
export function Announced() {
  const [list, setList] = useState<{ id: string; label: string; message: string; effectiveOn: string | null }[]>([]);
  const load = () => api<{ announcements: typeof list }>("GET", "/api/v1/announcements/mine").then((r) => setList(r.ok ? r.data.announcements : []));
  useEffect(() => {
    void load();
  }, []);
  if (!list.length) return null;
  return (
    <ul className="work-list">
      {list.map((a) => (
        <li key={a.id} className="work-item" data-testid="announced">
          <div className="work-head"><span className="work-kind">Change coming</span><strong>{a.label}</strong></div>
          <p>{a.message}{a.effectiveOn ? ` From ${a.effectiveOn}.` : ""} You own something built on it.</p>
          <div className="work-act"><button className="primary-inline" onClick={async () => { await api("POST", `/api/v1/announcements/${a.id}/ack`); void load(); }}>I have seen this</button></div>
        </li>
      ))}
    </ul>
  );
}

/** Forms with their own address, for people without an account to ask through. */
export function IntakeLinks() {
  const [links, setLinks] = useState<{ token: string; title: string; url: string }[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ links: typeof links }>("GET", "/api/v1/intake-links").then((r) => setLinks(r.ok ? r.data.links : []));
  useEffect(() => {
    void load();
  }, []);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ error?: string }>("POST", "/api/v1/intake-links", { title });
    setError(r.ok ? null : (r.data?.error ?? "The form could not be made."));
    if (r.ok) setTitle("");
    void load();
  };
  return (
    <details className="work-new">
      <summary>A form for people without an account ({links.length})</summary>
      <p className="muted">Anyone with the form's address can ask you for something. Their request arrives here, marked with their email address.</p>
      {links.map((l) => <p key={l.token} className="watch-row"><span><strong>{l.title}</strong> <input readOnly value={l.url} aria-label={`Address of the form ${l.title}`} onFocus={(e) => e.target.select()} className="intake-url" /></span><button className="link-button danger" onClick={async () => { await api("DELETE", `/api/v1/intake-links/${l.token}`); void load(); }}>Close it</button></p>)}
      <form className="insight-controls" onSubmit={make}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ask the data team" aria-label="Title of the form" required minLength={2} maxLength={80} />
        <button className="secondary">Make a form</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </details>
  );
}

/** Today: what is due or overdue, soonest first, with a way to finish or pass up each one. Made for a phone. */
export function Today() {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const load = () => api<{ items: WorkItem[] }>("GET", "/api/v1/work?scope=mine").then((r) => setItems(r.ok ? r.data.items : []));
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const day = new Date().toISOString().slice(0, 10);
  const due = (items ?? []).filter((i) => i.kind !== "decision" && (!i.due || i.due <= day)).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const later = (items ?? []).length - due.length;
  const move = async (i: WorkItem, status: string) => {
    const note = status === "escalated" ? window.prompt("What should whoever picks this up know?") : null;
    if (status === "escalated" && note === null) return;
    await api("PATCH", `/api/v1/work/${i.id}`, { status, ...(note ? { note } : {}) });
    void load();
  };
  if (items === null) return <p className="muted">Loading…</p>;
  return (
    <div className="today">
      <p className="muted">{due.length ? `${due.length} to deal with today${later ? `, ${later} due later` : ""}.` : `Nothing is due today${later ? `; ${later} due later` : ""}.`} As of {new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.</p>
      <ul className="work-list">
        {due.map((i) => (
          <li key={i.id} className="work-item today-item">
            <div className="work-head">
              {i.priority !== "normal" && <span className={`work-pri work-pri-${i.priority}`}>{i.priority}</span>}
              <strong>{i.title}</strong>
              <span className={`work-status${i.overdue ? " hot" : ""}`}>{i.due ? (i.overdue ? `overdue since ${i.due}` : "due today") : `raised ${new Date(i.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`}</span>
            </div>
            {i.object && <p className="muted">On {i.object.label} · from {i.createdBy}</p>}
            <div className="work-act">{i.moves.map((m) => <button key={m} className={m === "done" || m === "fixed" || m === "accepted" ? "primary-inline today-btn" : "secondary today-btn"} onClick={() => void move(i, m)}>{MOVE[m] ?? m}</button>)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
