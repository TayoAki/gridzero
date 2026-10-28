import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { app } from "./app.ts";
import { runMigrations } from "./db/client.ts";
import { env } from "./env.ts";

await runMigrations();

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
