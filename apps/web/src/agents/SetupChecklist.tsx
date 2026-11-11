// What is set up for agents, and where to fix what is not (agent spec §11.1).

import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api } from "./catalog";

interface Row {
  label: string;
  ready: boolean | null;
  detail: string;
  to: string;
  fix: string;
}

export function SetupChecklist() {
  const [rows, setRows] = useState<Row[] | null>(null);

  async function load() {
    const [key, conns, metrics, apps] = await Promise.all([
      api<{ provider: string | null; included?: unknown }>("GET", "/api/v1/ai-key"),
      api<{ connections: unknown[] }>("GET", "/api/v1/connections"),
      api<{ models: unknown[] }>("GET", "/api/v1/metrics"),
      api<{ configured: boolean; apps: { status: string }[] }>("GET", "/api/v1/apps"),
    ]);
    const connected = apps.ok ? apps.data.apps.filter((a) => a.status === "active").length : 0;
    setRows([
      {
        label: "AI for your agents",
        ready: key.ok ? key.data.provider !== null || !!key.data.included : null,
        detail: key.ok && key.data.provider === null && key.data.included ? "Included by GridZero. Add your own key for more." : "Agents run on your own key.",
        to: "/settings/ai",
        fix: "Add key",
      },
      { label: "A warehouse connection", ready: conns.ok ? conns.data.connections.length > 0 : null, detail: "Lets agents query your database.", to: "/", fix: "Open a workbook to connect" },
      { label: "A metric", ready: metrics.ok ? metrics.data.models.length > 0 : null, detail: "Numbers defined once, used by every agent.", to: "/metrics", fix: "Add a metric" },
      {
        label: "Connected apps",
        ready: apps.ok ? (apps.data.configured ? connected > 0 : null) : null,
        detail: apps.ok && !apps.data.configured ? "Not available on this server yet." : `${connected} connected.`,
        to: "/apps",
        fix: "Connect an app",
      },
    ]);
  }

  useEffect(() => {
    load();
    // Something may have been set up in another tab or window.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!rows) return null;
  return (
    <section className="settings-card setup-checklist" aria-labelledby="setup-title">
      <h2 id="setup-title">Setup</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <span className={`setup-mark ${r.ready ? "ready" : r.ready === false ? "todo" : "na"}`} aria-hidden="true">{r.ready ? "✓" : r.ready === false ? "○" : "–"}</span>
            <span className="setup-text">
              <strong>{r.label}</strong>
              <span>{r.ready ? "Ready" : r.ready === false ? "Needs setup" : "Not available"} · {r.detail}</span>
            </span>
            {r.ready === false && <Link to={r.to}>{r.fix}</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}
