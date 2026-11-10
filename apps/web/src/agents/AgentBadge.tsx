import { AVATAR_GLYPH, COLOR_HEX } from "./catalog";
import type { Agent } from "./catalog";

export function AgentBadge({ agent, size = 36 }: { agent: Pick<Agent, "avatar" | "color">; size?: number }) {
  return (
    <span className="agent-badge" style={{ width: size, height: size, fontSize: size * 0.55, background: COLOR_HEX[agent.color] ?? COLOR_HEX.gray }} aria-hidden="true">
      {AVATAR_GLYPH[agent.avatar] ?? "🤖"}
    </span>
  );
}
