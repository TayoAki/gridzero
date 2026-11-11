// Chat with one agent. Replies stream in as NDJSON lines (agent spec §4.2).

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { ProposalCard } from "../widgets/ProposalCard";
import { ApprovalCard, ConnectCard } from "./AppCards";
import { AgentBadge } from "./AgentBadge";
import { AgentDialog } from "./AgentDialog";
import { SchedulesDialog } from "./Schedules";
import { useTabTitle } from "../shell/context";
import { api } from "./catalog";
import type { Agent, KeyStatus } from "./catalog";

interface ToolRow {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary: string;
}

interface Message {
  key: string;
  seq?: number;
  role: "user" | "assistant";
  text: string;
  tools: ToolRow[];
  proposals: string[];
  approvals: string[];
  connects: { slug: string; name: string }[];
  error?: string;
  /** The run behind this reply, when it made a query: the reply can be marked as correct. */
  verifyRun?: string;
  runId?: string;
  /** Where the trusted answer went, once marked. */
  verified?: { sourceId: string } | { error: string };
}

interface StoredMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  visible: string;
  tools: { name: string; summary: string }[];
  proposals?: string[];
  approvals?: string[];
  verifyRun?: string;
}

const PAGE = 20;

/** Lines, with https:// links made clickable. Everything else stays plain text. */
export function ChatText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line.split(/(https:\/\/[^\s<>"]+)/g).map((part, j) =>
            j % 2 === 1 ? (
              <a key={j} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
            ) : (
              <Fragment key={j}>{part}</Fragment>
            ),
          )}
        </Fragment>
      ))}
    </>
  );
}

function AgentTitle({ name }: { name: string }) {
  useTabTitle(name);
  return null;
}

const fromStored = (m: StoredMessage): Message => ({
  key: m.id,
  seq: m.seq,
  role: m.role,
  text: m.visible ?? "",
  tools: m.tools.map((t, i) => ({ id: `${m.id}-${i}`, name: t.name, status: "done", summary: t.summary })),
  proposals: m.proposals ?? [],
  approvals: m.approvals ?? [],
  connects: [],
  verifyRun: m.verifyRun,
});

export function AgentChatPage() {
  const { id = "" } = useParams();
  return <AgentChat key={id} id={id} />;
}

/** What the shell adds to a message so the agent knows what is open. Hidden when shown. */
const LOOKING = /\n\n\(Open now: [^\n]*\)$/;

export function AgentChat({ id, embedded = false, looking = null }: { id: string; embedded?: boolean; looking?: string | null }) {
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [missing, setMissing] = useState(false);
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);

  useEffect(() => {
    api<{ agents: Agent[] }>("GET", "/api/v1/agents").then((r) => {
      const found = r.ok ? r.data.agents.find((a) => a.id === id) : undefined;
      if (found) setAgent(found);
      else setMissing(true);
    });
    api<KeyStatus>("GET", "/api/v1/ai-key").then((r) => setKey(r.ok ? r.data : { provider: null }));
    api<{ messages: StoredMessage[]; hasMore: boolean }>("GET", `/api/v1/agents/${id}/messages?limit=${PAGE}`).then((r) => {
      if (!r.ok) return;
      setMessages(r.data.messages.map(fromStored));
      setHasMore(r.data.hasMore);
    });
  }, [id]);

  // Keep the view pinned to the newest message, or in place after loading older ones.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function loadOlder() {
    const first = messages.find((m) => m.seq !== undefined);
    if (!hasMore || loadingOlder || !first) return;
    setLoadingOlder(true);
    const r = await api<{ messages: StoredMessage[]; hasMore: boolean }>("GET", `/api/v1/agents/${id}/messages?limit=${PAGE}&before=${first.seq}`);
    setLoadingOlder(false);
    if (!r.ok) return;
    const el = listRef.current;
    keepOffset.current = el ? el.scrollHeight - el.scrollTop : null;
    setMessages((prev) => [...r.data.messages.map(fromStored), ...prev]);
    setHasMore(r.data.hasMore);
  }

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 40) loadOlder();
  }

  function patchReply(update: (m: Message) => Message) {
    setMessages((prev) => {
      const next = prev.slice();
      next[next.length - 1] = update(next[next.length - 1]!);
      return next;
    });
  }

  async function send() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreaming(true);
    stickToBottom.current = true;
    const stamp = Date.now();
    setMessages((prev) => [...prev, { key: `u${stamp}`, role: "user", text, tools: [], proposals: [], approvals: [], connects: [] }, { key: `a${stamp}`, role: "assistant", text: "", tools: [], proposals: [], approvals: [], connects: [] }]);

    await consume(() =>
      fetch(`/api/v1/agents/${id}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: looking ? `${text}\n\n(Open now: ${looking})` : text }),
      }),
    );
  }

  /** Read an NDJSON reply into the last message. */
  async function consume(request: () => Promise<Response>) {
    try {
      const res = await request();
      if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("ndjson")) {
        const body = await res.json().catch(() => null);
        if (!res.ok) patchReply((m) => ({ ...m, error: body?.error ?? `Something went wrong (${res.status}).` }));
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (raw) handleLine(JSON.parse(raw));
        }
      }
    } catch {
      patchReply((m) => ({ ...m, error: "The connection dropped. Reload to see the full reply." }));
    } finally {
      setStreaming(false);
    }
  }

  /** Approving runs the action and streams the agent's follow-up as a new reply. */
  async function approve(approvalId: string) {
    setStreaming(true);
    stickToBottom.current = true;
    const stamp = Date.now();
    setMessages((prev) => [...prev, { key: `a${stamp}`, role: "assistant", text: "", tools: [], proposals: [], approvals: [], connects: [] }]);
    await consume(() => fetch(`/api/v1/approvals/${approvalId}/approve`, { method: "POST", credentials: "include" }));
  }

  function handleLine(line: { type: string; runId?: string; proposalId?: string; approvalId?: string; slug?: string; delta?: string; id?: string; name?: string; status?: ToolRow["status"]; summary?: string; message?: string }) {
    if (line.type === "text") patchReply((m) => ({ ...m, text: m.text + (line.delta ?? "") }));
    else if (line.type === "run") patchReply((m) => ({ ...m, runId: line.runId }));
    else if (line.type === "done") patchReply((m) => (m.runId && m.tools.some((t) => t.status === "done" && (t.name === "query_tables" || t.name === "query_definition")) ? { ...m, verifyRun: m.runId } : m));
    else if (line.type === "tool")
      patchReply((m) => {
        const row: ToolRow = { id: line.id ?? "", name: line.name ?? "", status: line.status ?? "running", summary: line.summary ?? `Using ${line.name}` };
        const at = m.tools.findIndex((t) => t.id === row.id);
        const tools = m.tools.slice();
        if (at >= 0) tools[at] = { ...tools[at]!, ...row, summary: line.summary ?? tools[at]!.summary };
        else tools.push(row);
        return { ...m, tools };
      });
    else if (line.type === "widget_proposal" && line.proposalId) patchReply((m) => ({ ...m, proposals: [...m.proposals, line.proposalId!] }));
    else if (line.type === "approval" && line.approvalId) patchReply((m) => ({ ...m, approvals: [...m.approvals, line.approvalId!] }));
    else if (line.type === "app_connect" && line.slug) patchReply((m) => ({ ...m, connects: [...m.connects, { slug: line.slug!, name: line.name ?? line.slug! }] }));
    else if (line.type === "error") patchReply((m) => ({ ...m, error: line.message ?? "Something went wrong." }));
  }

  /** "This answer is right": the agent reuses it from now on and is tested on it when it changes. */
  async function markCorrect(m: Message) {
    const r = await api<{ sourceId: string; error?: string }>("POST", `/api/v1/agents/${id}/runs/${m.verifyRun}/verify`);
    setMessages((prev) => prev.map((x) => (x.key === m.key ? { ...x, verified: r.ok ? { sourceId: r.data.sourceId } : { error: r.data?.error ?? "That did not work." } } : x)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  async function newChat() {
    if (streaming) return;
    const r = await api("DELETE", `/api/v1/agents/${id}/messages`);
    if (r.ok) {
      setMessages([]);
      setHasMore(false);
    }
  }

  async function deleteAgent() {
    if (!agent || !window.confirm(`Delete "${agent.name}" and its chat history?`)) return;
    const r = await api("DELETE", `/api/v1/agents/${id}`);
    if (r.ok) navigate("/agents");
  }

  if (missing)
    return (
      <main className="main">
        <p><Link to="/agents">← Agents</Link></p>
        <div className="empty"><strong>Agent not found</strong></div>
      </main>
    );
  if (!agent) return <main className="main"><p>Loading…</p></main>;

  return (
    <div className={`chat-page${embedded ? " embedded" : ""}`}>
      {!embedded && <AgentTitle name={agent.name} />}
{!embedded && (
      <header className="chat-head">
        <Link to="/agents" className="chat-back" aria-label="Back to agents">←</Link>
        <AgentBadge agent={agent} size={32} />
        <h1>{agent.name}</h1>
        <span className="chat-head-spacer" />
        <button className="secondary" onClick={() => setEditing(true)}>Edit</button>
        <button className="secondary" onClick={() => setScheduling(true)}>Schedules</button>
        <button className="secondary" onClick={newChat} disabled={streaming}>New chat</button>
        <button className="link-button danger" onClick={deleteAgent}>Delete</button>
      </header>
      )}

      <div className="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite">
        {hasMore && <p className="chat-older">{loadingOlder ? "Loading…" : <button className="link-button" onClick={loadOlder}>Load older messages</button>}</p>}
        {messages.length === 0 && <p className="chat-hint">{looking ? `Ask ${agent.name} about what is open. It reads every row.` : `Ask ${agent.name} anything. It can search the web and read pages.`}</p>}
        {embedded && messages.length > 0 && !streaming && <p className="chat-older"><button className="link-button" onClick={newChat}>Start a new chat</button></p>}
        {messages.map((m) => (
          <div key={m.key} className={`chat-msg ${m.role}`}>
            {m.tools.map((t) => (
              <div key={t.id} className={`tool-row ${t.status}`}>
                <span aria-hidden="true">{t.status === "running" ? "⟳" : t.status === "done" ? "✓" : "✕"}</span> {t.summary}
              </div>
            ))}
            {m.text && <div className="chat-bubble"><ChatText text={m.role === "user" ? m.text.replace(LOOKING, "") : m.text} /></div>}
            {m.role === "assistant" && !m.text && !m.error && streaming && m === messages[messages.length - 1] && m.tools.length === 0 && <div className="chat-bubble pending">…</div>}
            {m.verifyRun && m.text && !(streaming && m === messages[messages.length - 1]) && (
              <p className="chat-verify">
                {!m.verified ? (
                  <button className="link-button" onClick={() => markCorrect(m)} title="The agent will reuse this answer, and is tested on it whenever it changes">✓ Mark as correct</button>
                ) : "error" in m.verified ? (
                  <span className="error">{m.verified.error}</span>
                ) : (
                  <span>✓ Marked as correct. <Link to={`/definitions/${m.verified.sourceId}`}>Trusted answers</Link></span>
                )}
              </p>
            )}
            {m.proposals.map((p) => <ProposalCard key={p} id={p} />)}
            {m.connects.map((c) => <ConnectCard key={c.slug} slug={c.slug} name={c.name} />)}
            {m.approvals.map((a) => <ApprovalCard key={a} id={a} busy={streaming} onApprove={approve} />)}
            {m.error && <p className="error chat-error" role="alert">{m.error}</p>}
          </div>
        ))}
      </div>

      {key === null ? null : key.provider === null && !key.included ? (
        <div className="chat-nokey">
          Add your own AI key to start. <Link to="/settings/ai">AI settings</Link>
        </div>
      ) : (
        <div className="chat-composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={8000}
            placeholder={`Message ${agent.name}`}
            aria-label={`Message ${agent.name}`}
          />
          <button className="primary-inline" onClick={send} disabled={streaming || !draft.trim()}>
            {streaming ? "Working…" : "Send"}
          </button>
        </div>
      )}

      {scheduling && <SchedulesDialog title={`Scheduled tasks for ${agent.name}`} agentId={agent.id} onClose={() => setScheduling(false)} />}
      {editing && (
        <AgentDialog
          agent={agent}
          onClose={() => setEditing(false)}
          onSaved={(a) => {
            setAgent(a);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
