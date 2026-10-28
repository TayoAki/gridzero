import { useEffect, useState } from "react";
import { NavLink } from "react-router";

import { authClient } from "../auth-client";

interface WorkbookRow {
  id: string;
  title: string;
  lastAccessedAt: string;
}

export function HomePage({ email }: { email: string }) {
  const [workbooks, setWorkbooks] = useState<WorkbookRow[] | null>(null);

  useEffect(() => {
    fetch("/api/v1/workbooks", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { workbooks: [] }))
      .then((data: { workbooks: WorkbookRow[] }) => setWorkbooks(data.workbooks));
  }, []);

  // No manual navigation: the router redirects to /login once the session clears.
  // Navigating first raced the session update and re-mounted this page unauthenticated.
  async function logOut() {
    await authClient.signOut();
  }

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">GridZero</div>
        <NavLink to="/" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`} end>Home</NavLink>
        <div className="spacer" />
        <div className="account">{email}</div>
        <button className="link-button" onClick={logOut}>Log out</button>
      </nav>
      <main className="main">
        <h1>Home</h1>
        {workbooks === null ? (
          <p>Loading…</p>
        ) : workbooks.length === 0 ? (
          <div className="empty">
            <strong>No workbooks yet</strong>
            Workbooks you create or that are shared with you will appear here.
          </div>
        ) : (
          <ul>{workbooks.map((w) => <li key={w.id}>{w.title}</li>)}</ul>
        )}
      </main>
    </div>
  );
}
