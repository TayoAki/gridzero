// Agent tools over definitions (spec §8). Agents answer metric questions from confirmed
// definitions; anything else is labelled by the run loop, whatever the model writes.

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { newId } from "../agents/run.ts";
import { ToolError, registerTool, setSqlGate } from "../agents/tools.ts";
import type { ClientTool } from "../agents/tools.ts";
import { csvRow } from "../connectors.ts";
import { db } from "../db/client.ts";
import { definition, definitionChange, source, user, workspaceMember } from "../db/schema.ts";
import { MetricSqlError, NoCredential, memberAccess } from "./sql.ts";
import { TooCostly, definitionFor, runMetric, sourceDefinitions } from "./store.ts";

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
    "List the shared definitions of the user's workspaces: metrics (numbers the business has defined), dimensions (ways to group them) and rules. Each has an id, a status (confirmed, inferred, needs_answer or disputed) and who confirmed it. Call this first for any question about a business number, then use query_definition.",
  inputSchema: obj({}),
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  readOnly: true,
  privateData: false,
  async run(_input, ctx) {
    ctx.state.set("listedDefinitions", true);
    const rows = await visibleDefinitions(ctx.userId);
    const rank = { confirmed: 0, disputed: 1, inferred: 2, needs_answer: 3 } as Record<string, number>;
    rows.sort((a, b) => rank[a.d.status]! - rank[b.d.status]!);
    return {
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
        _grounding: confirmed || found.def.status === "disputed" ? "confirmed" : "unconfirmed",
        _label: found.def.label,
      };
    } catch (e) {
      if (e instanceof NoCredential || e instanceof MetricSqlError || e instanceof TooCostly) throw new ToolError(e.message);
      throw new ToolError(`The query failed: ${(e as Error).message.slice(0, 400)}`);
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

for (const tool of [listDefinitions, queryDefinition, proposeChange]) registerTool(tool as ClientTool<any>);

// Once a user's workspace has definitions, run_sql must come after list_definitions, and what it
// returns is never a confirmed number (spec §8.2).
setSqlGate(async (ctx) => {
  const rows = await visibleDefinitions(ctx.userId);
  if (!rows.length) return {};
  if (!ctx.state.get("listedDefinitions")) return { refuse: "This workspace has shared definitions. Call list_definitions first and use query_definition if one fits; write SQL only when none does." };
  return { grounding: "sql" };
});
