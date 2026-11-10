// Error reporting. Every error is logged as one JSON line (Railway keeps the logs);
// with SENTRY_DSN set, it also goes to Sentry, which alerts on new problems. Browser
// errors arrive through POST /api/v1/client-errors, so the DSN never ships to clients.

import * as Sentry from "@sentry/node";

import { env } from "./env.ts";

if (env.sentryDsn) {
  Sentry.init({ dsn: env.sentryDsn, environment: env.sentryEnvironment, tracesSampleRate: 0 });
}

export const reporting = () => !!env.sentryDsn;

/** Log an error from this server and send it to Sentry when configured. */
export function captureError(error: unknown, context: Record<string, unknown> = {}): void {
  const e = error instanceof Error ? error : new Error(String(error));
  // Database errors arrive wrapped; the cause has the real reason.
  const cause = e.cause instanceof Error ? e.cause.message : e.cause === undefined ? undefined : String(e.cause);
  console.error(JSON.stringify({ level: "error", source: "server", message: e.message, cause, stack: e.stack, ...context }));
  if (env.sentryDsn) Sentry.captureException(e, { extra: context });
}

export interface ClientError {
  message: string;
  stack?: string;
  url?: string;
  userAgent?: string;
}

/** Log an error reported by a browser and send it to Sentry when configured. */
export function captureClientError(report: ClientError, userId: string | null): void {
  console.error(JSON.stringify({ level: "error", source: "browser", userId, ...report }));
  if (!env.sentryDsn) return;
  Sentry.withScope((scope) => {
    scope.setTag("source", "browser");
    if (userId) scope.setUser({ id: userId });
    scope.setExtras({ url: report.url, userAgent: report.userAgent, stack: report.stack });
    Sentry.captureMessage(report.message, "error");
  });
}

/** Turn an untrusted report body into a bounded ClientError, or null. */
export function parseClientError(body: unknown): ClientError | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const message = text(b.message, 1000);
  if (!message) return null;
  return { message, stack: text(b.stack, 8000), url: text(b.url, 2000), userAgent: text(b.userAgent, 500) };
}

// Browser reports per address per minute; anything past this is dropped.
const CLIENT_LIMIT = 20;
const seen = new Map<string, { count: number; since: number }>();

export function allowClientReport(key: string, now = Date.now()): boolean {
  const entry = seen.get(key);
  if (!entry || now - entry.since > 60_000) {
    seen.set(key, { count: 1, since: now });
    if (seen.size > 10_000) seen.clear();
    return true;
  }
  entry.count++;
  return entry.count <= CLIENT_LIMIT;
}

process.on("unhandledRejection", (reason) => captureError(reason, { kind: "unhandledRejection" }));
process.on("uncaughtException", (error) => {
  captureError(error, { kind: "uncaughtException" });
  void Sentry.flush(2000).finally(() => process.exit(1));
});
