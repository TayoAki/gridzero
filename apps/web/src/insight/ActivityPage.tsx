// Activity: what has happened to the things you own, which of your reports get opened, and what the
// queries and the AI cost. An administrator can switch to everyone.

import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";
import { useTabTitle } from "../shell/context";
import { ReliabilityView } from "./AdminMore";
import { EventList, when } from "./ObjectPanel";
import type { LogEvent } from "./ObjectPanel";

interface Usage {
  days: number;
  reports: { id: string; name: string; owner: string; opens: number; people: number; lastOpened: string | null }[];
  unopened: number;
  cost: { queries: { owner: string; kind: string; id: string; label: string; runs: number; seconds: number }[]; ai: { owner: string; runs: number; usd: number }[] };
}

export function ActivityPage() {
  useTabTitle("Activity");
  const [tab, setTab] = useState<"log" | "usage" | "cost" | "reliability">("log");
  const [admin, setAdmin] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [days, setDays] = useState(30);
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    api<{ admin: boolean; auditor: boolean }>("GET", "/api/v1/me").then((r) => r.ok && setAdmin(r.data.admin || r.data.auditor));
  }, []);
  useEffect(() => {
    const all = everyone ? "&everyone=1" : "";
    api<{ events: LogEvent[] }>("GET", `/api/v1/activity?${all}`).then((r) => setEvents(r.ok ? r.data.events : []));
    api<Usage>("GET", `/api/v1/activity/usage?days=${days}${all}`).then((r) => r.ok && setUsage(r.data));
  }, [everyone, days]);
  return (
    <main className="main insight-page">
      <div className="main-head">
        <h1>Activity</h1>
        <div className="insight-controls">
          {admin && <label><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Everyone</label>}
          <label>Period <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label>
        </div>
      </div>
      <div className="need-tabs" role="tablist">
        {([["log", "What happened"], ["usage", "What gets used"], ["cost", "What it costs"], ["reliability", "How reliable the data is"]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "log" && (events ? <EventList events={events} showThing /> : <p className="muted">Loading…</p>)}
      {tab === "usage" && usage && (
        <>
          <p className="muted">{usage.reports.length ? `${usage.reports.length - usage.unopened} of ${usage.reports.length} reports were opened in the last ${usage.days} days.` : "There are no reports yet."}</p>
          <div className="insight-scroll">
            <table className="insight-table">
              <thead><tr><th>Report</th>{everyone && <th>Owner</th>}<th className="num">Opens</th><th className="num">People</th><th>Last opened</th></tr></thead>
              <tbody>{usage.reports.map((r) => <tr key={r.id}><td><Link to={`/dashboards/${r.id}`}>{r.name}</Link></td>{everyone && <td>{r.owner}</td>}<td className="num">{r.opens}</td><td className="num">{r.people}</td><td>{r.lastOpened ? when(r.lastOpened) : <span className="insight-flag">Not opened</span>}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      {tab === "reliability" && <ReliabilityView everyone={everyone} days={days} />}
      {tab === "cost" && usage && (
        <>
          <h2>Query time</h2>
          {usage.cost.queries.length === 0 ? <p className="muted">No timed queries in this period.</p> : (
            <div className="insight-scroll">
              <table className="insight-table">
                <thead><tr><th>What</th>{everyone && <th>Owner</th>}<th className="num">Runs</th><th className="num">Seconds</th></tr></thead>
                <tbody>{usage.cost.queries.map((q) => <tr key={q.kind + q.id}><td>{q.label || q.id} <span className="muted">{q.kind}</span></td>{everyone && <td>{q.owner}</td>}<td className="num">{q.runs}</td><td className="num">{q.seconds.toFixed(1)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <h2>AI spending</h2>
          {usage.cost.ai.length === 0 ? <p className="muted">No agent runs in this period.</p> : (
            <div className="insight-scroll">
              <table className="insight-table">
                <thead><tr>{everyone && <th>Person</th>}<th className="num">Agent runs</th><th className="num">US dollars</th></tr></thead>
                <tbody>{usage.cost.ai.map((a, i) => <tr key={i}>{everyone && <td>{a.owner}</td>}<td className="num">{a.runs}</td><td className="num">{a.usd.toFixed(2)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <p className="muted">Query time is measured here, in this app. It is not what your warehouse bills.</p>
        </>
      )}
    </main>
  );
}
