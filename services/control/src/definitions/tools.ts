// Agent tools over definitions (spec §8). Agents answer metric questions from confirmed
// definitions; anything else is labelled by the run loop, whatever the model writes.

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { newId } from "../agents/run.ts";
import { ToolError, registerTool, setSqlGate } from "../agents/tools.ts";
import type { ClientTool } from "../agents/tools.ts";
import { csvRow } from "../connectors.ts";
import { db } from "../db/client.ts";
import { definition, definitionChange, question, scan, source, user, workspaceMember } from "../db/schema.ts";
import { access } from "../sharing.ts";
import { readOnlySqlProblem } from "../agents/workbook-tools.ts";
import { EngineError } from "./engine.ts";
import { TablesError, queryTables, stage } from "./tables.ts";
import { MetricSqlError, NoCredential, SourceError, memberAccess } from "./sql.ts";
import { TooCostly, canEdit, definitionFor, latestScan, membership, runMetric, runScan, settle, sourceDefinitions, workbookSource } from "./store.ts";
import type { ScanResult } from "./store.ts";
import { trustedExamples, trustedQuery } from "./trusted.ts";

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

async function visibleDefinitions(userId: string) {
  const memberships = await db.select({ workspaceId: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, userId));
  if (!memberships.length) return [];
  return db
    .select({ d: definition, sourceName: source.name })
    .from(definition)
    .innerJoin(source, eq(source.id, definition.sourceId))
    .where(and(inArray(definition.workspaceId, memberships.map((m) => m.workspaceId)), inArray(definition.kind, ["metric", "dimension", "rule"])));
}

const listDefinitions: ClientTool<Record<string, never>> = {
  name: "list_definitions",
  description:
    "List the shared definitions of the user's workspaces, after trusted_examples (questions a person has marked as answered correctly, with the query or definition to reuse): metrics (numbers the business has defined), dimensions (ways to group them) and rules. Each has an id, a status (confirmed, inferred, needs_answer or disputed) and who confirmed it. Call this first for any question about a business number, then use query_definition.",
  inputSchema: obj({}),
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  readOnly: true,
  privateData: false,
  async run(_input, ctx) {
    ctx.state.set("listedDefinitions", true);
    const rows = await visibleDefinitions(ctx.userId);
    const rank = { confirmed: 0, disputed: 1, settled: 2, inferred: 3, needs_answer: 4 } as Record<string, number>;
    rows.sort((a, b) => rank[a.d.status]! - rank[b.d.status]!);
    return {
      trusted_examples: await trustedExamples([...new Set(rows.map((r) => r.d.sourceId))]),
      definitions: rows.slice(0, 200).map(({ d, sourceName }) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, description: d.description, status: d.status, source: sourceName, ...(d.kind === "dimension" ? { of: (d.body as { entity: string }).entity } : {}) })),
    };
  },
  summary: (_i, r) => `Listed ${(r as { definitions: unknown[] }).definitions.length} definitions`,
};

interface QueryInput {
  definition_id: string;
  group_by: string[];
  limit: number | null;
}

const queryDefinition: ClientTool<QueryInput> = {
  name: "query_definition",
  description:
    "Get the number for one metric definition, optionally grouped by up to 3 dimensions (give dimension names from list_definitions). It runs with the user's own database access. Returns the result as CSV, the SQL, the definition's status and who confirmed it. Say in your answer whether the definition is confirmed.",
  inputSchema: obj({ definition_id: { type: "string" }, group_by: { type: "array", items: { type: "string" } }, limit: { type: ["integer", "null"] } }),
  schema: z.object({ definition_id: z.string(), group_by: z.array(z.string()).max(3), limit: z.number().int().nullable() }).strict(),
  readOnly: true,
  privateData: true,
  async run(input, ctx) {
    const found = await definitionFor(ctx.userId, input.definition_id);
    if (!found || found.def.kind !== "metric") throw new ToolError("There is no metric with that id. Use list_definitions.");
    const rows = await sourceDefinitions(found.src.id);
    const all = rows.map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, status: d.status, body: d.body as Record<string, any> }));
    const groupBy = input.group_by.map((n) => {
      const dim = all.find((d) => d.kind === "dimension" && d.name === n);
      if (!dim) throw new ToolError(`There is no dimension named ${n}.`);
      return dim;
    });
    try {
      const v = await runMetric(await memberAccess(found.src, ctx.userId), all.find((d) => d.id === found.def.id)!, all, { groupBy, limit: input.limit ?? 100 });
      const [who] = found.def.confirmedBy ? await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, found.def.confirmedBy)) : [];
      const confirmed = found.def.status === "confirmed";
      return {
        label: found.def.label,
        status: found.def.status,
        confirmed_by: confirmed ? (who?.name || who?.email || null) : null,
        confirmed_at: confirmed ? found.def.confirmedAt?.toISOString().slice(0, 10) : null,
        csv: csvRow(v.columns) + v.rows.map((r) => csvRow(r)).join(""),
        sql: v.sql,
        // A disputed definition still serves its last confirmed version, with a note (spec §4.4).
        note: found.def.status === "disputed" ? "This definition is under review." : undefined,
        _grounding: confirmed || found.def.status === "disputed" ? "confirmed" : found.def.status === "settled" ? "settled" : "unconfirmed",
        _label: found.def.label,
      };
    } catch (e) {
      if (e instanceof NoCredential || e instanceof MetricSqlError || e instanceof TooCostly) throw new ToolError(e.message);
      if (e instanceof SourceError) throw new ToolError(`The query failed: ${e.message}`);
      throw e;
    }
  },
  summary: (_i, r) => `Measured ${(r as { _label: string })._label}`,
};

interface ProposeInput {
  definition_id: string;
  request: string;
}

const proposeChange: ClientTool<ProposeInput> = {
  name: "propose_definition_change",
  description:
    "When the user says a shared definition is wrong (for example 'revenue should leave out refunds'), file their correction as a proposed change for the definition's owner to review. This does not change the definition: tell the user it is waiting for review, and that answers stay unconfirmed until then.",
  inputSchema: obj({ definition_id: { type: "string" }, request: { type: "string" } }),
  schema: z.object({ definition_id: z.string(), request: z.string().min(3).max(2000) }).strict(),
  readOnly: false,
  privateData: false,
  async run(input, ctx) {
    const found = await definitionFor(ctx.userId, input.definition_id);
    if (!found) throw new ToolError("There is no definition with that id. Use list_definitions.");
    const id = newId();
    await db.insert(definitionChange).values({ id, definitionId: found.def.id, proposedBy: ctx.userId, origin: "chat", request: input.request, newBody: found.def.body, preview: { note: "Filed from a chat. Open it on the review screen to work out the new formula and numbers." } });
    return { change_id: id, status: "waiting for review", _grounding: "unconfirmed", _label: found.def.label };
  },
  summary: (_i, r) => `Proposed a change to ${(r as { _label: string })._label}`,
};

// --- tables in a workbook ---------------------------------------------------------

interface ListTablesInput {
  workbook_id: string;
}

const listTables: ClientTool<ListTablesInput> = {
  name: "list_tables",
  description:
    "Describe the Data Tables in a workbook (uploaded or imported files): every column with its type, how many different and empty values it has and its most common values. Also returns trusted_examples (questions a person has marked as answered correctly, with the query to reuse), the definitions GridZero drafted from them (metrics and rules, with ids for query_definition) and the open questions that decide what the numbers mean, each with the number every choice gives. Call this before answering anything from a table. Then compute with query_tables or query_definition; never add up rows you read with read_sheet.",
  inputSchema: obj({ workbook_id: { type: "string" } }),
  schema: z.object({ workbook_id: z.string() }).strict(),
  readOnly: true,
  privateData: true,
  async run(input, ctx) {
    const found = await access(ctx.userId, input.workbook_id);
    if (!found) throw new ToolError("Workbook not found.");
    let staged;
    try {
      staged = await stage(found.row.id);
    } catch (e) {
      throw new ToolError(e instanceof TablesError ? e.message : "The workbook's tables could not be read.");
    }
    if (!staged.tables.length) return { tables: [], skipped: staged.skipped, note: "This workbook has no Data Tables. Ask the user to import their file with Data → Import file or URL and choose Data table.", _title: found.row.title };
    const src = await workbookSource(ctx.userId, found.row.id, found.row.title);
    const role = await membership(ctx.userId, src.workspaceId);
    // Scan when there is no scan yet, or the tables have changed since the last one.
    let last = await latestScan(src.id);
    const scanned = (last?.stats as { signature?: string } | null)?.signature;
    // Only in a chat: a scheduled run reads what is there and drafts nothing.
    if (ctx.kind === "chat" && canEdit(role) && scanned !== staged.signature) {
      try {
        await runScan(src, ctx.userId);
        // Model the tables too: keys, links and fields the data makes clear are settled without asking.
        await settle(src, ctx.userId);
        last = await latestScan(src.id);
        if (last) await db.update(scan).set({ stats: { ...(last.stats as object), signature: staged.signature } }).where(eq(scan.id, last.id));
      } catch (e) {
        if (e instanceof EngineError) throw new ToolError("The tables could not be scanned.");
        throw e;
      }
    }
    const result = last?.result as ScanResult | undefined;
    const defs = await sourceDefinitions(src.id);
    const questions = await db.select().from(question).where(and(eq(question.sourceId, src.id), eq(question.status, "open"))).orderBy(asc(question.rank)).limit(5);
    return {
      trusted_examples: await trustedExamples([src.id]),
      tables: staged.tables.map((t) => {
        const profile = result?.tables[`main.${t.name}`];
        return {
          name: t.name,
          rows: t.totalRows,
          ...(t.shownRows !== t.totalRows ? { filtered: `Someone has filtered this table in the sheet: queries see ${t.shownRows} of ${t.totalRows} rows.` } : {}),
          one_row_per: profile?.keys[0]?.columns ?? null,
          columns: (profile?.columns ?? []).map((col) => ({ name: col.name, type: col.kind, different_values: col.distinct, empty: col.nulls, ...(col.top ? { common_values: col.top.slice(0, 8).map((v) => `${v[0]} (${v[1]})`) } : {}) })),
        };
      }),
      skipped: staged.skipped,
      definitions: defs.filter((d) => d.kind === "metric" || d.kind === "rule" || d.kind === "dimension").map((d) => ({ id: d.id, kind: d.kind, name: d.name, label: d.label, expression: (d.body as { expression?: string }).expression, filters: (d.body as { filters?: string[] }).filters, status: d.status })),
      open_questions: questions.map((q) => ({ topic: q.topic, question: q.prompt, choices: (q.options as { label: string; text?: string }[]).map((o) => (o.text ? `${o.label}: ${o.text}` : o.label)) })),
      review_page: `/definitions/${src.id}`,
      how_to_use: "Put the open questions that affect the user's request to them, with the numbers, before building on those numbers; they answer on the review page, where they can also confirm definitions. A number from an unconfirmed definition or from query_tables is unconfirmed: say so.",
      _title: found.row.title,
    };
  },
  summary: (_i, r) => `Looked at the tables in ${(r as { _title: string })._title}`,
};

interface QueryTablesInput {
  workbook_id: string;
  sql: string;
  max_rows: number | null;
}

const queryTablesTool: ClientTool<QueryTablesInput> = {
  name: "query_tables",
  description:
    "Run one read-only SQL query (DuckDB dialect) over the whole of a workbook's Data Tables and get the result as CSV. Tables are named as list_tables shows them. Use this to total, group, filter and join every row; it is the only way to get a correct number from a table with more than a few rows. max_rows defaults to 100 (at most 500).",
  inputSchema: obj({ workbook_id: { type: "string" }, sql: { type: "string" }, max_rows: { type: ["integer", "null"] } }),
  schema: z.object({ workbook_id: z.string(), sql: z.string(), max_rows: z.number().int().nullable() }).strict(),
  readOnly: true,
  privateData: true,
  async run(input, ctx) {
    const found = await access(ctx.userId, input.workbook_id);
    if (!found) throw new ToolError("Workbook not found.");
    if (input.sql.length > 20_000) throw new ToolError("The query is longer than 20,000 characters.");
    const problem = readOnlySqlProblem(input.sql);
    if (problem) throw new ToolError(problem);
    try {
      const out = await queryTables(found.row.id, input.sql, Math.min(500, Math.max(1, input.max_rows ?? 100)));
      const filtered = out.tables.filter((t) => t.shownRows !== t.totalRows).map((t) => `${t.name} is filtered in the sheet to ${t.shownRows} of ${t.totalRows} rows`);
      // A query a person has already marked as correct is as good as a confirmed definition.
      const trusted = await trustedQuery(ctx.userId, found.row.id, input.sql);
      return {
        csv: csvRow(out.columns) + out.rows.map((r) => csvRow(r)).join(""),
        truncated: out.truncated,
        ...(filtered.length ? { note: `${filtered.join("; ")}. The result only covers the rows showing.` } : {}),
        ...(trusted ? { verified: `This exact query was marked as correct by ${trusted.by} on ${trusted.on}.` } : {}),
        _grounding: trusted ? "confirmed" : "sql",
        _title: found.row.title,
      };
    } catch (e) {
      if (e instanceof TablesError) throw new ToolError(e.message);
      if (e instanceof EngineError) throw new ToolError(`The query failed: ${e.message.replace(/^\w+Exception: /, "").slice(0, 500)}`);
      throw e;
    }
  },
  summary: (_i, r) => `Queried the tables in ${(r as { _title: string })._title}`,
};

for (const tool of [listDefinitions, queryDefinition, proposeChange, listTables, queryTablesTool]) registerTool(tool as ClientTool<any>);

// Once a user's workspace has definitions, run_sql must come after list_definitions, and what it
// returns is never a confirmed number (spec §8.2).
setSqlGate(async (ctx) => {
  const rows = await visibleDefinitions(ctx.userId);
  if (!rows.length) return {};
  if (!ctx.state.get("listedDefinitions")) return { refuse: "This workspace has shared definitions. Call list_definitions first and use query_definition if one fits; write SQL only when none does." };
  return { grounding: "sql" };
});
