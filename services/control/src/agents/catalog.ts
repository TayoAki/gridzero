// Fixed choices and limits for agents (docs/AGENT-BUILD-SPEC.md §5). The web app keeps
// the same AVATARS and COLORS in apps/web/src/agents/catalog.ts; a test checks they match.

export const AVATARS = ["robot", "owl", "fox", "cat", "bear", "rocket", "spark", "leaf"] as const;
export const COLORS = ["blue", "green", "purple", "orange", "pink", "teal", "gray"] as const;

export type RunKind = "chat" | "scheduled" | "widget_refresh";

export const MAX_STEPS: Record<RunKind, number> = { chat: 12, scheduled: 20, widget_refresh: 20 };
export const HISTORY_MESSAGES = 60;
export const HISTORY_CHARS = 200_000;

/** Fixed messages shown to people (spec §4.4). Provider error text never reaches the browser. */
export const ERRORS = {
  E_NO_KEY: "Add your own AI key in Settings to use agents.",
  E_BAD_KEY: "That key was not accepted. Check it and try again.",
  E_MODEL: "The AI service could not complete this request. Try again in a moment.",
  E_REFUSED: "The model declined this request.",
  E_TOO_LONG: "The answer was too long to finish. Ask for something shorter.",
  E_TOO_MANY_STEPS: "The agent took too many steps and stopped. Try a narrower request.",
  E_BUSY: "This agent is already working on a reply.",
  E_LIMIT: "You have reached this month's spending cap. Raise it in Settings.",
  E_PLATFORM_LIMIT: "You have used this month's included AI. Add your own key in Settings to keep going.",
} as const;

export type ErrorCode = keyof typeof ERRORS;
