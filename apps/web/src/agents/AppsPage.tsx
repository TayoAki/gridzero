// Connected apps: connect or disconnect the apps agents may use.

import { useEffect, useState } from "react";
import { Link } from "react-router";

import { openConnect } from "./AppCards";
import { api } from "./catalog";

interface App {
  slug: string;
  name: string;
  category: string;
  status: "active" | "pending" | "error" | "none";
}

export function AppsPage() {
  const [data, setData] = useState<{ configured: boolean; apps: App[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await api<{ configured: boolean; apps: App[]; error?: string }>("GET", "/api/v1/apps");
    if (r.ok) setData(r.data);
    else setError(r.data?.error ?? "Could not load apps.");
  }
  useEffect(() => {
    load();
    // A connection finishes in another window; refresh when the user comes back.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // This page is also where the sign-in window lands; close it when it does.
  useEffect(() => {
    if (window.opener && new URLSearchParams(location.search).has("connected")) window.close();
  }, []);

  async function disconnect(a: App) {
    if (!window.confirm(`Disconnect ${a.name}? Agents will no longer be able to use it.`)) return;
    if ((await api("DELETE", `/api/v1/apps/${a.slug}`)).ok) load();
  }

  return (
    <main className="main apps-page">
      <p><Link to="/">← Home</Link></p>
      <h1>Connected apps</h1>
      <p className="collab-note">Agents can read from connected apps on their own. Anything that sends, creates, changes or deletes waits for your approval in the chat.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!data ? (
        <p>Loading…</p>
      ) : (
        <>
          {!data.configured && <p className="settings-card">Connected apps are not set up on this server yet.</p>}
          <ul className="app-grid">
            {data.apps.map((a) => (
              <li key={a.slug} className="app-tile">
                <div>
                  <strong>{a.name}</strong>
                  <span className="workbook-meta">{a.category}</span>
                </div>
                <span className={`app-status ${a.status}`}>{a.status === "active" ? "Connected" : a.status === "pending" ? "Waiting for sign-in" : a.status === "error" ? "Needs attention" : "Not connected"}</span>
                {data.configured &&
                  (a.status === "active" ? (
                    <button className="link-button danger" onClick={() => disconnect(a)}>Disconnect</button>
                  ) : (
                    <button className="secondary" onClick={async () => setError(await openConnect(a.slug))}>Connect</button>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
