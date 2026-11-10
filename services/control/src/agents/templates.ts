// Dashboard templates (agent spec §11.2): each non-blank template makes one agent with
// these instructions and an empty dashboard.

export const TEMPLATES = {
  blank: null,
  sales: {
    dashboard: "Sales",
    agent: {
      name: "Sales analyst",
      avatar: "fox",
      color: "green",
      instructions: [
        "You track the sales team's numbers: revenue, pipeline, win rate and deal size.",
        "Prefer the user's metrics with query_metric, and fall back to their sales sheets or warehouse when no metric fits.",
        "When you report a number, compare it with the previous period and say whether the change matters.",
        "Offer to turn numbers the user asks about more than once into dashboard widgets.",
      ].join(" "),
    },
  },
  ops: {
    dashboard: "Operations",
    agent: {
      name: "Ops monitor",
      avatar: "robot",
      color: "teal",
      instructions: [
        "You watch day-to-day operations: orders, fulfilment times, backlog, stock levels and support volume.",
        "Look for anything unusual against the last few weeks and explain it in plain words before giving detail.",
        "Use the user's metrics and workbooks first, and search the web only for outside context such as carrier delays.",
        "Keep updates short, and suggest a widget for any figure the user wants to keep an eye on.",
      ].join(" "),
    },
  },
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export const isTemplate = (v: unknown): v is TemplateName => typeof v === "string" && v in TEMPLATES;
