// Tool registry (spec §2.3, §4.3). Phase 1 has only Anthropic's server tools; later
// phases register client tools here.

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import type { RunKind } from "./catalog.ts";
import type { StreamLine } from "./run.ts";

export interface ToolContext {
  userId: string;
  agentId: string;
  runId: string;
  kind: RunKind;
  /** The widget a widget_refresh run updates. */
  widgetId: string | null;
  /** Send a line to the browser stream (chat runs; a no-op elsewhere). */
  emit: (line: StreamLine) => void;
  /** Notes tools leave for each other within one run (for example "definitions were listed"). */
  state: Map<string, unknown>;
}

/** How well an answer is grounded, worst last: a confirmed definition, an unconfirmed one, or SQL the agent wrote. */
export type Grounding = "confirmed" | "settled" | "unconfirmed" | "sql";

/** Fixed labels the server adds to a reply that does not rest only on confirmed definitions (definitions spec §8.2). */
export const GROUNDING_LABEL: Record<Exclude<Grounding, "confirmed">, string> = {
  settled: "Settled from the data: this uses a definition worked out from your data that no person has confirmed yet.",
  unconfirmed: "Unconfirmed: this uses a definition nobody has confirmed yet.",
  sql: "Unconfirmed: no shared definition exists for this, so I wrote a query.",
};

type SqlGate = (ctx: ToolContext) => Promise<{ refuse?: string; grounding?: Grounding }>;
let sqlGate: SqlGate | null = null;
/** Lets the definitions module decide whether run_sql may run and how its result is labelled. */
export const setSqlGate = (gate: SqlGate) => void (sqlGate = gate);
export const checkSqlGate = (ctx: ToolContext) => (sqlGate ? sqlGate(ctx) : Promise.resolve({} as { refuse?: string; grounding?: Grounding }));

/** A tool we run ourselves. Its input is validated with `schema` before `run` is called. */
export interface ClientTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema: z.ZodType<I>;
  /** Read-only tools may run in scheduled runs. */
  readOnly: boolean;
  /** Reading private data turns off the web tools for the rest of the run. */
  privateData: boolean;
  /** Limit the tool to these run kinds. Default: every kind for read-only tools, chat otherwise. */
  kinds?: RunKind[];
  run(input: I, ctx: ToolContext): Promise<unknown>;
  summary(input: I, result: unknown): string;
}

/** Thrown by a tool to return a readable error to the model. */
export class ToolError extends Error {}

export const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
] as const;

const registry = new Map<string, ClientTool<any>>();

export function registerTool(tool: ClientTool<any>): void {
  registry.set(tool.name, tool);
}

export function clientTool(name: string): ClientTool<any> | undefined {
  return registry.get(name);
}

/** Whether a tool may be offered and run in a run of this kind. */
export function availableIn(tool: ClientTool<any>, kind: RunKind): boolean {
  if (tool.kinds) return tool.kinds.includes(kind);
  return kind === "chat" || tool.readOnly;
}

/** The tools for one model call: server tools first (unless guarded off), then client tools by name. */
export function toolDefinitions(opts: { kind: RunKind; webOff: boolean }): Anthropic.Beta.BetaToolUnion[] {
  const server = opts.webOff ? [] : SERVER_TOOLS.map((t) => ({ ...t }));
  const client = [...registry.values()]
    .filter((t) => availableIn(t, opts.kind))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.inputSchema, type: "object" as const },
      strict: true,
      eager_input_streaming: true,
    }));
  return [...server, ...client] as unknown as Anthropic.Beta.BetaToolUnion[];
}

/** Label for a tool step in chat history (spec §5.5). */
export function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "web_search") return `Searched: ${String(i.query ?? "")}`.slice(0, 120);
  if (name === "web_fetch") return `Read: ${String(i.url ?? "")}`.slice(0, 120);
  return `Used ${name}`;
}
