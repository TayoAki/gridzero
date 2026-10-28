import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

// onnotice: the migrator's CREATE ... IF NOT EXISTS emits "already exists, skipping" notices on every boot.
export const sql = postgres(env.databaseUrl, { max: 10, onnotice: () => {} });
export const db = drizzle(sql, { schema });

export async function runMigrations(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
}
