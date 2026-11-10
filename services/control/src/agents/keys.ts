// Bring-your-own Anthropic key (spec §5.5). The key is sealed with encryptSecret and is
// only ever decrypted inside the request that uses it.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sql as dsql } from "drizzle-orm";

import { encryptSecret, decryptSecret } from "../connectors.ts";
import { db } from "../db/client.ts";
import { agentRun, aiKey } from "../db/schema.ts";
import { clientFor } from "./model.ts";

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_\-]{4,200}$/;

export class KeyError extends Error {
  readonly code: "E_BAD_KEY" | "E_MODEL";
  constructor(code: "E_BAD_KEY" | "E_MODEL") {
    super(code);
    this.code = code;
  }
}

/** Check the key with Anthropic, then store it sealed. */
export async function saveKey(userId: string, raw: string): Promise<{ provider: "anthropic"; last4: string }> {
  const key = raw.trim();
  if (!KEY_SHAPE.test(key)) throw new KeyError("E_BAD_KEY");
  try {
    await clientFor(key).models.list({ limit: 1 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new KeyError("E_BAD_KEY");
    throw new KeyError("E_MODEL");
  }
  const last4 = key.slice(-4);
  const secret = encryptSecret(key);
  await db
    .insert(aiKey)
    .values({ userId, provider: "anthropic", secret, last4 })
    .onConflictDoUpdate({ target: aiKey.userId, set: { secret, last4, provider: "anthropic" } });
  return { provider: "anthropic", last4 };
}

export async function deleteKey(userId: string): Promise<void> {
  await db.delete(aiKey).where(eq(aiKey.userId, userId));
}

export async function setCap(userId: string, capUsd: number): Promise<boolean> {
  const rows = await db
    .update(aiKey)
    .set({ monthlyCapMicroUsd: Math.round(capUsd * 1_000_000) })
    .where(eq(aiKey.userId, userId))
    .returning({ userId: aiKey.userId });
  return rows.length > 0;
}

export async function loadKey(userId: string): Promise<{ key: string; capMicroUsd: number } | null> {
  const [row] = await db.select().from(aiKey).where(eq(aiKey.userId, userId));
  if (!row) return null;
  return { key: decryptSecret(row.secret), capMicroUsd: row.monthlyCapMicroUsd };
}

/** Spend since the first day of the current UTC month, in millionths of a dollar. */
export async function monthSpend(userId: string, now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ total: dsql<string>`coalesce(sum(${agentRun.costMicroUsd}), 0)` })
    .from(agentRun)
    .where(and(eq(agentRun.ownerId, userId), gte(agentRun.startedAt, start)));
  return Number(row?.total ?? 0);
}

export async function keyStatus(userId: string) {
  const [row] = await db.select().from(aiKey).where(eq(aiKey.userId, userId));
  if (!row) return { provider: null };
  return {
    provider: row.provider,
    last4: row.last4,
    monthlyCapUsd: row.monthlyCapMicroUsd / 1_000_000,
    spentThisMonthUsd: (await monthSpend(userId)) / 1_000_000,
  };
}
