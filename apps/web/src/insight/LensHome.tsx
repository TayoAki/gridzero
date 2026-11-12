// The top of Home changes with the kind of work a person does. Five homes: Decide (figures against
// targets, actions, decisions), Analyse (start from data), Build (the health of the data), Govern
// (coverage and what is waiting for a decision), Run (what gets used and what it costs). The choice is
// kept in this browser.

import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";

export const LENSES = [
  ["decide", "Decide", "I read numbers and act on them"],
  ["analyse", "Analyse", "I answer questions with data"],
  ["build", "Build", "I make the data, models and reports"],
  ["govern", "Govern", "I approve, check and protect"],
  ["run", "Run", "I keep the platform working"],
] as const;
export type Lens = (typeof LENSES)[number][0];

interface Home {
  targets: { id: string; title: string; reportId: string; report: string; value: number; unit: string | null; target: number; met: boolean }[];
  work: { id: string; kind: string; title: string; status: string; due: string | null; overdue: boolean; label: string }[];
  decisions: { id: string; title: string; label: string; at: string }[];
  data: { late: { name: string; workbookId: string; note: string | null }[]; failing: { name: string; workbookId: string; rows: number | null }[]; arrived: string | null; workbooks: number };
}
interface Coverage {
  totals: { sources: number; sourcesOwned: number; definitions: number; confirmed: number; reports: number; cards: number };
  issues: { open: number; olderThanAWeek: number; oldestDays: number };
  sensitive: { marked: number; unreviewed: number };
}
interface Usage {
  reports: { id: string; name: string; opens: number; people: number }[];
  unopened: number;
  cost: { queries: { seconds: number }[]; ai: { usd: number }[] };
}
const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function useLens(): [Lens, (l: Lens) => void] {
  const read = (): Lens => {
    try {
      const v = localStorage.getItem("gz_lens");
      return LENSES.some(([id]) => id === v) ? (v as Lens) : "analyse";
    } catch {
      return "analyse";
    }
  };
  const [lens, setLens] = useState<Lens>(read);
  return [lens, (l) => { setLens(l); try { localStorage.setItem("gz_lens", l); } catch { /* the choice is then for this visit only */ } }];
}

function Tile({ title, children, to }: { title: string; children: React.ReactNode; to?: string }) {
  const body = <><span className="lens-tile-title">{title}</span>{children}</>;
  return to ? <Link to={to} className="lens-tile">{body}</Link> : <div className="lens-tile">{body}</div>;
}

export function LensHome({ lens, onLens, questions }: { lens: Lens; onLens: (l: Lens) => void; questions: number }) {
  const [home, setHome] = useState<Home | null>(null);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    api<Home>("GET", "/api/v1/home").then((r) => r.ok && setHome(r.data));
  }, []);
  useEffect(() => {
    if (lens === "govern" && !cov) api<Coverage>("GET", "/api/v1/coverage").then((r) => r.ok && setCov(r.data));
    if (lens === "run" && !usage) api<Usage>("GET", "/api/v1/activity/usage").then((r) => r.ok && setUsage(r.data));
  }, [lens]);
  // The starter list an administrator set for this kind of work, if there is one.
  const [steps, setSteps] = useState<{ text: string; link: string | null; done: boolean }[]>([]);
  useEffect(() => {
    api<{ items: { text: string; link: string | null; done: boolean }[] }>("GET", `/api/v1/checklists/${lens}`).then((r) => setSteps(r.ok ? r.data.items : []));
  }, [lens]);
  const tick = async (text: string, on: boolean) => {
    setSteps(steps.map((s) => (s.text === text ? { ...s, done: on } : s)));
    await api("POST", `/api/v1/checklists/${lens}/done`, { text, on });
  };
  const overdue = home?.work.filter((w) => w.overdue).length ?? 0;
  const health = home ? home.data.late.length + home.data.failing.length : 0;
  return (
    <section className="lens" aria-label="Your home">
      <div className="lens-pick" role="radiogroup" aria-label="The kind of work you do">
        {LENSES.map(([id, label, what]) => <button key={id} role="radio" aria-checked={lens === id} className={lens === id ? "on" : ""} title={what} onClick={() => onLens(id)}>{label}</button>)}
      </div>
      {steps.length > 0 && steps.some((s) => !s.done) && (
        <div className="lens-steps" role="group" aria-label="Getting started">
          <strong>Getting started</strong>
          {steps.map((s) => <label key={s.text}><input type="checkbox" checked={s.done} onChange={(e) => void tick(s.text, e.target.checked)} /> {s.link ? <Link to={s.link}>{s.text}</Link> : s.text}</label>)}
        </div>
      )}
      {!home ? <div className="gz-skel"><span /><span /></div> : (
        <div className="lens-grid">
          {lens === "decide" && (
            <>
              {home.targets.length === 0 && <Tile title="Figures against targets" to="/dashboards"><span className="lens-none">No card has a target yet. Open a report, then a figure card's menu, and choose "Set a target".</span></Tile>}
              {home.targets.slice(0, 6).map((t) => (
                <Tile key={t.id} title={t.title} to={`/dashboards/${t.reportId}`}>
                  <span className="lens-big">{n(t.value)}{t.unit ?? ""}</span>
                  <span className="lens-sub">of {n(t.target)} <b className={t.met ? "on" : "off"}>{t.target ? `${Math.round((t.value / t.target) * 100)}%` : ""} {t.met ? "on target" : "behind"}</b></span>
                  <span className="lens-sub">{t.report}</span>
                </Tile>
              ))}
              <Tile title="Waiting on you" to="/needs-you?tab=work"><span className="lens-big">{home.work.length}</span><span className="lens-sub">{overdue ? <b className="off">{overdue} overdue</b> : "nothing overdue"}</span>{home.work.slice(0, 3).map((w) => <span key={w.id} className="lens-line">{w.title}{w.due ? ` · due ${w.due}` : ""}</span>)}</Tile>
              <Tile title="Decisions recorded" to="/needs-you?tab=work">{home.decisions.length === 0 ? <span className="lens-none">None yet. Record one from any report: Who sees it, then Work.</span> : home.decisions.map((d) => <span key={d.id} className="lens-line">{d.title}{d.label ? ` · ${d.label}` : ""}</span>)}</Tile>
            </>
          )}
          {lens === "analyse" && (
            <>
              <Tile title="Questions only a person can answer" to="/needs-you"><span className="lens-big">{questions}</span><span className="lens-sub">each shows the figure for every choice</span></Tile>
              <Tile title="Query your tables" to="/sql"><span className="lens-sub">Write SQL over any workbook, see which definitions and cards use each field.</span></Tile>
              <Tile title="Build a card by hand" to="/dashboards"><span className="lens-sub">Totals, two tables side by side, a funnel, or retention.</span></Tile>
            </>
          )}
          {lens === "build" && (
            <>
              <Tile title="Data health" to="/sql"><span className="lens-big">{health}</span><span className="lens-sub">{health ? <b className="off">{home.data.late.length} late, {home.data.failing.length} failing checks</b> : "nothing late, no failing checks"}</span>{home.data.late.map((t) => <span key={t.name} className="lens-line">{t.name} is late{t.note ? ` · ${t.note}` : ""}</span>)}{home.data.failing.map((k) => <span key={k.name} className="lens-line">{k.name}{k.rows ? ` · ${k.rows} rows` : ""}</span>)}</Tile>
              <Tile title="Data last arrived"><span className="lens-sub">{home.data.arrived ? new Date(home.data.arrived).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "No connected table has refreshed yet."}</span><span className="lens-sub">{home.data.workbooks} workbooks</span></Tile>
              <Tile title="Definitions and releases" to="/definitions"><span className="lens-sub">See what a change moves before publishing, and cut a release with its test results.</span></Tile>
              <Tile title="Waiting on you" to="/needs-you?tab=work"><span className="lens-big">{home.work.length}</span><span className="lens-sub">requests, issues and actions</span></Tile>
            </>
          )}
          {lens === "govern" && (
            <>
              <Tile title="Definitions confirmed" to="/definitions"><span className="lens-big">{cov ? `${cov.totals.confirmed} of ${cov.totals.definitions}` : "…"}</span><span className="lens-sub">{questions} questions waiting for a person</span></Tile>
              <Tile title="Sources with a named owner" to="/definitions"><span className="lens-big">{cov ? `${cov.totals.sourcesOwned} of ${cov.totals.sources}` : "…"}</span><span className="lens-sub">name one from a source: Releases, owner and what uses this</span></Tile>
              <Tile title="Open issues" to="/needs-you?tab=work"><span className="lens-big">{cov?.issues.open ?? "…"}</span><span className="lens-sub">{cov?.issues.olderThanAWeek ? <b className="off">{cov.issues.olderThanAWeek} older than a week</b> : "none older than a week"}</span></Tile>
              <Tile title="Sensitive fields" to="/sql"><span className="lens-big">{cov ? cov.sensitive.marked : "…"}</span><span className="lens-sub">{cov?.sensitive.unreviewed ? <b className="off">{cov.sensitive.unreviewed} look sensitive and are not marked</b> : "none waiting to be reviewed"}</span></Tile>
              <Tile title="Who did what" to="/activity"><span className="lens-sub">Every share, approval of a sensitive field, snapshot and release, with who and when.</span></Tile>
            </>
          )}
          {lens === "run" && (
            <>
              <Tile title="Reports opened in 30 days" to="/activity"><span className="lens-big">{usage ? `${usage.reports.length - usage.unopened} of ${usage.reports.length}` : "…"}</span><span className="lens-sub">{usage?.unopened ? <b className="off">{usage.unopened} not opened</b> : "all in use"}</span></Tile>
              <Tile title="Query time and AI spending" to="/activity"><span className="lens-big">{usage ? `${n(usage.cost.queries.reduce((a, q) => a + q.seconds, 0))} s` : "…"}</span><span className="lens-sub">{usage ? `$${usage.cost.ai.reduce((a, x) => a + x.usd, 0).toFixed(2)} on agents` : ""}</span></Tile>
              <Tile title="Data health" to="/sql"><span className="lens-big">{health}</span><span className="lens-sub">{health ? <b className="off">late tables and failing checks</b> : "nothing late, no failing checks"}</span></Tile>
              <Tile title="Requests and issues waiting on you" to="/needs-you?tab=work"><span className="lens-big">{home.work.length}</span><span className="lens-sub">{overdue ? <b className="off">{overdue} overdue</b> : "nothing overdue"}</span></Tile>
            </>
          )}
        </div>
      )}
    </section>
  );
}
