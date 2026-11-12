// Posting to an address a person gave us (a Slack incoming webhook, or any other). The address is theirs,
// so it is treated as hostile: https only, and never anywhere inside our own network.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { env } from "./env.ts";

/** Whether an IP address is on the public internet. */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPublicAddress(v6.slice(7));
  return !(v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff"));
}

/** Why an address cannot be used as a webhook, or null. Looks the host up: every address it has must be public. */
export async function webhookProblem(address: string): Promise<string | null> {
  if (address.length > 2000) return "The address is longer than 2,000 characters.";
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "Enter the full address, starting with https://";
  }
  if (url.username || url.password) return "Leave the user name and password out of the address.";
  if (env.webhookAllowPrivate) return url.protocol === "http:" || url.protocol === "https:" ? null : "Enter the full address, starting with https://";
  if (url.protocol !== "https:") return "Enter the full address, starting with https://";
  try {
    const found = await lookup(url.hostname, { all: true });
    if (found.length === 0 || found.some((a) => !isPublicAddress(a.address))) return "That address is not on the public internet.";
  } catch {
    return "That address could not be found.";
  }
  return null;
}

/** Post JSON to a webhook. Checked again at send time, redirects not followed, ten seconds at most. */
export async function postWebhook(address: string, body: unknown): Promise<string | null> {
  const problem = await webhookProblem(address);
  if (problem) return problem;
  try {
    const res = await fetch(address, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return res.ok ? null : `The webhook answered ${res.status}.`;
  } catch {
    return "The webhook could not be reached.";
  }
}
