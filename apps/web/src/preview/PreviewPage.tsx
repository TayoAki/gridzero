// Planned screens, shown with sample data, and what each needs from the backend.

import { useEffect } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";

import { useShell, useStatus, useTabTitle } from "../shell/context";
import { PREVIEW_GROUPS, PREVIEW_SCREENS, previewOn } from "./registry";
import { screens as agency } from "./screens/agency";
import { screens as governance } from "./screens/governance";
import { screens as sources } from "./screens/sources";
import { screens as warehouse } from "./screens/warehouse";
import type { Need, ScreenMeta } from "./types";

const SCREENS = { ...agency, ...sources, ...warehouse, ...governance };
const EXISTS = { yes: "Built", partly: "Partly built", no: "Not built" } as const;

function Needs({ needs }: { needs: Need[] }) {
  return (
    <ul className="pv-needs">
      {needs.map((n) => (
        <li key={n.kind + n.name}>
          <span className={`pv-need-kind ${n.kind}`}>{n.kind}</span>
          <strong>{n.name}</strong>
          <span className={`pv-need-state ${n.exists}`}>{EXISTS[n.exists]}</span>
          <p>{n.note}</p>
        </li>
      ))}
    </ul>
  );
}

function PreviewIndex() {
  useTabTitle("Planned screens");
  useStatus("preview", { left: `${PREVIEW_SCREENS.length} planned screens`, right: "Sample data throughout" });
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
  const all = PREVIEW_SCREENS.flatMap((s) => s.needs);
  const distinct = new Map(all.map((n) => [n.kind + n.name, n]));
  const missing = [...distinct.values()].filter((n) => n.exists !== "yes").length;
  return (
    <main className="main pv-index">
      <h1>Planned screens</h1>
      <p className="pv-lead">These screens are designed and not connected. Every number on them is a sample. Each one lists what it needs from the backend: {distinct.size} different things in all, {missing} of them not fully built.</p>
      {PREVIEW_GROUPS.map((g) => (
        <section key={g.code} id={g.code} className="def-section">
          <h2>{g.code} · {g.name} <span className="workbook-meta">{g.screens.length} screens</span></h2>
          <div className="pv-grid">
            {g.screens.map((s) => (
              <Link key={s.code} to={`/preview/${s.code}`} className="pv-tile">
                <span className="pv-tile-code">{s.code}</span>
                <strong>{s.title}</strong>
                <span>{s.summary}</span>
                <small>For {s.for} · needs {s.needs.length}</small>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function PreviewScreen({ meta }: { meta: ScreenMeta }) {
  const shell = useShell();
  useTabTitle(`${meta.code} · ${meta.title}`);
  useEffect(() => {
    shell?.setPanel("preview", {
      title: "What this screen needs",
      body: (
        <div className="pv-panel">
          <p>{meta.summary}</p>
          <p className="gz-muted">For {meta.for}.</p>
          <Needs needs={meta.needs} />
        </div>
      ),
    });
    return () => shell?.setPanel("preview", null);
  }, [shell, meta]);
  const at = PREVIEW_SCREENS.indexOf(meta);
  const prev = PREVIEW_SCREENS[at - 1];
  const next = PREVIEW_SCREENS[at + 1];
  const Body = SCREENS[meta.code];
  return (
    <main className="pv-frame">
      <div className="pv-sample" role="note">
        <strong>Planned screen {meta.code}.</strong> Sample data, not connected yet.
        <span className="gz-rail-space" />
        {prev && <Link to={`/preview/${prev.code}`}>← {prev.code}</Link>}
        <Link to="/preview">All</Link>
        {next && <Link to={`/preview/${next.code}`}>{next.code} →</Link>}
      </div>
      {Body ? <Body /> : <div className="empty"><strong>{meta.title}</strong>This screen has not been drawn yet.</div>}
    </main>
  );
}

export function PreviewPage() {
  const { code } = useParams();
  if (!previewOn()) return <Navigate to="/" replace />;
  if (!code) return <PreviewIndex />;
  const meta = PREVIEW_SCREENS.find((s) => s.code.toLowerCase() === code.toLowerCase());
  return meta ? <PreviewScreen key={meta.code} meta={meta} /> : <Navigate to="/preview" replace />;
}
