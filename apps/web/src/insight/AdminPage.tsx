// Admin: every person, every connection, and what one person can reach. Only for administrators.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { api } from "../agents/catalog";
import { useTabTitle } from "../shell/context";
import { Contracts, Groups, StarterLists, TopQuestions, UnityCatalog, WarehouseSpend } from "./AdminMore";
import { eventText, when } from "./ObjectPanel";
import type { LogEvent } from "./ObjectPanel";

interface Overview {
  days: number;
  active: number;
  people: { id: string; name: string; email: string; joined: string; lastActive: string | null; events: number; admin: boolean; auditor: boolean }[];
  connections: { id: string; name: string; kind: string; host: string; owner: string; lastUsed: string | null; failures: number }[];
  sources: { id: string; name: string; kind: string; workspace: string }[];
}
interface Reach {
  person: { name: string; email: string };
  reports: { id: string; name: string; role: string; rows: string; columns: string; tables: string; shareId: string | null }[];
  workbooks: { id: string; title: string; role: string }[];
  workspaces: { id: string; name: string; role: string }[];
  connections: { id: string; name: string; kind: string }[];
  changes: { at: string; kind: string; label: string; by: string; detail: Record<string, unknown> }[];
}

export function AdminPage() {
  useTabTitle("Admin");
  const [tab, setTab] = useState<"people" | "connections" | "access" | "groups" | "lists" | "questions" | "spend" | "unity" | "contracts">("people");
  const [over, setOver] = useState<Overview | null>(null);
  const [denied, setDenied] = useState(false);
  const [email, setEmail] = useState("");
  const [reach, setReach] = useState<Reach | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Overview>("GET", "/api/v1/admin/overview?days=90").then((r) => (r.ok ? setOver(r.data) : setDenied(true)));
  }, []);
  const look = async (e: FormEvent | null, who = email) => {
    e?.preventDefault();
    const r = await api<Reach & { error?: string }>("GET", `/api/v1/admin/access?email=${encodeURIComponent(who.trim())}`);
    setReach(r.ok ? r.data : null);
    setError(r.ok ? null : (r.data.error ?? "That could not be looked up."));
  };
  if (denied) return <main className="main"><h1>Admin</h1><p>Only an administrator can see this page. Administrators are named in the server's ADMIN_EMAILS setting.</p></main>;
  if (!over) return <main className="main"><div className="gz-skel"><span /><span /><span /></div></main>;
  return (
    <main className="main insight-page">
      <h1>Admin</h1>
      <div className="need-tabs" role="tablist">
        {([["people", `People (${over.people.length})`], ["connections", `Connections (${over.connections.length})`], ["access", "View as"], ["groups", "Groups"], ["lists", "Starter lists"], ["questions", "What people ask"], ["contracts", "Contracts"], ["spend", "Warehouse spend"], ["unity", "Unity Catalog"]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "people" && (
        <>
          <p className="muted">{over.active} of {over.people.length} people did something in the last {over.days} days. <a className="link-button" href="/api/v1/activity/export?what=people&days=90" download>Download this list</a></p>
          <div className="insight-scroll">
            <table className="insight-table">
              <thead><tr><th>Person</th><th>Joined</th><th>Last active</th><th className="num">Events</th><th></th></tr></thead>
              <tbody>{over.people.map((p) => (
                <tr key={p.id}>
                  <td>{p.name} <span className="muted">{p.email}</span>{p.admin && <span className="insight-tag">administrator</span>}{p.auditor && <span className="insight-tag">auditor</span>}</td>
                  <td>{new Date(p.joined).toLocaleDateString()}</td>
                  <td>{p.lastActive ? when(p.lastActive) : <span className="insight-flag">Idle</span>}</td>
                  <td className="num">{p.events}</td>
                  <td><button className="link-button" onClick={() => { setEmail(p.email); setTab("access"); void look(null, p.email); }}>View as</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      {tab === "connections" && (
        <>
          <div className="insight-scroll">
            <table className="insight-table">
              <thead><tr><th>Connection</th><th>Kind</th><th>Where</th><th>Owner</th><th>Last used</th><th className="num">Failures</th></tr></thead>
              <tbody>{over.connections.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.kind}</td><td>{x.host}</td><td>{x.owner}</td><td>{x.lastUsed ? when(x.lastUsed) : "Never"}</td><td className="num">{x.failures ? <span className="insight-flag">{x.failures}</span> : 0}</td></tr>)}</tbody>
            </table>
          </div>
          <h2>Sources in workspaces</h2>
          <div className="insight-scroll">
            <table className="insight-table">
              <thead><tr><th>Source</th><th>Kind</th><th>Workspace</th></tr></thead>
              <tbody>{over.sources.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.kind}</td><td>{s.workspace}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="muted">Passwords are never shown. Each member of a workspace signs in to a database source as themselves.</p>
        </>
      )}
      {tab === "groups" && <Groups />}
      {tab === "lists" && <StarterLists />}
      {tab === "questions" && <TopQuestions />}
      {tab === "contracts" && <Contracts />}
      {tab === "spend" && <WarehouseSpend />}
      {tab === "unity" && <UnityCatalog />}
      {tab === "access" && (
        <>
          <form className="insight-controls" onSubmit={look}>
            <label>Email address <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email address" /></label>
            <button className="primary-inline">View as</button>
          </form>
          {error && <p className="error" role="alert">{error}</p>}
          {reach && (
            <>
              <h2>{reach.person.name} can reach</h2>
              <div className="insight-scroll">
                <table className="insight-table">
                  <thead><tr><th>Report</th><th>Role</th><th>Rows</th><th>Columns</th><th>Tables and queries</th><th></th></tr></thead>
                  <tbody>{reach.reports.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.role}</td><td>{r.rows}</td><td>{r.columns}</td><td>{r.tables}</td><td>{r.shareId && <button className="link-button danger" onClick={async () => { if (!window.confirm(`Remove ${reach.person.name}'s access to ${r.name}? The report's owner is told.`)) return; const done = await api<{ error?: string }>("PATCH", `/api/v1/admin/shares/${r.shareId}`, { remove: true }); setError(done.ok ? null : (done.data?.error ?? "That could not be done.")); void look(null, reach.person.email); }}>Remove access</button>}</td></tr>)}{reach.reports.length === 0 && <tr><td colSpan={6} className="muted">No reports.</td></tr>}</tbody>
                </table>
              </div>
              <div className="insight-scroll">
                <table className="insight-table">
                  <thead><tr><th>Workbook</th><th>Role</th></tr></thead>
                  <tbody>{reach.workbooks.map((w) => <tr key={w.id}><td>{w.title}</td><td>{w.role}</td></tr>)}{reach.workbooks.length === 0 && <tr><td colSpan={2} className="muted">No workbooks.</td></tr>}</tbody>
                </table>
              </div>
              <p>Workspaces: {reach.workspaces.map((w) => `${w.name} (${w.role})`).join(", ") || "none"}. Own connections: {reach.connections.map((x) => `${x.name} (${x.kind})`).join(", ") || "none"}.</p>
              <h2>Changes to their access</h2>
              {reach.changes.length === 0 ? <p className="muted">None recorded.</p> : <ul className="insight-log">{reach.changes.map((x, i) => <li key={i}><time dateTime={x.at}>{when(x.at)}</time><span><strong>{x.by}</strong> {eventText({ ...x, id: i, who: x.by, objectKind: "report", objectId: "", ms: null } as LogEvent)} <em>· {x.label}</em></span></li>)}</ul>}
            </>
          )}
        </>
      )}
    </main>
  );
}
