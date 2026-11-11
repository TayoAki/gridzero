import { useEffect, useState } from "react";

interface Row {
  id: string;
  title: string;
  deletedAt: string;
}

export function TrashPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [keepDays, setKeepDays] = useState(7);

  function load() {
    fetch("/api/v1/workbooks/trash", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { workbooks: [], keepDays: 7 }))
      .then((d: { workbooks: Row[]; keepDays: number }) => {
        setRows(d.workbooks);
        setKeepDays(d.keepDays);
      });
  }
  useEffect(load, []);

  async function restore(w: Row) {
    const res = await fetch(`/api/v1/workbooks/${w.id}/restore`, { method: "POST", credentials: "include" });
    if (res.ok) load();
  }

  return (
    <main className="main">
      <h1>Trash</h1>
      <p className="collab-note">Workbooks are deleted for good {keepDays} days after they are moved here.</p>
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty"><strong>Trash is empty</strong></div>
      ) : (
        <ul className="workbook-list">
          {rows.map((w) => (
            <li key={w.id}>
              <span className="workbook-link">{w.title}</span>
              <span className="workbook-meta">Deleted {new Date(w.deletedAt).toLocaleString()}</span>
              <button className="link-button" onClick={() => void restore(w)} aria-label={`Restore ${w.title}`}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
