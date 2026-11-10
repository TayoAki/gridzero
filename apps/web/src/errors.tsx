// Browser error reporting: uncaught errors, rejected promises and React crashes go to
// the control service (POST /api/v1/client-errors), which logs them and forwards them
// to Sentry when configured.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

const MAX_PER_PAGE = 10;
let sent = 0;
const recent = new Set<string>();

export function reportError(error: unknown, extra = ""): void {
  const e = error instanceof Error ? error : new Error(String(error));
  const key = `${e.message}|${e.stack?.split("\n")[1] ?? ""}`;
  if (recent.has(key) || sent >= MAX_PER_PAGE) return;
  recent.add(key);
  sent++;
  const body = JSON.stringify({ message: e.message, stack: [e.stack, extra].filter(Boolean).join("\n"), url: location.href, userAgent: navigator.userAgent });
  fetch("/api/v1/client-errors", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}

export function installErrorReporting(): void {
  window.addEventListener("error", (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason));
}

/** Shows a way out instead of a blank page when rendering fails. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, info.componentStack ?? "");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crash">
        <h1>Something went wrong</h1>
        <p>The problem has been reported. Your work is saved on the server as you go.</p>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }
}
