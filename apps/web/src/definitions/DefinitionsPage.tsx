// Definitions: connect a source, scan it, answer the questions the data cannot settle, and confirm
// or correct what GridZero drafted (docs/specs/DEFINITIONS-SPEC.md).

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { api } from "../agents/catalog";
import { useStatus, useTabTitle } from "../shell/context";

interface Workspace { id: string; name: string; role: string }
interface SourceItem { id: string; name: string; kind: string; config: { host?: string; database?: string; schemas?: string[] }; mySignIn: string | null; lastScanAt: string | null }
interface Evidence { type: string; text: string }
interface Definition {
  id: string; kind: "entity" | "link" | "dimension" | "metric" | "rule"; name: string; label: string; description: string;
  body: Record<string, any>; status: "inferred" | "needs_answer" | "settled" | "confirmed" | "disputed"; confidence: string; evidence: Evidence[];
  confirmedBy: string | null; confirmedAt: string | null; checkNumber: { value: string | null } | null; version: number;
}
interface Option { label: string; change: string; text?: string; value?: string | null; note?: string; expression?: string }
interface Question { id: string; kind: string; topic: string; prompt: string; options: Option[]; rank: number; atSetup: boolean; assigneeId: string | null; status: string; answer: { label?: string | null; text?: string; applied?: string[] } | null }
interface Preview { oldValue: string | null; newValue: string | null; newSql: string | null; findings?: { check: string; message: string }[]; impact?: { label: string; oldValue: string | null; newValue: string | null }[]; newRules?: { label: string; body: { expression: string } }[]; note?: string }
interface Change { id: string; definitionId: string; origin: string; request: string; preview: Preview; explanation?: string | null }
interface Member { userId: string; name: string; email: string; role: string; team: string | null }
interface Review {
  source: { id: string; name: string }; role: string; me: string; mySignIn: string | null; kind?: string;
  scan: { finishedAt: string; stats: { historyNote: string; history: { statements: number }; findings: { message: string }[] }; tables: { name: string; rows: number; sampled: boolean; columns: number }[] } | null;
  definitions: Definition[]; questions: Question[]; changes: Change[]; members: Member[];
}

const STATUS: Record<Definition["status"], string> = { inferred: "Draft", needs_answer: "Needs an answer", settled: "Settled from the data", confirmed: "Confirmed", disputed: "Under review" };
const KINDS: [Definition["kind"], string, string][] = [
  ["metric", "Metrics", "Numbers the business names."],
  ["rule", "Rules", "Filters with a business meaning."],
  ["entity", "Tables", "What one row is."],
  ["link", "Links", "How tables join."],
  ["dimension", "Dimensions", "Ways people slice the numbers."],
];
const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "nothing" : Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) : v);
const summary = (d: Definition) => {
  const b = d.body;
  const short = (fq: string) => fq?.split(".").pop();
  if (d.kind === "metric") return `${b.expression}${b.filters?.length ? `, only ${b.filters.join(" and ")}` : ""}`;
  if (d.kind === "rule") return b.expression;
  if (d.kind === "entity") return b.grain ? `One row per ${b.grain.join(" + ")} (${Number(b.row_count).toLocaleString("en-US")} rows)` : `No key found (${Number(b.row_count).toLocaleString("en-US")} rows)`;
  if (d.kind === "link") return `${short(b.from_entity)}.${b.from_columns.join(", ")} → ${short(b.to_entity)}.${b.to_columns.join(", ")}, ${b.cardinality === "many_to_one" ? "many to one" : "one to one"}`;
  return `${short(b.entity)}.${b.expression}`;
};

function ChangeCard({ change, label, canEdit, onDone }: { change: Change; label: string; canEdit: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = change.preview;
  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const r = await api<{ error?: string }>("POST", path, body);
    setBusy(false);
    if (!r.ok) return setError(r.data?.error ?? "That did not work.");
    onDone();
  }
  // A correction filed from a chat has no numbers yet: work them out, then drop the note it came from.
  async function workOut() {
    setBusy(true);
    setError(null);
    const r = await api<{ error?: string }>("POST", `/api/v1/definitions/${change.definitionId}/correct`, { request: change.request });
    if (!r.ok) {
      setBusy(false);
      return setError(r.data?.error ?? "That did not work.");
    }
    await api("POST", `/api/v1/changes/${change.id}/discard`);
    setBusy(false);
    onDone();
  }
  return (
    <div className="def-change" data-testid="change">
      <strong>Proposed change to {label}</strong>
      <p className="collab-note">“{change.request}”{change.origin === "chat" ? " (from a chat with an agent)" : ""}</p>
      {change.explanation && <p>{change.explanation}</p>}
      {p.note ? (
        <p className="collab-note">{p.note}</p>
      ) : (
        <>
          <p className="def-numbers">
            <span>Now <b>{num(p.oldValue)}</b></span> → <span>After <b>{num(p.newValue)}</b></span>
          </p>
          {p.newRules?.map((r) => <p key={r.label} className="collab-note">Adds the rule “{r.label}”: <code>{r.body.expression}</code></p>)}
          {(p.impact?.length ?? 0) > 1 && (
            <ul className="def-evidence">{p.impact!.map((i) => <li key={i.label}>{i.label}: {num(i.oldValue)} → {num(i.newValue)}</li>)}</ul>
          )}
          {p.findings?.map((f) => <p key={f.message} className="def-warning">Check: {f.message}</p>)}
          {p.newSql && <details><summary>The query</summary><pre className="metric-sql">{p.newSql}</pre></details>}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {canEdit && (
        <div className="def-actions">
          {p.note ? <button className="primary-inline" disabled={busy} onClick={workOut}>Work out the numbers</button> : <button className="primary-inline" disabled={busy} onClick={() => act(`/api/v1/changes/${change.id}/publish`)}>Publish</button>}
          <button className="secondary" disabled={busy} onClick={() => act(`/api/v1/changes/${change.id}/discard`)}>Discard</button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ q, review, onDone }: { q: Question; review: Review; onDone: (applied?: string[]) => void }) {
  const [text, setText] = useState("");
  const [metric, setMetric] = useState("");
  const [trusted, setTrusted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = review.role !== "viewer";
  const metrics = review.definitions.filter((d) => d.kind === "metric");
  async function send(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const r = await api<{ error?: string; applied?: string[] }>("POST", path, body);
    setBusy(false);
    if (!r.ok) return setError(r.data?.error ?? "That did not work.");
    onDone(r.data?.applied);
  }
  const assignee = review.members.find((m) => m.userId === q.assigneeId);
  return (
    <div className="def-question" data-testid="question">
      <div className="metric-head">
        <strong>{q.topic}</strong>
        <span className="chat-head-spacer" />
        <span className="workbook-meta">For {q.assigneeId === review.me ? "you" : (assignee?.name || assignee?.email || "an admin")}</span>
      </div>
      <p>{q.prompt}</p>
      {q.kind === "trusted_number" ? (
        <div className="def-actions">
          <select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option value="">Choose a metric…</option>
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <input aria-label="The number you trust" inputMode="decimal" placeholder="The number you trust" value={trusted} onChange={(e) => setTrusted(e.target.value)} />
          <button className="primary-inline" disabled={busy || !canEdit || !metric || !Number.isFinite(Number(trusted)) || trusted === ""} onClick={() => send(`/api/v1/questions/${q.id}/answer`, { definitionId: metric, value: Number(trusted) })}>Compare</button>
        </div>
      ) : (
        <>
          <div className="def-options">
            {q.options.map((o, i) => (
              <button key={i} className="def-option" disabled={busy || !canEdit} onClick={() => send(`/api/v1/questions/${q.id}/answer`, { option: i })}>
                <span className="def-option-letter">{String.fromCharCode(65 + i)}</span>
                <span>
                  <b>{o.expression ? <code>{o.label}</code> : o.label}</b>
                  {o.text && <span className="def-option-number">{o.text}</span>}
                  {o.note && <span className="collab-note"> {o.note}</span>}
                </span>
              </button>
            ))}
          </div>
          {!["excluded_rows", "conflict"].includes(q.kind) && (
            <div className="def-actions">
              <input aria-label="Something else" placeholder={q.options.length ? "Something else…" : "Your answer…"} value={text} onChange={(e) => setText(e.target.value)} />
              <button className="secondary" disabled={busy || !canEdit || !text.trim()} onClick={() => send(`/api/v1/questions/${q.id}/answer`, { text })}>Answer</button>
            </div>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {canEdit && (
        <div className="def-actions def-minor">
          <button className="link-button" disabled={busy} onClick={() => send(`/api/v1/questions/${q.id}/skip`)}>Skip</button>
          <label>Ask someone else{" "}
            <select value="" onChange={(e) => e.target.value && send(`/api/v1/questions/${q.id}/assign`, { userId: e.target.value })}>
              <option value="">…</option>
              {review.members.filter((m) => m.userId !== q.assigneeId && m.role !== "viewer").map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}{m.team ? ` (${m.team})` : ""}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function DefinitionRow({ d, review, onChanged }: { d: Definition; review: Review; onChanged: () => void }) {
  const [value, setValue] = useState<{ value: string | null; sql: string; estimate: { rows: number } } | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = review.role !== "viewer";
  const who = review.members.find((m) => m.userId === d.confirmedBy);
  async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await api<T & { error?: string }>(method, path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.data?.error ?? "That did not work.");
      return null;
    }
    return r.data;
  }
  return (
    <li className="def-row" data-testid={`def-${d.kind}-${d.name}`}>
      <div className="metric-head">
        <strong>{d.label}</strong>
        <span className={`def-chip def-${d.status}`}>{STATUS[d.status]}</span>
        {d.status !== "confirmed" && <span className="workbook-meta">{d.confidence} confidence</span>}
        {d.status === "confirmed" && <span className="workbook-meta">by {who?.name || who?.email || "a member"}{d.confirmedAt ? ` on ${new Date(d.confirmedAt).toLocaleDateString()}` : ""}{d.checkNumber?.value != null ? ` · check number ${num(d.checkNumber.value)}` : ""}</span>}
      </div>
      <code className="def-summary">{summary(d)}</code>
      {d.description && <p className="collab-note">{d.description}</p>}
      <ul className="def-evidence">{d.evidence.map((e, i) => <li key={i} className={e.type === "conflict" ? "def-warning" : undefined}>{e.text}</li>)}</ul>
      {value && (
        <p className="def-numbers"><b>{num(value.value)}</b> <span className="workbook-meta">read about {value.estimate.rows.toLocaleString("en-US")} rows</span>
          <details><summary>The query</summary><pre className="metric-sql">{value.sql}</pre></details>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="def-actions">
        {d.kind === "metric" && <button className="secondary" disabled={busy} onClick={async () => setValue(await call("GET", `/api/v1/definitions/${d.id}/value`))}>Show the number</button>}
        {canEdit && d.status !== "confirmed" && <button className="primary-inline" disabled={busy} onClick={async () => (await call("POST", `/api/v1/definitions/${d.id}/confirm`)) && onChanged()}>Confirm</button>}
        {canEdit && (d.kind === "metric" || d.kind === "rule") && <button className="secondary" disabled={busy} onClick={() => setCorrecting(!correcting)}>Correct…</button>}
        {(d.status === "confirmed" || d.status === "settled") && <button className="link-button" disabled={busy} onClick={async () => { const reason = window.prompt("What is wrong with it?"); if (reason && (await call("POST", `/api/v1/definitions/${d.id}/dispute`, { reason }))) onChanged(); }}>Dispute</button>}
      </div>
      {correcting && (
        <form className="def-correct" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (await call("POST", `/api/v1/definitions/${d.id}/correct`, { request })) { setCorrecting(false); setRequest(""); onChanged(); } }}>
          <label className="field">What should change? Say it in plain words.
            <textarea rows={2} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Leave out cancelled orders." required />
          </label>
          <button className="primary-inline" type="submit" disabled={busy || !request.trim()}>{busy ? "Working it out…" : "See the old and new numbers"}</button>
        </form>
      )}
    </li>
  );
}

interface TrustedAnswer {
  id: string;
  question: string;
  origin: "confirmed" | "chat";
  sql: string | null;
  expected: string;
  verifiedBy: string;
  createdAt: string;
  lastStatus: "pass" | "fail" | "error" | null;
  lastDetail: string | null;
  lastRunAt: string | null;
  stale: boolean;
}

/** Questions with answers a person vouched for: what agents reuse, and what they are tested on. */
function TrustedAnswers({ sourceId, canEdit, stamp }: { sourceId: string; canEdit: boolean; stamp: unknown }) {
  const [answers, setAnswers] = useState<TrustedAnswer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ answers: TrustedAnswer[] }>("GET", `/api/v1/sources/${sourceId}/answers`).then((r) => r.ok && setAnswers(r.data.answers));
  }, [sourceId, stamp]);

  async function recheck(all: boolean) {
    setBusy(true);
    setError(null);
    const r = await api<{ answers: TrustedAnswer[]; error?: string }>("POST", `/api/v1/sources/${sourceId}/answers/recheck`, { all });
    setBusy(false);
    if (r.ok) setAnswers(r.data.answers);
    else setError(r.data?.error ?? "That did not work.");
  }

  async function remove(id: string) {
    const r = await api("DELETE", `/api/v1/answers/${id}`);
    if (r.ok) setAnswers((prev) => prev?.filter((a) => a.id !== id) ?? null);
  }

  if (answers === null) return null;
  if (!answers.length)
    return (
      <p className="collab-note def-section">
        No checked answers yet. Confirm a number, or press "Mark as correct" under an agent's reply, and it appears here: the agent reuses it and is tested on it whenever the agent changes.
      </p>
    );
  const stale = answers.filter((a) => a.stale).length;
  const failing = answers.filter((a) => !a.stale && a.lastStatus === "fail").length;
  return (
    <section className="def-section" data-testid="trusted-answers">
      <h2>Checked answers <span className="workbook-meta">{answers.length} · agents reuse these and are tested on them</span></h2>
      <p className="collab-note">
        Each confirmed number, and each agent reply someone marked as correct, is a question the agent must keep getting right.
        {stale > 0 ? ` ${stale} ${stale === 1 ? "has" : "have"} not been tried since the agent last changed.` : failing > 0 ? ` ${failing} ${failing === 1 ? "is" : "are"} failing.` : " All were tried with the current agent."}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="def-actions">
        <button className="secondary" disabled={busy} onClick={() => recheck(stale === 0)}>{busy ? "Asking the agent…" : stale > 0 ? `Test the agent on ${Math.min(stale, 10)} now` : "Test the agent again"}</button>
        <span className="workbook-meta">Uses your AI allowance: one short agent run per answer.</span>
      </div>
      <ul className="def-list">
        {answers.map((a) => (
          <li className="def-row" key={a.id}>
            <div className="metric-head">
              <strong>{a.question}</strong>
              <span className={`def-chip ${a.stale || !a.lastStatus ? "" : a.lastStatus === "pass" ? "def-confirmed" : "def-disputed"}`}>
                {a.stale || !a.lastStatus ? "Not tried yet" : a.lastStatus === "pass" ? "Agent gets it right" : a.lastStatus === "fail" ? "Agent gets it wrong" : "Could not test"}
              </span>
              <span className="workbook-meta">{a.origin === "confirmed" ? "confirmed" : "marked correct"} by {a.verifiedBy} on {new Date(a.createdAt).toLocaleDateString()}</span>
            </div>
            {!a.stale && a.lastDetail && a.lastStatus !== "pass" && <p className="def-warning">{a.lastDetail}</p>}
            <details>
              <summary>The answer{a.sql ? " and its query" : ""}</summary>
              {a.sql && <pre className="metric-sql">{a.sql}</pre>}
              <pre className="metric-sql">{a.expected}</pre>
            </details>
            {canEdit && <div className="def-actions"><button className="link-button" onClick={() => remove(a.id)}>Remove</button></div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

type ReviewTab = "questions" | "count" | "checked" | "changes";

export function DefinitionsPage() {
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [estimate, setEstimate] = useState<{ tables: number; rows: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newSource, setNewSource] = useState({ name: "", host: "", port: "5432", database: "", schemas: "public", ssl: "verify" });
  const [signIn, setSignIn] = useState({ username: "", password: "" });
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState<ReviewTab>("questions");

  const loadWorkspaces = useCallback(async () => {
    const r = await api<{ workspaces: Workspace[] }>("GET", "/api/v1/workspaces");
    const list = r.ok ? r.data.workspaces : [];
    setWorkspaces(list);
    setWorkspaceId((cur) => cur || list[0]?.id || "");
  }, []);
  const loadSources = useCallback(async () => {
    if (!workspaceId) return setSources([]);
    const r = await api<{ sources: SourceItem[] }>("GET", `/api/v1/workspaces/${workspaceId}/sources`);
    if (r.ok) setSources(r.data.sources);
  }, [workspaceId]);
  const loadReview = useCallback(async () => {
    if (!sourceId) return setReview(null);
    const r = await api<Review>("GET", `/api/v1/sources/${sourceId}/review`);
    setReview(r.ok ? r.data : null);
    if (r.ok && r.data.mySignIn) {
      const e = await api<{ tables: number; rows: number }>("GET", `/api/v1/sources/${sourceId}/scan/estimate`);
      setEstimate(e.ok ? e.data : null);
    }
  }, [sourceId]);
  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => { loadSources(); }, [loadSources]);
  useEffect(() => { loadReview(); }, [loadReview]);

  async function submit<T>(method: string, path: string, body: unknown, then: (data: T) => void) {
    setBusy(true);
    setError(null);
    const r = await api<T & { error?: string }>(method, path, body);
    setBusy(false);
    if (!r.ok) return setError(r.data?.error ?? "That did not work.");
    then(r.data);
  }
  const role = workspaces?.find((w) => w.id === workspaceId)?.role;
  const open = review?.questions.filter((q) => q.status === "open") ?? [];
  const counted = review?.definitions.filter((d) => d.kind === "metric" || d.kind === "rule") ?? [];
  const confirmedCount = counted.filter((d) => d.status === "confirmed").length;
  const settledCount = review ? review.definitions.filter((d) => d.status === "settled").length : 0;
  useTabTitle(review ? review.source.name : "How we count");
  useStatus(
    "definitions",
    !review || !review.scan
      ? null
      : {
          left: `${review.source.name} · ${confirmedCount} of ${counted.length} confirmed${settledCount ? ` · ${settledCount} settled from the data` : ""}`,
          right: review.changes.length ? `${review.changes.length} ${review.changes.length === 1 ? "change" : "changes"} waiting` : open.length ? `${open.length} ${open.length === 1 ? "question" : "questions"} to answer` : counted.length && confirmedCount === counted.length ? "All numbers confirmed" : undefined,
          tone: review.changes.length || open.length ? "warn" : counted.length && confirmedCount === counted.length ? "good" : undefined,
        },
  );
  const shown = showAll ? open : open.filter((q) => q.atSetup);
  const labelOf = (id: string) => review?.definitions.find((d) => d.id === id)?.label ?? "a definition";

  return (
    <main className="main definitions-page">
      <h1>How we count</h1>
      <p className="collab-note">Connect a data source and GridZero works out its structure, metrics and rules. You confirm or correct them, and agents answer from what has been confirmed.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="def-notice" role="status">{notice}</p>}

      {workspaces === null ? <p>Loading…</p> : (
        <section className="settings-card def-wide">
          <h2>Workspace</h2>
          {workspaces.length > 0 && (
            <label className="field">Workspace
              <select value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); navigate("/definitions"); }}>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}
              </select>
            </label>
          )}
          <form className="def-actions" onSubmit={(e) => { e.preventDefault(); const name = new FormData(e.currentTarget).get("name"); const form = e.currentTarget; submit<Workspace>("POST", "/api/v1/workspaces", { name }, (w) => { form.reset(); setWorkspaces([...(workspaces ?? []), w]); setWorkspaceId(w.id); }); }}>
            <input name="name" aria-label="New workspace name" placeholder="New workspace, for example your company" required maxLength={80} />
            <button className="secondary" type="submit" disabled={busy}>Create workspace</button>
          </form>
        </section>
      )}

      {workspaceId && (
        <section className="settings-card def-wide">
          <h2>Sources</h2>
          {sources.length === 0 && <p className="collab-note">No sources yet. A source is the address of a database; everyone signs in to it with their own user.</p>}
          <ul className="def-sources">
            {sources.map((s) => (
              <li key={s.id}>
                <Link to={`/definitions/${s.id}`} className={s.id === sourceId ? "active" : undefined}>{s.name}</Link>
                <span className="workbook-meta">{s.kind === "workbook" ? "the tables in a workbook" : `${s.config.database} on ${s.config.host} · ${s.mySignIn ? `you sign in as ${s.mySignIn}` : "you have not signed in"}`} · {s.lastScanAt ? `scanned ${new Date(s.lastScanAt).toLocaleString()}` : "not scanned"}</span>
              </li>
            ))}
          </ul>
          {role === "admin" && (
            <details>
              <summary>Add a Postgres source</summary>
              <form className="def-form" onSubmit={(e) => { e.preventDefault(); submit<{ id: string }>("POST", `/api/v1/workspaces/${workspaceId}/sources`, { ...newSource, port: Number(newSource.port), schemas: newSource.schemas.split(",").map((x) => x.trim()).filter(Boolean) }, (s) => { loadSources(); navigate(`/definitions/${s.id}`); }); }}>
                {(["name", "host", "port", "database", "schemas"] as const).map((k) => (
                  <label className="field" key={k}>{k === "schemas" ? "Schemas to scan (comma separated)" : k[0]!.toUpperCase() + k.slice(1)}
                    <input value={newSource[k]} onChange={(e) => setNewSource({ ...newSource, [k]: e.target.value })} required={k !== "schemas"} />
                  </label>
                ))}
                <label className="field">Encryption
                  <select value={newSource.ssl} onChange={(e) => setNewSource({ ...newSource, ssl: e.target.value })}>
                    <option value="verify">Encrypted, certificate checked</option>
                    <option value="require">Encrypted, certificate not checked</option>
                    <option value="disable">Not encrypted</option>
                  </select>
                </label>
                <button className="primary-inline" type="submit" disabled={busy}>Add source</button>
              </form>
            </details>
          )}
        </section>
      )}

      {review && (
        <>
          <section className="settings-card def-wide">
            <h2>{review.source.name}</h2>
            {!review.mySignIn ? (
              <form className="def-form" onSubmit={(e) => { e.preventDefault(); submit("PUT", `/api/v1/sources/${review.source.id}/credential`, signIn, () => { setSignIn({ username: "", password: "" }); loadReview(); loadSources(); }); }}>
                <p>Sign in with your own database user. Every query runs with your access, so what you may see in the database is what you see here.</p>
                <label className="field">Database user<input value={signIn.username} onChange={(e) => setSignIn({ ...signIn, username: e.target.value })} required autoComplete="off" /></label>
                <label className="field">Password<input type="password" value={signIn.password} onChange={(e) => setSignIn({ ...signIn, password: e.target.value })} required autoComplete="new-password" /></label>
                <button className="primary-inline" type="submit" disabled={busy}>Save my sign-in</button>
              </form>
            ) : (
              <>
                <p className="collab-note">{review.kind === "workbook" ? "These are the tables in one of your workbooks. Anyone who can open the workbook can use them here." : <>You sign in as <b>{review.mySignIn}</b>.</>} Queries only read.</p>
                {review.scan ? (
                  <p className="collab-note">Last scan {new Date(review.scan.finishedAt).toLocaleString()}: {review.scan.tables.length} tables; {review.scan.stats.historyNote || "no query history"}.</p>
                ) : <p>Not scanned yet.</p>}
                {review.role !== "viewer" && (
                  <div className="def-actions">
                    <button className="primary-inline" disabled={busy} onClick={() => { setNotice(null); submit<{ tables: number; definitions: number; questions: number; settled: number }>("POST", `/api/v1/sources/${review.source.id}/scan`, undefined, (s) => { setNotice(`Scanned ${s.tables} tables and modelled them: ${s.definitions} definitions, ${s.settled} settled from the data without asking, ${s.questions} ${s.questions === 1 ? "question" : "questions"} for a person.`); loadReview(); loadSources(); }); }}>{busy ? "Scanning…" : review.scan ? "Scan again" : "Scan"}</button>
                    {estimate && <span className="workbook-meta">Reads {estimate.tables} tables, about {estimate.rows.toLocaleString("en-US")} rows, with counting queries that run in the database.</span>}
                  </div>
                )}
                {review.scan && (
                  <div className="def-actions">
                    <a className="secondary" href={`/api/v1/sources/${review.source.id}/export`}>Export confirmed (Apache Ossie)</a>
                    <a className="link-button" href={`/api/v1/sources/${review.source.id}/export?all=1`}>Export everything</a>
                  </div>
                )}
              </>
            )}
          </section>

          {review.scan && (
            <div className="def-tabs" role="tablist">
              {([["questions", "Questions", open.length], ["count", "How we count", review.definitions.filter((d) => d.kind === "metric" || d.kind === "rule").length], ["checked", "Checked answers", null], ["changes", "Changes", review.changes.length]] as [ReviewTab, string, number | null][]).map(([id, label, n]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}{n ? <span className="workbook-meta">{n}</span> : null}</button>
              ))}
            </div>
          )}

          {tab === "changes" && review.changes.length === 0 && review.scan && <p className="collab-note def-section">No changes are waiting. A correction shows its old and new numbers here before anyone publishes it.</p>}
          {tab === "changes" && review.changes.length > 0 && (
            <section className="def-section">
              <h2>Changes waiting to be published</h2>
              {review.changes.map((ch) => <ChangeCard key={ch.id} change={ch} label={labelOf(ch.definitionId)} canEdit={review.role !== "viewer"} onDone={loadReview} />)}
            </section>
          )}

          {review.scan && tab === "questions" && (
            <section className="def-section">
              <h2>Questions {open.length > 0 && <span className="workbook-meta">{open.length} open</span>}</h2>
              {open.length === 0 ? <p className="collab-note">Nothing to ask right now.</p> : (
                <>
                  <p className="collab-note">Only what the data could not settle, most important first. Each choice shows the number it gives.</p>
                  {shown.map((q) => <QuestionCard key={q.id} q={q} review={review} onDone={(applied) => { setNotice(applied?.join(" ") ?? null); loadReview(); }} />)}
                  {open.length > shown.length && <button className="link-button" onClick={() => setShowAll(true)}>Show {open.length - shown.length} more</button>}
                </>
              )}
            </section>
          )}

          {tab === "checked" && <TrustedAnswers sourceId={review.source.id} canEdit={review.role === "admin" || review.role === "editor"} stamp={review} />}

          {KINDS.map(([kind, title, hint]) => {
            const rows = review.definitions.filter((d) => d.kind === kind);
            if (!rows.length || tab !== "count") return null;
            return (
              <section className="def-section" key={kind}>
                <h2>{title} <span className="workbook-meta">{rows.filter((d) => d.status === "confirmed").length} of {rows.length} confirmed · {hint}</span></h2>
                <ul className="def-list">{rows.map((d) => <DefinitionRow key={d.id} d={d} review={review} onChanged={loadReview} />)}</ul>
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}
