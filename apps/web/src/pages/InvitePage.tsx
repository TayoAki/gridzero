import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // StrictMode runs effects twice in development; an invitation only works once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch(`/api/v1/invites/${encodeURIComponent(token ?? "")}/accept`, { method: "POST", credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (res.ok) navigate(`/workbook/${body.workbook}`, { replace: true });
        else setError(body?.error ?? "This invitation could not be opened.");
      })
      .catch(() => setError("This invitation could not be opened."));
  }, [token]);

  return (
    <main className="invite-page">
      {error ? (
        <p role="alert">
          {error} <Link to="/">Go home</Link>
        </p>
      ) : (
        <p>Opening the workbook…</p>
      )}
    </main>
  );
}
