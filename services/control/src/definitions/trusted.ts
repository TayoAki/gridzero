// Trusted answers: questions whose answers a person has vouched for.
//
// 1. Each one is a test for its workspace: the question is put to the agent again whenever the
//    agent's prompt, tools or model change, and the reply is graded against the vouched-for query.
// 2. Agents are shown them first (list_tables, list_definitions), and a query that repeats one
//    exactly counts as confirmed.

import { createHash } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";

import { modelFor, systemPrompt } from "../agents/model.ts";
import { loadKey, overCap } from "../agents/keys.ts";
import type { LoadedKey } from "../agents/keys.ts";
import { runAgent } from "../agents/run.ts";
import { newId } from "../agents/run.ts";
import { toolDefinitions } from "../agents/tools.ts";
import { csvRow } from "../connectors.ts";
import { db } from "../db/client.ts";
import { agent, agentMessage, trustedAnswer, user, workspaceMember } from "../db/schema.ts";
import { captureError } from "../errors.ts";
import { access } from "../sharing.ts";
import { memberAccess, parseCsv } from "./sql.ts";
import { queryTables } from "./tables.ts";
import { canEdit, definitionFor, membership, runMetric, sourceDefinitions, workbookSource } from "./store.ts";

export type TrustedRow = typeof trustedAnswer.$inferSelect;
export class TrustedError extends Error {}

const QUERY_TOOLS = ["query_tables", "query_definition"] as const;
type QueryTool = (typeof QUERY_TOOLS)[number];

/** The same query, however it is spaced. Case is kept: 'Paid' and 'paid' are different values. */
export const sameSql = (sql: string) => sql.replace(/\s+/g, " ").replace(/[; ]+$/, "").trim();

// --- adding ------------------------------------------------------------------------

async function save(values: Omit<typeof trustedAnswer.$inferInsert, "id">): Promise<TrustedRow> {
  const [row] = await db
    .insert(trustedAnswer)
    .values({ id: newId(), ...values })
    .onConflictDoUpdate({
      target: [trustedAnswer.sourceId, trustedAnswer.tool, trustedAnswer.question],
      set: { input: values.input, expected: values.expected, definitionId: values.definitionId ?? null, origin: values.origin, agentId: values.agentId ?? null, createdBy: values.createdBy, createdAt: new Date(), lastStatus: null, lastDetail: null, lastRunAt: null, lastFingerprint: null },
    })
    .returning();
  return row!;
}

/** A confirmed metric is a trusted answer to "What is <metric>?". */
export async function trustConfirmed(def: { id: string; label: string; workspaceId: string; sourceId: string }, userId: string, value: unknown): Promise<void> {
  await save({ workspaceId: def.workspaceId, sourceId: def.sourceId, definitionId: def.id, question: `What is ${def.label}?`, tool: "query_definition", input: { definition_id: def.id, group_by: [] }, expected: `${value ?? ""}\n`, origin: "confirmed", createdBy: userId });
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** The last query a run made that worked, with the question that started the run. */
async function runQuery(agentId: string, runId: string) {
  const rows = await db.select().from(agentMessage).where(and(eq(agentMessage.agentId, agentId), eq(agentMessage.runId, runId))).orderBy(asc(agentMessage.seq));
  const asked = rows.find((r) => r.role === "user" && r.visible !== null)?.visible ?? null;
  const uses = new Map<string, Block>();
  let last: { tool: QueryTool; input: Record<string, unknown>; csv: string } | null = null;
  for (const r of rows) {
    for (const b of (r.content ?? []) as Block[]) {
      if (b.type === "tool_use" && b.id && (QUERY_TOOLS as readonly string[]).includes(b.name ?? "")) uses.set(b.id, b);
      if (b.type !== "tool_result" || b.is_error || typeof b.content !== "string") continue;
      const use = uses.get(b.tool_use_id ?? "");
      if (!use) continue;
      try {
        const csv = (JSON.parse(b.content) as { csv?: unknown }).csv;
        if (typeof csv === "string") last = { tool: use.name as QueryTool, input: use.input ?? {}, csv };
      } catch {
        // Not a result we can keep.
      }
    }
  }
  return { asked, last };
}

/** Whether a run made a query a person could vouch for. */
export async function verifiable(agentId: string, runId: string): Promise<boolean> {
  return (await runQuery(agentId, runId)).last !== null;
}

/** Someone says an agent's reply is right: keep its question and query as a trusted answer. */
export async function trustRun(userId: string, agentId: string, runId: string): Promise<TrustedRow> {
  const { asked, last } = await runQuery(agentId, runId);
  if (!asked || !last) throw new TrustedError("This reply did not come from a query, so there is nothing to mark as correct.");
  if (last.tool === "query_definition") {
    const found = await definitionFor(userId, String(last.input.definition_id ?? ""));
    if (!found) throw new TrustedError("That definition is no longer there.");
    if (!canEdit(found.role)) throw new TrustedError("Only an editor or admin of the workspace can mark answers as correct.");
    return save({ workspaceId: found.src.workspaceId, sourceId: found.src.id, definitionId: found.def.id, question: asked, tool: "query_definition", input: { definition_id: found.def.id, group_by: last.input.group_by ?? [] }, expected: last.csv, origin: "chat", agentId, createdBy: userId });
  }
  const book = await access(userId, String(last.input.workbook_id ?? ""));
  if (!book) throw new TrustedError("That workbook is no longer there.");
  const src = await workbookSource(userId, book.row.id, book.row.title);
  if (!canEdit(await membership(userId, src.workspaceId))) throw new TrustedError("Only an editor or admin of the workspace can mark answers as correct.");
  return save({ workspaceId: src.workspaceId, sourceId: src.id, question: asked, tool: "query_tables", input: { workbook_id: book.row.id, sql: sameSql(String(last.input.sql ?? "")) }, expected: last.csv, origin: "chat", agentId, createdBy: userId });
}

// --- showing them to agents ------------------------------------------------------------

async function names(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, ids));
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

/** Trusted answers of these sources, in the shape an agent reads. Chat-verified ones first. */
export async function trustedExamples(sourceIds: string[]) {
  if (!sourceIds.length) return [];
  const rows = await db.select().from(trustedAnswer).where(inArray(trustedAnswer.sourceId, sourceIds)).orderBy(asc(trustedAnswer.origin), asc(trustedAnswer.createdAt)).limit(40);
  const who = await names([...new Set(rows.map((r) => r.createdBy))]);
  return rows.map((r) => {
    const input = r.input as Record<string, unknown>;
    return {
      question: r.question,
      ...(r.tool === "query_tables" ? { use: "query_tables", workbook_id: input.workbook_id, sql: input.sql } : { use: "query_definition", definition_id: input.definition_id, group_by: input.group_by }),
      verified_by: who.get(r.createdBy) ?? "a member",
      verified_on: r.createdAt.toISOString().slice(0, 10),
    };
  });
}

/** The trusted answer this exact query repeats, if any. */
export async function trustedQuery(userId: string, workbookId: string, sql: string): Promise<{ by: string; on: string } | null> {
  const rows = await db
    .select({ t: trustedAnswer })
    .from(trustedAnswer)
    .innerJoin(workspaceMember, and(eq(workspaceMember.workspaceId, trustedAnswer.workspaceId), eq(workspaceMember.userId, userId)))
    .where(eq(trustedAnswer.tool, "query_tables"));
  const wanted = sameSql(sql);
  const hit = rows.find(({ t }) => (t.input as { workbook_id?: string }).workbook_id === workbookId && (t.input as { sql?: string }).sql === wanted);
  if (!hit) return null;
  return { by: (await names([hit.t.createdBy])).get(hit.t.createdBy) ?? "a member", on: hit.t.createdAt.toISOString().slice(0, 10) };
}

// --- putting the agent through them again ----------------------------------------------

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
let base: string | null = null;

/** Changes whenever the prompt, the tools on offer, the model or the agent's own instructions change. */
export function fingerprint(instructions: string): string {
  base ??= hash(systemPrompt({ name: "", instructions: "" }, new Date(0)) + JSON.stringify(toolDefinitions({ kind: "check", webOff: true })) + modelFor("anthropic"));
  return `${base}:${hash(instructions.trim())}`;
}

const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
/** Numbers written in prose, where 22,500 is one number. */
const numbersInText = (text: string) => (text.replace(/(\d),(?=\d{3})/g, "$1").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** Numbers in a CSV result, cell by cell. */
const numbersInCsv = (csv: string) => parseCsv(csv).flat().filter((c): c is string => c !== null && NUMBER.test(c.trim())).map(Number);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 1e-4);

/**
 * Did the agent land on the trusted result? Every number of the trusted result (or, when it has
 * none, every value) must appear in one of the agent's query results, or in its reply.
 */
export function grade(truthCsv: string, resultCsvs: string[], reply: string): { pass: boolean; detail: string } {
  const cells = parseCsv(truthCsv).slice(parseCsv(truthCsv).length > 1 ? 1 : 0).flat().filter((c): c is string => c !== null && c !== "");
  const wantNumbers = cells.filter((c) => NUMBER.test(c.trim())).map(Number).slice(0, 200);
  if (!cells.length) return { pass: false, detail: "The trusted query returns nothing now, so there is nothing to compare with." };
  const places = [...resultCsvs, reply];
  if (wantNumbers.length) {
    const found = [...resultCsvs.map(numbersInCsv), numbersInText(reply)];
    const ok = found.some((have) => wantNumbers.every((w) => have.some((h) => near(h, w))));
    if (ok) return { pass: true, detail: "The agent reached the same numbers." };
    const best = found.length > 1 ? found.at(-2)! : found[0]!;
    const missing = wantNumbers.filter((w) => !best.some((h) => near(h, w))).slice(0, 3);
    return { pass: false, detail: `Expected ${missing.join(", ")}${wantNumbers.length > 3 ? " and more" : ""}; the agent's ${resultCsvs.length ? "query" : "reply"} did not give ${missing.length === 1 ? "it" : "them"}.` };
  }
  const want = cells.slice(0, 50).map((c) => c.trim().toLowerCase());
  const ok = places.some((p) => want.every((w) => p.toLowerCase().includes(w)));
  return ok ? { pass: true, detail: "The agent reached the same values." } : { pass: false, detail: "The agent's answer did not include the trusted values." };
}

/** What the trusted query gives on today's data. */
async function truthNow(row: TrustedRow, userId: string): Promise<{ csv: string; hint: string }> {
  const input = row.input as Record<string, any>;
  if (row.tool === "query_tables") {
    const book = await access(userId, input.workbook_id);
    if (!book) throw new TrustedError("You can no longer open the workbook this answer is about.");
    const out = await queryTables(book.row.id, input.sql, 500);
    return { csv: csvRow(out.columns) + out.rows.map((r) => csvRow(r)).join(""), hint: `(The data is in the workbook "${book.row.title}", id ${book.row.id}.)` };
  }
  const found = await definitionFor(userId, input.definition_id);
  if (!found) throw new TrustedError("The definition this answer uses is no longer there.");
  const all = (await sourceDefinitions(found.src.id)).map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, status: d.status, body: d.body as Record<string, any> }));
  const groupBy = ((input.group_by ?? []) as string[]).map((n) => all.find((d) => d.kind === "dimension" && d.name === n)).filter((d) => d !== undefined);
  const v = await runMetric(await memberAccess(found.src, userId), all.find((d) => d.id === found.def.id)!, all, { groupBy, limit: 500 });
  const workbookId = found.src.kind === "workbook" ? (found.src.config as { workbookId?: string }).workbookId : null;
  return { csv: csvRow(v.columns) + v.rows.map((r) => csvRow(r)).join(""), hint: workbookId ? `(The data is in the workbook with id ${workbookId}.)` : `(The data is in the source "${found.src.name}".)` };
}

/** Ask the agent one trusted question again and record how it did. */
export async function recheck(row: TrustedRow, userId: string, key: LoadedKey): Promise<TrustedRow> {
  const mine = await db.select().from(agent).where(eq(agent.ownerId, userId)).orderBy(asc(agent.createdAt));
  const who = mine.find((a) => a.id === row.agentId) ?? mine[0];
  let status: "pass" | "fail" | "error" = "error";
  let detail: string;
  if (!who) detail = "Create an agent first: the question is put to one of your agents.";
  else {
    try {
      const truth = await truthNow(row, userId);
      const csvs: string[] = [];
      const out = await runAgent({
        agent: who,
        userId,
        apiKey: key.key,
        provider: key.provider,
        keySource: key.source,
        kind: "check",
        userText: `${row.question}\n\n${truth.hint}`,
        store: false,
        emit: () => {},
        onToolResult: (name, _input, result) => {
          const csv = (result as { csv?: unknown } | null)?.csv;
          if ((QUERY_TOOLS as readonly string[]).includes(name) && typeof csv === "string") csvs.push(csv);
        },
      });
      if (!out.ok) detail = "The agent could not finish its answer.";
      else {
        const g = grade(truth.csv, csvs, out.finalText);
        status = g.pass ? "pass" : "fail";
        detail = g.detail;
      }
    } catch (e) {
      if (!(e instanceof TrustedError)) captureError(e, { job: "trusted answer recheck", id: row.id });
      detail = e instanceof TrustedError ? e.message : "The trusted query could not be run.";
    }
  }
  const [next] = await db
    .update(trustedAnswer)
    .set({ lastStatus: status, lastDetail: detail, lastRunAt: new Date(), lastFingerprint: fingerprint(who?.instructions ?? "") })
    .where(eq(trustedAnswer.id, row.id))
    .returning();
  return next ?? row;
}

/** Whether an answer has not been tried since the agent last changed. */
export async function staleFor(rows: TrustedRow[], userId: string): Promise<Map<string, boolean>> {
  const mine = await db.select({ id: agent.id, instructions: agent.instructions }).from(agent).where(eq(agent.ownerId, userId)).orderBy(asc(agent.createdAt));
  return new Map(rows.map((r) => [r.id, r.lastFingerprint !== fingerprint((mine.find((a) => a.id === r.agentId) ?? mine[0])?.instructions ?? "")]));
}

export const RECHECK_LIMIT = 10;

/**
 * After a release: put the agent through the trusted answers it has not seen since it changed.
 * Only for people on GridZero's own key, inside its spending caps, and at most ten per workspace;
 * nobody's own key is spent without them pressing the button.
 */
export async function recheckStale(): Promise<number> {
  const rows = await db.select().from(trustedAnswer).orderBy(asc(trustedAnswer.createdAt));
  const done = new Map<string, number>();
  let ran = 0;
  for (const row of rows) {
    if ((done.get(row.workspaceId) ?? 0) >= RECHECK_LIMIT) continue;
    if (!(await membership(row.createdBy, row.workspaceId))) continue;
    if (!(await staleFor([row], row.createdBy)).get(row.id)) continue;
    const key = await loadKey(row.createdBy);
    if (!key || key.source !== "platform" || (await overCap(row.createdBy, key))) continue;
    await recheck(row, row.createdBy, key);
    done.set(row.workspaceId, (done.get(row.workspaceId) ?? 0) + 1);
    ran++;
  }
  return ran;
}

export async function answersOf(sourceId: string): Promise<TrustedRow[]> {
  return db.select().from(trustedAnswer).where(eq(trustedAnswer.sourceId, sourceId)).orderBy(asc(trustedAnswer.createdAt));
}

