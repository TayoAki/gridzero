// Create or edit an agent: name, avatar, color, instructions.

import { useState } from "react";
import type { FormEvent } from "react";

import { useEscape } from "../use-escape";
import { AVATARS, AVATAR_GLYPH, COLORS, COLOR_HEX, api } from "./catalog";
import type { Agent, Avatar, Color } from "./catalog";

const MAX_INSTRUCTIONS = 4000;

export function AgentDialog({ agent, onClose, onSaved }: { agent?: Agent; onClose: () => void; onSaved: (a: Agent) => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [avatar, setAvatar] = useState<Avatar>(agent?.avatar ?? "robot");
  const [color, setColor] = useState<Color>(agent?.color ?? "blue");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), avatar, color, instructions };
    const res = agent ? await api<{ agent: Agent; error?: string }>("PATCH", `/api/v1/agents/${agent.id}`, body) : await api<{ agent: Agent; error?: string }>("POST", "/api/v1/agents", body);
    setBusy(false);
    if (res.ok) onSaved(res.data.agent);
    else setError(res.data?.error ?? `Could not save (${res.status})`);
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog small-dialog agent-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title" onSubmit={save}>
        <div className="dialog-head">
          <h2 id="agent-dialog-title">{agent ? "Edit agent" : "New agent"}</h2>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="field">
          Name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <fieldset className="choice-row">
          <legend>Avatar</legend>
          {AVATARS.map((a) => (
            <button type="button" key={a} className={`choice${avatar === a ? " selected" : ""}`} aria-pressed={avatar === a} aria-label={a} onClick={() => setAvatar(a)}>
              {AVATAR_GLYPH[a]}
            </button>
          ))}
        </fieldset>
        <fieldset className="choice-row">
          <legend>Color</legend>
          {COLORS.map((c) => (
            <button type="button" key={c} className={`swatch${color === c ? " selected" : ""}`} aria-pressed={color === c} aria-label={c} style={{ background: COLOR_HEX[c] }} onClick={() => setColor(c)} />
          ))}
        </fieldset>
        <label className="field">
          Instructions
          <textarea rows={6} value={instructions} maxLength={MAX_INSTRUCTIONS} onChange={(e) => setInstructions(e.target.value)} placeholder="What should this agent do? For example: Track competitor prices and summarize changes." />
          <span className="counter">{instructions.length} / {MAX_INSTRUCTIONS}</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-inline" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : agent ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
