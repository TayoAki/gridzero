// M4: share dialog, comments pane and version history pane.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { Action, Comment, Peer, Reply, VersionInfo } from "../sheet-socket";

interface Share {
  id: string;
  email: string;
  role: "editor" | "viewer";
  pending: boolean;
  inviteUrl: string | null;
}

type LinkAccess = "none" | "view" | "edit";

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

export function ShareDialog({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [link, setLink] = useState<{ linkAccess: LinkAccess; allowCopy: boolean }>({ linkAccess: "none", allowCopy: true });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const url = `${window.location.origin}/workbook/${id}`;

  const load = () =>
    api(`/api/v1/workbooks/${id}/shares`).then(
      (d) => {
        setShares(d.shares);
        setLink(d.link);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => void load(), [id]);

  const run = (p: Promise<unknown>) => {
    setError(null);
    setNote(null);
    p.then(load, (e: Error) => setError(e.message));
  };

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    try {
      const r = await api(`/api/v1/workbooks/${id}/shares`, "PUT", { email, role });
      setEmail("");
      setNote(r.emailed ? `Invitation sent to ${r.email}.` : `Email isn't set up yet, so copy the invitation link below and send it to ${r.email}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function saveLink(next: typeof link) {
    setLink(next);
    run(api(`/api/v1/workbooks/${id}/link`, "PUT", next));
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog small-dialog" role="dialog" aria-label="Share workbook">
        <div className="dialog-head">
          <h2>Share "{title}"</h2>
          <button className="link-button" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {note && <p className="collab-note" role="status">{note}</p>}
        <form className="share-row" onSubmit={invite}>
          <input type="email" required aria-label="Email address" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
            <option value="editor">Can edit</option>
            <option value="viewer">Can view</option>
          </select>
          <button className="primary share-send" type="submit">Invite</button>
        </form>
        <ul className="share-list">
          {shares.map((s) => (
            <li key={s.id}>
              <span className="share-email">{s.email}{s.pending ? " (invited)" : ""}</span>
              {s.inviteUrl && <button className="link-button" onClick={() => void navigator.clipboard.writeText(s.inviteUrl!).then(() => setNote("Invitation link copied."))}>Copy invitation link</button>}
              <select aria-label={`Role for ${s.email}`} value={s.role} onChange={(e) => run(api(`/api/v1/workbooks/${id}/shares`, "PUT", { email: s.email, role: e.target.value }))}>
                <option value="editor">Can edit</option>
                <option value="viewer">Can view</option>
              </select>
              <button className="link-button danger" onClick={() => run(api(`/api/v1/workbooks/${id}/shares/${s.id}`, "DELETE"))} aria-label={`Remove ${s.email}`}>Remove</button>
            </li>
          ))}
        </ul>
        <h3 className="share-sub">Anyone with the link (signed in)</h3>
        <div className="share-row">
          <select aria-label="Link access" value={link.linkAccess} onChange={(e) => saveLink({ ...link, linkAccess: e.target.value as LinkAccess })}>
            <option value="none">No access</option>
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </select>
          <label className="share-check">
            <input type="checkbox" checked={link.allowCopy} onChange={(e) => saveLink({ ...link, allowCopy: e.target.checked })} /> Viewers can make a copy
          </label>
          <button className="link-button" disabled={link.linkAccess === "none"} onClick={() => void navigator.clipboard.writeText(url).then(() => setNote("Link copied."))}>Copy link</button>
        </div>
      </div>
    </div>
  );
}

export function PeerList({ peers, you, following, onFollow }: { peers: Peer[]; you: number; following: number | null; onFollow: (id: number | null) => void }) {
  return (
    <div className="peers" aria-label="People here">
      {peers
        .filter((p) => p.id !== you)
        .map((p) => (
          <button
            key={p.id}
            className={`peer${following === p.id ? " following" : ""}`}
            style={{ background: p.color }}
            title={following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}`}
            aria-label={following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}`}
            aria-pressed={following === p.id}
            onClick={() => onFollow(following === p.id ? null : p.id)}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </button>
        ))}
    </div>
  );
}

function when(ms: number) {
  return ms ? new Date(ms).toLocaleString() : "";
}

interface CommentsProps {
  comments: Comment[];
  /** The cell a new comment attaches to. */
  cellLabel: string;
  focus: { row: number; col: number };
  sheet: number;
  readOnly: boolean;
  send: (a: Action) => Promise<Reply>;
  onGoTo: (c: Comment) => void;
  onClose: () => void;
}

export function CommentsPane({ comments, cellLabel, focus, sheet, readOnly, send, onGoTo, onClose }: CommentsProps) {
  const [text, setText] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (a: Action) => send(a).then(() => setError(null), (e: Error) => { setError(e.message); throw e; });
  const shown = comments.filter((c) => showResolved || !c.resolved);

  return (
    <aside className="collab-pane" aria-label="Comments">
      <div className="dialog-head">
        <h2>Comments</h2>
        <button className="link-button" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!readOnly && (
        <form
          className="comment-new"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ type: "AddComment", sheet, row: focus.row, col: focus.col, text }).then(() => setText(""), () => {});
          }}
        >
          <textarea aria-label={`Comment on ${cellLabel}`} placeholder={`Comment on ${cellLabel}`} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="primary" type="submit" disabled={!text.trim()}>Comment</button>
        </form>
      )}
      <label className="share-check">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
      </label>
      {shown.length === 0 && <p className="collab-note">No comments on this sheet.</p>}
      <ul className="comment-list">
        {shown.map((c) => (
          <li key={c.id} className={c.resolved ? "resolved" : undefined}>
            <button className="link-button comment-cell" onClick={() => onGoTo(c)}>{cellName(c)}</button>
            <div className="comment-meta">{c.author} · {when(c.at)}</div>
            <p>{c.text}</p>
            {c.replies.map((r, i) => (
              <div className="comment-reply" key={i}>
                <div className="comment-meta">{r.author} · {when(r.at)}</div>
                <p>{r.text}</p>
              </div>
            ))}
            {!readOnly && (
              <>
                <form
                  className="share-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run({ type: "ReplyComment", id: c.id, text: replies[c.id] ?? "" }).then(() => setReplies((x) => ({ ...x, [c.id]: "" })), () => {});
                  }}
                >
                  <input aria-label="Reply" placeholder="Reply" value={replies[c.id] ?? ""} onChange={(e) => setReplies((x) => ({ ...x, [c.id]: e.target.value }))} />
                </form>
                <div className="comment-actions">
                  <button className="link-button" onClick={() => void run({ type: "ResolveComment", id: c.id, resolved: !c.resolved }).catch(() => {})}>{c.resolved ? "Reopen" : "Resolve"}</button>
                  <button className="link-button danger" onClick={() => void run({ type: "DeleteComment", id: c.id }).catch(() => {})}>Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function cellName(c: Comment) {
  let n = c.col + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${c.row + 1}`;
}

interface VersionsProps {
  id: string;
  seq: number;
  readOnly: boolean;
  send: (a: Action) => Promise<Reply>;
  onClose: () => void;
}

export function VersionPane({ id, seq, readOnly, send, onClose }: VersionsProps) {
  const [list, setList] = useState<VersionInfo[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const take = (p: Promise<Reply>) =>
    p.then(
      (r) => {
        if (r.k === "Versions") setList(r.list);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => void take(send({ type: "ListVersions" })), [id, seq]);

  function restore(v: VersionInfo) {
    if (window.confirm(`Restore this version for everyone? The current state is saved in the history first.`)) void take(send({ type: "RestoreVersion", seq: v.seq }));
  }

  return (
    <aside className="collab-pane" aria-label="Version history">
      <div className="dialog-head">
        <h2>Version history</h2>
        <button className="link-button" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!readOnly && (
        <form
          className="share-row"
          onSubmit={(e) => {
            e.preventDefault();
            void take(send({ type: "CreateVersion", name })).then(() => setName(""));
          }}
        >
          <input aria-label="Version name" placeholder="Name the current version" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary share-send" type="submit" disabled={!name.trim()}>Save</button>
        </form>
      )}
      {list === null ? <p className="collab-note">Loading…</p> : list.length === 0 && <p className="collab-note">No saved versions yet. One is saved when everyone leaves the workbook.</p>}
      <ul className="version-list">
        {list?.map((v) => (
          <li key={v.seq}>
            <strong>{v.name ?? new Date(v.at).toLocaleString()}</strong>
            <div className="comment-meta">{v.name ? `${new Date(v.at).toLocaleString()}${v.by ? ` · ${v.by}` : ""}` : `Edit ${v.seq}`}</div>
            <div className="comment-actions">
              <a href={`/workbook/${id}?version=${v.seq}`} target="_blank" rel="noreferrer">Preview</a>
              {!readOnly && (
                <>
                  <button className="link-button" onClick={() => restore(v)}>Restore</button>
                  <button
                    className="link-button"
                    onClick={() => {
                      const next = window.prompt("Version name", v.name ?? "");
                      if (next?.trim()) void take(send({ type: "NameVersion", seq: v.seq, name: next }));
                    }}
                  >
                    Name
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
