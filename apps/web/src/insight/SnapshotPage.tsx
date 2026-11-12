// A report as it stood: every card frozen at the moment the snapshot was taken, and each single
// figure set beside what it is today.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { api } from "../agents/catalog";
import { useTabTitle } from "../shell/context";
import { WidgetBody } from "../widgets/WidgetView";
import type { Widget } from "../widgets/spec";

interface Snap {
  id: string;
  report: string;
  dashboardId: string;
  label: string;
  takenAt: string;
  cards: Pick<Widget, "id" | "title" | "form" | "theme" | "size" | "data" | "options">[];
  figures: { id: string; title: string; unit: string | null; then: number; now: number | null; change: number | null }[];
}
const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function SnapshotPage() {
  const { id } = useParams();
  const [snap, setSnap] = useState<Snap | null>(null);
  const [missing, setMissing] = useState(false);
  useTabTitle(snap ? `${snap.report}, as it stood` : "Snapshot");
  useEffect(() => {
    api<Snap>("GET", `/api/v1/snapshots/${id}`).then((r) => (r.ok ? setSnap(r.data) : setMissing(true)));
  }, [id]);
  if (missing) return <main className="main"><h1>This snapshot is not available</h1><p>It may have been removed, or the report is one you see only part of.</p></main>;
  if (!snap) return <main className="main"><div className="gz-skel"><span /><span /><span /></div></main>;
  const at = new Date(snap.takenAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  return (
    <main className="main insight-page">
      <div className="main-head">
        <h1>{snap.report}</h1>
        <Link className="secondary" to={`/dashboards/${snap.dashboardId}`}>Open it as it is now</Link>
      </div>
      <p className="snap-banner" role="status">As it stood on <strong>{at}</strong>{snap.label ? ` · ${snap.label}` : ""}. Nothing here updates, and filters do not apply.</p>
      {snap.figures.length > 0 && (
        <div className="insight-scroll">
          <table className="insight-table snap-figures">
            <thead><tr><th>Figure</th><th className="num">Then</th><th className="num">Now</th><th className="num">Change</th></tr></thead>
            <tbody>{snap.figures.map((f) => <tr key={f.id}><td>{f.title}</td><td className="num">{n(f.then)}{f.unit ?? ""}</td><td className="num">{f.now === null ? "no longer on the report" : `${n(f.now)}${f.unit ?? ""}`}</td><td className={`num ${f.change === null || f.change === 0 ? "" : f.change > 0 ? "up" : "down"}`}>{f.change === null ? "" : f.change === 0 ? "none" : `${f.change > 0 ? "+" : "−"}${n(Math.abs(f.change))}`}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="snap-grid">
        {snap.cards.map((c) => (
          <section key={c.id} className={`widget-card widget-${c.theme}`}>
            <header className="widget-head"><h3>{c.title}</h3></header>
            <WidgetBody form={c.form} theme={c.theme} size={c.size} data={c.data} title={c.title} options={c.options} />
          </section>
        ))}
      </div>
    </main>
  );
}
