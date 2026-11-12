// A form anyone with its address can use to ask for a report or some data, without an account.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useParams } from "react-router";

export function AskPage() {
  const { token = "" } = useParams();
  const [form, setForm] = useState<{ title: string; owner: string } | null>(null);
  const [closed, setClosed] = useState(false);
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    fetch(`/api/v1/public/intake/${encodeURIComponent(token)}`).then(async (r) => (r.ok ? setForm(await r.json()) : setClosed(true)), () => setClosed(true));
  }, [token]);
  useEffect(() => {
    if (form) document.title = `${form.title} · GridZero`;
  }, [form]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await fetch(`/api/v1/public/intake/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, title, ...(body.trim() ? { body } : {}), ...(due ? { due } : {}) }) });
    if (r.ok) return setSent(true);
    setError((await r.json().catch(() => null))?.error ?? "Your request could not be sent. Try again.");
  };
  return (
    <main className="auth-page">
      <div className="auth-card ask-card">
        {closed ? (
          <><h1>This form is no longer open</h1><p>Ask whoever sent you the address for a new one.</p></>
        ) : !form ? (
          <div className="gz-skel"><span /><span /></div>
        ) : sent ? (
          <><h1>Sent to {form.owner}</h1><p>They have your request and your email address, and will reply to you there. You can close this page.</p></>
        ) : (
          <form onSubmit={submit} className="report-form">
            <h1>{form.title}</h1>
            <p className="muted">Your request goes to {form.owner}.</p>
            <label className="field">Your email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
            <label className="field">What do you need?<input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} placeholder="Revenue by region for the last quarter" /></label>
            <label className="field">Anything that helps (optional)<textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></label>
            <label className="field">Needed by (optional)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary">Send the request</button>
          </form>
        )}
      </div>
    </main>
  );
}
