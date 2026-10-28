// Auth (BUILD-SPEC D13): email + password for M0. Google OAuth is added once a
// client id/secret exists for the staging domain.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { env } from "./env.ts";

export const auth = betterAuth({
  baseURL: env.publicUrl,
  secret: env.authSecret,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  trustedOrigins: [env.publicUrl, "http://localhost:5173"],
});

export type Session = typeof auth.$Infer.Session;
