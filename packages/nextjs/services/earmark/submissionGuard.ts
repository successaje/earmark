import type { Hex } from "viem";

/**
 * Keeps the HCS route from becoming a free relay that spends the operator's HBAR: each document is anchored once,
 * and each client gets a small budget per minute.
 *
 * State is per server process. That is enough for a single `next start`; behind several instances or on a
 * serverless host, move both maps to a shared store (Redis, KV) with the same logic.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_REMEMBERED = 5_000;

const anchored = new Set<Hex>();
const windows = new Map<string, { start: number; count: number }>();

export type GuardResult = { ok: true } | { ok: false; status: 409 | 429; error: string };

export function admit(client: string, hash: Hex, now = Date.now()): GuardResult {
  if (anchored.has(hash)) return { ok: false, status: 409, error: "This document is already anchored" };

  const window = windows.get(client);
  if (!window || now - window.start > WINDOW_MS) {
    windows.set(client, { start: now, count: 1 });
  } else if (window.count >= MAX_PER_WINDOW) {
    return { ok: false, status: 429, error: "Too many submissions; try again in a minute" };
  } else {
    window.count += 1;
  }
  return { ok: true };
}

/** Call after a successful submission so the same document is never paid for twice. */
export function remember(hash: Hex) {
  if (anchored.size >= MAX_REMEMBERED) anchored.delete(anchored.values().next().value as Hex);
  anchored.add(hash);
}

export function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
