// Calls from agents to the workbook host (agent spec §6.1).

import { sign } from "hono/jwt";

import { env } from "../env.ts";

export const TILE_ROWS = 64;
export const TILE_COLS = 16;

export type TileCell = [number, string, ...unknown[]];
export interface Tile {
  tr: number;
  tc: number;
  cells: TileCell[];
}
export interface SheetInfo {
  id: number;
  name: string;
  hidden: boolean;
}
export interface AgentReply<R = Record<string, unknown>> {
  reply: R & { k: string };
  sheets: SheetInfo[];
}

export const hostBase = (workbookId: string) => env.wbhostUrl.replace(/^ws/, "http") + `/wb/${workbookId}`;

export async function hostToken(workbookId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 1800;
  return sign({ wb: workbookId, sub: "control", role: "owner", admin: true, exp }, env.wbTokenSecret, "HS256");
}

/** Send one allowed action to `/agent`; returns `{ reply, sheets }` or throws `Error(text)`. */
export async function hostAgentCall<R = Record<string, unknown>>(workbookId: string, action: Record<string, unknown>): Promise<AgentReply<R>> {
  const token = encodeURIComponent(await hostToken(workbookId));
  const res = await fetch(`${hostBase(workbookId)}/agent?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) throw new Error((await res.text()) || `The workbook host answered ${res.status}`);
  return (await res.json()) as AgentReply<R>;
}

/** Displayed text by (row, col) from tiles. */
export function cellGrid(tiles: Tile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tiles) {
    for (const cell of t.cells) {
      const idx = cell[0];
      const text = cell[1];
      if (text === "") continue;
      const row = t.tr * TILE_ROWS + Math.floor(idx / TILE_COLS);
      const col = t.tc * TILE_COLS + (idx % TILE_COLS);
      out.set(`${row},${col}`, text);
    }
  }
  return out;
}

/** A1 notation ("B2:D10" or "A1") to zero-based inclusive bounds. Throws on anything else. */
export function parseA1Range(a1: string): { r0: number; c0: number; r1: number; c1: number } {
  const ref = (s: string) => {
    const m = /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/.exec(s.trim());
    if (!m) throw new Error(`"${a1}" is not a cell range like A1:C20`);
    let col = 0;
    for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(m[2]) - 1, col: col - 1 };
  };
  const parts = a1.split(":");
  if (parts.length > 2 || !a1.trim()) throw new Error(`"${a1}" is not a cell range like A1:C20`);
  const a = ref(parts[0]!);
  const b = parts.length === 2 ? ref(parts[1]!) : a;
  return { r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) };
}
