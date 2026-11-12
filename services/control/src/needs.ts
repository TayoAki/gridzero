// "Needs you": everything waiting on a person, across every source they belong to, in one call.
// Open questions (with the numbers each answer gives and, when AI is on, the answer the evidence
// favours), changes waiting to be published, what the last scan settled without asking, and
// alerts or shares they have not seen.

import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";

import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { definition, definitionChange, notification, question, source, workItem, workspaceMember } from "./db/schema.ts";

interface Evidence {
  type: string;
  text: string;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  app.get("/api/v1/needs-you", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const memberships = await db.select({ workspaceId: workspaceMember.workspaceId, role: workspaceMember.role }).from(workspaceMember).where(eq(workspaceMember.userId, user.id));
    const roleOf = new Map(memberships.map((m) => [m.workspaceId, m.role]));
    const sources = memberships.length ? await db.select({ id: source.id, name: source.name, workspaceId: source.workspaceId }).from(source).where(inArray(source.workspaceId, [...roleOf.keys()])) : [];
    const ids = sources.map((s) => s.id);
    const nameOf = new Map(sources.map((s) => [s.id, s.name]));
    const canAnswer = (sourceId: string) => roleOf.get(sources.find((s) => s.id === sourceId)?.workspaceId ?? "") !== "viewer";

    const questions = ids.length ? await db.select().from(question).where(and(inArray(question.sourceId, ids), eq(question.status, "open"))).orderBy(asc(question.rank)).limit(60) : [];
    const defs = ids.length ? await db.select().from(definition).where(inArray(definition.sourceId, ids)) : [];
    const defName = new Map(defs.map((d) => [d.id, d]));
    const changes = defs.length ? await db.select().from(definitionChange).where(and(inArray(definitionChange.definitionId, defs.map((d) => d.id)), eq(definitionChange.status, "proposed"))).orderBy(desc(definitionChange.createdAt)).limit(30) : [];
    const [{ unread }] = (await db.select({ unread: count() }).from(notification).where(and(eq(notification.userId, user.id), isNull(notification.readAt)))) as [{ unread: number }];
    const notes = await db.select().from(notification).where(eq(notification.userId, user.id)).orderBy(desc(notification.createdAt)).limit(15);

    // Questions with numbers to choose from come first; an open-ended one is easier once those are answered.
    questions.sort((x, y) => Number(x.kind === "trusted_number") - Number(y.kind === "trusted_number"));
    const settled = defs.filter((d) => d.status === "settled");
    const mine = questions.filter((q) => q.assigneeId === user.id).length;
    const [{ work }] = (await db.select({ work: count() }).from(workItem).where(and(eq(workItem.assigneeId, user.id), isNull(workItem.closedAt)))) as [{ work: number }];
    return c.json({
      questions: questions.map((q) => {
        const data = q.data as { suggestion?: { option: number; why: string } };
        return { id: q.id, sourceId: q.sourceId, source: nameOf.get(q.sourceId) ?? "", kind: q.kind, topic: q.topic, prompt: q.prompt, options: q.options, mine: q.assigneeId === user.id, canAnswer: canAnswer(q.sourceId), suggestion: data.suggestion ?? null };
      }),
      changes: changes.map((ch) => {
        const d = defName.get(ch.definitionId);
        return { id: ch.id, sourceId: d?.sourceId ?? "", source: nameOf.get(d?.sourceId ?? "") ?? "", label: d?.label ?? "", request: ch.request, preview: ch.preview };
      }),
      settled: settled.slice(0, 80).map((d) => ({ id: d.id, sourceId: d.sourceId, kind: d.kind, label: d.label, why: ((d.evidence as Evidence[]).find((e) => e.type === "settled")?.text ?? "").replace(/^Settled from the data on [\d-]+:? ?/, "").replace(/ ?No person had to answer\.$/, "") })),
      counts: { definitions: defs.length, settled: settled.length, confirmed: defs.filter((d) => d.status === "confirmed").length, drafts: defs.filter((d) => d.status === "inferred" || d.status === "needs_answer").length, sources: sources.length },
      notifications: notes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.readAt, at: n.createdAt })),
      // What the rail's badge shows: questions passed to this person, changes to review, things not yet seen.
      work,
      waiting: mine + changes.length + unread + work,
    });
  });
}
