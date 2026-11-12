import { noteKind } from "../insight/ObjectPanel";
import { LensHome, useLens } from "../insight/LensHome";
import type { Needs } from "./NeedsYouPage";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { api } from "../agents/catalog";
import { useStatus, useTabTitle } from "../shell/context";

interface WorkbookRow {
  id: string;
  title: string;
  lastAccessedAt: string;
  role: "owner" | "editor" | "viewer";
  owner: string;
}

/** Workbooks, and for someone new, three ways to start. */
/** A greeting for the time of day, as the design has it. */
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomePage() {
  const navigate = useNavigate();
  const [workbooks, setWorkbooks] = useState<WorkbookRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ agents: number; reports: number } | null>(null);
  const [needs, setNeeds] = useState<Needs | null>(null);
  useTabTitle("Home");

  function load() {
    api<{ workbooks: WorkbookRow[] }>("GET", "/api/v1/workbooks").then((r) => {
      setFailed(!r.ok);
      setWorkbooks(r.ok ? r.data.workbooks : []);
    });
  }

  useEffect(() => {
    load();
    void api<Needs>("GET", "/api/v1/needs-you").then((r) => r.ok && setNeeds(r.data));
    void Promise.all([api<{ agents: unknown[] }>("GET", "/api/v1/agents"), api<{ dashboards: { widgetCount?: number }[] }>("GET", "/api/v1/dashboards")]).then(([a, d]) =>
      setSetup({ agents: a.ok ? a.data.agents.length : 0, reports: d.ok ? d.data.dashboards.length : 0 }),
    );
  }, []);

  /** Make a workbook and open it, optionally straight into an import. */
  async function start(how: "blank" | "upload" | "sample") {
    setCreating(how);
    const r = await api<{ id: string }>("POST", "/api/v1/workbooks");
    setCreating(null);
    if (r.ok) navigate(`/workbook/${r.data.id}${how === "blank" ? "" : `?import=${how}`}`);
  }

  async function deleteWorkbook(w: WorkbookRow) {
    if (!window.confirm(`Move "${w.title}" to trash?`)) return;
    const r = await api("DELETE", `/api/v1/workbooks/${w.id}`);
    if (r.ok) load();
  }

  const [lens, setLens] = useLens();
  const fresh = workbooks !== null && workbooks.length === 0 && !failed;
  const steps: [string, boolean][] = [["Add your data", (workbooks?.length ?? 0) > 0], ["Ask the agent a question", (setup?.agents ?? 0) > 0], ["Make a report", (setup?.reports ?? 0) > 0]];
  const at = steps.findIndex(([, done]) => !done);
  useStatus("home", workbooks === null ? { left: "Opening…", tone: "busy" } : fresh ? { left: "Step 1 of 3", right: "Add your data to begin", tone: "busy" } : { left: `${workbooks.length} ${workbooks.length === 1 ? "workbook" : "workbooks"}`, right: at >= 0 ? `Next: ${steps[at]![0].toLowerCase()}` : undefined });

  return (
    <main className="main">
      {fresh ? (
        <div className="main-head">
          <h1>Start with your data</h1>
        </div>
      ) : (
        <>
          <h1 className="home-hello">{greeting()}</h1>
          <p className="home-sub">
            {needs === null
              ? "Ask anything in the bar above, on any screen."
              : needs.counts.definitions === 0
                ? "Ask anything in the bar above, on any screen. Upload a table and Grid Zero works out its keys, links and totals for you."
                : `Grid Zero has modelled ${needs.counts.definitions} definitions from your data: ${needs.counts.settled} settled without asking, ${needs.counts.confirmed} confirmed by people. ${needs.questions.length ? `${needs.questions.length} ${needs.questions.length === 1 ? "question needs" : "questions need"} a person.` : "Nothing needs you."}`}
          </p>
          <LensHome lens={lens} onLens={setLens} questions={needs?.questions.length ?? 0} />
          {needs && (needs.questions.length > 0 || needs.changes.length > 0 || needs.notifications.some((n) => !n.read)) && (
            <>
              <h2>Waiting for you</h2>
              <div className="home-waiting">
                {needs.questions.slice(0, 2).map((q) => (
                  <Link key={q.id} to="/needs-you" className="home-wait">
                    <span className="slice-chip">Question</span>
                    <strong>{q.prompt}</strong>
                    <span>{q.options.slice(0, 2).map((o) => (o.text ? `${o.label}: ${o.text}` : o.label)).join(" · ") || q.source}</span>
                  </Link>
                ))}
                {needs.changes.slice(0, 1).map((ch) => (
                  <Link key={ch.id} to="/needs-you" className="home-wait">
                    <span className="slice-chip">Change to review</span>
                    <strong>{ch.label}</strong>
                    <span>{ch.request}</span>
                  </Link>
                ))}
                {needs.notifications.filter((n) => !n.read).slice(0, 1).map((n) => (
                  <Link key={n.id} to="/needs-you" className="home-wait">
                    <span className="slice-chip">{noteKind(n.kind)}</span>
                    <strong>{n.title}</strong>
                    <span>{n.body}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <div className="home-start">
        <button className="home-tile" onClick={() => start("upload")} disabled={creating !== null}>
          <strong>{creating === "upload" ? "Opening…" : "Upload a file"}</strong>
          <span>An export from your store, ad account or any spreadsheet. CSV, Excel, JSON or Parquet.</span>
        </button>
        <button className="home-tile" onClick={() => start("sample")} disabled={creating !== null}>
          <strong>{creating === "sample" ? "Opening…" : "Try sample data"}</strong>
          <span>6,000 orders from a made-up outdoor store, with refunds, cancelled and test orders.</span>
        </button>
        <button className="home-tile" onClick={() => start("blank")} disabled={creating !== null}>
          <strong>{creating === "blank" ? "Opening…" : "Blank workbook"}</strong>
          <span>Start from an empty sheet.</span>
        </button>
      </div>

      {workbooks === null ? (
        <div className="gz-skel"><span /><span /><span /></div>
      ) : failed ? (
        <p className="error" role="alert">Your workbooks could not be loaded. Check your connection and reload the page.</p>
      ) : fresh ? (
        <section className="settings-card">
          <h2>Getting set up</h2>
          <ol className="home-steps">
            {steps.map(([label, done], i) => <li key={label} className={done ? "done" : ""}><span aria-hidden="true">{done ? "✓" : `${i + 1}.`}</span>{label}</li>)}
          </ol>
          <p className="collab-note">Most people start with an orders export. The agent in the panel on the right reads every row and tells you what is in it.</p>
        </section>
      ) : (
        <>
          <h2 className="home-list-head">Your workbooks</h2>
          <ul className="workbook-list">
            {workbooks.map((w) => (
              <li key={w.id}>
                <Link to={`/workbook/${w.id}`} className="workbook-link">{w.title}</Link>
                <span className="workbook-meta">
                  {w.role === "owner" ? "" : `Shared by ${w.owner} · `}Opened {new Date(w.lastAccessedAt).toLocaleString()}
                </span>
                {w.role === "owner" && <button className="link-button danger" onClick={() => deleteWorkbook(w)} aria-label={`Delete ${w.title}`}>Delete</button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
