// Needs you: only what a person has to decide. Questions come with the number each answer gives;
// what the data settled by itself is listed beside them, with what it rests on, so it can be checked.

import { noteKind } from "../insight/ObjectPanel";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api } from "../agents/catalog";
import { Announced, IntakeLinks, Today, WorkList } from "../insight/Work";
import { useShell, useStatus, useTabTitle } from "../shell/context";

interface Option {
  label: string;
  text?: string;
  note?: string;
}
interface Question {
  id: string;
  sourceId: string;
  source: string;
  kind: string;
  topic: string;
  prompt: string;
  options: Option[];
  mine: boolean;
  canAnswer: boolean;
  suggestion: { option: number; why: string } | null;
}
interface Change {
  id: string;
  sourceId: string;
  source: string;
  label: string;
  request: string;
  preview: { oldValue: string | null; newValue: string | null } | null;
}
interface Settled {
  id: string;
  sourceId: string;
  kind: string;
  label: string;
  why: string;
}
interface Note {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  at: string;
}
export interface Needs {
  questions: Question[];
  changes: Change[];
  settled: Settled[];
  counts: { definitions: number; settled: number; confirmed: number; drafts: number; sources: number };
  notifications: Note[];
  waiting: number;
  work: number;
}

const KIND: Record<string, string> = { entity: "One row per", link: "Link", dimension: "Split by", metric: "Total", rule: "Rule" };

function QuestionCard({ q, index, total, onDone }: { q: Question; index: number; total: number; onDone: (applied: string[]) => void }) {
  const [picked, setPicked] = useState<number | null>(q.suggestion?.option ?? null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A question with free text takes "Something else"; one that edits a formula takes only its options.
  const free = !["excluded_rows", "conflict", "trusted_number"].includes(q.kind);
  const other = q.options.length;
  async function send(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const r = await api<{ error?: string; applied?: string[] }>("POST", path, body);
    setBusy(false);
    if (!r.ok) return setError(r.data?.error ?? "That did not work.");
    onDone(r.data?.applied ?? []);
  }
  if (q.kind === "trusted_number") {
    return (
      <section className="need-card">
        <p className="need-meta">Question {index} of {total} · {q.topic} · {q.source}</p>
        <h2>{q.prompt}</h2>
        <p><Link className="primary-inline need-link" to={`/definitions/${q.sourceId}`}>Answer it under How we count</Link></p>
      </section>
    );
  }
  return (
    <section className="need-card" data-testid="need-question">
      <p className="need-meta">Question {index} of {total} · {q.topic} · {q.source}{q.mine ? " · passed to you" : ""}</p>
      <h2>{q.prompt}</h2>
      <div className="need-options" role="radiogroup" aria-label={q.topic}>
        {q.options.map((o, i) => (
          <label key={i} className={`need-option${picked === i ? " on" : ""}`}>
            <input type="radio" name={q.id} checked={picked === i} disabled={!q.canAnswer} onChange={() => setPicked(i)} />
            <span>
              <b>{o.label}</b>
              {o.text && <span className="need-number">{o.text}</span>}
              {o.note && <span className="need-note">{o.note}</span>}
              {q.suggestion?.option === i && <span className="need-hint"><span className="slice-chip">The evidence favours this</span>{q.suggestion.why}</span>}
            </span>
          </label>
        ))}
        {free && (
          <label className={`need-option${picked === other ? " on" : ""}`}>
            <input type="radio" name={q.id} checked={picked === other} disabled={!q.canAnswer} onChange={() => setPicked(other)} />
            <span>
              <b>Something else</b>
              <input className="need-text" aria-label="Describe it in your own words" placeholder="Describe it in your own words" value={text} onFocus={() => setPicked(other)} onChange={(e) => setText(e.target.value)} />
            </span>
          </label>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {q.canAnswer ? (
        <div className="need-actions">
          <button className="primary-inline" disabled={busy || picked === null || (picked === other && !text.trim())} onClick={() => send(`/api/v1/questions/${q.id}/answer`, picked === other ? { text } : { option: picked })}>Confirm</button>
          <button className="secondary" disabled={busy} onClick={() => send(`/api/v1/questions/${q.id}/skip`)}>Skip for now</button>
          <Link className="link-button" to={`/definitions/${q.sourceId}`}>Ask someone else</Link>
        </div>
      ) : (
        <p className="collab-note">You can read this source but not answer for it. An editor or admin can.</p>
      )}
    </section>
  );
}

export function NeedsYouPage() {
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [tab, setTab] = useState<"questions" | "changes" | "told" | "work" | "today">(new URLSearchParams(window.location.search).get("tab") === "work" ? "work" : new URLSearchParams(window.location.search).get("tab") === "today" ? "today" : "questions");
  const [workScope, setWorkScope] = useState<"mine" | "all">("mine");
  const [done, setDone] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shell = useShell();
  useTabTitle("Inbox");
  const load = () => api<Needs>("GET", "/api/v1/needs-you").then((r) => r.ok && setNeeds(r.data));
  useEffect(() => {
    void load();
  }, []);
  // Looking at what you were told marks it as seen.
  useEffect(() => {
    if (tab === "told" && needs?.notifications.some((n) => !n.read)) void api("POST", "/api/v1/notifications/read", {}).then(() => shell?.refreshNeeds());
  }, [tab, needs]);
  useStatus("needs", needs ? { left: `${needs.counts.definitions} definitions: ${needs.counts.settled} settled from the data, ${needs.counts.confirmed} confirmed, ${needs.counts.drafts} drafts`, right: needs.questions.length ? `${needs.questions.length} waiting` : "Nothing waiting", tone: needs.questions.length ? "warn" : "good" } : { left: "Looking…", tone: "busy" });

  // What the data settled, beside the questions: the proof that most of the model needed nobody.
  useEffect(() => {
    if (!needs) return;
    const list = showAll ? needs.settled : needs.settled.slice(0, 6);
    shell?.setPanel("needs", {
      title: "Settled without asking",
      body: (
        <div className="need-settled">
          <p>{needs.counts.settled ? `${needs.counts.settled} ${needs.counts.settled === 1 ? "definition" : "definitions"}. Each says what it rests on, so you can check any of them.` : "Nothing yet. After a source is scanned, what its data makes clear is settled here without a question."}</p>
          {list.map((s) => (
            <Link key={s.id} to={`/definitions/${s.sourceId}`} className="need-settled-item">
              <strong><span aria-hidden="true">✓</span> {KIND[s.kind] ?? s.kind}: {s.label}</strong>
              <span>{s.why}</span>
            </Link>
          ))}
          {needs.settled.length > 6 && <button className="link-button" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `See all ${needs.counts.settled}`}</button>}
          <p className="collab-note">Something wrong? Open it under How we count and say so in plain words.</p>
        </div>
      ),
    });
    return () => shell?.setPanel("needs", null);
  }, [needs, showAll]);

  if (!needs) return <main className="main"><div className="gz-skel"><span /><span /><span /></div></main>;
  const { questions, changes, notifications } = needs;
  const fresh = notifications.filter((n) => !n.read).length;
  return (
    <main className="main needs-page">
      <div className="need-tabs" role="tablist">
        {([["questions", `Questions (${questions.length})`], ["today", "Today"], ["work", `Work${needs.work ? ` (${needs.work})` : ""}`], ["changes", `Changes (${changes.length})`], ["told", `Alerts and shares${fresh ? ` (${fresh} new)` : ""}`]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {done && <p className="ok-note" role="status">{done}</p>}
      {tab === "questions" && (
        questions.length === 0 ? (
          <section className="need-empty">
            <h1>Nothing needs you</h1>
            <p>{needs.counts.sources === 0 ? "Connect a source or upload a table, and Grid Zero works out its keys, links and totals. You are asked only what the data cannot settle." : `${needs.counts.settled} definitions were settled from the data and ${needs.counts.confirmed} confirmed by people. No question is open.`}</p>
            <p><Link className="primary-inline need-link" to={needs.counts.sources === 0 ? "/" : "/definitions"}>{needs.counts.sources === 0 ? "Upload a table" : "Open How we count"}</Link></p>
          </section>
        ) : (
          <>
            <h1>{questions.length} {questions.length === 1 ? "question" : "questions"} only a person can answer</h1>
            <p className="need-lead">Grid Zero drafted {needs.counts.definitions} definitions from your {needs.counts.sources === 1 ? "source" : `${needs.counts.sources} sources`}. The data settled {needs.counts.settled} of them. {questions.length === 1 ? "This one needs" : `These ${questions.length} need`} a person.</p>
            {questions.map((q, i) => <QuestionCard key={q.id} q={q} index={i + 1} total={questions.length} onDone={(applied) => { setDone(applied.length ? applied.join(" ") : "Answered."); void load(); shell?.refreshNeeds(); }} />)}
          </>
        )
      )}
      {tab === "today" && <section className="need-work"><Today /></section>}
      {tab === "work" && (
        <section className="need-work">
          <Announced />
          <div className="insight-controls">
            <label><input type="radio" name="work-scope" checked={workScope === "mine"} onChange={() => setWorkScope("mine")} /> Waiting on me</label>
            <label><input type="radio" name="work-scope" checked={workScope === "all"} onChange={() => setWorkScope("all")} /> Everything I raised or was given</label>
          </div>
          <WorkList key={workScope} scope={workScope} onCount={() => shell?.refreshNeeds()} />
          <IntakeLinks />
        </section>
      )}
      {tab === "changes" && (
        changes.length === 0 ? <section className="need-empty"><h1>No changes to review</h1><p>When someone corrects a definition, the change waits here with its old and new numbers until it is published.</p></section> : changes.map((ch) => (
          <section key={ch.id} className="need-card">
            <p className="need-meta">Change · {ch.source}</p>
            <h2>{ch.label}</h2>
            <p>“{ch.request}”</p>
            {ch.preview && <p className="need-number">{ch.preview.oldValue ?? "?"} → {ch.preview.newValue ?? "?"}</p>}
            <p><Link className="primary-inline need-link" to={`/definitions/${ch.sourceId}`}>Review the change</Link></p>
          </section>
        ))
      )}
      {tab === "told" && (
        notifications.length === 0 ? <section className="need-empty"><h1>Nothing yet</h1><p>An alert that fires, or a report someone shares with you, shows here.</p></section> : notifications.map((n) => (
          <section key={n.id} className={`need-card${n.read ? "" : " fresh"}`}>
            <p className="need-meta">{noteKind(n.kind)} · {new Date(n.at).toLocaleString()}</p>
            <h2>{n.title}</h2>
            <p>{n.body}</p>
            {n.link && <p><Link className="secondary" to={n.link}>Open</Link></p>}
          </section>
        ))
      )}
    </main>
  );
}
