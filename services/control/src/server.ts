import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { app } from "./app.ts";
import { runMigrations } from "./db/client.ts";
import { env } from "./env.ts";
import { runDue } from "./connected.ts";
import { purgeExpired } from "./sharing.ts";

await runMigrations();

const purge = () => purgeExpired().catch((e: unknown) => console.error("trash purge failed", e));
void purge();
setInterval(purge, 3_600_000).unref();
setInterval(() => void runDue().catch((e: unknown) => console.error("scheduled refresh failed", e)), 15_000).unref();

if (env.webDist) {
  const root = env.webDist;
  app.use("/*", serveStatic({ root }));
  // SPA fallback: client-side routes resolve to index.html.
  const indexHtml = await readFile(join(root, "index.html"), "utf8");
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml)));
}

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`control plane listening on :${info.port}${env.webDist ? ` (serving ${env.webDist})` : ""}`);
});
