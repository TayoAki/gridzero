// One panel for any thing in the app (a workbook, table, field, source, definition, card or report):
// what is built on it and who sees that, and what has happened to it.

import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";
import { useEscape } from "../use-escape";
import { Checks, History, OwnerLine, Releases, SensitiveFields } from "./PanelTabs";
import { WorkList } from "./Work";

export type ObjectKind = "workbook" | "table" | "field" | "source" | "definition" | "card" | "report";
export interface ObjectRef {
  kind: ObjectKind;
  id: string;
  label: string;
  /** The tab to open on: used, work, history, releases, checks or activity. */
  tab?: string;
}
interface UsedBy {
  item: { label: string; owner: string | null };
  definitions: { id: string; label: string; kind: string; status: string }[];
  cards: { id: string; title: string; reportId: string; report: string }[];
  reports: { id: string; name: string; owner: string; link: boolean }[];
  people: { total: number; outside: number; list: { email: string; role: string; limited: boolean; report: string }[] };
  announcements: { id: string; message: string; effectiveOn: string | null; told: number; at: string }[];
}
export interface LogEvent {
  id: number;
  at: string;
  who: string;
  kind: string;
  objectKind: string;
  objectId: string;
  label: string;
  detail: Record<string, unknown>;
  ms: number | null;
}

const WHAT: Record<string, string> = {
  "report.opened": "opened it",
  "report.opened_by_link": "opened it from the view link",
  "workbook.opened": "opened it",
  "query.run": "ran a query",
  "share.added": "shared it with",
  "share.changed": "changed the access of",
  "share.removed": "stopped sharing with",
  "link.changed": "turned the view link",
  "definition.confirmed": "confirmed it",
  "definition.changed": "published a change",
  "change.announced": "announced a change",
  "connection.used": "refreshed a table",
  "connection.failed": "had a refresh fail",
  "owner.named": "named the owner:",
  "action.opened": "raised an action",
  "decision.opened": "recorded a decision",
  "request.opened": "made a request",
  "issue.opened": "raised an issue",
  "check.failed": "A check started failing",
  "table.late": "A table went late",
  "table.recovered": "A table has fresh data again",
  "snapshot.taken": "took a snapshot",
  "snapshot.opened": "opened a snapshot",
  "release.cut": "cut a release",
  "share.sensitive_approved": "shared sensitive fields on purpose with",
  "embed.link_made": "made a signed link",
  "embed.links_stopped": "stopped every signed link",
  "report.protected": "set the smallest group viewers may see",
  "field.marked_sensitive": "marked a field sensitive:",
  "field.unmarked": "unmarked a field:",
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** One line of the log, in words. */
export function eventText(e: LogEvent): string {
  const d = e.detail as { email?: string; role?: string; on?: boolean; limits?: { field: string; values: string[] }[] | null; message?: string; rows?: number; error?: string };
  const base = WHAT[e.kind] ?? e.kind;
  if (e.kind.startsWith("share.")) return `${base} ${d.email ?? ""}${d.role ? ` (${d.role}${d.limits?.length ? `, only ${d.limits.map((l) => `${l.field} is ${l.values.join(" or ")}`).join("; ")}` : ""})` : ""}`;
  if (e.kind === "link.changed") return `${base} ${d.on ? "on" : "off"}`;
  if (e.kind === "change.announced") return `${base}: ${d.message ?? ""}`;
  if (e.kind === "query.run") return `${base} (${plural(d.rows ?? 0, "row")}, ${((e.ms ?? 0) / 1000).toFixed(1)} s)`;
  if (e.kind === "connection.failed") return `${base}: ${d.error ?? ""}`;
  if (e.kind === "owner.named") return `${base} ${d.email ?? ""}`;
  if (e.kind === "share.sensitive_approved") return `${base} ${d.email ?? ""} (${((e.detail as { fields?: string[] }).fields ?? []).join(", ")})`;
  if (e.kind.startsWith("field.")) return `${base} ${e.label}`;
  if (e.kind.endsWith(".opened") && e.objectKind !== "report" && e.label) return `${base}: ${e.label}`;
  return base;
}

export function EventList({ events, showThing }: { events: LogEvent[]; showThing?: boolean }) {
  if (!events.length) return <p className="muted">Nothing has been recorded yet. The log starts from when this was switched on.</p>;
  return (
    <ul className="insight-log">
      {events.map((e) => (
        <li key={e.id}>
          <time dateTime={e.at}>{when(e.at)}</time>
          <span><strong>{e.who}</strong> {eventText(e)}{showThing && e.label ? <em> · {e.label}</em> : null}</span>
        </li>
      ))}
    </ul>
  );
}

export interface PanelTab {
  id: string;
  label: string;
  body: ReactNode;
}

export function ObjectPanel({ item, onClose, extra = [] }: { item: ObjectRef; onClose: () => void; extra?: PanelTab[] }) {
  useEscape(onClose);
  const [tab, setTab] = useState(item.tab ?? "used");
  const [open, setOpen] = useState(0);
  const [used, setUsed] = useState<UsedBy | null>(null);
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [date, setDate] = useState("");
  const [told, setTold] = useState<string | null>(null);
  const q = `kind=${item.kind}&id=${encodeURIComponent(item.id)}`;
  const load = () => api<UsedBy>("GET", `/api/v1/used-by?${q}`).then((r) => (r.ok ? setUsed(r.data) : setError("You cannot see what is built on this.")));
  useEffect(() => {
    void load();
    api<{ events: LogEvent[] }>("GET", `/api/v1/activity?${q}`).then((r) => setEvents(r.ok ? r.data.events : []));
  }, [q]);
  const announce = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ told: number; error?: string }>("POST", "/api/v1/announcements", { kind: item.kind, id: item.id, message, effectiveOn: date || null });
    if (!r.ok) return setError(r.data.error ?? "That could not be sent.");
    setError(null);
    setMessage("");
    setTold(r.data.told ? `${plural(r.data.told, "owner")} told.` : "Recorded. Nobody else owns anything built on this.");
    void load();
  };
  const tabs: PanelTab[] = [
    {
      id: "used",
      label: "Used by",
      body: !used ? (
        <p className="muted">{error ?? "Looking…"}</p>
      ) : (
        <>
          <OwnerLine item={item} owner={used.item.owner} onChanged={load} />
          {used.definitions.length + used.cards.length + used.reports.length + used.people.total === 0 && <p>Nothing is built on this yet.</p>}
          {used.definitions.length > 0 && (
            <section>
              <h3>{plural(used.definitions.length, "definition")}</h3>
              <ul className="insight-list">{used.definitions.map((d) => <li key={d.id}>{d.label} <span className="muted">{d.kind}, {d.status.replace("_", " ")}</span></li>)}</ul>
            </section>
          )}
          {used.cards.length > 0 && (
            <section>
              <h3>{plural(used.cards.length, "card")} in {plural(new Set(used.cards.map((c) => c.reportId)).size, "report")}</h3>
              <ul className="insight-list">{used.cards.map((c) => <li key={c.id}>{c.title} <span className="muted">in <Link to={`/dashboards/${c.reportId}`} onClick={onClose}>{c.report}</Link></span></li>)}</ul>
            </section>
          )}
          {used.people.total > 0 && (
            <section>
              <h3>{plural(used.people.total, "person").replace("persons", "people")} can see {item.kind === "report" ? "it" : "those reports"}{used.people.outside ? `, ${used.people.outside} from outside the owner's email domain` : ""}</h3>
              <ul className="insight-list">{used.people.list.map((p, i) => <li key={i}>{p.email} <span className="muted">{p.role}{p.limited ? ", limited to certain rows" : ""}{item.kind === "report" ? "" : ` · ${p.report}`}</span></li>)}</ul>
              {used.reports.some((r) => r.link) && <p className="muted">A view link is on for {used.reports.filter((r) => r.link).map((r) => r.name).join(", ")}: anyone with it can look.</p>}
            </section>
          )}
          {item.kind !== "card" && item.kind !== "report" && (
            <form className="report-form insight-announce" onSubmit={announce}>
              <h3>Announce a change</h3>
              <p className="muted">The owners of what is built on this are told in the app before it happens.</p>
              <label className="field">What is changing<textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} required minLength={3} /></label>
              <label className="field">From (optional)<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
              <div><button className="primary-inline" disabled={message.trim().length < 3}>Tell the owners</button></div>
              {told && <p className="ok-note" role="status">{told}</p>}
              {error && used && <p className="error" role="alert">{error}</p>}
            </form>
          )}
          {used.announcements.length > 0 && (
            <section>
              <h3>Changes announced</h3>
              <ul className="insight-list">{used.announcements.map((a) => <li key={a.id}>{a.message} <span className="muted">{a.effectiveOn ? `from ${a.effectiveOn} · ` : ""}{when(a.at)} · {plural(a.told, "owner")} told</span></li>)}</ul>
            </section>
          )}
        </>
      ),
    },
    { id: "work", label: open ? `Work (${open})` : "Work", body: <WorkList scope="object" object={item} onCount={setOpen} /> },
    ...(item.kind === "report" ? [{ id: "history", label: "History", body: <History boardId={item.id} onClose={onClose} /> }] : []),
    ...(item.kind === "source" ? [{ id: "releases", label: "Releases", body: <Releases sourceId={item.id} /> }] : []),
    ...(item.kind === "workbook" ? [{ id: "checks", label: "Checks", body: <Checks workbookId={item.id} /> }, { id: "sensitive", label: "Sensitive fields", body: <SensitiveFields workbookId={item.id} onClose={onClose} /> }] : []),
    { id: "activity", label: "Activity", body: events ? <EventList events={events} /> : <p className="muted">Loading…</p> },
    ...extra,
  ];
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog report-dialog insight-panel" role="dialog" aria-modal="true" aria-label={`About ${item.label}`}>
        <div className="dialog-head">
          <h2>{item.label} <span className="muted insight-kind">{item.kind}</span></h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="need-tabs" role="tablist">
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div className="insight-body">{tabs.find((t) => t.id === tab)?.body}</div>
      </div>
    </div>
  );
}
