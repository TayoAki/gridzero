// A planned screen and what it would need from the backend. No JSX here: scripts read these files.

export type NeedKind = "connection" | "endpoint" | "job" | "data" | "policy";

export interface Need {
  kind: NeedKind;
  /** Short and stable, so the same need on several screens is counted once: "Shopify", "POST /api/v1/reports/:id/send". */
  name: string;
  /** What it has to do for this screen, in a sentence. */
  note: string;
  /** Whether the product already has it. */
  exists: "yes" | "partly" | "no";
}

export interface ScreenMeta {
  /** The code used on the plan page, such as "G1". */
  code: string;
  title: string;
  /** One sentence on what the person sees and why. */
  summary: string;
  /** Who it is mainly for. */
  for: string;
  needs: Need[];
}

export interface GroupMeta {
  code: string;
  name: string;
  screens: ScreenMeta[];
}
