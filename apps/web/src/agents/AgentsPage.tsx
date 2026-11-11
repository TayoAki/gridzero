// The list of a person's agents, with a button to make a new one.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { AgentBadge } from "./AgentBadge";
import { AgentDialog } from "./AgentDialog";
import { api } from "./catalog";
import type { Agent } from "./catalog";

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api<{ agents: Agent[] }>("GET", "/api/v1/agents").then((r) => setAgents(r.ok ? r.data.agents : []));
  }, []);

  return (
    <main className="main agents-page">
      <div className="main-head">
        <h1>Agents</h1>
        <button className="primary-inline" onClick={() => setCreating(true)}>New agent</button>
      </div>
      {agents === null ? (
        <p>Loading…</p>
      ) : agents.length === 0 ? (
        <div className="empty">
          <strong>No agents yet</strong>
          An agent answers questions with web search and, later, your workbooks. Make one to get started.
        </div>
      ) : (
        <ul className="agent-grid">
          {agents.map((a) => (
            <li key={a.id}>
              <Link to={`/agents/${a.id}`} className="agent-card">
                <AgentBadge agent={a} />
                <span className="agent-card-text">
                  <strong>{a.name}</strong>
                  <span className="agent-card-sub">{a.instructions.split("\n")[0] || "No instructions"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <AgentDialog onClose={() => setCreating(false)} onSaved={(a) => navigate(`/agents/${a.id}`)} />}
    </main>
  );
}
