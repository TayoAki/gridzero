// Python in a notebook. A cell runs in its own process with the workbook's tables copied beside it,
// confined the same way a workbook's Python is (services/sandbox): no network, no file outside its
// own folder, no starting other programs, two minutes at most. What it saves comes back as tables;
// a notebook run on a schedule writes those into the workbook, and when the notebook is tied to a
// model each run is a new version of it whose predictions are kept, so a rollback puts them back.

import { spawn } from "node:child_process";
import { chown, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { record } from "./activity.ts";
import { hostBase, hostToken } from "./agents/host.ts";
import { newId } from "./agents/run.ts";
import { notify } from "./alerts.ts";
import type { Vars } from "./app.ts";
import { db } from "./db/client.ts";
import { modelAsset, notebook, trackedTable } from "./db/schema.ts";
import { capture } from "./delta.ts";
import { forgetStaged, stage } from "./definitions/tables.ts";
import { env } from "./env.ts";
import { captureError } from "./errors.ts";
import { parseCsv } from "./widgets/refresh.ts";
import { access } from "./sharing.ts";
import { downstreamOwners } from "./usedby.ts";

const DIR = env.sandboxDir ?? fileURLToPath(new URL("../../sandbox", import.meta.url));
const TIMEOUT_MS = 120_000;
const MAX_SOURCE = 100_000;
const MAX_SAVED_BYTES = 30 << 20;
const NOBODY = 65534;
let running = 0;

export class PythonError extends Error {}

export interface Saved {
  name: string;
  columns: string[];
  rows: string[][];
  count: number;
  csv: Buffer;
}
export interface PythonResult {
  output: string;
  error: string | null;
  saved: Saved[];
  ms: number;
}

/** Whether Python can run here, and if not, why. */
export function pythonProblem(): string | null {
  if (env.sandboxAllowUnisolated) return null;
  if (process.platform !== "linux" || process.arch !== "x64") return "Python cells need a Linux x86-64 server, where the cell can be confined.";
  return null;
}

/** Run Python over a copy of a workbook's tables. Never throws for what the code does: that comes back as `error`. */
export async function runPython(workbookId: string, source: string): Promise<PythonResult> {
  const problem = pythonProblem();
  if (problem) throw new PythonError(problem);
  if (running >= 2) throw new PythonError("Two Python cells are already running. Try again in a moment.");
  running++;
  const started = Date.now();
  const work = await mkdtemp(join(tmpdir(), "gz-py-"));
  try {
    const staged = await stage(workbookId);
    await mkdir(join(work, "tables"));
    await mkdir(join(work, "tmp"));
    for (const f of staged.files) await copyFile(f.path, join(work, "tables", `${f.name}.csv`));
    // As root, the cell runs as nobody, who must be able to read its tables and write its results.
    const root = process.getuid?.() === 0;
    if (root) for (const p of [work, join(work, "tables"), join(work, "tmp"), ...staged.files.map((f) => join(work, "tables", `${f.name}.csv`))]) await chown(p, NOBODY, NOBODY);
    const child = spawn(env.sandboxPython ?? env.semanticPython, [join(DIR, "runner.py")], {
      cwd: work,
      env: { PYTHONPATH: DIR, SANDBOX_WORK_DIR: work, SANDBOX_MEM_MB: "2048", HOME: join(work, "tmp"), TMPDIR: join(work, "tmp"), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", ...(env.sandboxAllowUnisolated ? { PATH: process.env.PATH ?? "" } : { SANDBOX_LOCKDOWN: "1" }) },
      stdio: ["pipe", "pipe", "pipe"],
      ...(root ? { uid: NOBODY, gid: NOBODY } : {}),
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    let done: { output: string; error: string | null } | null = null;
    try {
      for await (const line of lines) {
        let msg: { ready?: boolean; rpc?: unknown; done?: { output: string; error: string | null } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.ready) child.stdin.write(JSON.stringify({ op: "run", source: `from nb import sql, table, tables, save\n${source}` }) + "\n");
        // A workbook's Python can ask its host for cells; a notebook cell has only its copy of the tables.
        else if (msg.rpc !== undefined) child.stdin.write(JSON.stringify({ error: "That is not available in a notebook. Use table(), sql() and save()." }) + "\n");
        else if (msg.done) {
          done = msg.done;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
    const ms = Date.now() - started;
    if (!done) return { output: "", error: ms >= TIMEOUT_MS - 500 ? "The cell took longer than two minutes and was stopped." : `Python could not be started, or stopped before it finished. ${stderr.split("\n").filter(Boolean).at(-1) ?? ""}`.trim(), saved: [], ms };
    const saved: Saved[] = [];
    const out = join(work, "out");
    for (const f of (await readdir(out).catch(() => [])).filter((x) => x.endsWith(".csv")).sort().slice(0, 5)) {
      if ((await stat(join(out, f))).size > MAX_SAVED_BYTES) continue;
      const csv = await readFile(join(out, f));
      const rows = parseCsv(csv.toString("utf8"));
      saved.push({ name: f.slice(0, -4), columns: rows[0] ?? [], rows: rows.slice(1, 51), count: Math.max(0, rows.length - 1), csv });
    }
    // The line the person wrote, not the one after the line added in front.
    const error = done.error ? done.error.replace(/File "<code>", line (\d+)/g, (_, n: string) => `line ${Number(n) - 1}`) : null;
    return { output: done.output.slice(0, 200_000), error, saved, ms };
  } finally {
    running--;
    void rm(work, { recursive: true, force: true });
  }
}

/** Put a saved table into the workbook as a Data Table: a new one, or over the one an earlier run made. */
export async function landTable(workbookId: string, name: string, csv: Buffer, tableId: string | null): Promise<{ table: string | null; rows: number }> {
  const base = hostBase(workbookId);
  const token = encodeURIComponent(await hostToken(workbookId));
  const importId = `nb${newId().slice(0, 16)}`;
  let res = await fetch(`${base}/import?token=${token}&import_id=${importId}&name=${encodeURIComponent(name)}.csv`, { method: "POST", body: Readable.toWeb(Readable.from(csv)) as unknown as BodyInit, duplex: "half" } as RequestInit);
  if (!res.ok) throw new PythonError((await res.text()) || `The table could not be sent to the workbook (${res.status}).`);
  const finish = (dest: unknown) => fetch(`${base}/apply?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "FinalizeImport", import_id: importId, options: { header: true, separator: ",", quote: null, skip_rows: 0 }, dest, mode: "Table", name }) });
  res = await finish(tableId ? { type: "Table", table: tableId } : { type: "NewSheet" });
  if (res.status === 404) res = await finish({ type: "NewSheet" });
  if (!res.ok) throw new PythonError((await res.text()) || `The table could not be written to the workbook (${res.status}).`);
  const done = (await res.json()) as { rows: number; table: string | null };
  forgetStaged(workbookId);
  return { table: done.table, rows: Math.max(0, done.rows - 1) };
}

type Notebook = typeof notebook.$inferSelect;
const pythonOf = (nb: Notebook) => nb.cells.filter((c) => c.kind === "python" && c.text.trim()).map((c) => c.text).join("\n\n");

/** Run a notebook's Python from top to bottom as its owner, and write what it saved into the workbook. */
export async function runNotebook(nb: Notebook, scheduled: boolean): Promise<{ status: "ok" | "error"; output: string; landed: { name: string; rows: number }[]; version: string | null }> {
  const found = await access(nb.ownerId, nb.workbookId);
  const landed: { name: string; rows: number }[] = [];
  let status: "ok" | "error" = "ok";
  let output = "";
  let version: string | null = null;
  const outputs = { ...nb.outputs };
  try {
    if (!found || found.role === "viewer") throw new PythonError("The notebook's owner can no longer change this workbook, so it cannot write to it.");
    const source = pythonOf(nb);
    if (!source) throw new PythonError("This notebook has no Python to run.");
    const res = await runPython(nb.workbookId, source);
    output = res.output;
    if (res.error) throw new PythonError(res.error);
    for (const s of res.saved) {
      const done = await landTable(nb.workbookId, s.name, s.csv, outputs[s.name] ?? null);
      if (done.table) outputs[s.name] = done.table;
      landed.push({ name: s.name, rows: done.rows });
    }
    // Tied to a model: this run is a new version of it, and its predictions are kept so they can be put back.
    const [m] = nb.modelId ? await db.select().from(modelAsset).where(and(eq(modelAsset.id, nb.modelId), eq(modelAsset.ownerId, nb.ownerId))) : [];
    if (m && landed.some((l) => l.name === m.tableName)) {
      const key = res.saved.find((s) => s.name === m.tableName)?.columns[0];
      let [t] = await db.select().from(trackedTable).where(and(eq(trackedTable.workbookId, nb.workbookId), eq(trackedTable.tableName, m.tableName)));
      if (!t && key) [t] = await db.insert(trackedTable).values({ id: newId(), ownerId: nb.ownerId, workbookId: nb.workbookId, tableName: m.tableName, keyColumn: key }).returning();
      const kept = t ? await capture(t).catch((e: unknown) => (captureError(e, { job: "model-capture" }), null)) : null;
      version = `run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      await db.update(modelAsset).set({ version, capture: kept?.version ?? null, history: [...m.history, { version: m.version, at: m.updatedAt.toISOString(), notes: m.notes, capture: m.capture }].slice(-50), notes: scheduled ? "A scheduled run of its notebook." : "A run of its notebook.", updatedAt: new Date(), health: null, baseline: null }).where(eq(modelAsset.id, m.id));
      const down = await downstreamOwners(nb.ownerId, "table", `${nb.workbookId}:${m.tableName}`);
      for (const o of (down?.owners ?? []).filter((x) => x !== nb.ownerId)) await notify(o, "model", `${m.name} has new predictions`, `Its notebook ran and wrote ${landed.find((l) => l.name === m.tableName)!.rows} rows to ${m.tableName}.`, null);
    }
  } catch (e) {
    if (!(e instanceof PythonError)) captureError(e, { job: "notebook", id: nb.id });
    status = "error";
    output = `${output}${output ? "\n" : ""}${e instanceof PythonError ? e.message : "Something went wrong on our side. It has been logged."}`;
    if (scheduled) await notify(nb.ownerId, "notebook", `The scheduled run of "${nb.title}" failed`, output.slice(-300), `/lab?wb=${nb.workbookId}`);
  }
  await db.update(notebook).set({ lastRunAt: new Date(), lastStatus: status, lastOutput: output.slice(-20_000), outputs, nextRunAt: nb.everyHours ? new Date(Date.now() + nb.everyHours * 3_600_000) : null }).where(eq(notebook.id, nb.id));
  record({ userId: nb.ownerId, kind: status === "ok" ? "notebook.ran" : "notebook.failed", objectKind: "workbook", objectId: nb.workbookId, label: nb.title, ownerId: nb.ownerId, detail: { scheduled, landed } });
  return { status, output, landed, version };
}

export async function runDueNotebooks(now = new Date()): Promise<number> {
  const due = await db.select().from(notebook).where(and(isNotNull(notebook.everyHours), lte(notebook.nextRunAt, now))).limit(2);
  for (const nb of due) {
    await db.update(notebook).set({ nextRunAt: new Date(now.getTime() + (nb.everyHours ?? 24) * 3_600_000) }).where(eq(notebook.id, nb.id));
    await runNotebook(nb, true).catch((e: unknown) => captureError(e, { job: "notebook", id: nb.id }));
  }
  return due.length;
}

export function routes(app: Hono<{ Variables: Vars }>) {
  /** Run Python over the workbook's tables. Anyone who can open the workbook can: it reads copies and writes nothing back. */
  app.post("/api/v1/workbooks/:id/python", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const found = await access(user.id, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const parsed = z.object({ source: z.string().min(1).max(MAX_SOURCE) }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Write some Python first (up to 100,000 characters)." }, 400);
    try {
      const res = await runPython(found.row.id, parsed.data.source);
      record({ userId: user.id, kind: "python.run", objectKind: "workbook", objectId: found.row.id, label: found.row.title, ownerId: found.row.ownerId, detail: { saved: res.saved.map((s) => s.name), failed: !!res.error }, ms: res.ms });
      return c.json({ output: res.output, error: res.error, ms: res.ms, saved: res.saved.map((s) => ({ name: s.name, columns: s.columns, rows: s.rows, count: s.count })) });
    } catch (e) {
      if (e instanceof PythonError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  const mine = async (userId: string, id: string) => (await db.select().from(notebook).where(and(eq(notebook.id, id), eq(notebook.ownerId, userId))))[0] ?? null;

  /** Run the whole notebook now and write what it saves into the workbook. */
  app.post("/api/v1/notebooks/:id/run", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const nb = await mine(user.id, c.req.param("id"));
    if (!nb) return c.json({ error: "not found" }, 404);
    return c.json(await runNotebook(nb, false));
  });

  /** Run it every so many hours, and optionally say which model's predictions it writes. */
  app.put("/api/v1/notebooks/:id/schedule", async (c) => {
    const user = c.get("user");
    if (!user || !c.get("session")) return c.json({ error: "unauthenticated" }, 401);
    const nb = await mine(user.id, c.req.param("id"));
    if (!nb) return c.json({ error: "not found" }, 404);
    const parsed = z.object({ everyHours: z.number().int().min(1).max(720).nullable().optional(), modelId: z.string().max(64).nullable().optional() }).strict().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Hours must be a whole number from 1 to 720." }, 400);
    const found = await access(user.id, nb.workbookId);
    if (!found || found.role === "viewer") return c.json({ error: "A scheduled notebook writes to the workbook, so you must be able to change it." }, 403);
    const set: Partial<typeof notebook.$inferInsert> = {};
    if (parsed.data.everyHours !== undefined) Object.assign(set, { everyHours: parsed.data.everyHours, nextRunAt: parsed.data.everyHours ? new Date(Date.now() + parsed.data.everyHours * 3_600_000) : null });
    if (parsed.data.modelId !== undefined) {
      if (parsed.data.modelId) {
        const [m] = await db.select({ id: modelAsset.id }).from(modelAsset).where(and(eq(modelAsset.id, parsed.data.modelId), eq(modelAsset.ownerId, user.id), eq(modelAsset.workbookId, nb.workbookId)));
        if (!m) return c.json({ error: "That model is not one of yours on this workbook." }, 400);
      }
      set.modelId = parsed.data.modelId;
    }
    const [row] = await db.update(notebook).set(set).where(eq(notebook.id, nb.id)).returning();
    return c.json({ everyHours: row!.everyHours, nextRunAt: row!.nextRunAt, modelId: row!.modelId });
  });
}
