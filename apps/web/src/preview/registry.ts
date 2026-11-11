// Every planned screen, grouped as on the plan page. The screens themselves are in ./screens.

import { meta as agency } from "./meta/agency.ts";
import { meta as governance } from "./meta/governance.ts";
import { meta as sources } from "./meta/sources.ts";
import { meta as warehouse } from "./meta/warehouse.ts";
import type { GroupMeta, ScreenMeta } from "./types.ts";

export const PREVIEW_SCREENS: ScreenMeta[] = [...agency, ...sources, ...warehouse, ...governance];

const NAMES: Record<string, string> = {
  G: "Clients and delivery",
  H: "No more exports",
  I: "Fitting the other profiles",
  J: "Warehouse teams",
  K: "Closing each person's last gap",
  L: "Agency reports on autopilot",
  M: "Warehouse teams, to a 10",
};

const order = (code: string) => Number(code.slice(1));
export const PREVIEW_GROUPS: GroupMeta[] = Object.keys(NAMES)
  .map((code) => ({ code, name: NAMES[code]!, screens: PREVIEW_SCREENS.filter((s) => s.code[0] === code).sort((a, b) => order(a.code) - order(b.code)) }))
  .filter((g) => g.screens.length > 0);

/** Planned screens show only to people who asked for them: open any page once with ?preview=1 (or ?preview=0 to hide). */
export function previewOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const asked = new URLSearchParams(window.location.search).get("preview");
    if (asked === "1") localStorage.setItem("gz_preview", "1");
    if (asked === "0") localStorage.removeItem("gz_preview");
    return localStorage.getItem("gz_preview") === "1";
  } catch {
    return false;
  }
}
