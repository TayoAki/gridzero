// Chat cards for connected apps: "Connect <app>" and approving an action (agent spec §10).

import { useEffect, useState } from "react";

import { api } from "./catalog";

export async function openConnect(slug: string): Promise<string | null> {
  // Open the window first, inside the click, so pop-up blockers allow it.
  const win = window.open("about:blank", "gz-connect", "width=520,height=700");
  const r = await api<{ url?: string; error?: string }>("POST", `/api/v1/apps/${slug}/connect`, { returnUrl: "/apps?connected=1" });
  if (!r.ok || !r.data?.url) {
    win?.close();
    return r.data?.error ?? "Could not start the sign-in.";
  }
  if (win) win.location.href = r.data.url;
  else window.location.href = r.data.url;
  return null;
}

export function ConnectCard({ slug, name }: { slug: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="app-card">
      <span>The agent needs <strong>{name}</strong>.</span>
      <button className="primary-inline" onClick={async () => setError(await openConnect(slug))}>Connect {name}</button>
      <span className="collab-note">Then ask again.</span>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

interface Approval {
  id: string;
  action: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "refused";
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function ApprovalCard({ id, onApprove, busy }: { id: string; onApprove: (id: string) => Promise<void>; busy: boolean }) {
  const [a, setA] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    api<Approval>("GET", `/api/v1/approvals/${id}`).then((r) => r.ok && setA(r.data));
  }, [id]);
  if (!a) return null;

  async function approve() {
    setWorking(true);
    setA((x) => (x ? { ...x, status: "approved" } : x));
    await onApprove(id);
    setWorking(false);
  }

  async function refuse() {
    setWorking(true);
    const r = await api<{ error?: string }>("POST", `/api/v1/approvals/${id}/refuse`);
    setWorking(false);
    if (r.ok) setA((x) => (x ? { ...x, status: "refused" } : x));
    else setError(r.data?.error ?? "Could not refuse.");
  }

  const entries = Object.entries(a.args ?? {});
  return (
    <div className={`approval-card ${a.status}`}>
      <div className="approval-head">
        <strong>Approve this action?</strong>
        <code>{a.action}</code>
      </div>
      {entries.length > 0 && (
        <dl className="approval-args">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{show(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {a.status === "pending" ? (
        <div className="approval-buttons">
          <button className="primary-inline" disabled={working || busy} onClick={approve}>Approve</button>
          <button className="secondary" disabled={working || busy} onClick={refuse}>Refuse</button>
        </div>
      ) : (
        <p className={a.status === "approved" ? "ok-note" : "collab-note"}>{a.status === "approved" ? "Approved." : "Refused."}</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
