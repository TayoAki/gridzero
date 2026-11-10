import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";

import { authClient } from "../auth-client";

interface WorkbookRow {
  id: string;
  title: string;
  lastAccessedAt: string;
  role: "owner" | "editor" | "viewer";
  owner: string;
}

export function HomePage({ email }: { email: string }) {
  const navigate = useNavigate();
  const [workbooks, setWorkbooks] = useState<WorkbookRow[] | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    fetch("/api/v1/workbooks", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { workbooks: [] }))
      .then((data: { workbooks: WorkbookRow[] }) => setWorkbooks(data.workbooks));
  }

  useEffect(load, []);

  // No manual navigation: the router redirects to /login once the session clears.
  // Navigating first raced the session update and re-mounted this page unauthenticated.
  async function logOut() {
    await authClient.signOut();
  }

  async function createWorkbook() {
    setCreating(true);
    const res = await fetch("/api/v1/workbooks", { method: "POST", credentials: "include" });
    setCreating(false);
    if (res.ok) navigate(`/workbook/${(await res.json()).id}`);
  }

  async function deleteWorkbook(w: WorkbookRow) {
    if (!window.confirm(`Move "${w.title}" to trash?`)) return;
    const res = await fetch(`/api/v1/workbooks/${w.id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) load();
  }

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">GridZero</div>
        <NavLink to="/" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`} end>Home</NavLink>
        <NavLink to="/trash" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>Trash</NavLink>
        <div className="spacer" />
        <div className="account">{email}</div>
        <NavLink to="/account" className="link-button">Account</NavLink>
        <button className="link-button" onClick={logOut}>Log out</button>
        <div className="legal-links"><NavLink to="/terms">Terms</NavLink> · <NavLink to="/privacy">Privacy</NavLink></div>
      </nav>
      <main className="main">
        <div className="main-head">
          <h1>Home</h1>
          <button className="primary new-workbook" onClick={createWorkbook} disabled={creating}>
            {creating ? "Creating…" : "New workbook"}
          </button>
        </div>
        {workbooks === null ? (
          <p>Loading…</p>
        ) : workbooks.length === 0 ? (
          <div className="empty">
            <strong>No workbooks yet</strong>
            Create a workbook to start, or open one that is shared with you.
          </div>
        ) : (
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
        )}
      </main>
    </div>
  );
}
