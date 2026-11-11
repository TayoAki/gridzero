// The agent, beside whatever is open. It is told which workbook or report you are looking at.

import { useEffect, useState } from "react";
import { Link } from "react-router";

import { AgentChat } from "../agents/AgentChatPage";
import { api } from "../agents/catalog";
import { Icon } from "./icons";

interface AgentRow {
  id: string;
  name: string;
}

export function AgentPanel({ looking, ask, onClose }: { looking: string | null; ask: { text: string; n: number } | null; onClose: () => void }) {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [id, setId] = useState<string>(() => {
    try {
      return localStorage.getItem("gz_agent") ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ agents: AgentRow[] }>("GET", "/api/v1/agents").then((r) => setAgents(r.ok ? r.data.agents : []));
  }, []);
  const current = agents?.find((a) => a.id === id) ?? agents?.[0];

  function choose(next: string) {
    setId(next);
    try {
      localStorage.setItem("gz_agent", next);
    } catch {
      // Not remembered; nothing else depends on it.
    }
  }

  async function create() {
    setBusy(true);
    const r = await api<{ agent: AgentRow }>("POST", "/api/v1/agents", { name: "Analyst", avatar: "owl", color: "blue", instructions: "" });
    setBusy(false);
    if (r.ok) {
      setAgents([r.data.agent]);
      choose(r.data.agent.id);
    }
  }

  return (
    <>
      <div className="gz-right-head">
        {agents && agents.length > 1 ? (
          <select value={current?.id ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Agent">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        ) : (
          <strong>{current?.name ?? "Agent"}</strong>
        )}
        <span className="gz-rail-space" />
        {current && <Link to={`/agents/${current.id}`} className="gz-right-link">Open</Link>}
        <button className="gz-icon-btn" onClick={onClose} aria-label="Close the agent panel"><Icon name="close" size={14} /></button>
      </div>
      <div className="gz-right-body gz-right-chat">
        {agents === null ? (
          <div className="gz-skel"><span /><span /><span /></div>
        ) : current ? (
          <AgentChat key={current.id} id={current.id} embedded looking={looking} ask={ask} />
        ) : (
          <div className="gz-empty">
            <strong>Ask about your data</strong>
            <p>An agent can total, compare and chart a whole table, and build a report from it.</p>
            <button className="primary-inline" onClick={create} disabled={busy}>{busy ? "Creating…" : "Create an agent"}</button>
          </div>
        )}
      </div>
    </>
  );
}
