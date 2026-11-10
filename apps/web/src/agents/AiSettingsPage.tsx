// The person's Anthropic key, monthly cap and spend.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";

import { api } from "./catalog";
import { SetupChecklist } from "./SetupChecklist";
import { UsageChart } from "./UsageChart";
import type { KeyStatus } from "./catalog";

interface Usage {
  totalCostUsd: number;
  runs: number;
  byDay: { date: string; costUsd: number }[];
  byAgent: { agentId: string; name: string; costUsd: number }[];
}

const usd = (n: number) => `$${n.toFixed(n < 1 && n > 0 ? 4 : 2)}`;

export function AiSettingsPage() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const [s, u] = await Promise.all([api<KeyStatus>("GET", "/api/v1/ai-key"), api<Usage>("GET", "/api/v1/usage?days=30")]);
    if (s.ok) {
      setStatus(s.data);
      if (s.data.monthlyCapUsd !== undefined) setCap(String(s.data.monthlyCapUsd));
    }
    if (u.ok) setUsage(u.data);
  }
  useEffect(() => {
    load();
  }, []);

  async function saveKey(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await api<{ error?: string }>("PUT", "/api/v1/ai-key", { key: keyInput });
    setBusy(false);
    if (!r.ok) return setError(r.data?.error ?? `Could not save the key (${r.status}).`);
    setKeyInput("");
    setNote("Key saved.");
    load();
  }

  async function removeKey() {
    if (!window.confirm("Remove your Anthropic key? Your agents stop working until you add one again.")) return;
    const r = await api("DELETE", "/api/v1/ai-key");
    if (r.ok) {
      setNote("Key removed.");
      load();
    }
  }

  async function saveCap(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    const r = await api<{ error?: string }>("PATCH", "/api/v1/ai-key", { monthlyCapUsd: Number(cap) });
    if (!r.ok) return setError(r.data?.error ?? `Could not save the cap (${r.status}).`);
    setNote("Cap saved.");
    load();
  }

  return (
    <main className="main ai-settings">
      <p><Link to="/">← Home</Link></p>
      <h1>AI settings</h1>
      <p className="collab-note">Your key is stored encrypted and used only for your own agents. GridZero never shows it again.</p>
      <SetupChecklist key={status?.provider ?? "none"} />
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="ok-note" role="status">{note}</p>}

      {status === null ? (
        <p>Loading…</p>
      ) : status.provider === null ? (
        <form className="settings-card" onSubmit={saveKey}>
          <h2>Anthropic API key</h2>
          <label className="field">
            API key
            <input type="password" autoComplete="off" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="sk-ant-…" required />
          </label>
          <button className="primary-inline" type="submit" disabled={busy || !keyInput.trim()}>{busy ? "Checking…" : "Save key"}</button>
        </form>
      ) : (
        <>
          <section className="settings-card">
            <h2>Anthropic API key</h2>
            <p>Key ending in …{status.last4}</p>
            <button className="secondary" onClick={removeKey}>Remove key</button>
          </section>
          <form className="settings-card" onSubmit={saveCap}>
            <h2>Monthly cap</h2>
            <p>Spent this month: <strong>{usd(status.spentThisMonthUsd ?? 0)}</strong> of {usd(status.monthlyCapUsd ?? 0)}. Agents stop when the cap is reached.</p>
            <label className="field cap-field">
              Cap in US dollars
              <input type="number" min={1} max={10000} step={1} value={cap} onChange={(e) => setCap(e.target.value)} required />
            </label>
            <button className="primary-inline" type="submit">Save</button>
          </form>
        </>
      )}

      {usage && (
        <section className="settings-card">
          <h2>Last 30 days</h2>
          <p>{usage.runs} {usage.runs === 1 ? "run" : "runs"}, {usd(usage.totalCostUsd)} in all.</p>
          {usage.byDay.length > 0 && <UsageChart days={usage.byDay} />}
          {usage.byDay.length > 0 && (
            <div className="usage-tables">
              <table className="usage-table">
                <thead><tr><th>Date</th><th>Cost</th></tr></thead>
                <tbody>{usage.byDay.map((d) => <tr key={d.date}><td>{d.date}</td><td>{usd(d.costUsd)}</td></tr>)}</tbody>
              </table>
              <table className="usage-table">
                <thead><tr><th>Agent</th><th>Cost</th></tr></thead>
                <tbody>{usage.byAgent.map((a) => <tr key={a.agentId}><td>{a.name}</td><td>{usd(a.costUsd)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
