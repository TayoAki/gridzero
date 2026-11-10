function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required("DATABASE_URL"),
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  authSecret: required("BETTER_AUTH_SECRET"),
  // Public origin the browser uses, e.g. https://staging.gridzero.app
  publicUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  // Built SPA to serve in deployed environments; unset in local dev (Vite serves it).
  webDist: process.env.WEB_DIST,
  // Shared with wbhost: signs the short-lived routing tokens that open a workbook socket.
  wbTokenSecret: required("WB_TOKEN_SECRET"),
  // Base URL browsers use to reach wbhost, e.g. wss://wbhost-staging.up.railway.app
  wbhostUrl: process.env.WBHOST_PUBLIC_URL ?? "ws://localhost:8790",
  // Encrypts stored database credentials. Without it connections cannot be saved.
  connectionSecretKey: process.env.CONNECTION_SECRET_KEY,
  // Tests only: lets connections reach localhost and private networks.
  connectorAllowPrivate: process.env.CONNECTOR_ALLOW_PRIVATE === "1",
  // Tests only: a stand-in for Snowflake.
  snowflakeBaseUrl: process.env.SNOWFLAKE_BASE_URL,
  // Tests only: stand-ins for Databricks, BigQuery and Google's token endpoint.
  databricksBaseUrl: process.env.DATABRICKS_BASE_URL,
  bigqueryBaseUrl: process.env.BIGQUERY_BASE_URL,
  googleTokenUrl: process.env.GOOGLE_TOKEN_URL,
  // Tests only: a stand-in for the Anthropic API (tests/e2e/fake-anthropic.mjs).
  // Tests shorten the 15-second scheduler tick.
  scheduleTickMs: Number(process.env.SCHEDULE_TICK_MS) || 15_000,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
  // Invitation email; without a key the share dialog hands out the link instead.
  resendApiKey: process.env.RESEND_API_KEY,
  mailFrom: process.env.MAIL_FROM ?? "GridZero <invites@gridzero.app>",
  // Error reporting; without a DSN errors are only logged.
  sentryDsn: process.env.SENTRY_DSN,
  sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? "development",
};
