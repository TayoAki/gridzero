// Agent avatars and colors. services/control/src/agents/catalog.ts declares the same lists
// in the same order; a control test checks they match.

export const AVATARS = ["robot", "owl", "fox", "cat", "bear", "rocket", "spark", "leaf"] as const;
export const COLORS = ["blue", "green", "purple", "orange", "pink", "teal", "gray"] as const;

export type Avatar = (typeof AVATARS)[number];
export type Color = (typeof COLORS)[number];

export const AVATAR_GLYPH: Record<Avatar, string> = {
  robot: "🤖",
  owl: "🦉",
  fox: "🦊",
  cat: "🐱",
  bear: "🐻",
  rocket: "🚀",
  spark: "✨",
  leaf: "🍃",
};

export const COLOR_HEX: Record<Color, string> = {
  blue: "#1a73e8",
  green: "#188038",
  purple: "#8430ce",
  orange: "#e8710a",
  pink: "#d01884",
  teal: "#129eaf",
  gray: "#5f6368",
};

export interface Agent {
  id: string;
  name: string;
  avatar: Avatar;
  color: Color;
  instructions: string;
  createdAt: string;
}

export interface KeyStatus {
  provider: "anthropic" | null;
  last4?: string;
  monthlyCapUsd?: number;
  spentThisMonthUsd?: number;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? (null as T) : await res.json().catch(() => null as T);
  return { ok: res.ok, status: res.status, data };
}
