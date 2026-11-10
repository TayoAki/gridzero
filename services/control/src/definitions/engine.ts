// Runs one job of the semantic engine (services/semantic/worker.py). The engine asks for
// queries; this side runs them and hands back the rows, so the engine never sees a credential.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { env } from "../env.ts";

const WORKER_DIR = env.semanticDir ?? fileURLToPath(new URL("../../../semantic", import.meta.url));
const JOB_TIMEOUT_MS = 15 * 60_000;

export class EngineError extends Error {}

export type RunSql = (sql: string) => Promise<(string | null)[][]>;

export async function engineJob<T>(job: Record<string, unknown>, runSql?: RunSql): Promise<T> {
  const child = spawn(env.semanticPython, ["worker.py"], { cwd: WORKER_DIR, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill(), JOB_TIMEOUT_MS);
  const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  try {
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (e) => reject(new EngineError(`The semantic engine could not start: ${e.message}`)));
    });
    failed.catch(() => {});
    write(job);
    const answer = (async () => {
      for await (const line of lines) {
        const msg = JSON.parse(line) as { need?: string; result?: T; error?: string };
        if (msg.need !== undefined) {
          if (!runSql) throw new EngineError("This job may not run queries.");
          try {
            write({ rows: await runSql(msg.need) });
          } catch (e) {
            write({ error: (e as Error).message.slice(0, 1000) });
          }
        } else if (msg.error !== undefined) throw new EngineError(msg.error);
        else if (msg.result !== undefined) return msg.result;
      }
      throw new EngineError(`The semantic engine ended without an answer. ${stderr}`);
    })();
    return await Promise.race([answer, failed]);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
