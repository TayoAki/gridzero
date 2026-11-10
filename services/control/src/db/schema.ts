// Control-plane schema (BUILD-SPEC §4.1). The user/session/account/verification
// tables mirror Better-Auth's core schema (better-auth 1.7 getAuthTables) so its
// Drizzle adapter can use them directly.

import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    kind: text("kind", { enum: ["postgres", "redshift", "snowflake", "databricks", "bigquery"] }).notNull(),
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

// --- Agents (docs/AGENT-BUILD-SPEC.md, phase 1) -------------------------------

/** A user's own Anthropic key (beta: bring your own key), sealed with encryptSecret. */
export const aiKey = pgTable("ai_key", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  secret: text("secret").notNull(),
  last4: text("last4").notNull(),
  monthlyCapMicroUsd: bigint("monthly_cap_micro_usd", { mode: "number" }).notNull().default(20_000_000),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    avatar: text("avatar").notNull(),
    color: text("color").notNull(),
    instructions: text("instructions").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_owner_idx").on(t.ownerId)],
);

/** One Anthropic message per row, content blocks stored exactly as sent or received. */
export const agentMessage = pgTable(
  "agent_message",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    visible: text("visible"),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_message_seq_idx").on(t.agentId, t.seq)],
);

export const agentRun = pgTable(
  "agent_run",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    steps: integer("steps").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_run_owner_idx").on(t.ownerId, t.startedAt)],
);
// Phase 3: metric models in Apache Ossie format (docs/AGENT-BUILD-SPEC.md §7).
export const metricModel = pgTable(
  "metric_model",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The YAML exactly as uploaded, so an export gives it back unchanged.
    source: text("source").notNull(),
    parsed: jsonb("parsed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("metric_model_owner_name_idx").on(t.ownerId, t.name)],
);

// Phase 4: dashboards and widgets (docs/AGENT-BUILD-SPEC.md §8).
export const dashboard = pgTable(
  "dashboard",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboard_owner_idx").on(t.ownerId)],
);

export const widget = pgTable(
  "widget",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboard.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agent.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    form: text("form").notNull(),
    theme: text("theme").notNull(),
    size: text("size").notNull(),
    position: integer("position").notNull(),
    data: jsonb("data").notNull(),
    source: jsonb("source").notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("widget_dashboard_idx").on(t.dashboardId, t.position)],
);

export const widgetProposal = pgTable("widget_proposal", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agent.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  acceptedWidgetId: text("accepted_widget_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
