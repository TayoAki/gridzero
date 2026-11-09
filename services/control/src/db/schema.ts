// Control-plane schema (BUILD-SPEC §4.1). The user/session/account/verification
// tables mirror Better-Auth's core schema (better-auth 1.7 getAuthTables) so its
// Drizzle adapter can use them directly.

import { bigint, bigserial, boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  plan: text("plan", { enum: ["free", "pro"] }).notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const workbook = pgTable(
  "workbook",
  {
    // 24 uppercase hex chars, matching the reference product's workbook ids.
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled Workbook"),
    region: text("region").notNull().default("us-east-1"),
    latestSeq: bigint("latest_seq", { mode: "number" }).notNull().default(0),
    latestSnapshotKey: text("latest_snapshot_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("workbook_owner_id_idx").on(t.ownerId)],
);

export const workbookShare = pgTable(
  "workbook_share",
  {
    id: text("id").primaryKey(),
    workbookId: text("workbook_id")
      .notNull()
      .references(() => workbook.id, { onDelete: "cascade" }),
    // Null until the invitation is accepted.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    inviteToken: text("invite_token").unique(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("workbook_share_email_idx").on(t.workbookId, t.email), index("workbook_share_user_idx").on(t.userId)],
);

export const workbookLink = pgTable("workbook_link_settings", {
  workbookId: text("workbook_id")
    .primaryKey()
    .references(() => workbook.id, { onDelete: "cascade" }),
  linkAccess: text("link_access", { enum: ["none", "view", "edit"] }).notNull().default("none"),
  allowCopy: boolean("allow_copy").notNull().default(true),
});

// Kept after a workbook is purged, so no foreign key.
export const auditEvent = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Empty for events about a connection rather than a workbook.
    workbookId: text("workbook_id").notNull(),
    userId: text("user_id").notNull(),
    event: text("event").notNull(),
    detail: jsonb("detail").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_events_workbook_idx").on(t.workbookId)],
);

export const connection = pgTable(
  "connection",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["postgres", "snowflake"] }).notNull(),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    // AES-256-GCM, never returned by the API.
    secret: text("secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connection_owner_name_idx").on(t.ownerId, t.name)],
);

export const connectedTable = pgTable(
  "connected_table",
  {
    id: text("id").primaryKey(),
    workbookId: text("workbook_id")
      .notNull()
      .references(() => workbook.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sql: text("sql").notNull(),
    // The Data Table it fills, once it has run.
    tableId: text("table_id"),
    // Cron, UTC.
    schedule: text("schedule"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status", { enum: ["ok", "error"] }),
    lastError: text("last_error"),
    rowCount: bigint("row_count", { mode: "number" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connected_table_workbook_idx").on(t.workbookId), index("connected_table_due_idx").on(t.nextRunAt)],
);
