// AI keys (spec §5.5). A person can bring their own key (Anthropic or OpenRouter), sealed with
// encryptSecret and only ever decrypted inside the request that uses it. When GridZero has a key
// of its own (OPENROUTER_API_KEY), people without one can use that, within a small monthly allowance.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sql as dsql } from "drizzle-orm";

import { encryptSecret, decryptSecret } from "../connectors.ts";
import { db } from "../db/client.ts";
import { agentRun, aiKey } from "../db/schema.ts";
import { env } from "../env.ts";
import { clientFor } from "./model.ts";
import type { Provider } from "./model.ts";

const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_\-]{4,200}$/;
const OPENROUTER_KEY = /^sk-or-[A-Za-z0-9_\-]{4,200}$/;

export class KeyError extends Error {
  readonly code: "E_BAD_KEY" | "E_MODEL";
  constructor(code: "E_BAD_KEY" | "E_MODEL") {
    super(code);
    this.code = code;
  }
}

/** Ask the provider whether it accepts the key. */
async function check(provider: Provider, key: string): Promise<void> {
  if (provider === "openrouter") {
    let res: Response;
    try {
      res = await fetch(`${env.openrouterBaseUrl}/v1/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new KeyError("E_MODEL");
    }
    if (res.status === 401 || res.status === 403) throw new KeyError("E_BAD_KEY");
    if (!res.ok) throw new KeyError("E_MODEL");
    return;
  }
  try {
    await clientFor(key).models.list({ limit: 1 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new KeyError("E_BAD_KEY");
    throw new KeyError("E_MODEL");
  }
}

/** Check the key with its provider, then store it sealed. */
export async function saveKey(userId: string, raw: string): Promise<{ provider: Provider; last4: string }> {
  const key = raw.trim();
  const provider: Provider | null = ANTHROPIC_KEY.test(key) ? "anthropic" : OPENROUTER_KEY.test(key) ? "openrouter" : null;
  if (!provider) throw new KeyError("E_BAD_KEY");
  await check(provider, key);
  const last4 = key.slice(-4);
  const secret = encryptSecret(key);
  await db
    .insert(aiKey)
    .values({ userId, provider, secret, last4 })
    .onConflictDoUpdate({ target: aiKey.userId, set: { secret, last4, provider } });
  return { provider, last4 };
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

export interface LoadedKey {
  key: string;
  provider: Provider;
  /** The person's own key, or GridZero's. */
  source: "own" | "platform";
  capMicroUsd: number;
}

/** The key a person's runs use: their own if they saved one, else GridZero's when it has one. */
export async function loadKey(userId: string): Promise<LoadedKey | null> {
  const [row] = await db.select().from(aiKey).where(eq(aiKey.userId, userId));
  if (row) return { key: decryptSecret(row.secret), provider: row.provider === "openrouter" ? "openrouter" : "anthropic", source: "own", capMicroUsd: row.monthlyCapMicroUsd };
  if (env.openrouterApiKey) return { key: env.openrouterApiKey, provider: "openrouter", source: "platform", capMicroUsd: Math.round(env.platformUserCapUsd * 1_000_000) };
  return null;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Spend since the first day of the current UTC month, in millionths of a dollar. `source` narrows it to one kind of key. */
export async function monthSpend(userId: string, now = new Date(), source?: "own" | "platform"): Promise<number> {
  const [row] = await db
    .select({ total: dsql<string>`coalesce(sum(${agentRun.costMicroUsd}), 0)` })
    .from(agentRun)
    .where(and(eq(agentRun.ownerId, userId), gte(agentRun.startedAt, monthStart(now)), source ? eq(agentRun.keySource, source) : undefined));
  return Number(row?.total ?? 0);
}

/** What everyone together has spent on GridZero's key this month. */
export async function platformSpend(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: dsql<string>`coalesce(sum(${agentRun.costMicroUsd}), 0)` })
    .from(agentRun)
    .where(and(eq(agentRun.keySource, "platform"), gte(agentRun.startedAt, monthStart(now))));
  return Number(row?.total ?? 0);
}

/**
 * Whether a run may start: null, or the reason it may not. A person's own key is held to the cap
 * they set. GridZero's key is held to a small allowance per person and to a total for everyone.
 */
export async function overCap(userId: string, key: LoadedKey): Promise<"E_LIMIT" | "E_PLATFORM_LIMIT" | null> {
  if (key.source === "own") return (await monthSpend(userId, new Date(), "own")) >= key.capMicroUsd ? "E_LIMIT" : null;
  if ((await monthSpend(userId, new Date(), "platform")) >= key.capMicroUsd) return "E_PLATFORM_LIMIT";
  if ((await platformSpend()) >= env.platformTotalCapUsd * 1_000_000) return "E_PLATFORM_LIMIT";
  return null;
}

export async function keyStatus(userId: string) {
  const [row] = await db.select().from(aiKey).where(eq(aiKey.userId, userId));
  // What GridZero includes, shown whether or not the person has a key of their own.
  const included = env.openrouterApiKey
    ? { included: { monthlyCapUsd: env.platformUserCapUsd, spentThisMonthUsd: (await monthSpend(userId, new Date(), "platform")) / 1_000_000 } }
    : {};
  if (!row) return { provider: null, ...included };
  return {
    provider: row.provider,
    last4: row.last4,
    monthlyCapUsd: row.monthlyCapMicroUsd / 1_000_000,
    spentThisMonthUsd: (await monthSpend(userId, new Date(), "own")) / 1_000_000,
    ...included,
  };
}
