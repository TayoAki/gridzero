// The agent run loop (spec §2.4) and conversation storage (§5.4, §5.6).

import { randomBytes } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, sql as dsql } from "drizzle-orm";

import { db } from "../db/client.ts";
import { agentMessage, agentRun } from "../db/schema.ts";
import { captureError } from "../errors.ts";
import { ERRORS, HISTORY_CHARS, HISTORY_MESSAGES, MAX_STEPS } from "./catalog.ts";
import type { ErrorCode, RunKind } from "./catalog.ts";
import { MODEL, clientFor, costMicroUsd, systemPrompt } from "./model.ts";
import { GROUNDING_LABEL, ToolError, availableIn, clientTool, toolDefinitions, toolLabel } from "./tools.ts";
import type { Grounding } from "./tools.ts";

type Block = Anthropic.Beta.BetaContentBlock;
type Param = Anthropic.Beta.BetaMessageParam;

export const newId = () => randomBytes(12).toString("hex");

/** A line of the browser stream (spec §4.2). */
export type StreamLine =
  | { type: "run"; runId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; status: "running" | "done" | "error"; summary?: string }
  | { type: "widget_proposal"; proposalId: string }
  | { type: "approval"; approvalId: string }
  | { type: "app_connect"; slug: string; name: string }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number; costMicroUsd: number } };

export interface StoredRow {
  role: "user" | "assistant";
  content: unknown[];
}

const isToolResultRow = (r: StoredRow) => r.role === "user" && r.content.some((b) => (b as { type?: string }).type === "tool_result");

/**
 * The model's history: rows in order, starting at a plain user message and within
 * `maxChars` of JSON. Leading rows are dropped until both hold.
 */
export function trimHistory(rows: StoredRow[], maxChars = HISTORY_CHARS): StoredRow[] {
  let start = 0;
  let size = rows.reduce((n, r) => n + JSON.stringify(r.content).length, 0);
  while (start < rows.length && (rows[start]!.role !== "user" || isToolResultRow(rows[start]!) || size > maxChars)) {
    size -= JSON.stringify(rows[start]!.content).length;
    start++;
  }
  return rows.slice(start);
}

export async function loadHistory(agentId: string): Promise<StoredRow[]> {
  const rows = await db
    .select({ role: agentMessage.role, content: agentMessage.content })
    .from(agentMessage)
    .where(eq(agentMessage.agentId, agentId))
    .orderBy(desc(agentMessage.seq))
    .limit(HISTORY_MESSAGES);
  return trimHistory(rows.reverse().map((r) => ({ role: r.role as StoredRow["role"], content: r.content as unknown[] })));
}

/** Append one message with the next seq for the agent; retries if two writers collide. */
export async function appendMessage(agentId: string, role: "user" | "assistant", content: unknown[], visible: string | null, runId: string | null): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ max: dsql<number | null>`max(${agentMessage.seq})` })
          .from(agentMessage)
          .where(eq(agentMessage.agentId, agentId));
        await tx.insert(agentMessage).values({ id: newId(), agentId, seq: Number(row?.max ?? 0) + 1, role, content, visible, runId });
      });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

export async function listMessages(agentId: string, before: number | null, limit: number) {
  const where = before ? dsql`${agentMessage.agentId} = ${agentId} and ${agentMessage.seq} < ${before}` : eq(agentMessage.agentId, agentId);
  const rows = await db.select().from(agentMessage).where(where).orderBy(desc(agentMessage.seq)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const messages: {
    id: string;
    seq: number;
    role: "user" | "assistant";
    visible: string | null;
    tools: { name: string; summary: string }[];
    proposals: string[];
    approvals: string[];
    createdAt: Date;
  }[] = [];
  for (const r of page) {
    const blocks = (r.content ?? []) as { type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }[];
    if (r.role === "user" && r.visible === null) {
      // A tool-result row: attach any widget proposals to the reply before it.
      const last = messages[messages.length - 1];
      for (const b of blocks) {
        if (b.type !== "tool_result" || b.is_error || typeof b.content !== "string") continue;
        const id = /"proposal_id":"([0-9a-f]+)"/.exec(b.content)?.[1];
        if (id && last?.role === "assistant") last.proposals.push(id);
        const approvalId = /"approval_id":"([0-9a-f]+)"/.exec(b.content)?.[1];
        if (approvalId && last?.role === "assistant") last.approvals.push(approvalId);
      }
      continue;
    }
    const assistant = r.role === "assistant";
    messages.push({
      id: r.id,
      seq: r.seq,
      role: r.role as "user" | "assistant",
      visible: assistant ? blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : r.visible,
      tools: assistant ? blocks.filter((b) => b.type === "tool_use" || b.type === "server_tool_use").map((b) => ({ name: b.name ?? "", summary: toolLabel(b.name ?? "", b.input) })) : [],
      proposals: [],
      approvals: [],
      createdAt: r.createdAt,
    });
  }
  return { messages, hasMore };
}

interface Totals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  searches: number;
  steps: number;
}

export interface RunOptions {
  agent: { id: string; name: string; instructions: string };
  userId: string;
  apiKey: string;
  kind: RunKind;
  userText: string;
  /** Store the run's messages in the agent's chat (false for widget refreshes). */
  store: boolean;
  emit: (line: StreamLine) => void;
  /** The widget a widget_refresh run updates. */
  widgetId?: string | null;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  errorCode: ErrorCode | null;
  finalText: string;
  costMicroUsd: number;
}

/** Run the agent until it answers, fails, or uses up its steps (spec §2.4). */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { agent, userId, kind, emit } = opts;
  const runId = newId();
  await db.insert(agentRun).values({ id: runId, agentId: agent.id, ownerId: userId, kind, status: "running", model: MODEL });
  emit({ type: "run", runId });

  const userMessage: Param = { role: "user", content: [{ type: "text", text: opts.userText }] };
  const history: Param[] = opts.store ? ((await loadHistory(agent.id)) as Param[]) : [];
  history.push(userMessage);
  if (opts.store) await appendMessage(agent.id, "user", userMessage.content as unknown[], opts.userText, runId);

  const totals: Totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, searches: 0, steps: 0 };
  const client = clientFor(opts.apiKey);
  const system = systemPrompt(agent);
  let webOff = false;
  let errorCode: ErrorCode | null = null;
  let finalText = "";
  let parseRetries = 0;
  // The weakest grounding any tool result of this run had (definitions spec §8.2).
  const state = new Map<string, unknown>();
  const order: Grounding[] = ["confirmed", "unconfirmed", "sql"];
  let grounding: Grounding | null = null;

  const fail = (code: ErrorCode) => {
    errorCode = code;
    emit({ type: "error", code, message: ERRORS[code] });
  };

  try {
    loop: for (;;) {
      if (totals.steps >= MAX_STEPS[kind]) {
        fail("E_TOO_MANY_STEPS");
        break;
      }
      totals.steps++;
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: kind === "chat" ? "low" : "medium" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: toolDefinitions({ kind, webOff }),
        messages: history,
      } as unknown as Anthropic.Beta.MessageCreateParamsStreaming);

      stream.on("text", (delta) => emit({ type: "text", delta }));
      stream.on("streamEvent", (event) => {
        if (event.type !== "content_block_start") return;
        const block = event.content_block as { type: string; id?: string; name?: string; tool_use_id?: string };
        if (block.type === "tool_use" || block.type === "server_tool_use") emit({ type: "tool", id: block.id ?? "", name: block.name ?? "", status: "running" });
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        parseRetries = 0;
      } catch (e) {
        if (e instanceof Anthropic.APIError || parseRetries++ >= 2) throw e;
        totals.steps--;
        continue;
      }

      const usage = message.usage as unknown as Record<string, any>;
      totals.input += usage.input_tokens ?? 0;
      totals.output += usage.output_tokens ?? 0;
      totals.cacheCreation += usage.cache_creation_input_tokens ?? 0;
      totals.cacheRead += usage.cache_read_input_tokens ?? 0;
      totals.searches += usage.server_tool_use?.web_search_requests ?? 0;

      const content = message.content as Block[];
      history.push({ role: "assistant", content } as unknown as Param);
      const text = content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (text) finalText = text;
      if (opts.store) await appendMessage(agent.id, "assistant", content as unknown[], null, runId);

      // Server tools ran inside this response: report each one as done.
      for (const b of content as { type: string; id?: string; name?: string; input?: unknown }[]) {
        if (b.type === "server_tool_use") emit({ type: "tool", id: b.id ?? "", name: b.name ?? "", status: "done", summary: toolLabel(b.name ?? "", b.input) });
      }

      switch (message.stop_reason) {
        case "end_turn":
        case "stop_sequence":
          break loop;
        case "refusal":
          fail("E_REFUSED");
          break loop;
        case "max_tokens":
          fail("E_TOO_LONG");
          break loop;
        case "pause_turn":
          continue;
        case "tool_use":
          break;
        default:
          break loop;
      }

      const uses = content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
      if (uses.length === 0) break;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const tool = clientTool(use.name);
        if (!tool || !availableIn(tool, kind)) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "That tool is not available here." });
          emit({ type: "tool", id: use.id, name: use.name, status: "error", summary: "Not available" });
          continue;
        }
        const parsed = tool.schema.safeParse(use.input);
        if (!parsed.success) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid input: ${parsed.error.message}` });
          emit({ type: "tool", id: use.id, name: use.name, status: "error", summary: "Invalid input" });
          continue;
        }
        try {
          const result = await tool.run(parsed.data, { userId, agentId: agent.id, runId, kind, widgetId: opts.widgetId ?? null, emit, state });
          if (tool.privateData) webOff = true;
          const g = (result as { _grounding?: Grounding } | null)?._grounding;
          if (g && (grounding === null || order.indexOf(g) > order.indexOf(grounding))) grounding = g;
          // Keys starting with "_" are for our labels only, not the model.
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result, (k, v) => (k.startsWith("_") ? undefined : v)) });
          emit({ type: "tool", id: use.id, name: use.name, status: "done", summary: tool.summary(parsed.data, result).slice(0, 120) });
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : "The tool failed.";
          if (!(e instanceof ToolError)) captureError(e, { tool: use.name, runId });
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: msg });
          emit({ type: "tool", id: use.id, name: use.name, status: "error", summary: msg.slice(0, 120) });
        }
      }
      const toolMessage: Param = { role: "user", content: results };
      history.push(toolMessage);
      if (opts.store) await appendMessage(agent.id, "user", results as unknown[], null, runId);
    }
  } catch (e) {
    captureError(e, { runId, agentId: agent.id, kind });
    fail("E_MODEL");
  }

  // A reply that rests on anything but confirmed definitions gets a fixed label, whatever the model wrote.
  const weakest = grounding as Grounding | null;
  if (!errorCode && weakest && weakest !== "confirmed") {
    const label = `\n\n${GROUNDING_LABEL[weakest]}`;
    finalText += label;
    emit({ type: "text", delta: label });
    if (opts.store) {
      const [last] = await db.select().from(agentMessage).where(dsql`${agentMessage.runId} = ${runId} and ${agentMessage.role} = 'assistant'`).orderBy(desc(agentMessage.seq)).limit(1);
      if (last) await db.update(agentMessage).set({ content: [...(last.content as unknown[]), { type: "text", text: label }] }).where(eq(agentMessage.id, last.id));
    }
  }

  const cost = costMicroUsd({
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_creation_input_tokens: totals.cacheCreation,
    cache_read_input_tokens: totals.cacheRead,
    server_tool_use: { web_search_requests: totals.searches },
  });
  await db
    .update(agentRun)
    .set({
      status: errorCode ? "error" : "ok",
      errorCode,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheCreationTokens: totals.cacheCreation,
      cacheReadTokens: totals.cacheRead,
      webSearches: totals.searches,
      costMicroUsd: cost,
      steps: totals.steps,
      finishedAt: new Date(),
    })
    .where(eq(agentRun.id, runId));
  if (!errorCode) emit({ type: "done", usage: { inputTokens: totals.input, outputTokens: totals.output, costMicroUsd: cost } });
  return { runId, ok: !errorCode, errorCode, finalText, costMicroUsd: cost };
}
