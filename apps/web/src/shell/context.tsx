// What a page can tell the shell around it: its tab's name, and what the bottom bar says.

import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";

export type Tone = "good" | "warn" | "bad" | "busy";

export interface Status {
  /** Left side: what is open and how fresh it is. */
  left?: string;
  /** Right side: how far the numbers can be trusted, or what needs doing. */
  right?: string;
  tone?: Tone;
  /** The one next action, if there is one. */
  action?: { label: string; to?: string; onClick?: () => void };
}

export interface ShellApi {
  setStatus: (owner: string, status: Status | null) => void;
  setTitle: (path: string, title: string) => void;
  /** Replace the right panel's content (null gives it back to the agent). */
  setPanel: (owner: string, panel: { title: string; body: ReactNode } | null) => void;
  openAgent: () => void;
}

export const ShellContext = createContext<ShellApi | null>(null);

/** Say what the bottom bar shows while this page is on screen. Safe outside the shell. */
export function useStatus(owner: string, status: Status | null): void {
  const shell = useContext(ShellContext);
  const key = JSON.stringify(status && { ...status, action: status.action && { label: status.action.label, to: status.action.to } });
  useEffect(() => {
    shell?.setStatus(owner, status);
    return () => shell?.setStatus(owner, null);
    // The status is compared by its text; a new onClick closure alone does not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, owner, key]);
}

/** Name this page's tab. */
export function useTabTitle(title: string | null | undefined): void {
  const shell = useContext(ShellContext);
  useEffect(() => {
    if (title) shell?.setTitle(window.location.pathname, title);
  }, [shell, title]);
}

export function useShell(): ShellApi | null {
  return useContext(ShellContext);
}
