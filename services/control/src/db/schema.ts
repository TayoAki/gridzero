// Control-plane schema (BUILD-SPEC §4.1). The user/session/account/verification
// tables mirror Better-Auth's core schema (better-auth 1.7 getAuthTables) so its
// Drizzle adapter can use them directly.

import { doublePrecision, bigint, bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    kind: text("kind", { enum: ["postgres", "redshift", "snowflake", "databricks", "bigquery", "web"] }).notNull(),
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
    /** How often fresh data is expected, in hours. When it is overdue, or a refresh fails, the owners downstream are told. */
    expectEveryHours: integer("expect_every_hours"),
    /** Set while the table is late or failing, so people are told once. */
    lateSince: timestamp("late_since", { withTimezone: true }),
    /** What whoever is looking into it has said, shown on the reports affected. */
    lateNote: text("late_note"),
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
    /** Whose key paid: the person's own, or GridZero's (counted against the platform caps). */
    keySource: text("key_source", { enum: ["own", "platform"] }).notNull().default("own"),
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
    /** Set while anyone with the link may view the report without signing in. */
    linkToken: text("link_token").unique(),
    /** The report's tabs, in order: [{ id, name }]. Empty means one unnamed page. */
    tabs: jsonb("tabs").$type<{ id: string; name: string }[]>().notNull().default([]),
    /** Viewers never see a group with fewer rows than this. 0 or 1 means no such rule. */
    minGroup: integer("min_group").notNull().default(0),
    /** Signs the links made for embedding. Changing it stops every such link at once. */
    embedKey: text("embed_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboard_owner_idx").on(t.ownerId)],
);

/** A person a report is shared with. They join by opening the invitation link while signed in. */
export const dashboardShare = pgTable(
  "dashboard_share",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboard.id, { onDelete: "cascade" }),
    /** Null until the invitation is accepted. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().$type<"editor" | "viewer">(),
    /** Rows this person is limited to: [{ field, values }]. Every card they see is worked out for these rows only. */
    limits: jsonb("limits").$type<{ field: string; values: string[] }[]>(),
    /** Columns this person never sees: a card that reads one is not shown to them. */
    hide: jsonb("hide").$type<string[]>(),
    inviteToken: text("invite_token").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("dashboard_share_email_idx").on(t.dashboardId, t.email), index("dashboard_share_user_idx").on(t.userId)],
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
    /** { x, y, w, h } on the report's 12-column grid, once someone has moved or resized a card. */
    layout: jsonb("layout"),
    /** { trend, forecast, anomalies }: analysis drawn over the chart. */
    options: jsonb("options"),
    /** The tab this card is on. Null, or a tab that no longer exists, means the first. */
    tab: text("tab"),
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

// Phase 5: schedules that only read (docs/AGENT-BUILD-SPEC.md §9).
export const schedule = pgTable(
  "schedule",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agent.id, { onDelete: "cascade" }),
    widgetId: text("widget_id").references(() => widget.id, { onDelete: "cascade" }),
    /** For kind "report_email": the report to send, and who to (email addresses). */
    dashboardId: text("dashboard_id").references(() => dashboard.id, { onDelete: "cascade" }),
    recipients: jsonb("recipients").$type<string[]>(),
    /** For kind "report_email": an https address the report is also posted to (a Slack incoming webhook, or any other). */
    webhook: text("webhook"),
    kind: text("kind").notNull(),
    prompt: text("prompt"),
    cron: text("cron").notNull(),
    label: text("label").notNull(),
    paused: boolean("paused").notNull().default(false),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_due_idx").on(t.paused, t.nextRunAt)],
);

/** Tell the owner when a number card goes above or below a line. Checked each time the card refreshes. */
export const alert = pgTable(
  "alert",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    widgetId: text("widget_id")
      .notNull()
      .references(() => widget.id, { onDelete: "cascade" }),
    op: text("op").notNull().$type<"above" | "below">(),
    threshold: doublePrecision("threshold").notNull(),
    /** True while the card is past the line, so the owner is told once per crossing. */
    firing: boolean("firing").notNull().default(false),
    lastValue: doublePrecision("last_value"),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    /** An https address the alert is also posted to. */
    webhook: text("webhook"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alert_widget_idx").on(t.widgetId)],
);

/** Something a person should see next time they look: an alert that fired, a report shared with them. */
export const notification = pgTable(
  "notification",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** A path in the app. */
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notification_user_idx").on(t.userId, t.createdAt)],
);

// Phase 6: approvals for app actions that change something (docs/AGENT-BUILD-SPEC.md §10.3).
export const approval = pgTable(
  "approval",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    action: text("action").notNull(),
    args: jsonb("args").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("approval_owner_idx").on(t.ownerId)],
);

// --- Confirmed definitions (docs/specs/DEFINITIONS-SPEC.md) --------------------

/** A company or team. Owns sources, definitions and questions. */
export const workspace = pgTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // No foreign key: a workspace outlives the account of whoever created it, as long as it has members.
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMember = pgTable(
  "workspace_member",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "editor", "viewer"] }).notNull(),
    /** A free label used to route questions, such as "Finance". */
    team: text("team"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_member_idx").on(t.workspaceId, t.userId), index("workspace_member_user_idx").on(t.userId)],
);

/** Where data lives: the address only. Each member signs in with their own source_credential. */
export const source = pgTable(
  "source",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["postgres", "workbook"] }).notNull(),
    name: text("name").notNull(),
    /** Postgres: host, port, database, ssl and the schemas to scan; never a user name or a secret. Workbook: its id. */
    config: jsonb("config").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_workspace_name_idx").on(t.workspaceId, t.name)],
);

export const sourceCredential = pgTable(
  "source_credential",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The member's own database user name. */
    username: text("username").notNull(),
    // AES-256-GCM, never returned by the API.
    secret: text("secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_credential_idx").on(t.sourceId, t.userId)],
);

export const scan = pgTable(
  "scan",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    startedBy: text("started_by").notNull(),
    status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
    error: text("error"),
    /** Catalog, profiles, keys and links. No row data beyond common values of low-cardinality columns. */
    result: jsonb("result"),
    stats: jsonb("stats"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("scan_source_idx").on(t.sourceId, t.startedAt)],
);

export const definition = pgTable(
  "definition",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["entity", "link", "dimension", "metric", "rule"] }).notNull(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    body: jsonb("body").notNull(),
    status: text("status", { enum: ["inferred", "needs_answer", "settled", "confirmed", "disputed"] }).notNull(),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull(),
    evidence: jsonb("evidence").notNull(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    confirmedBy: text("confirmed_by").references(() => user.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** { sql, value, period, takenAt } for a confirmed metric. */
    checkNumber: jsonb("check_number"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("definition_name_idx").on(t.sourceId, t.kind, t.name), index("definition_workspace_idx").on(t.workspaceId)],
);

/** Every status move and published change: who, when, from, to, why. Old bodies are kept here. */
export const definitionEvent = pgTable(
  "definition_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => definition.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    event: text("event").notNull(),
    detail: jsonb("detail").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("definition_event_idx").on(t.definitionId)],
);

export const question = pgTable(
  "question",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    topic: text("topic").notNull(),
    prompt: text("prompt").notNull(),
    /** [{ label, change, value?, sql?, note? }]: each one a ready answer with the number it gives. */
    options: jsonb("options").notNull(),
    data: jsonb("data").notNull(),
    rank: integer("rank").notNull(),
    atSetup: boolean("at_setup").notNull(),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    status: text("status", { enum: ["open", "answered", "skipped"] }).notNull().default("open"),
    answer: jsonb("answer"),
    answeredBy: text("answered_by").references(() => user.id, { onDelete: "set null" }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("question_source_idx").on(t.sourceId, t.status, t.rank)],
);

/** A proposed edit to a definition, with old and new numbers, waiting for a person to publish it. */
export const definitionChange = pgTable(
  "definition_change",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => definition.id, { onDelete: "cascade" }),
    proposedBy: text("proposed_by").notNull(),
    origin: text("origin", { enum: ["correction", "chat", "question"] }).notNull(),
    request: text("request").notNull(),
    newBody: jsonb("new_body").notNull(),
    /** { oldValue, newValue, oldSql, newSql, findings, impact } */
    preview: jsonb("preview").notNull(),
    status: text("status", { enum: ["proposed", "published", "discarded"] }).notNull().default("proposed"),
    decidedBy: text("decided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("definition_change_idx").on(t.definitionId, t.status)],
);

/**
 * A question with an answer a person has vouched for: a confirmed metric, or an agent's reply
 * someone marked as correct. Agents see these first, and each one is a test the agent is put
 * through again whenever its prompt, tools or model change.
 */
export const trustedAnswer = pgTable(
  "trusted_answer",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").references(() => definition.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    tool: text("tool", { enum: ["query_tables", "query_definition"] }).notNull(),
    /** query_tables: { workbook_id, sql }. query_definition: { definition_id, group_by }. */
    input: jsonb("input").notNull(),
    /** The result when it was vouched for, as CSV. */
    expected: text("expected").notNull(),
    origin: text("origin", { enum: ["confirmed", "chat"] }).notNull(),
    agentId: text("agent_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastStatus: text("last_status", { enum: ["pass", "fail", "error"] }),
    lastDetail: text("last_detail"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Which prompt, tools and model the last run used. */
    lastFingerprint: text("last_fingerprint"),
  },
  (t) => [uniqueIndex("trusted_answer_question_idx").on(t.sourceId, t.tool, t.question)],
);

/** A person's folder for filing workbooks and reports. */
export const folder = pgTable(
  "folder",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("folder_owner_name_idx").on(t.ownerId, t.name)],
);

/** Where one person has filed one workbook or report. Filing is per person: it moves nothing for anyone else. */
export const folderItem = pgTable(
  "folder_item",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"workbook" | "report">(),
    itemId: text("item_id").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => folder.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("folder_item_one_idx").on(t.userId, t.kind, t.itemId), index("folder_item_folder_idx").on(t.folderId)],
);

/** Who did what, to which thing, and when. `ownerId` is whoever the thing belongs to, so they can read its log. */
export const activity = pgTable(
  "activity",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Null for someone who was not signed in (a view link). */
    userId: text("user_id"),
    kind: text("kind").notNull(),
    objectKind: text("object_kind").notNull(),
    objectId: text("object_id").notNull(),
    label: text("label").notNull().default(""),
    ownerId: text("owner_id"),
    detail: jsonb("detail").notNull().default({}),
    /** How long a query took, when the event was one. */
    ms: integer("ms"),
  },
  (t) => [index("activity_object_idx").on(t.objectKind, t.objectId, t.at), index("activity_owner_idx").on(t.ownerId, t.at), index("activity_user_idx").on(t.userId, t.at)],
);

/** A change someone said is coming to a table, field, definition or source, sent to the owners of what is built on it. */
export const announcement = pgTable(
  "announcement",
  {
    id: text("id").primaryKey(),
    objectKind: text("object_kind").notNull(),
    objectId: text("object_id").notNull(),
    label: text("label").notNull(),
    message: text("message").notNull(),
    /** YYYY-MM-DD, when the change takes effect. */
    effectiveOn: text("effective_on"),
    told: integer("told").notNull().default(0),
    /** Who was told, and who of them has said they have seen it. */
    toldIds: jsonb("told_ids").$type<string[]>().notNull().default([]),
    ackedIds: jsonb("acked_ids").$type<string[]>().notNull().default([]),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("announcement_object_idx").on(t.objectKind, t.objectId)],
);

/** Who answers for a thing, when that is not simply whoever made it. */
export const ownership = pgTable(
  "ownership",
  {
    objectKind: text("object_kind").notNull(),
    objectId: text("object_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    setBy: text("set_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ownership_object_idx").on(t.objectKind, t.objectId), index("ownership_owner_idx").on(t.ownerId)],
);

/**
 * Work that hangs off a thing: an action someone must take, a decision that was made, a request for a
 * report or dataset, or an issue with the data. One table, because each is a title, a person, a state
 * and a trail of what happened.
 */
export const workItem = pgTable(
  "work_item",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().$type<"action" | "decision" | "request" | "issue">(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").notNull(),
    /** YYYY-MM-DD. */
    due: text("due"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    objectKind: text("object_kind"),
    objectId: text("object_id"),
    label: text("label").notNull().default(""),
    priority: text("priority").notNull().$type<"low" | "normal" | "high" | "urgent">().default("normal"),
    /** Who asked, when the request came through a public form from someone without an account. */
    requester: text("requester"),
    /** Example rows attached to a request or issue: { columns, rows }. */
    examples: jsonb("examples").$type<{ columns: string[]; rows: (string | null)[][] }>(),
    /** Requests: what must be true for it to be accepted as done: [{ text, done }]. */
    acceptance: jsonb("acceptance").$type<{ text: string; done: boolean }[]>().notNull().default([]),
    /** Requests and issues: things attached along the way: [{ kind, id, label }]. */
    links: jsonb("links").$type<{ kind: string; id: string; label: string }[]>().notNull().default([]),
    /** What happened, in order: [{ at, by, text }]. */
    events: jsonb("events").$type<{ at: string; by: string; text: string }[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("work_item_assignee_idx").on(t.assigneeId, t.status), index("work_item_creator_idx").on(t.createdBy), index("work_item_object_idx").on(t.objectKind, t.objectId)],
);

/** A check on a workbook's tables: a query that returns the rows that are wrong. No rows means it passes. */
export const dataCheck = pgTable(
  "data_check",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workbookId: text("workbook_id")
      .notNull()
      .references(() => workbook.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sql: text("sql").notNull(),
    /** The definition this check protects, if any. */
    definitionId: text("definition_id"),
    everyMinutes: integer("every_minutes"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status").$type<"ok" | "failing" | "error">(),
    lastCount: integer("last_count"),
    lastSample: jsonb("last_sample").$type<{ columns: string[]; rows: (string | null)[][] }>(),
    lastError: text("last_error"),
    webhook: text("webhook"),
    /** The issue opened when it last started failing. */
    issueId: text("issue_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("data_check_workbook_idx").on(t.workbookId), index("data_check_due_idx").on(t.nextRunAt)],
);

/** A report as it stood at a moment: every card's title, form and data, frozen. */
export const reportSnapshot = pgTable(
  "report_snapshot",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboard.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    takenBy: text("taken_by"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
    cards: jsonb("cards").notNull(),
  },
  (t) => [index("report_snapshot_dashboard_idx").on(t.dashboardId, t.takenAt)],
);

/** A release of a source's definitions: what changed since the last one, and the test results it went out with. */
export const release = pgTable(
  "release",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** { definitions: [{ id, label, version, status }], changed: [...], answers: {...}, checks: {...}, passed } */
    results: jsonb("results").notNull(),
  },
  (t) => [index("release_source_idx").on(t.sourceId, t.createdAt)],
);

/** A column someone marked as sensitive. Sharing a report that reads one needs a deliberate yes, which is logged. */
export const sensitiveField = pgTable(
  "sensitive_field",
  {
    workbookId: text("workbook_id")
      .notNull()
      .references(() => workbook.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    markedBy: text("marked_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sensitive_field_idx").on(t.workbookId, t.tableName, t.columnName)],
);

/**
 * A table on a report that people type into: free rows, or columns added beside the rows of a table
 * card (matched by a key column), such as an owner and a status for each account. It takes entries
 * only once the report's owner has approved it.
 */
export const inputTable = pgTable(
  "input_table",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboard.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    columns: jsonb("columns").$type<{ name: string; kind: "text" | "number" | "date" | "choice"; options?: string[] }[]>().notNull(),
    widgetId: text("widget_id").references(() => widget.id, { onDelete: "set null" }),
    keyColumn: text("key_column"),
    status: text("status").notNull().$type<"draft" | "pending" | "live">().default("draft"),
    /** Where a finished row is sent on: { webhook, column, value }. A row is posted once, when that column takes that value. */
    handoff: jsonb("handoff").$type<{ webhook: string; column: string; value: string }>(),
    /** The last version written out as a Delta table. */
    exportedVersion: integer("exported_version"),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("input_table_dashboard_idx").on(t.dashboardId)],
);

export const inputRow = pgTable(
  "input_row",
  {
    id: text("id").primaryKey(),
    tableId: text("table_id")
      .notNull()
      .references(() => inputTable.id, { onDelete: "cascade" }),
    /** The value of the key column of the card row this belongs to; null for a free row. */
    key: text("key"),
    values: jsonb("values").$type<Record<string, string | number | null>>().notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("input_row_table_idx").on(t.tableId), uniqueIndex("input_row_key_idx").on(t.tableId, t.key)],
);

/** A personal token for reading from outside the app: a notebook, a script, a pipeline. Only its hash is kept. */
export const apiToken = pgTable(
  "api_token",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("api_token_owner_idx").on(t.ownerId)],
);

/** A model whose predictions land in a workbook table. Changing its version tells the owners of what reads that table. */
export const modelAsset = pgTable(
  "model_asset",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: text("version").notNull(),
    workbookId: text("workbook_id")
      .notNull()
      .references(() => workbook.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    notes: text("notes").notNull().default(""),
    /** Earlier versions, newest last: [{ version, at, notes }]. */
    history: jsonb("history").$type<{ version: string; at: string; notes: string }[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_asset_workbook_idx").on(t.workbookId)],
);

/** A workbook table whose rows are kept, version by version, as a Delta table, so changes to each record can be seen. */
export const trackedTable = pgTable(
  "tracked_table",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workbookId: text("workbook_id")
      .notNull()
      .references(() => workbook.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    keyColumn: text("key_column").notNull(),
    everyHours: integer("every_hours"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastVersion: integer("last_version"),
    lastAt: timestamp("last_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tracked_table_idx").on(t.workbookId, t.tableName), index("tracked_table_due_idx").on(t.nextRunAt)],
);

/** A form anyone with its address can use to ask for something, without an account. Requests go to its owner. */
export const intakeLink = pgTable("intake_link", {
  token: text("token").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
