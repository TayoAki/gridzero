// A widget an agent proposed in chat: preview each design and add one to a dashboard.

import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";
import type { Proposal } from "./spec";
import { WidgetBody, WidgetFrame } from "./WidgetView";

interface Board {
  id: string;
  name: string;
}

export function ProposalCard({ id }: { id: string }) {
  const [proposal, setProposal] = useState<{ payload: Proposal; acceptedWidgetId: string | null } | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState("");
  const [added, setAdded] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ payload: Proposal; acceptedWidgetId: string | null }>("GET", `/api/v1/widget-proposals/${id}`).then((r) => r.ok && setProposal(r.data));
    api<{ dashboards: Board[] }>("GET", "/api/v1/dashboards").then((r) => {
      if (!r.ok) return;
      setBoards(r.data.dashboards);
      setBoardId(r.data.dashboards[0]?.id ?? "");
    });
  }, [id]);

  if (!proposal) return null;
  const p = proposal.payload;

  async function add(design: number) {
    setBusy(true);
    setError(null);
    const r = await api<{ error?: string }>("POST", `/api/v1/widget-proposals/${id}/accept`, { dashboardId: boardId, design });
    setBusy(false);
    if (r.ok) setAdded(boards.find((b) => b.id === boardId) ?? null);
    else setError(r.data?.error ?? "Could not add the widget.");
  }

  const source = p.source.kind === "metric" ? "Refreshes from a metric" : p.source.kind === "definition" ? "Refreshes from a shared definition" : p.source.kind === "table_query" ? "Refreshes from your table" : p.source.kind === "sheet" ? "Refreshes from a workbook" : "Refreshes by asking the agent again";

  return (
    <div className="proposal-card">
      <div className="proposal-head">
        <strong>Widget: {p.title}</strong>
        <span className="workbook-meta">{source}</span>
      </div>
      {added || proposal.acceptedWidgetId ? (
        <p className="ok-note">
          {added ? <>Added to <Link to={`/dashboards/${added.id}`}>{added.name}</Link>.</> : <>Added to a dashboard. <Link to="/dashboards">Open dashboards</Link></>}
        </p>
      ) : (
        <>
          <div className="proposal-designs">
            {p.designs.map((d, i) => (
              <div className="proposal-design" key={i}>
                <WidgetFrame title={p.title} theme={d.theme} size="m">
                  <WidgetBody form={d.form} theme={d.theme} size="m" data={p.data} />
                </WidgetFrame>
                <button className="primary-inline" disabled={busy || !boardId} onClick={() => add(i)}>Add to dashboard</button>
              </div>
            ))}
          </div>
          <label className="field proposal-board">
            Dashboard
            <select value={boardId} onChange={(e) => setBoardId(e.target.value)}>
              {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
