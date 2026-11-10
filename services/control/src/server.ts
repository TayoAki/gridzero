import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { app } from "./app.ts";
import { captureError, reporting } from "./errors.ts";
import { runMigrations } from "./db/client.ts";
import { env } from "./env.ts";
import { runDue } from "./connected.ts";
import { runDueSchedules } from "./schedules.ts";
import { purgeExpired } from "./sharing.ts";

await runMigrations();

const purge = () => purgeExpired().catch((e: unknown) => captureError(e, { job: "trash purge" }));
void purge();
setInterval(purge, 3_600_000).unref();
// One job after the other, so a tick never runs two batches of queries at once.
let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  await runDue().catch((e: unknown) => captureError(e, { job: "scheduled refresh" }));
  await runDueSchedules().catch((e: unknown) => captureError(e, { job: "schedules" }));
  ticking = false;
};
setInterval(() => void tick(), env.scheduleTickMs).unref();

if (env.webDist) {
  const root = env.webDist;
  app.use("/*", serveStatic({ root }));
  // SPA fallback: client-side routes resolve to index.html.
  const indexHtml = await readFile(join(root, "index.html"), "utf8");
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml)));
}

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`control plane listening on :${info.port}${env.webDist ? ` (serving ${env.webDist})` : ""}; errors ${reporting() ? "go to Sentry" : "are logged only (no SENTRY_DSN)"}`);
});
