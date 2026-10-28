import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

// onnotice: the migrator's CREATE ... IF NOT EXISTS emits "already exists, skipping" notices on every boot.
// DB_POOL_MAX=1 for local PGlite, which is a single Postgres session: concurrent
// prepared statements from several pooled connections collide there.
export const sql = postgres(env.databaseUrl, { max: env.dbPoolMax, onnotice: () => {} });
export const db = drizzle(sql, { schema });

export async function runMigrations(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
}
